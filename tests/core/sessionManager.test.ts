import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import { DshClient } from "../../src/transport/client";
import { SessionStore } from "../../src/core/store";
import { SessionManager } from "../../src/core/sessionManager";
import type { DshSettings } from "../../src/settings";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rpcId: string; method: string; payload: Record<string, unknown> };
      const url = req.url ?? "";
      let value: unknown = {};
      if (url === "/api/session.list") {
        value = {
          items: [
            { sessionId: "remote-1", updatedAt: 3, running: false, blank: false, cwd: "C:\\elsewhere" },
            { sessionId: "vault-1", updatedAt: 2, running: true, blank: false, cwd: "C:\\vault" },
            { sessionId: "vault-2", updatedAt: 1, running: false, blank: true, cwd: "C:\\vault" },
          ],
        };
      } else if (url === "/api/session.create") {
        value = { sessionId: "new-1" };
      } else if (url === "/api/session.history") {
        const p = body.payload as { beforeSeq?: number };
        if (p.beforeSeq === 9) {
          value = {
            events: [{ event: { type: "user/message", seq: 4, time: 4, data: { id: "m0", role: "user", content: [{ type: "text", text: "更早的消息" }], source: { kind: "user" } } } }],
            hasMore: false,
          };
        } else {
          value = {
            events: [
              { event: { type: "session/title", seq: 9, time: 9, data: { title: "标题", source: "fallback" } } },
              { event: { type: "user/message", seq: 10, time: 10, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } } },
            ],
            hasMore: true,
            projections: { asOfSeq: 10, values: { title: "标题", plan: { active: true, pending: false } } },
          };
        }
      } else if (url === "/api/session.prompt") {
        value = { accepted: true };
      } else if (url === "/api/session.cancel") {
        value = { accepted: true };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function makeManager() {
  const client = new DshClient({ baseUrl });
  const store = new SessionStore();
  const settings = { values: { historyPageSize: 50 } } as unknown as DshSettings;
  return { client, store, manager: new SessionManager({ client, store, vaultPath: "C:\\vault", settings }) };
}

describe("SessionManager", () => {
  it("refresh 拉取列表且 vault 绑定会话置顶", async () => {
    const { manager } = makeManager();
    await manager.refresh();
    expect(manager.sessions.map((s) => s.sessionId)).toEqual(["vault-1", "vault-2", "remote-1"]);
  });

  it("newSession 以 vault 为 cwd 创建并返回 id", async () => {
    const { manager } = makeManager();
    const id = await manager.newSession();
    expect(id).toBe("new-1");
  });

  it("openSession 播种历史并设为当前会话", async () => {
    const { manager, store } = makeManager();
    await manager.openSession("vault-1");
    expect(manager.currentId).toBe("vault-1");
    const view = store.ensureView("vault-1");
    expect(view.title).toBe("标题");
    expect(view.plan).toEqual({ active: true, pending: false });
  });

  it("loadOlder 用最早 seq 翻页并前插", async () => {
    const { manager, store } = makeManager();
    await manager.openSession("vault-1");
    const hadMore = await manager.loadOlder("vault-1");
    expect(hadMore).toBe(false);
    expect(store.ensureView("vault-1").nodes[0]).toMatchObject({ text: "更早的消息" });
  });

  it("loadOlder 翻页不破坏 running/plan 状态", async () => {
    const { manager, store } = makeManager();
    await manager.openSession("vault-1");
    const before = store.ensureView("vault-1");
    before.running = false;
    await manager.loadOlder("vault-1");
    const view = store.ensureView("vault-1");
    expect(view.nodes.map((n) => (n.kind === "user" ? n.text : ""))).toEqual(["更早的消息", "hi"]);
    expect(view.running).toBe(false);
    expect(view.plan.active).toBe(true);
    expect(view.firstSeq).toBe(4);
  });

  it("prompt/cancel 转发到 client", async () => {
    const { manager } = makeManager();
    const res = await manager.prompt("s", "你好", "queue");
    expect(res.ok).toBe(true);
    const cancel = await manager.cancel("s");
    expect(cancel.ok).toBe(true);
  });
});
