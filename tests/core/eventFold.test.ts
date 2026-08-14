import { describe, expect, it } from "vitest";
import { createSessionView, foldEvent, type SessionView } from "../../src/core/eventFold";
import type { SessionEvent } from "../../src/transport/types";

function ev(type: string, seq: number, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: seq * 1000, data };
}

describe("foldEvent", () => {
  it("user/message 生成用户节点，工具类来源跳过", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("user/message", 1, { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } }));
    foldEvent(view, ev("user/message", 2, { id: "m2", role: "user", content: [{ type: "text", text: "tool-data" }], source: { kind: "tool", callId: "c1" } }));
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "user", text: "你好" });
  });

  it("assistant/chunk 增量流式追加文本", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("turn/start", 1, { turn: 1 }));
    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    foldEvent(view, ev("assistant/chunk", 3, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "你" } }));
    foldEvent(view, ev("assistant/chunk", 4, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "好" } }));
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", text: "你好", streaming: true });
  });

  it("assistant/message 终结流式节点并生成工具卡片", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/chunk", 1, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "查一下" } }));
    foldEvent(view, ev("assistant/message", 2, {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [
          { type: "text", text: "查一下" },
          { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.md"}' },
        ],
        source: { kind: "model", provider: "deepseek", model: "v4" },
      },
    }));
    const node = view.nodes[0];
    expect(node).toMatchObject({ kind: "assistant", streaming: false });
    if (node.kind === "assistant") {
      expect(node.toolCards).toHaveLength(1);
      expect(node.toolCards[0]).toMatchObject({ id: "c1", name: "read", status: "running" });
    }
  });

  it("tool/result 落卡到对应工具卡片", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: { id: "am1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    foldEvent(view, ev("tool/result", 2, {
      turn: 1, step: 1,
      message: { id: "tr1", role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "文件内容" }], isError: false }], source: { kind: "tool", callId: "c1" } },
    }));
    const node = view.nodes[0];
    if (node.kind === "assistant") {
      expect(node.toolCards[0]).toMatchObject({ status: "done", resultText: "文件内容" });
    }
  });

  it("command/run 与 command/done 生成命令卡片", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("command/run", 1, { commandId: "cmd1", name: "plan", args: undefined, source: { kind: "user" } }));
    expect(view.nodes[0]).toMatchObject({ kind: "command", status: "running" });
    foldEvent(view, ev("command/done", 2, { commandId: "cmd1", kind: "success", text: "计划模式已开启" }));
    expect(view.nodes[0]).toMatchObject({ kind: "command", status: "success", text: "计划模式已开启" });
  });

  it("session/title 与 plan/mode 更新头部状态", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("session/title", 1, { title: "我的会话", source: "fallback" }));
    expect(view.title).toBe("我的会话");
    foldEvent(view, ev("plan/mode", 2, { active: true }));
    expect(view.plan.active).toBe(true);
  });

  it("turn/start 与 turn/end 维护 running 标志", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("turn/start", 1, { turn: 1 }));
    expect(view.running).toBe(true);
    foldEvent(view, ev("turn/end", 2, { turn: 1, reason: { kind: "completed" } }));
    expect(view.running).toBe(false);
  });

  it("回合出错时追加错误节点", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("turn/start", 1, { turn: 1 }));
    foldEvent(view, ev("turn/end", 2, { turn: 1, reason: { kind: "error", error: { message: "模型挂了", code: "E1" } } }));
    expect(view.nodes.at(-1)).toMatchObject({ kind: "error", text: "回合错误：模型挂了" });
  });

  it("同一回合多步骤生成多个 assistant 节点", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/chunk", 1, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "第一步" } }));
    foldEvent(view, ev("assistant/message", 2, { turn: 1, step: 1, message: { id: "am1", role: "assistant", content: [{ type: "text", text: "第一步" }], source: { kind: "model", provider: "p", model: "m" } } }));
    foldEvent(view, ev("assistant/chunk", 3, { turn: 1, step: 2, chunk: { type: "text-delta", index: 0, text: "第二步" } }));
    foldEvent(view, ev("assistant/message", 4, { turn: 1, step: 2, message: { id: "am2", role: "assistant", content: [{ type: "text", text: "第二步" }], source: { kind: "model", provider: "p", model: "m" } } }));
    expect(view.nodes.filter((n) => n.kind === "assistant")).toHaveLength(2);
    expect(view.nodes[0]).toMatchObject({ text: "第一步", streaming: false });
    expect(view.nodes[1]).toMatchObject({ text: "第二步", streaming: false });
  });

  it("tool/result 的 isError 信号置为错误状态", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: { id: "am1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "write", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    foldEvent(view, ev("tool/result", 2, {
      turn: 1, step: 1,
      message: { id: "tr1", role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "失败原因" }], isError: true }], source: { kind: "tool", callId: "c1" } },
    }));
    const node = view.nodes[0];
    if (node.kind === "assistant") {
      expect(node.toolCards[0]).toMatchObject({ status: "error", resultText: "失败原因" });
    }
  });

  it("无流式前缀的 assistant/message 填充文本", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: { id: "am1", role: "assistant", content: [{ type: "text", text: "完整回复" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", text: "完整回复", streaming: false });
  });

  it("assistant/message 提取 reasoning 块（历史回放路径）", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "思考过程" },
          { type: "text", text: "回复" },
        ],
        source: { kind: "model", provider: "p", model: "m" },
      },
    }));
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", reasoning: "思考过程", text: "回复" });
  });

  it("独立 tool/call 事件创建工具卡片", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("tool/call", 1, { turn: 1, step: 1, callId: "c9", name: "bash", arguments: '{"cmd":"ls"}' }));
    const node = view.nodes[0];
    expect(node.kind).toBe("assistant");
    if (node.kind === "assistant") {
      expect(node.toolCards[0]).toMatchObject({ id: "c9", name: "bash", status: "running" });
    }
  });
});
