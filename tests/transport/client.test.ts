/**
 * 批 2 RPC 层单测：新契约 mock server（DSH 0.1.2-rc.1）。
 *
 * 覆盖：
 * - 端点斜杠（session/list 等）；payload.args 结构（键集合与描述符一致）
 * - Cookie header 注入（假 cookieHeader）；auth 失败（DshAuthError）明确传播
 * - requestId 自动填充（prompt）；throughSeq 必填（page）
 * - 信封回显校验（rpcId 不匹配 → internal）
 * - 错误结果透传（gateway/arguments-invalid、session/not-found 等业务错误码）
 * - 硬超时 / 中途断开（TransportFailure）
 * - answerEvent 三态编码（next/result/rejected）
 * - openStream 批 3 占位（StreamNotImplementedError）
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "http";
import { DshClient, postJson, StreamNotImplementedError, TransportFailure } from "../../src/transport/client";
import { DshAuthError, DshCookieAuth } from "../../src/transport/auth";

let server: Server;
let baseUrl: string;

/** 每个请求的观测记录：url/headers/body（测试断言线上契约形状）。 */
interface Observed {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
}
const observed: Observed[] = [];

const FIXED_COOKIE = "dsh-auth-fixed=fake.v1.cookie";

function sendJson(res: import("http").ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      observed.push({ url: req.url ?? "", headers: { ...req.headers }, body });
      const url = req.url ?? "";
      const b = body as { rpcId?: string; method?: string; payload?: { args?: Record<string, unknown> } } | null;

      // ---- 通用信封校验端点（rpcId 回显 / args 键校验 / 错误结果 / 中途断开 / 慢响应） ----
      if (url === "/api/echo/ok") {
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, value: { echo: b } } });
      } else if (url === "/api/echo/mismatch") {
        sendJson(res, 200, { type: "server-response", rpcId: "other-rpc-id", result: { ok: true, value: {} } });
      } else if (url === "/api/echo/malformed") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not-json");
      } else if (url === "/api/echo/invalid-envelope") {
        sendJson(res, 200, { type: "client-request", rpcId: b?.rpcId, method: "x", payload: {} });
      } else if (url === "/api/echo/bad-error-shape") {
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: false, error: { code: 7 } } });
      } else if (url === "/api/echo/business-error") {
        // 业务错误透传（session/not-found 等新错误码）
        sendJson(res, 200, {
          type: "server-response",
          rpcId: b?.rpcId,
          result: { ok: false, error: { code: "session/not-found", message: "会话不存在", details: { sessionId: "x" } } },
        });
      } else if (url === "/api/echo/hang") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"type":"server-response","rpcId":"x","result":{"ok":true');
        setTimeout(() => res.socket?.destroy(), 50);
      } else if (url === "/api/echo/slow") {
        setTimeout(() => {
          if (res.destroyed) return;
          sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, value: {} } });
        }, 5000);
      }
      // ---- session 域端点（assert 端点斜杠 + args 键） ----
      else if (url === "/api/session/list") {
        sendJson(res, 200, {
          type: "server-response",
          rpcId: b?.rpcId,
          result: {
            ok: true,
            value: {
              items: [
                {
                  sessionId: "s1",
                  updatedAt: 3,
                  running: false,
                  blank: false,
                  cwd: "C:\\vault",
                  projections: { asOfSeq: 10, values: { sessionListMetadata: { blank: false, lastPromptAt: 3 } } },
                },
              ],
            },
          },
        });
      } else if (url === "/api/session/create") {
        const args = b?.payload?.args as { request?: { cwd?: string; sessionId?: string; agentPreset?: string } } | undefined;
        sendJson(res, 200, {
          type: "server-response",
          rpcId: b?.rpcId,
          result: { ok: true, value: { sessionId: args?.request?.sessionId ?? "new-sess", agentPreset: args?.request?.agentPreset } },
        });
      } else if (url === "/api/session/prompt") {
        const args = b?.payload?.args as { request?: { requestId?: string } } | undefined;
        if (typeof args?.request?.requestId !== "string" || args.request.requestId.length === 0) {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "gateway/arguments-invalid", message: "requestId 必填" } },
          });
          return;
        }
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, value: { accepted: true } } });
      } else if (url === "/api/session/page") {
        const args = b?.payload?.args as { request?: { address?: { kind?: string; sessionId?: string }; throughSeq?: number } } | undefined;
        if (args?.request?.address?.kind !== "session" || typeof args.request.address.sessionId !== "string") {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "gateway/arguments-invalid", message: "address 非法" } },
          });
          return;
        }
        if (typeof args?.request?.throughSeq !== "number") {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "gateway/arguments-invalid", message: "throughSeq 必填" } },
          });
          return;
        }
        sendJson(res, 200, {
          type: "server-response",
          rpcId: b?.rpcId,
          result: {
            ok: true,
            value: {
              records: [
                { type: "event", event: { type: "user/message", seq: 1, time: 1, data: { id: "m1", content: [] } } },
                {
                  type: "chunks",
                  event: {
                    type: "chunkrow/reasoning-chunks",
                    seq: 2,
                    time: 1000,
                    data: { turn: 1, step: 1, index: 0, dt: [0, 5], texts: ["a", "b"] },
                  },
                },
              ],
              hasMore: true,
            },
          },
        });
      } else if (url === "/api/session/cancel") {
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, value: { accepted: true } } });
      }
      // ---- $events/result（waterfall 应答） ----
      else if (url === "/api/$events/result") {
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, value: undefined } });
      }
      // ---- 未知端点 / 非 2xx ----
      else if (url === "/api/echo/500") {
        sendJson(res, 500, "boom");
      } else {
        sendJson(res, 404, "not found");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function makeClient(extra?: { timeoutMs?: number; cookieHeader?: () => Promise<string> }): DshClient {
  return new DshClient({ baseUrl, cookieHeader: () => Promise.resolve(FIXED_COOKIE), ...extra });
}

function lastObserved(): Observed {
  return observed[observed.length - 1];
}

describe("DshClient 新契约（端点斜杠 + args 包装 + Cookie）", () => {
  it("call 发送 client-request 信封，payload 恒为 {args:{...}}，端点使用斜杠", async () => {
    const client = makeClient();
    const res = await client.call<{ echo: unknown }>("echo/ok", { foo: 1 });
    expect(res.ok).toBe(true);
    const seen = lastObserved();
    expect(seen.url).toBe("/api/echo/ok");
    expect(seen.body).toMatchObject({ type: "client-request", method: "echo/ok" });
    const payload = (seen.body as { payload: unknown }).payload;
    expect(payload).toEqual({ args: { foo: 1 } });
  });

  it("list 使用 session/list 端点并发送 {args:{_request:{}}}", async () => {
    const client = makeClient();
    const res = await client.list();
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.items).toHaveLength(1);
    const seen = lastObserved();
    expect(seen.url).toBe("/api/session/list");
    expect((seen.body as { payload: unknown }).payload).toEqual({ args: { _request: {} } });
  });

  it("create 发送 {args:{request:{cwd,sessionId,agentPreset}}}", async () => {
    const client = makeClient();
    const res = await client.create({ cwd: "C:\\vault", sessionId: "pre-1", agentPreset: "p" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.sessionId).toBe("pre-1");
    const seen = lastObserved();
    expect(seen.url).toBe("/api/session/create");
    expect((seen.body as { payload: unknown }).payload).toEqual({ args: { request: { cwd: "C:\\vault", sessionId: "pre-1", agentPreset: "p" } } });
  });

  it("prompt 自动铸造 requestId（UUID），并包装 request 形状", async () => {
    const client = makeClient();
    const res = await client.prompt({ sessionId: "s", mode: "queue", content: [{ type: "text", text: "hi" }] });
    expect(res.ok).toBe(true);
    const seen = lastObserved();
    expect(seen.url).toBe("/api/session/prompt");
    const args = (seen.body as { payload: { args: { request: PromptRequestOnWire } } }).payload.args.request;
    expect(args.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(args).toMatchObject({ sessionId: "s", mode: "queue", content: [{ type: "text", text: "hi" }] });
  });

  it("prompt 显式 requestId 时原样透传（不覆盖）", async () => {
    const client = makeClient();
    await client.prompt({ requestId: "my-id", sessionId: "s", mode: "steer", content: [{ type: "text", text: "x" }] });
    const args = (lastObserved().body as { payload: { args: { request: { requestId: string } } } }).payload.args.request;
    expect(args.requestId).toBe("my-id");
  });

  it("prompt 发送的 args 键集合与描述符精确一致（无多余键）", async () => {
    const client = makeClient();
    await client.prompt({ sessionId: "s", mode: "queue", content: [{ type: "text", text: "hi" }] });
    const args = (lastObserved().body as { payload: { args: { request: Record<string, unknown> } } }).payload.args.request;
    expect(Object.keys(args).sort()).toEqual(["content", "mode", "requestId", "sessionId"]);
  });

  it("page 发送 {args:{request:{address:{kind:'session',sessionId},throughSeq,...}}}", async () => {
    const client = makeClient();
    const res = await client.page({ address: { kind: "session", sessionId: "s1" }, throughSeq: -1, maxMessages: 50 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.hasMore).toBe(true);
      expect(res.value.records[1].type).toBe("chunks");
    }
    const seen = lastObserved();
    expect(seen.url).toBe("/api/session/page");
    expect((seen.body as { payload: unknown }).payload).toEqual({
      args: { request: { address: { kind: "session", sessionId: "s1" }, throughSeq: -1, maxMessages: 50 } },
    });
  });

  it("cancel 发送 {args:{request:{sessionId}}}", async () => {
    const client = makeClient();
    const res = await client.cancel({ sessionId: "s1" });
    expect(res.ok).toBe(true);
    const seen = lastObserved();
    expect(seen.url).toBe("/api/session/cancel");
    expect((seen.body as { payload: unknown }).payload).toEqual({ args: { request: { sessionId: "s1" } } });
  });

  it("每个请求都注入 Cookie header（来自注入的 cookieHeader）", async () => {
    const client = makeClient();
    await client.list();
    const seen = lastObserved();
    expect(seen.headers.cookie).toBe(FIXED_COOKIE);
  });

  it("DshCookieAuth 注入路径：请求携带自签 cookie（dsh-auth- 前缀 + v1.<body>.<sig> 三段）", async () => {
    const auth = new DshCookieAuth({
      baseUrl,
      readCredentialsFile: async () =>
        `records:\n  client-connection/browser-session:\n    payload:\n      secret: ${Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url")}\n`,
    });
    const client = new DshClient({ baseUrl, auth });
    await client.list();
    const cookie = lastObserved().headers.cookie;
    expect(typeof cookie).toBe("string");
    expect(cookie).toMatch(/^dsh-auth-[A-Za-z0-9_-]+=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("auth 读取失败（DshAuthError）明确传播，不静默吞", async () => {
    const client = new DshClient({
      baseUrl,
      cookieHeader: async () => {
        throw new DshAuthError("DSH 凭据不可读");
      },
    });
    await expect(client.list()).rejects.toBeInstanceOf(DshAuthError);
  });

  it("answerEvent 三态编码：next / result / rejected 走 $events/result", async () => {
    const client = makeClient();
    const res = await client.answerEvent("cid", "eid", { kind: "next" });
    expect(res.ok).toBe(true);
    expect(lastObserved().url).toBe("/api/$events/result");
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { clientId: "cid", eventId: "eid", outcome: { kind: "next" } },
    });

    await client.answerEvent("cid", "eid", { kind: "result", value: "allowed-once" });
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { clientId: "cid", eventId: "eid", outcome: { kind: "result", value: "allowed-once" } },
    });

    await client.answerEvent("cid", "eid", { kind: "rejected", error: { name: "E", message: "m", code: "c", details: { x: 1 } } });
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: {
        clientId: "cid",
        eventId: "eid",
        outcome: { kind: "rejected", error: { name: "E", message: "m", code: "c", details: { x: 1 } } },
      },
    });
  });

  it("openStream 是批 3 占位：调用即抛 StreamNotImplementedError", async () => {
    const client = makeClient();
    expect(() => client.openStream("session/follow", { request: {} })).toThrow(StreamNotImplementedError);
    // 显式 await 抛错（同步 throw 在 async 语义下仍为 rejected promise 的等价形式）
    await expect(Promise.resolve().then(() => client.openStream("$events", {}))).rejects.toBeInstanceOf(StreamNotImplementedError);
  });
});

describe("DshClient 错误路径", () => {
  it("响应 rpcId 不匹配时返回 internal 错误（信封回显校验）", async () => {
    const client = makeClient();
    const res = await client.call("echo/mismatch", {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal");
      expect(res.error.message).toContain("rpcId");
    }
  });

  it("非 JSON 响应返回 internal 错误", async () => {
    const client = makeClient();
    const res = await client.call("echo/malformed", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("internal");
  });

  it("信封格式非法（非 server-response）返回 internal 错误", async () => {
    const client = makeClient();
    const res = await client.call("echo/invalid-envelope", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("internal");
  });

  it("畸形错误结果归一化为 internal（code 非字符串）", async () => {
    const client = makeClient();
    const res = await client.call("echo/bad-error-shape", {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("internal");
  });

  it("业务错误原样透传（session/not-found 新错误码 + details）", async () => {
    const client = makeClient();
    const res = await client.call("echo/business-error", {});
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("session/not-found");
      expect(res.error.message).toBe("会话不存在");
      expect(res.error.details).toEqual({ sessionId: "x" });
    }
  });

  it("非 2xx 状态码抛 TransportFailure（HTTP 状态透出）", async () => {
    const client = makeClient();
    await expect(client.call("echo/500", {})).rejects.toBeInstanceOf(TransportFailure);
    const client404 = new DshClient({ baseUrl: `${baseUrl}/definitely-missing` });
    await expect(client404.list()).rejects.toBeInstanceOf(TransportFailure);
  });

  it("服务器中途断开连接时以 TransportFailure 拒绝而非永久挂起", async () => {
    const client = makeClient({ timeoutMs: 2000 });
    await expect(client.call("echo/hang", {})).rejects.toBeInstanceOf(TransportFailure);
  }, 5000);

  it("慢响应触发硬超时（TransportFailure）", async () => {
    const client = makeClient({ timeoutMs: 300 });
    await expect(client.call("echo/slow", {})).rejects.toBeInstanceOf(TransportFailure);
  }, 5000);

  it("postJson 保持向后兼容（无 headers 参数也可用）", async () => {
    const text = await postJson(`${baseUrl}/api/echo/ok`, JSON.stringify({ type: "client-request", rpcId: "r", method: "echo/ok", payload: { args: {} } }), 2000);
    expect(JSON.parse(text)).toMatchObject({ type: "server-response", rpcId: "r" });
  });
});

interface PromptRequestOnWire {
  requestId: string;
  sessionId: string;
  mode: string;
  content: unknown[];
}
