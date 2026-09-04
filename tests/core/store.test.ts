import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/store";
import type { SessionControlFrame, SessionFollowFrame } from "../../src/transport/types";

function userEvent(seq: number, text: string, id = `m${seq}`) {
  return {
    type: "user/message",
    seq,
    time: seq,
    data: { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } },
  };
}

describe("SessionStore", () => {
  it("applyFollowEvent 折叠事件进对应会话视图", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyFollowEvent("s1", { type: "event", event: userEvent(1, "hi") });
    const view = store.ensureView("s1");
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "user", text: "hi" });
  });

  it("applyControlFrame projection 更新 title 与 plan", () => {
    const store = new SessionStore();
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "title", value: "标题A", seq: 1 });
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "plan", value: { active: true, pending: true }, seq: 2 });
    const view = store.ensureView("s1");
    expect(view.title).toBe("标题A");
    expect(view.plan).toEqual({ active: true, pending: true });
  });

  it("投影按 higher-seq-wins 覆盖，旧 seq 不覆盖新值", () => {
    const store = new SessionStore();
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "title", value: "新", seq: 5 });
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "title", value: "旧", seq: 3 });
    expect(store.ensureView("s1").title).toBe("新");
  });

  it("applyFollowSnapshot 以 snapshot 的 lastSeq 建立基线（lastSeq 跟随最大 seq）", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 42,
      records: [{ type: "event", event: userEvent(42, "hi") }],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    });
    expect(store.ensureView("s1").lastSeq).toBe(42);
  });

  it("applyFollowSnapshot 播种事件（等价旧 seedHistory 语义）并触发变更回调", () => {
    const store = new SessionStore();
    let changed = 0;
    store.onChange(() => changed++);
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 2,
      records: [
        { type: "event", event: { type: "session/title", seq: 1, time: 1, data: { title: "T", source: "fallback" } } },
        { type: "event", event: userEvent(2, "hello") },
      ],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    });
    const view = store.ensureView("s1");
    expect(view.title).toBe("T");
    expect(view.nodes).toHaveLength(1);
    expect(changed).toBe(1);
  });

  it("applyControlFrame jobs 帧被安全忽略（不触发 notify）", () => {
    const store = new SessionStore();
    let changed = 0;
    store.onChange(() => changed++);
    store.applyControlFrame({ type: "jobs", sessionId: "s1", jobs: [{ id: "j1" }] });
    expect(changed).toBe(0);
    expect(store.getView("s1")).toBeUndefined();
  });

  it("onChange 返回解除函数，解除后不再收到通知", () => {
    const store = new SessionStore();
    let changed = 0;
    const off = store.onChange(() => changed++);
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 1,
      records: [{ type: "event", event: userEvent(1, "a") }],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    });
    expect(changed).toBe(1);
    off();
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 2,
      records: [{ type: "event", event: userEvent(2, "b") }],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    });
    expect(changed).toBe(1);
  });

  it("applyFollowEvent 不会为未打开过的会话物化视图", () => {
    const store = new SessionStore();
    store.applyFollowEvent("never-opened", { type: "event", event: userEvent(1, "hi") });
    expect(store.getView("never-opened")).toBeUndefined();
  });

  it("prependHistory 前插旧页并保持尾部状态", () => {
    const store = new SessionStore();
    let changed = 0;
    store.onChange(() => changed++);
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 5,
      records: [{ type: "event", event: userEvent(5, "新消息", "m2") }],
      hasMore: false,
      projections: { asOfSeq: 0, values: {} },
    });
    const before = store.ensureView("s1");
    before.running = true;
    before.title = "新标题";
    changed = 0;
    store.prependHistory("s1", [userEvent(1, "旧消息", "m1")]);
    const view = store.ensureView("s1");
    expect(view.nodes.map((n) => (n.kind === "user" ? n.text : ""))).toEqual(["旧消息", "新消息"]);
    expect(view.lastSeq).toBe(5);
    expect(view.running).toBe(true);
    expect(view.title).toBe("新标题");
    expect(changed).toBe(1);
  });

  it("dropView 同时清除投影单元", () => {
    const store = new SessionStore();
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "title", value: "T", seq: 1 });
    store.dropView("s1");
    store.ensureView("s1");
    // 旧投影单元已清除：更低 seq 的新投影不应被旧的更高 seq 拒绝
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "title", value: "新T", seq: 0 });
    expect(store.ensureView("s1").title).toBe("新T");
  });
});

describe("SessionStore 批4 follow/control 帧", () => {
  function makeSnapshot(
    records: Extract<SessionFollowFrame, { type: "snapshot" }>["records"],
    projections: Extract<SessionFollowFrame, { type: "snapshot" }>["projections"] = { asOfSeq: 0, values: {} }
  ): Extract<SessionFollowFrame, { type: "snapshot" }> {
    return { type: "snapshot", header: { version: 1, id: "s1", createdAt: 1 }, cursor: 10, records, hasMore: false, projections };
  }

  it("applyFollowSnapshot 展开 chunkrow 并折叠进视图", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot(
      "s1",
      makeSnapshot([
        {
          type: "chunks",
          event: { type: "chunkrow/text-chunks", seq: 5, time: 100, data: { turn: 1, step: 1, index: 0, dt: [2], texts: ["你", "好"] } },
        },
        { type: "event", event: userEvent(8, "hi") },
      ])
    );
    const view = store.ensureView("s1");
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", text: "你好", seq: 5 });
    expect(view.nodes[1]).toMatchObject({ kind: "user", text: "hi" });
  });

  it("applyFollowSnapshot 播种 projections（title/plan，asOfSeq 水位）", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot(
      "s1",
      makeSnapshot([], { asOfSeq: 42, values: { title: "快照标题", plan: { active: true, pending: false } } })
    );
    const view = store.ensureView("s1");
    expect(view.title).toBe("快照标题");
    expect(view.plan).toEqual({ active: true, pending: false });
  });

  it("applyFollowEvent 折叠 event 帧；未打开会话不物化", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    let changed = 0;
    store.onChange(() => changed++);
    store.applyFollowEvent("s1", { type: "event", event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } } });
    expect(store.ensureView("s1").running).toBe(true);
    expect(changed).toBe(1);
    changed = 0;
    store.applyFollowEvent("never-opened", { type: "event", event: { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } } });
    expect(store.getView("never-opened")).toBeUndefined();
    expect(changed).toBe(0);
  });

  it("applyControlFrame baseline 播种队列与投影（投影允许播种，队列仅物化已存在视图）", () => {
    const store = new SessionStore();
    store.ensureView("s1"); // s2 未打开
    const baseline: SessionControlFrame = {
      type: "baseline",
      value: {
        queues: {
          s1: [{ id: "q1", placement: "queued", message: { id: "m1", content: [] } }],
          s2: [{ id: "q2", placement: "queued", message: { id: "m2", content: [] } }],
        },
        jobs: {},
        projections: {
          s1: { asOfSeq: 9, values: { title: "基线标题" } },
          s2: { asOfSeq: 9, values: { plan: { active: true, pending: false } } },
        },
      },
    };
    store.applyControlFrame(baseline);
    expect(store.ensureView("s1").title).toBe("基线标题");
    expect(store.ensureView("s1").queueItems).toHaveLength(1);
    expect(store.ensureView("s2").plan).toEqual({ active: true, pending: false }); // 投影播种了未打开会话
    expect(store.ensureView("s2").queueItems).toHaveLength(0); // 队列不物化未打开会话
  });

  it("applyControlFrame 增量帧：queue 更新 / projection higher-seq-wins / jobs 忽略", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyControlFrame({ type: "queue", sessionId: "s1", items: [{ id: "q1", placement: "queued", message: { id: "m1", content: [] } }] });
    expect(store.ensureView("s1").queueItems).toHaveLength(1);
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "title", value: "新标题", seq: 5 });
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "title", value: "旧标题", seq: 3 });
    expect(store.ensureView("s1").title).toBe("新标题");
    let changed = 0;
    store.onChange(() => changed++);
    store.applyControlFrame({ type: "jobs", sessionId: "s1", jobs: [{ id: "j1" }] });
    expect(changed).toBe(0); // jobs 忽略且不触发 notify
  });
});
