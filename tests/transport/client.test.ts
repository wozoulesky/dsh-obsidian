import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import { DshClient, TransportFailure } from "../../src/transport/client";

let server: Server;
let baseUrl: string;
let lastBody: unknown;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        lastBody = null;
      }
      const url = req.url ?? "";
      if (url.startsWith("/api/session.prompt")) {
        const b = lastBody as { rpcId: string; method: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: b.rpcId, result: { ok: true, value: { accepted: true } } }));
      } else if (url === "/api/respond") {
        if ((lastBody as any)?.result?.value?.badReceipt === true) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("not-json");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ accepted: true }));
        }
      } else if (url === "/api/session.create") {
        const b = lastBody as { rpcId: string; payload: { cwd?: string; forceMismatch?: boolean } };
        const echoId = b.payload?.forceMismatch === true ? "other-id" : b.rpcId;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: echoId, result: { ok: true, value: { sessionId: "sess-1" } } }));
      } else if (url === "/api/session.list") {
        const b = lastBody as { rpcId: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: b.rpcId, result: { ok: true, value: { items: [] } } }));
      } else if (url === "/api/hang") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"type":"server-response","rpcId":"x","result":{"ok":true');
        setTimeout(() => res.socket?.destroy(), 50);
      } else if (url === "/api/bad-receipt") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("not-json");
      } else if (url === "/api/session.history") {
        const b = lastBody as { rpcId: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: b.rpcId, result: { ok: false, error: { code: "session-not-found", message: "会话不存在", details: { sessionId: "x" } } } }));
      } else if (url === "/api/slow") {
        const b = lastBody as { rpcId: string };
        setTimeout(() => {
          if (res.destroyed) return;
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ type: "server-response", rpcId: b.rpcId, result: { ok: true, value: { items: [] } } }));
        }, 5000);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("DshClient", () => {
  it("prompt 发送正确信封并解析成功响应", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.prompt({ sessionId: "s", mode: "queue", content: [{ type: "text", text: "你好" }] });
    expect(res.ok).toBe(true);
    expect(lastBody).toMatchObject({ type: "client-request", method: "session.prompt" });
  });

  it("create 透传 cwd 载荷", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.create({ cwd: "C:\\vault" });
    expect(res.ok && res.value.sessionId).toBe("sess-1");
    expect(lastBody).toMatchObject({ payload: { cwd: "C:\\vault" } });
  });

  it("响应 rpcId 不匹配时返回 internal 错误", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.call("session.create", { forceMismatch: true }, { forceRpcId: "mine" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal");
      expect(res.error.message).toContain("rpcId");
    }
  });

  it("非 2xx 状态码抛 transportFailure", async () => {
    const client = new DshClient({ baseUrl: `${baseUrl}/definitely-missing` });
    await expect(client.list()).rejects.toBeInstanceOf(TransportFailure);
  });

  it("respond 使用 client-response 信封并回传回执", async () => {
    const client = new DshClient({ baseUrl });
    const receipt = await client.respond("rpc-x", { sessionId: "s", approvalId: "a", outcome: "allowed-once" });
    expect(receipt.accepted).toBe(true);
    expect(lastBody).toMatchObject({
      type: "client-response",
      rpcId: "rpc-x",
      result: { ok: true, value: { outcome: "allowed-once" } },
    });
  });

  it("list 包装器使用 session.list 方法", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.list();
    expect(res.ok).toBe(true);
    expect(lastBody).toMatchObject({ method: "session.list" });
  });

  it("业务错误原样透传（ok:false + error）", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.call("session.history", { sessionId: "x" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("session-not-found");
      expect(res.error.message).toBe("会话不存在");
    }
  });

  it("服务器中途断开连接时以 TransportFailure 拒绝而非永久挂起", async () => {
    const client = new DshClient({ baseUrl, timeoutMs: 2000 });
    await expect(client.call("hang", {})).rejects.toBeInstanceOf(TransportFailure);
  }, 5000);

  it("respond 收到非法 JSON 回执时返回 bad-response", async () => {
    const client = new DshClient({ baseUrl });
    const receipt = await client.respond("rpc-x", { badReceipt: true });
    expect(receipt.accepted).toBe(false);
  });

  it("慢响应触发硬超时", async () => {
    const client = new DshClient({ baseUrl: `${baseUrl}`, timeoutMs: 300 });
    await expect(client.call("slow", {})).rejects.toBeInstanceOf(TransportFailure);
  }, 5000);
});
