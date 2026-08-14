import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage } from "http";
import { DshClient, transportFailure } from "../../src/transport/client";

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
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      } else if (url === "/api/session.create") {
        const b = lastBody as { rpcId: string; payload: { cwd?: string; forceMismatch?: boolean } };
        const echoId = b.payload?.forceMismatch === true ? "other-id" : b.rpcId;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: echoId, result: { ok: true, value: { sessionId: "sess-1" } } }));
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
    await expect(client.list()).rejects.toBeInstanceOf(transportFailure);
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
});
