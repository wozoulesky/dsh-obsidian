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
 * - openStream（批 3）：注入假物理层断言端点/args 透传与帧迭代
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "http";
import { DshClient, postJson, TransportFailure } from "../../src/transport/client";
import { DshAuthError, DshCookieAuth } from "../../src/transport/auth";
import { RemoteMuxTransport } from "../../src/transport/muxStream";

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
      // ---- TASK-030 新增端点（真机 args 形状见 tmp/probe-task030.notes.md） ----
      else if (url === "/api/session/modelCatalog") {
        const args = b?.payload?.args as Record<string, unknown> | undefined;
        // 描述符**没有参数**：任何多余键都是 arguments-invalid（真机反例实测）
        if (args === undefined || Object.keys(args).length > 0) {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "gateway/arguments-invalid", message: `unexpected ${Object.keys(args ?? {}).join(",")}` } },
          });
          return;
        }
        sendJson(res, 200, {
          type: "server-response",
          rpcId: b?.rpcId,
          result: {
            ok: true,
            value: {
              default: { provider: "p1", model: "m1", reasoningEffort: "high" },
              routableProviders: ["p1"],
              groups: [{ id: "p1", name: "Provider 1", models: [{ id: "m1", name: "Model 1", reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" } }] }],
              failures: [],
            },
          },
        });
      } else if (url === "/api/session/selectModel") {
        const args = b?.payload?.args as { request?: { sessionId?: string; provider?: string; model?: string; reasoningEffort?: string } } | undefined;
        if (typeof args?.request?.sessionId !== "string" || typeof args.request.provider !== "string" || typeof args.request.model !== "string") {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "gateway/arguments-invalid", message: "request 非法" } },
          });
          return;
        }
        sendJson(res, 200, {
          type: "server-response",
          rpcId: b?.rpcId,
          result: { ok: true, value: { selected: { provider: args.request.provider, model: args.request.model, ...(args.request.reasoningEffort === undefined ? {} : { reasoningEffort: args.request.reasoningEffort }) } } },
        });
      } else if (url === "/api/session/attachment") {
        const args = b?.payload?.args as { request?: { sessionId?: string; attachmentId?: string } } | undefined;
        if (typeof args?.request?.attachmentId !== "string") {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "session/attachment-invalid", message: "Image is not referenced by this session.", details: { reason: "ATTACHMENT_NOT_REFERENCED" } } },
          });
          return;
        }
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, value: { attachment: { id: args.request.attachmentId }, data: "QUJD" } } });
      } else if (url === "/api/commands/list") {
        const args = b?.payload?.args as Record<string, unknown> | undefined;
        // 平铺 {agentId}：包裹或漏字段一律 arguments-invalid（真机反例实测）
        if (typeof args?.agentId !== "string" || "request" in (args ?? {})) {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "gateway/arguments-invalid", message: `missing "agentId"; unexpected ${Object.keys(args ?? {}).join(",")}` } },
          });
          return;
        }
        sendJson(res, 200, {
          type: "server-response",
          rpcId: b?.rpcId,
          result: { ok: true, value: [{ name: "compact", description: "Compact older conversation history" }, { name: "goal", description: "set or view the goal", input: { hint: "[<objective>]", attachments: true } }] },
        });
      } else if (url === "/api/commands/execute") {
        const args = b?.payload?.args as Record<string, unknown> | undefined;
        if (typeof args?.agentId !== "string" || typeof args.line !== "string" || !Array.isArray(args.submittedAttachments) || "request" in (args ?? {})) {
          sendJson(res, 200, {
            type: "server-response",
            rpcId: b?.rpcId,
            result: { ok: false, error: { code: "gateway/arguments-invalid", message: 'missing "agentId", "line", "submittedAttachments"' } },
          });
          return;
        }
        // 未注册命令 → host 返回 undefined（真机实测）；/goal 命中 → 返回执行结果
        const value = args.line === "/goal" ? { commandId: "cmd-1", result: { kind: "error", text: "/goal 需要参数" } } : undefined;
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, ...(value === undefined ? {} : { value }) } });
      } else if (url === "/api/goals/get") {
        const args = b?.payload?.args as Record<string, unknown> | undefined;
        if (typeof args?.agentId !== "string" || "request" in (args ?? {})) {
          sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: false, error: { code: "gateway/arguments-invalid", message: 'missing "agentId"' } } });
          return;
        }
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true } }); // 无目标：value 缺省
      } else if (url === "/api/goals/create" || url === "/api/goals/edit" || url === "/api/goals/pause" || url === "/api/goals/resume" || url === "/api/goals/complete" || url === "/api/goals/clear") {
        const args = b?.payload?.args as Record<string, unknown> | undefined;
        if (typeof args?.agentId !== "string" || "request" in (args ?? {})) {
          sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: false, error: { code: "gateway/arguments-invalid", message: 'missing "agentId"' } } });
          return;
        }
        sendJson(res, 200, { type: "server-response", rpcId: b?.rpcId, result: { ok: true, value: { id: "g1", revision: 2, objective: "完成 X", phase: "active", maxGoalRounds: 12, roundsStarted: 0, createdAt: 1, updatedAt: 2, activation: "armed" } } });
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

  /* ---- TASK-030 新增端点：args 形状逐字对齐真机探测（tmp/probe-task030.notes.md） ---- */

  it("modelCatalog 发送空 args（描述符无参数；带 request 会被网关拒绝）", async () => {
    const client = makeClient();
    const res = await client.modelCatalog();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.default).toEqual({ provider: "p1", model: "m1", reasoningEffort: "high" });
      expect(res.value.groups[0].models[0].reasoning?.efforts.map((e) => e.id)).toEqual(["high"]);
    }
    const seen = lastObserved();
    expect(seen.url).toBe("/api/session/modelCatalog");
    expect((seen.body as { payload: unknown }).payload).toEqual({ args: {} });
  });

  it("selectModel 发送 {args:{request:{sessionId,provider,model,reasoningEffort?}}}（无档位时不下发该键）", async () => {
    const client = makeClient();
    await client.selectModel({ sessionId: "s1", provider: "p1", model: "m1" });
    expect(lastObserved().url).toBe("/api/session/selectModel");
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { request: { sessionId: "s1", provider: "p1", model: "m1" } },
    });

    const res = await client.selectModel({ sessionId: "s1", provider: "p1", model: "m1", reasoningEffort: "max" });
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { request: { sessionId: "s1", provider: "p1", model: "m1", reasoningEffort: "max" } },
    });
    expect(res.ok && res.value.selected.reasoningEffort).toBe("max");
  });

  it("attachment 发送 {args:{request:{sessionId,attachmentId}}} 并透传领域错误", async () => {
    const client = makeClient();
    const ok = await client.attachment({ sessionId: "s1", attachmentId: "att-1" });
    expect(lastObserved().url).toBe("/api/session/attachment");
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { request: { sessionId: "s1", attachmentId: "att-1" } },
    });
    expect(ok.ok && ok.value.data).toBe("QUJD");
  });

  it("listCommands 的 args 是**平铺** {agentId}（不包裹 request）", async () => {
    const client = makeClient();
    const res = await client.listCommands("sess-1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.map((c) => c.name)).toEqual(["compact", "goal"]);
      expect(res.value[1].input?.attachments).toBe(true);
    }
    const seen = lastObserved();
    expect(seen.url).toBe("/api/commands/list");
    expect((seen.body as { payload: unknown }).payload).toEqual({ args: { agentId: "sess-1" } });
  });

  it("executeCommand 的 args 平铺且三键齐全；未命中命令时 value 缺省（undefined）", async () => {
    const client = makeClient();
    const miss = await client.executeCommand("sess-1", "/__no_such__", []);
    const seen = lastObserved();
    expect(seen.url).toBe("/api/commands/execute");
    expect((seen.body as { payload: unknown }).payload).toEqual({
      args: { agentId: "sess-1", line: "/__no_such__", submittedAttachments: [] },
    });
    expect(miss.ok && miss.value).toBeUndefined(); // 回退为普通 prompt 的信号

    const hit = await client.executeCommand("sess-1", "/goal", [{ type: "image", mediaType: "image/png", data: "AAAA", name: "a.png" }]);
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { agentId: "sess-1", line: "/goal", submittedAttachments: [{ type: "image", mediaType: "image/png", data: "AAAA", name: "a.png" }] },
    });
    expect(hit.ok && hit.value?.result.kind).toBe("error");
  });

  it("goals/* 参数平铺：get 只带 agentId；create 带 request；pause/resume/complete/clear 带 ref", async () => {
    const client = makeClient();
    await client.goalGet("sess-1");
    expect(lastObserved().url).toBe("/api/goals/get");
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({ args: { agentId: "sess-1" } });

    await client.goalCreate("sess-1", { objective: "完成 TASK-030" });
    expect(lastObserved().url).toBe("/api/goals/create");
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { agentId: "sess-1", request: { objective: "完成 TASK-030" } },
    });

    const ref = { id: "g1", revision: 3 };
    await client.goalEdit("sess-1", ref, { objective: "改目标" });
    expect((lastObserved().body as { payload: unknown }).payload).toEqual({
      args: { agentId: "sess-1", ref, request: { objective: "改目标" } },
    });

    for (const [method, call] of [
      ["pause", () => client.goalPause("sess-1", ref)],
      ["resume", () => client.goalResume("sess-1", ref)],
      ["complete", () => client.goalComplete("sess-1", ref)],
      ["clear", () => client.goalClear("sess-1", ref)],
    ] as const) {
      await call();
      expect(lastObserved().url).toBe(`/api/goals/${method}`);
      expect((lastObserved().body as { payload: unknown }).payload).toEqual({ args: { agentId: "sess-1", ref } });
    }
  });

  it("goals/get 无目标时 value 缺省 → ok 且值为 undefined（不是错误）", async () => {
    const client = makeClient();
    const res = await client.goalGet("sess-1");
    expect(res.ok).toBe(true);
    expect(res.ok && res.value).toBeUndefined();
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

  it("openStream 委托注入的物理层：端点/args 透传 + 帧迭代（批 3）", async () => {
    const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
    const fake = {
      open<T>(endpoint: string, args: Record<string, unknown>): AsyncIterable<T> {
        calls.push({ endpoint, args });
        return (async function* () {
          yield { type: "snapshot" } as T;
          yield { type: "event" } as T;
        })();
      },
      start: () => {},
      stop: () => {},
      get state() {
        return null;
      },
    } as unknown as RemoteMuxTransport;
    const client = new DshClient({ baseUrl, cookieHeader: () => Promise.resolve(FIXED_COOKIE), streamTransport: fake });
    const stream = await client.openStream<{ type: string }>("session/follow", {
      request: { address: { kind: "session", sessionId: "s1" }, maxMessages: 10 },
    });
    const frames: Array<{ type: string }> = [];
    for await (const frame of stream) frames.push(frame);
    expect(calls).toEqual([
      { endpoint: "session/follow", args: { request: { address: { kind: "session", sessionId: "s1" }, maxMessages: 10 } } },
    ]);
    expect(frames).toEqual([{ type: "snapshot" }, { type: "event" }]);
  });

  it("openStream $events 端点 args 恒为空对象（网关精确要求 args:{}）", async () => {
    const calls: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
    const fake = {
      open<T>(endpoint: string, args: Record<string, unknown>): AsyncIterable<T> {
        calls.push({ endpoint, args });
        return (async function* () {
          yield { type: "ready", clientId: "cid-1" } as T;
        })();
      },
      start: () => {},
      stop: () => {},
      get state() {
        return null;
      },
    } as unknown as RemoteMuxTransport;
    const client = new DshClient({ baseUrl, cookieHeader: () => Promise.resolve(FIXED_COOKIE), streamTransport: fake });
    const stream = await client.openStream<{ type: string; clientId?: string }>("$events", {});
    const frames: Array<{ type: string; clientId?: string }> = [];
    for await (const frame of stream) frames.push(frame);
    expect(calls).toEqual([{ endpoint: "$events", args: {} }]);
    expect(frames[0]).toEqual({ type: "ready", clientId: "cid-1" });
  });

  it("默认物理层（未注入）时 client.mux 可用且 muxUrl 指向 ws://.../api/remote.mux", () => {
    const client = makeClient();
    expect(client.mux.muxUrl()).toBe(`${baseUrl.replace(/^http/u, "ws")}/api/remote.mux`);
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
