import { describe, expect, it } from "vitest";
import type { DshClient } from "../../src/transport/client";
import { RemoteStreamError } from "../../src/transport/muxStream";
import { SessionStore } from "../../src/core/store";
import { SessionManager } from "../../src/core/sessionManager";
import type { DshSettings } from "../../src/settings";
import type { SessionFollowFrame, SessionSummary } from "../../src/transport/types";

/** 可控 async 迭代器：手动 push 帧/异常/结束。 */
function makeStream<T>() {
  const queue: Array<{ kind: "value"; value: T } | { kind: "error"; error: unknown } | { kind: "done" }> = [];
  const waiters: Array<() => void> = [];
  let returned = false;
  const push = (value: T) => {
    queue.push({ kind: "value", value });
    for (const w of waiters.splice(0)) w();
  };
  const fail = (error: unknown) => {
    queue.push({ kind: "error", error });
    for (const w of waiters.splice(0)) w();
  };
  const end = () => {
    queue.push({ kind: "done" });
    for (const w of waiters.splice(0)) w();
  };
  const iterator: AsyncIterator<T> = {
    next: () =>
      new Promise<IteratorResult<T>>((resolve, reject) => {
        const take = () => {
          const item = queue.shift();
          if (!item) {
            waiters.push(take);
            return;
          }
          if (item.kind === "value") resolve({ done: false, value: item.value });
          else if (item.kind === "error") reject(item.error);
          else resolve({ done: true, value: undefined as never });
        };
        take();
      }),
    return: () => {
      returned = true;
      queue.length = 0;
      for (const w of waiters.splice(0)) w();
      return Promise.resolve({ done: true, value: undefined as never });
    },
  };
  const iterable: AsyncIterable<T> & AsyncIterator<T> = { ...iterator, [Symbol.asyncIterator]: () => iterator };
  return { push, fail, end, iterator: iterable, isReturned: () => returned };
}

function snapshot(overrides: Partial<Extract<SessionFollowFrame, { type: "snapshot" }>> = {}): Extract<SessionFollowFrame, { type: "snapshot" }> {
  return {
    type: "snapshot",
    header: { version: 1, id: "s1", createdAt: 1 },
    cursor: 9,
    records: [
      { type: "event", event: { type: "session/title", seq: 9, time: 9, data: { title: "标题", source: "fallback" } } },
      { type: "event", event: { type: "plan/mode", seq: 10, time: 10, data: { active: true, pending: false } } },
      { type: "event", event: { type: "user/message", seq: 11, time: 11, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } } },
    ],
    hasMore: true,
    projections: { asOfSeq: 10, values: { title: "投影标题" } },
    ...overrides,
  };
}

function eventFrame(seq: number): Extract<SessionFollowFrame, { type: "event" }> {
  return { type: "event", event: { type: "user/message", seq, time: seq, data: { id: `m${seq}`, role: "user", content: [{ type: "text", text: `live-${seq}` }], source: { kind: "user" } } } };
}

interface FakeClient {
  list: () => Promise<{ ok: true; value: { items: SessionSummary[] } }>;
  create: (payload: { cwd?: string }) => Promise<{ ok: true; value: { sessionId: string } }>;
  prompt: () => Promise<{ ok: true; value: { accepted: true } }>;
  cancel: () => Promise<{ ok: true; value: { accepted: true } }>;
  page: (payload: unknown) => Promise<{ ok: true; value: { records: unknown[]; hasMore: boolean } }>;
  openStream: (endpoint: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<AsyncIterable<unknown>>;
}

function makeManager(fake: Partial<FakeClient> = {}, settingsOverride: Partial<DshSettings> = {}, vaultPath = "C:\\vault") {
  const client = {
    list: async () => ({
      ok: true as const,
      value: { items: [] as SessionSummary[] },
    }),
    create: async () => ({ ok: true as const, value: { sessionId: "new-1" } }),
    prompt: async () => ({ ok: true as const, value: { accepted: true as const } }),
    cancel: async () => ({ ok: true as const, value: { accepted: true as const } }),
    page: async () => ({ ok: true as const, value: { records: [] as unknown[], hasMore: false } }),
    openStream: async <T>() => makeStream<T>().iterator as unknown as AsyncIterable<T>,
    ...fake,
  } as unknown as DshClient;
  const store = new SessionStore();
  const settings = { values: { historyPageSize: 50, ...settingsOverride } } as unknown as DshSettings;
  return { client, store, manager: new SessionManager({ client, store, vaultPath, settings, t: (key) => key }) };
}

describe("SessionManager 批4a-3（follow 驱动）", () => {
  it("refresh 拉取列表且 vault 绑定会话置顶", async () => {
    const { manager } = makeManager({
      list: async () => ({
        ok: true,
        value: {
          items: [
            { sessionId: "remote-1", updatedAt: 3, running: false, blank: false, cwd: "C:\\elsewhere" },
            { sessionId: "vault-1", updatedAt: 2, running: true, blank: false, cwd: "C:\\vault" },
            { sessionId: "vault-2", updatedAt: 1, running: false, blank: true, cwd: "C:\\vault" },
          ],
        },
      }),
    });
    await manager.refresh();
    expect(manager.sessions.map((s) => s.sessionId)).toEqual(["vault-1", "vault-2", "remote-1"]);
  });

  it("vault 绑定在 unix 风格路径下也生效", async () => {
    const { manager } = makeManager({
      list: async () => ({
        ok: true,
        value: {
          items: [
            { sessionId: "u1", updatedAt: 1, running: false, blank: false, cwd: "/home/user/vault" },
            { sessionId: "u2", updatedAt: 2, running: false, blank: false, cwd: "/home/user/vault/notes" },
            { sessionId: "u3", updatedAt: 3, running: false, blank: false, cwd: "/home/user/other" },
            { sessionId: "u4", updatedAt: 4, running: false, blank: false, cwd: "/home/user/vault2" },
          ],
        },
      }),
    }, {}, "/home/user/vault");
    await manager.refresh();
    expect(manager.sessions.map((s) => s.sessionId)).toEqual(["u2", "u1", "u4", "u3"]);
  });

  it("newSession 以 vault 为 cwd 创建并返回 id", async () => {
    const created: unknown[] = [];
    const { manager } = makeManager({ create: async (payload) => { created.push(payload); return { ok: true, value: { sessionId: "new-1" } }; } });
    const id = await manager.newSession();
    expect(id).toBe("new-1");
    expect(created[0]).toMatchObject({ cwd: "C:\\vault" });
  });

  it("openSession：follow 首帧 snapshot 播种（含 chunkrow 展开 + projections）并设为当前会话；后续 event 帧折叠", async () => {
    const stream = makeStream<SessionFollowFrame>();
    const { manager, store } = makeManager({ openStream: async () => stream.iterator });
    const p = manager.openSession("vault-1");
    stream.push(
      snapshot({
        records: [
          {
            type: "chunks",
            event: { type: "chunkrow/text-chunks", seq: 5, time: 100, data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["A", "B"] } },
          },
          { type: "event", event: { type: "user/message", seq: 11, time: 11, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } } },
        ],
        projections: { asOfSeq: 11, values: { title: "快照标题", plan: { active: true, pending: false } } },
      })
    );
    await p;
    expect(manager.currentId).toBe("vault-1");
    const view = store.ensureView("vault-1");
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", text: "AB" });
    expect(view.title).toBe("快照标题");
    expect(view.plan).toEqual({ active: true, pending: false });
    // 后续 event 帧
    stream.push(eventFrame(12));
    await new Promise((r) => setTimeout(r, 20));
    expect(store.ensureView("vault-1").nodes[2]).toMatchObject({ kind: "user", text: "live-12" });
    expect(manager.currentId).toBe("vault-1");
  });

  it("openSession 首帧非 snapshot（协议违约）→ 抛错且不设 currentId", async () => {
    const stream = makeStream<SessionFollowFrame>();
    const { manager } = makeManager({ openStream: async () => stream.iterator });
    const p = manager.openSession("vault-1");
    stream.push(eventFrame(1));
    await expect(p).rejects.toThrow(/snapshot/);
    expect(manager.currentId).toBeUndefined();
  });

  it("openSession 竞态：后一次切换使前一代播种被放弃", async () => {
    const streamA = makeStream<SessionFollowFrame>();
    const streamB = makeStream<SessionFollowFrame>();
    const opened: string[] = [];
    const { manager } = makeManager({
      openStream: async <T>(_endpoint: string, args?: Record<string, unknown>) => {
        const request = (args as { request: { address: { sessionId: string } } }).request;
        opened.push(request.address.sessionId);
        const target = request.address.sessionId === "a" ? streamA : streamB;
        return target.iterator as unknown as AsyncIterable<T>;
      },
    });
    const pa = manager.openSession("a");
    const pb = manager.openSession("b");
    streamB.push(snapshot({ header: { version: 1, id: "b", createdAt: 1 } }));
    await pb;
    streamA.push(snapshot({ header: { version: 1, id: "a", createdAt: 1 } }));
    await pa; // 旧代被 epoch 守卫放弃：不播种、不覆盖 currentId
    expect(manager.currentId).toBe("b");
  });

  it("切换会话 abort 旧 follow", async () => {
    const streamA = makeStream<SessionFollowFrame>();
    const streamB = makeStream<SessionFollowFrame>();
    const signals: AbortSignal[] = [];
    const { manager } = makeManager({
      openStream: async <T>(_endpoint: string, args?: Record<string, unknown>, signal?: AbortSignal) => {
        signals.push(signal as AbortSignal);
        const request = (args as { request: { address: { sessionId: string } } }).request;
        return (request.address.sessionId === "a" ? streamA : streamB).iterator as unknown as AsyncIterable<T>;
      },
    });
    const pa = manager.openSession("a");
    streamA.push(snapshot({ header: { version: 1, id: "a", createdAt: 1 } }));
    await pa;
    const pb = manager.openSession("b");
    streamB.push(snapshot({ header: { version: 1, id: "b", createdAt: 1 } }));
    await pb;
    expect(signals[0]?.aborted).toBe(true); // a 的 follow 已被 abort
    expect(signals[1]?.aborted).toBe(false);
  });

  it("follow 迭代异常（断线）→ 静默清理句柄，不抛给调用方", async () => {
    const stream = makeStream<SessionFollowFrame>();
    const { manager } = makeManager({ openStream: async () => stream.iterator });
    const p = manager.openSession("vault-1");
    stream.push(snapshot());
    await p;
    stream.fail(new Error("carrier lost"));
    await new Promise((r) => setTimeout(r, 20));
    // 不抛、视图仍在（播种完成）
    expect(manager.currentId).toBe("vault-1");
  });

  it("loadOlder：page args 精确断言 + 展开后前插 + 返回 hasMore", async () => {
    const pages: unknown[] = [];
    const openStream = makeStream<SessionFollowFrame>();
    const { manager, store } = makeManager({
      openStream: async () => openStream.iterator,
      page: async (payload) => {
        pages.push(payload);
        return {
          ok: true,
          value: {
            records: [
              {
                type: "chunks",
                event: { type: "chunkrow/reasoning-chunks", seq: 1, time: 50, data: { turn: 1, step: 1, index: 0, dt: [2], texts: ["思", "考"] } },
              },
            ],
            hasMore: false,
          },
        };
      },
    });
    const p = manager.openSession("vault-1");
    openStream.push(snapshot({ records: [{ type: "event", event: { type: "user/message", seq: 11, time: 11, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } } }] }));
    await p;
    const hadMore = await manager.loadOlder("vault-1");
    expect(hadMore).toBe(false);
    expect(pages[0]).toMatchObject({
      address: { kind: "session", sessionId: "vault-1" },
      throughSeq: 11, // = view.lastSeq（snapshot 折叠后）
      beforeSeq: 11, // = view.firstSeq（snapshot 只有 seq 11 一条）
      maxMessages: 50,
    });
    const nodes = store.ensureView("vault-1").nodes;
    expect(nodes[0]).toMatchObject({ kind: "assistant", reasoning: "思考" }); // reasoning-delta 折叠进 reasoning
  });

  it("exists：snapshot → true；session/not-found → false", async () => {
    const okStream = makeStream<SessionFollowFrame>();
    okStream.push(snapshot({ header: { version: 1, id: "x", createdAt: 1 } }));
    const missingStream = makeStream<SessionFollowFrame>();
    missingStream.fail(new RemoteStreamError("session/not-found", 'session "x" not found', { sessionId: "x" }));
    let round = 0;
    const { manager } = makeManager({
      openStream: async () => {
        round++;
        return (round === 1 ? okStream : missingStream).iterator;
      },
    });
    expect(await manager.exists("x")).toBe(true);
    expect(await manager.exists("x")).toBe(false);
  });

  it("exists：transport 错误 → false（触发重建）", async () => {
    const stream = makeStream<SessionFollowFrame>();
    stream.fail(new Error("carrier lost"));
    const { manager } = makeManager({ openStream: async () => stream.iterator });
    expect(await manager.exists("x")).toBe(false);
  });

  it("resyncSession：重开 follow 且不改 currentId", async () => {
    const streamA = makeStream<SessionFollowFrame>();
    const streamB = makeStream<SessionFollowFrame>();
    let round = 0;
    const { manager, store } = makeManager({
      openStream: async () => {
        round++;
        return (round === 1 ? streamA : streamB).iterator;
      },
    });
    const p = manager.openSession("vault-1");
    streamA.push(snapshot());
    await p;
    expect(manager.currentId).toBe("vault-1");
    const pr = manager.resyncSession("vault-1");
    streamB.push(snapshot({ projections: { asOfSeq: 12, values: { title: "重连标题" } } }));
    await pr;
    expect(manager.currentId).toBe("vault-1"); // 不改变
    expect(store.getView("vault-1")?.title).toBe("重连标题");
  });

  it("prompt/cancel 转发到 client", async () => {
    const { manager } = makeManager();
    const res = await manager.prompt("s", "你好", "queue");
    expect(res.ok).toBe(true);
    const cancel = await manager.cancel("s");
    expect(cancel.ok).toBe(true);
  });
});
