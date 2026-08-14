import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/store";
import type { MuxFrame } from "../../src/transport/types";

describe("SessionStore", () => {
  it("session/event 帧折叠进对应会话视图", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyMux("r1", {
      type: "session/event",
      sessionId: "s1",
      event: { type: "user/message", seq: 1, time: 1, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    });
    const view = store.ensureView("s1");
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "user", text: "hi" });
  });

  it("session/projection 更新 title 与 plan", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "session/projection", sessionId: "s1", key: "title", value: "标题A", seq: 1 });
    store.applyMux("r2", { type: "session/projection", sessionId: "s1", key: "plan", value: { active: true, pending: true }, seq: 2 });
    const view = store.ensureView("s1");
    expect(view.title).toBe("标题A");
    expect(view.plan).toEqual({ active: true, pending: true });
  });

  it("投影按 higher-seq-wins 覆盖，旧 seq 不覆盖新值", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "session/projection", sessionId: "s1", key: "title", value: "新", seq: 5 });
    store.applyMux("r2", { type: "session/projection", sessionId: "s1", key: "title", value: "旧", seq: 3 });
    expect(store.ensureView("s1").title).toBe("新");
  });

  it("session/subscribed 更新 lastSeq 基线", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyMux("r1", { type: "session/subscribed", sessionId: "s1", lastSeq: 42 });
    expect(store.ensureView("s1").lastSeq).toBe(42);
  });

  it("seedHistory 按序折叠并触发变更回调", () => {
    const store = new SessionStore();
    let changed = 0;
    store.onChange(() => changed++);
    store.seedHistory("s1", [
      { event: { type: "session/title", seq: 1, time: 1, data: { title: "T", source: "fallback" } } },
      { event: { type: "user/message", seq: 2, time: 2, data: { id: "m1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } } } },
    ]);
    const view = store.ensureView("s1");
    expect(view.title).toBe("T");
    expect(view.nodes).toHaveLength(1);
    expect(changed).toBe(1);
  });

  it("unknown 帧类型被安全忽略", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "whatever/else" } as unknown as MuxFrame);
    expect(store.ensureView("s1").nodes).toHaveLength(0);
  });

  it("onChange 返回解除函数，解除后不再收到通知", () => {
    const store = new SessionStore();
    let changed = 0;
    const off = store.onChange(() => changed++);
    store.seedHistory("s1", [
      { event: { type: "user/message", seq: 1, time: 1, data: { id: "m1", role: "user", content: [{ type: "text", text: "a" }], source: { kind: "user" } } } },
    ]);
    expect(changed).toBe(1);
    off();
    store.seedHistory("s1", [
      { event: { type: "user/message", seq: 2, time: 2, data: { id: "m2", role: "user", content: [{ type: "text", text: "b" }], source: { kind: "user" } } } },
    ]);
    expect(changed).toBe(1);
  });

  it("applyMux 不会为未打开过的会话物化视图", () => {
    const store = new SessionStore();
    store.applyMux("r1", {
      type: "session/event",
      sessionId: "never-opened",
      event: { type: "user/message", seq: 1, time: 1, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    });
    expect(store.getView("never-opened")).toBeUndefined();
  });

  it("prependHistory 前插旧页并保持尾部状态", () => {
    const store = new SessionStore();
    let changed = 0;
    store.onChange(() => changed++);
    store.seedHistory("s1", [
      { event: { type: "user/message", seq: 5, time: 5, data: { id: "m2", role: "user", content: [{ type: "text", text: "新消息" }], source: { kind: "user" } } } },
    ]);
    const before = store.ensureView("s1");
    before.running = true;
    before.title = "新标题";
    changed = 0;
    store.prependHistory("s1", [
      { event: { type: "user/message", seq: 1, time: 1, data: { id: "m1", role: "user", content: [{ type: "text", text: "旧消息" }], source: { kind: "user" } } } },
    ]);
    const view = store.ensureView("s1");
    expect(view.nodes.map((n) => (n.kind === "user" ? n.text : ""))).toEqual(["旧消息", "新消息"]);
    expect(view.lastSeq).toBe(5);
    expect(view.running).toBe(true);
    expect(view.title).toBe("新标题");
    expect(changed).toBe(1);
  });

  it("dropView 同时清除投影单元", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "session/projection", sessionId: "s1", key: "title", value: "T", seq: 1 });
    store.dropView("s1");
    store.ensureView("s1");
    // 旧投影单元已清除：更低 seq 的新投影不应被旧的更高 seq 拒绝
    store.applyMux("r2", { type: "session/projection", sessionId: "s1", key: "title", value: "新T", seq: 0 });
    expect(store.ensureView("s1").title).toBe("新T");
  });
});
