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
  prompt: (payload?: unknown) => Promise<{ ok: true; value: { accepted: true } }>;
  cancel: () => Promise<{ ok: true; value: { accepted: true } }>;
  page: (payload: unknown) => Promise<{ ok: true; value: { records: unknown[]; hasMore: boolean } }>;
  openStream: (endpoint: string, args?: Record<string, unknown>, signal?: AbortSignal) => Promise<AsyncIterable<unknown>>;
  /**
   * TASK-030 新增端点：参数与返回值都按需覆写。
   * 形参用 `never[]`（参数逆变下最宽松：任何具体签名都可赋值给它），未覆写时调用即抛错。
   */
  listCommands: (...args: never[]) => Promise<FakeResult>;
  executeCommand: (...args: never[]) => Promise<FakeResult>;
  selectModel: (...args: never[]) => Promise<FakeResult>;
  goalGet: (...args: never[]) => Promise<FakeResult>;
  goalCreate: (...args: never[]) => Promise<FakeResult>;
  goalEdit: (...args: never[]) => Promise<FakeResult>;
  goalPause: (...args: never[]) => Promise<FakeResult>;
  goalResume: (...args: never[]) => Promise<FakeResult>;
  goalComplete: (...args: never[]) => Promise<FakeResult>;
  goalClear: (...args: never[]) => Promise<FakeResult>;
}

/** 假客户端的宽松结果（成功/失败两种形态，字段按测试需要而定）。 */
type FakeResult = { ok: true; value?: unknown } | { ok: false; error: { code: string; message: string } };

/** 未被测试覆写的新端点：调用即失败（避免"忘了覆写"被静默通过）。 */
function notStubbed(name: string): never {
  throw new Error(`测试未覆写 ${name}`);
}

function makeManager(
  fake: Partial<FakeClient> = {},
  settingsOverride: Partial<DshSettings> = {},
  vaultPath = "C:\\vault",
  extraDeps: { onInterruptedTurnDropped?: (sessionId: string) => void } = {}
) {
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
    listCommands: async () => notStubbed("listCommands"),
    executeCommand: async () => notStubbed("executeCommand"),
    selectModel: async () => notStubbed("selectModel"),
    goalGet: async () => notStubbed("goalGet"),
    goalCreate: async () => notStubbed("goalCreate"),
    goalEdit: async () => notStubbed("goalEdit"),
    goalPause: async () => notStubbed("goalPause"),
    goalResume: async () => notStubbed("goalResume"),
    goalComplete: async () => notStubbed("goalComplete"),
    goalClear: async () => notStubbed("goalClear"),
    ...fake,
  } as unknown as DshClient;
  const store = new SessionStore();
  const settings = { values: { historyPageSize: 50, ...settingsOverride } } as unknown as DshSettings;
  return {
    client,
    store,
    manager: new SessionManager({
      client,
      store,
      vaultPath,
      settings,
      t: (key) => key,
      ...(extraDeps.onInterruptedTurnDropped ? { onInterruptedTurnDropped: extraDeps.onInterruptedTurnDropped } : {}),
    }),
  };
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

  it("sessionTitle：store 视图标题优先于 list 投影（线上 list 无 title）", async () => {
    const stream = makeStream<SessionFollowFrame>();
    const { manager, store } = makeManager({ openStream: async () => stream.iterator });
    const p = manager.openSession("vault-1");
    stream.push(snapshot({ projections: { asOfSeq: 10, values: { title: "视图标题" } } }));
    await p;
    expect(manager.sessionTitle("vault-1")).toBe("视图标题");
    // 未打开会话回退 list 投影（如有）
    expect(store.getView("vault-1")?.title).toBe("视图标题");
  });

  it("prompt/cancel 转发到 client", async () => {
    const { manager } = makeManager();
    const res = await manager.prompt("s", "你好", "queue");
    expect(res.ok).toBe(true);
    const cancel = await manager.cancel("s");
    expect(cancel.ok).toBe(true);
  });
});

describe("SessionManager 会话索引（TASK-028 项 2）", () => {
  const listWith = (items: SessionSummary[]): Partial<FakeClient> => ({
    list: async () => ({ ok: true as const, value: { items } }),
  });

  const summary = (sessionId: string, updatedAt: number, title?: string, cwd = "C:\\vault"): SessionSummary => ({
    sessionId,
    updatedAt,
    running: false,
    blank: false,
    cwd,
    ...(title === undefined ? {} : { projections: { asOfSeq: updatedAt, values: { title } } }),
  });

  it("sessionTitle 命中索引：未打开会话也能拿到 list 摘要里的标题（不落到占位标题）", async () => {
    const { manager } = makeManager(listWith([summary("s1", 3, "列表标题-s1"), summary("s2", 2, "列表标题-s2")]));
    await manager.refresh();
    expect(manager.sessionTitle("s1")).toBe("列表标题-s1");
    expect(manager.sessionTitle("s2")).toBe("列表标题-s2");
    expect(manager.sessionTitle("nope")).toBe("chat.sessionFallback"); // 未命中 → 本地化回退键
  });

  it("refresh 重建索引：标题改名立即生效，被下线的会话不再命中（无陈旧条目）", async () => {
    const items: SessionSummary[] = [summary("s1", 3, "旧标题"), summary("s2", 2, "二号")];
    const { manager } = makeManager({ list: async () => ({ ok: true, value: { items } }) });
    await manager.refresh();
    expect(manager.sessionTitle("s1")).toBe("旧标题");

    items.length = 0;
    items.push(summary("s1", 9, "新标题"), summary("s3", 1, "三号"));
    await manager.refresh();
    expect(manager.sessionTitle("s1")).toBe("新标题"); // 索引里的摘要已换成新的
    expect(manager.sessionTitle("s3")).toBe("三号");
    expect(manager.sessionTitle("s2")).toBe("chat.sessionFallback"); // s2 已不在列表 → 无陈旧命中
  });

  it("索引与列表同源：sessions 只读且顺序不变（vault 绑定置顶）", async () => {
    const { manager } = makeManager(listWith([summary("remote", 5, undefined, "C:\\elsewhere"), summary("vault", 1)]));
    await manager.refresh();
    expect(manager.sessions.map((s) => s.sessionId)).toEqual(["vault", "remote"]);
    expect(manager.sessionTitle("remote")).toBe("chat.sessionFallback"); // 无投影标题 → 占位
  });

  it("store 视图标题优先于索引里的 list 投影（线上 list 常无 title）", async () => {
    const stream = makeStream<SessionFollowFrame>();
    const { manager, store } = makeManager({
      ...listWith([summary("vault-1", 3, "列表标题")]),
      openStream: async () => stream.iterator,
    });
    await manager.refresh();
    const p = manager.openSession("vault-1");
    stream.push(snapshot({ projections: { asOfSeq: 10, values: { title: "视图标题" } } }));
    await p;
    expect(store.getView("vault-1")?.title).toBe("视图标题");
    expect(manager.sessionTitle("vault-1")).toBe("视图标题"); // 索引命中后仍由 displayTitle 决定优先级
  });
});

describe("SessionManager 0.1.5 assistant-stream 能力探测", () => {
  /** 让 consumeFollow 的 await 链跑完（宏任务边界可排空全部待处理微任务）。 */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** 记录每次 openStream 收到的 request，便于断言参数是否带 assistantStream。 */
  function trackingManager(behaviour: (request: Record<string, unknown>, attempt: number) => AsyncIterable<SessionFollowFrame>) {
    const seen: Array<Record<string, unknown>> = [];
    let attempt = 0;
    const fake: Partial<FakeClient> = {
      openStream: async (_endpoint, args) => {
        attempt += 1;
        const request = (args?.request ?? {}) as Record<string, unknown>;
        seen.push(request);
        return behaviour(request, attempt);
      },
    };
    return { seen, ...makeManager(fake) };
  }

  it("0.1.5：请求带 assistantStream:true，并消费 assistant-stream 瞬态帧", async () => {
    const stream = makeStream<SessionFollowFrame>();
    const { manager, store, seen } = trackingManager(() => stream.iterator);
    const p = manager.openSession("vault-1");
    stream.push(snapshot());
    await p;

    expect(seen[0]).toMatchObject({ assistantStream: true });

    stream.push({ type: "assistant-stream", frame: { type: "start", attemptId: "a1", revision: 1, startedAfterSeq: 11, turn: 1, step: 1 } });
    stream.push({ type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", revision: 2, index: 0, time: 1, chunk: { type: "text-delta", index: 0, text: "流式" } } });
    stream.push({ type: "assistant-stream", frame: { type: "chunk", attemptId: "a1", revision: 3, index: 1, time: 2, chunk: { type: "text-delta", index: 0, text: "输出" } } });
    await flush();

    const node = store.getView("vault-1")?.nodes.at(-1);
    expect(node).toMatchObject({ kind: "assistant", text: "流式输出", streaming: true });

    stream.push({ type: "assistant-stream", frame: { type: "end", attemptId: "a1", revision: 4, index: 2, outcome: { kind: "committed", eventType: "assistant/message", seq: 20 } } });
    await flush();
    // end(committed→assistant/message) 不自行收尾，交给 durable 事件
    expect(store.getView("vault-1")?.nodes.at(-1)).toMatchObject({ streaming: true });

    stream.push({ type: "event", event: { type: "assistant/message", seq: 20, time: 20, data: { message: { id: "m1", content: [{ type: "text", text: "流式输出" }] } } } });
    await flush();
    const nodes = store.getView("vault-1")?.nodes ?? [];
    expect(nodes.filter((n) => n.kind === "assistant")).toHaveLength(1); // 不产生重复消息
    expect(nodes.at(-1)).toMatchObject({ streaming: false, text: "流式输出" });
  });

  it("0.1.2-rc.1：带参被拒（gateway/arguments-invalid）后自动降级重试，且之后不再带参", async () => {
    const ok1 = makeStream<SessionFollowFrame>();
    const ok2 = makeStream<SessionFollowFrame>();
    const { manager, store, seen } = trackingManager((request, attempt) => {
      if (request.assistantStream === true) {
        const bad = makeStream<SessionFollowFrame>();
        bad.fail(new RemoteStreamError("gateway/arguments-invalid", 'unexpected "assistantStream"'));
        return bad.iterator;
      }
      return (attempt === 2 ? ok1 : ok2).iterator;
    });

    const p = manager.openSession("vault-1");
    ok1.push(snapshot());
    await p;

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ assistantStream: true });
    expect(seen[1]).not.toHaveProperty("assistantStream"); // 降级后不带字段
    expect(store.getView("vault-1")?.title).toBe("投影标题"); // 降级后仍正常播种

    // 能力位已记住：后续调用（resync）不再先带参试探
    seen.length = 0;
    const pr = manager.resyncSession("vault-1");
    ok2.push(snapshot());
    await pr;
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty("assistantStream");
  });

  it("非能力错误的流失败不触发降级重试（原样抛出）", async () => {
    const { manager, seen } = trackingManager(() => {
      const bad = makeStream<SessionFollowFrame>();
      bad.fail(new RemoteStreamError("session/not-found", "not found"));
      return bad.iterator;
    });
    await expect(manager.openSession("vault-1")).rejects.toThrow(/not found/);
    expect(seen).toHaveLength(1);
  });

  it("快照在飞 attempt 基线：恢复流式文本并置 running", async () => {
    const stream = makeStream<SessionFollowFrame>();
    const { manager, store } = trackingManager(() => stream.iterator);
    const p = manager.openSession("vault-1");
    stream.push(
      snapshot({
        assistantStream: {
          revision: 7,
          activeAttempt: {
            attemptId: "a9",
            startedAfterSeq: 3,
            turn: 1,
            step: 2,
            nextIndex: 4,
            stream: [{ type: "text-chunks", time0: 1, index: 0, dt: [1], texts: ["已", "生成"] }],
          },
        },
      })
    );
    await p;
    const view = store.getView("vault-1");
    expect(view?.running).toBe(true);
    expect(view?.nodes.at(-1)).toMatchObject({ kind: "assistant", text: "已生成", streaming: true });
  });
});

describe("TASK-032 C4：重连丢弃进行中回合时通知一次", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** 造一个「流式中且已有文本」的视图，模拟断线瞬间的状态。 */
  function seedStreaming(store: SessionStore): void {
    store.applyFollowSnapshot("vault-1", snapshot());
    store.applyFollowAssistantStream("vault-1", { type: "start", attemptId: "a1", revision: 1, startedAfterSeq: 1, turn: 1, step: 1 });
    store.applyFollowAssistantStream("vault-1", {
      type: "chunk",
      attemptId: "a1",
      revision: 2,
      index: 0,
      time: 1,
      chunk: { type: "text-delta", index: 0, text: "半截回复内容" },
    });
  }

  function resyncManager(snapshotFrame: Extract<SessionFollowFrame, { type: "snapshot" }>, dropped: string[]) {
    const stream = makeStream<SessionFollowFrame>();
    return {
      stream,
      dropped,
      ...makeManager({ openStream: async () => stream.iterator }, {}, "C:\\vault", {
        onInterruptedTurnDropped: (id) => dropped.push(id),
      }),
    };
  }

  it("服务端重启场景：流式文本不在快照里 → 通知一次", async () => {
    const dropped: string[] = [];
    const { stream, manager, store } = resyncManager(snapshot(), dropped);
    seedStreaming(store);
    expect(store.getView("vault-1")?.nodes.at(-1)).toMatchObject({ text: "半截回复内容", streaming: true });

    const p = manager.resyncSession("vault-1");
    stream.push(snapshot()); // 服务端 log 里没有这段 assistant 文本（从未落库）
    await p;
    await flush();

    expect(dropped).toEqual(["vault-1"]);
    const assistants = (store.getView("vault-1")?.nodes ?? []).filter((n) => n.kind === "assistant");
    expect(assistants).toHaveLength(0); // 半截气泡按服务端真值被摘除
  });

  it("断线期间服务端已正常落库同一回合 → 文本仍在，不通知", async () => {
    const dropped: string[] = [];
    const committed = snapshot({
      records: [
        { type: "event", event: { type: "user/message", seq: 11, time: 11, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } } },
        {
          type: "event",
          event: {
            type: "assistant/message",
            seq: 12,
            time: 12,
            data: { message: { id: "am1", content: [{ type: "text", text: "半截回复内容以及后续完整内容" }], source: { kind: "model", provider: "p", model: "m" } } },
          },
        },
      ],
    });
    const { stream, manager, store } = resyncManager(committed, dropped);
    seedStreaming(store);

    const p = manager.resyncSession("vault-1");
    stream.push(committed);
    await p;
    await flush();

    expect(dropped).toEqual([]); // 前 40 字符前缀命中 → 未丢失，不打扰用户
  });

  it("重连前没有流式文本 → 不通知", async () => {
    const dropped: string[] = [];
    const { stream, manager, store } = resyncManager(snapshot(), dropped);
    store.applyFollowSnapshot("vault-1", snapshot()); // 有视图，但无流式节点

    const p = manager.resyncSession("vault-1");
    stream.push(snapshot());
    await p;
    await flush();

    expect(dropped).toEqual([]);
  });
});

/* ---- TASK-030：富内容 prompt / 命令清单缓存 / goals 转发 ---- */

describe("SessionManager TASK-030（附件·命令·目标）", () => {
  it("promptContent 透传文本+图片 content 块（含 vault 路径作 name）", async () => {
    const sent: unknown[] = [];
    const { manager } = makeManager({
      prompt: async (payload: unknown) => {
        sent.push(payload);
        return { ok: true as const, value: { accepted: true as const } };
      },
    });
    const res = await manager.promptContent("s1", [
      { type: "text", text: "看图" },
      { type: "image", mediaType: "image/png", data: "AAAA", name: "notes/a.png" },
    ]);
    expect(res.ok).toBe(true);
    expect(sent).toEqual([
      {
        sessionId: "s1",
        mode: "queue",
        content: [
          { type: "text", text: "看图" },
          { type: "image", mediaType: "image/png", data: "AAAA", name: "notes/a.png" },
        ],
      },
    ]);
  });

  it("promptContent 空内容不发 RPC（本地返回错误，避免 gateway/arguments-invalid 噪音）", async () => {
    let called = 0;
    const { manager } = makeManager({
      prompt: async () => {
        called += 1;
        return { ok: true as const, value: { accepted: true as const } };
      },
    });
    const res = await manager.promptContent("s1", []);
    expect(called).toBe(0);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe("invalid-content");
  });

  it("prompt 文本路径仍走 promptContent（回归保护）", async () => {
    const sent: unknown[] = [];
    const { manager } = makeManager({
      prompt: async (payload: unknown) => {
        sent.push(payload);
        return { ok: true as const, value: { accepted: true as const } };
      },
    });
    await manager.prompt("s1", "hi", "steer");
    expect(sent).toEqual([{ sessionId: "s1", mode: "steer", content: [{ type: "text", text: "hi" }] }]);
  });

  it("loadCommands 收窄并缓存；cachedCommands 未拉取时为 null", async () => {
    const { manager } = makeManager({
      listCommands: async (agentId: string) => {
        expect(agentId).toBe("s1");
        return {
          ok: true as const,
          value: [
            { name: "compact", description: "Compact older conversation history" },
            { name: "", description: "畸形项" },
          ],
        };
      },
    });
    expect(manager.cachedCommands("s1")).toBeNull();
    const list = await manager.loadCommands("s1");
    expect(list.map((c) => c.name)).toEqual(["compact"]);
    expect(manager.cachedCommands("s1")).toEqual(list);
    expect(manager.cachedCommands("other")).toBeNull(); // 按会话隔离
  });

  it("loadCommands 失败时抛错但保留上一次缓存（联想不回退到兜底清单）", async () => {
    let mode: "ok" | "fail" = "ok";
    const { manager } = makeManager({
      listCommands: async () =>
        mode === "ok"
          ? { ok: true as const, value: [{ name: "goal", description: "set goal" }] }
          : { ok: false as const, error: { code: "gateway/internal", message: "boom" } },
    });
    await manager.loadCommands("s1");
    mode = "fail";
    await expect(manager.loadCommands("s1")).rejects.toThrow(/boom/);
    expect(manager.cachedCommands("s1")?.map((c) => c.name)).toEqual(["goal"]);
  });

  it("runCommand 平铺参数转发（agentId/line/submittedAttachments）并透传 undefined 结果", async () => {
    const calls: unknown[] = [];
    const { manager } = makeManager({
      executeCommand: async (agentId: string, line: string, attachments: unknown[]) => {
        calls.push({ agentId, line, attachments });
        return { ok: true as const, value: undefined };
      },
    });
    const res = await manager.runCommand("s1", "/goal create X", [{ type: "image", mediaType: "image/png", data: "AA" }]);
    expect(calls).toEqual([{ agentId: "s1", line: "/goal create X", attachments: [{ type: "image", mediaType: "image/png", data: "AA" }] }]);
    expect(res.ok && res.value).toBeUndefined();
  });

  it("runCommand 缺省附件为 []（不传 undefined：网关要求该键存在）", async () => {
    const calls: unknown[] = [];
    const { manager } = makeManager({
      executeCommand: async (agentId: string, line: string, attachments: unknown[]) => {
        calls.push({ agentId, line, attachments });
        return { ok: true as const, value: undefined };
      },
    });
    await manager.runCommand("s1", "/compact");
    expect(calls).toEqual([{ agentId: "s1", line: "/compact", attachments: [] }]);
  });

  it("goals/* 转发（get/create/edit/pause/resume/complete/clear）", async () => {
    const calls: unknown[] = [];
    const { manager } = makeManager({
      goalGet: async (agentId: string) => {
        calls.push(["get", agentId]);
        return { ok: true as const, value: undefined };
      },
      goalCreate: async (agentId: string, request: unknown) => {
        calls.push(["create", agentId, request]);
        return { ok: true as const, value: { ref: { id: "g1", revision: 1 } } };
      },
      goalEdit: async (agentId: string, ref: unknown, request: unknown) => {
        calls.push(["edit", agentId, ref, request]);
        return { ok: true as const, value: {} };
      },
      goalPause: async (agentId: string, ref: unknown) => {
        calls.push(["pause", agentId, ref]);
        return { ok: true as const, value: {} };
      },
      goalResume: async (agentId: string, ref: unknown) => {
        calls.push(["resume", agentId, ref]);
        return { ok: true as const, value: {} };
      },
      goalComplete: async (agentId: string, ref: unknown) => {
        calls.push(["complete", agentId, ref]);
        return { ok: true as const, value: {} };
      },
      goalClear: async (agentId: string, ref: unknown) => {
        calls.push(["clear", agentId, ref]);
        return { ok: true as const, value: { id: "g1", revision: 4 } };
      },
    });
    const ref = { id: "g1", revision: 3 };
    await manager.goalGet("s1");
    await manager.goalCreate("s1", { objective: "完成 X" });
    await manager.goalEdit("s1", ref, { objective: "改" });
    await manager.goalPause("s1", ref);
    await manager.goalResume("s1", ref);
    await manager.goalComplete("s1", ref);
    await manager.goalClear("s1", ref);
    expect(calls).toEqual([
      ["get", "s1"],
      ["create", "s1", { objective: "完成 X" }],
      ["edit", "s1", ref, { objective: "改" }],
      ["pause", "s1", ref],
      ["resume", "s1", ref],
      ["complete", "s1", ref],
      ["clear", "s1", ref],
    ]);
  });

  it("selectModel 把会话 id 与选择合并为 request 形状", async () => {
    const sent: unknown[] = [];
    const { manager } = makeManager({
      selectModel: async (payload: unknown) => {
        sent.push(payload);
        return { ok: true as const, value: { selected: { provider: "p", model: "m" } } };
      },
    });
    await manager.selectModel("s1", { provider: "p", model: "m" });
    await manager.selectModel("s1", { provider: "p", model: "m", reasoningEffort: "high" });
    expect(sent).toEqual([
      { sessionId: "s1", provider: "p", model: "m" },
      { sessionId: "s1", provider: "p", model: "m", reasoningEffort: "high" },
    ]);
  });
});

