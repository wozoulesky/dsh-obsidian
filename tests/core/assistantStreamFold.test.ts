import { describe, expect, it } from "vitest";
import { createSessionView, foldAssistantStreamFrame, foldEvent, type SessionView } from "../../src/core/eventFold";
import type { AssistantStreamFrame } from "../../src/transport/types";

const chunk = (text: string, index = 0): AssistantStreamFrame => ({
  type: "chunk",
  attemptId: "a1",
  revision: 1,
  index,
  time: 1,
  chunk: { type: "text-delta", index: 0, text },
});

const start = (attemptId = "a1"): AssistantStreamFrame => ({ type: "start", attemptId, revision: 0, startedAfterSeq: 0, turn: 1, step: 1 });

const end = (attemptId = "a1"): AssistantStreamFrame => ({
  type: "end",
  attemptId,
  revision: 9,
  index: 0,
  outcome: { kind: "committed", eventType: "assistant/message", seq: 30 },
});

describe("foldAssistantStreamFrame（0.1.5 瞬态增量折叠）", () => {
  it("start 建流式节点，chunk 追加文本，durable assistant/message 收尾", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, start());
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", text: "", streaming: true });

    foldAssistantStreamFrame(view, chunk("你"));
    foldAssistantStreamFrame(view, chunk("好"));
    expect(view.nodes[0]).toMatchObject({ text: "你好", streaming: true });

    foldAssistantStreamFrame(view, end());
    foldEvent(view, { type: "assistant/message", seq: 30, time: 30, data: { message: { id: "m1", content: [{ type: "text", text: "你好" }] } } });
    expect(view.nodes[0]).toMatchObject({ text: "你好", streaming: false });
  });

  it("无 start 直接来 chunk 也能落节点（帧丢失容错）", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, chunk("孤儿增量"));
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ text: "孤儿增量", streaming: true });
  });

  it("reasoning-delta 累积到 reasoning（不污染正文）", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, start());
    foldAssistantStreamFrame(view, { type: "chunk", attemptId: "a1", revision: 1, index: 0, time: 1, chunk: { type: "reasoning-delta", index: 0, text: "思考" } });
    expect(view.nodes[0]).toMatchObject({ text: "", reasoning: "思考" });
  });

  it("每一步一个节点：durable assistant/message 结算后，下一次 start 建新节点", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, start("a1"));
    foldAssistantStreamFrame(view, chunk("第一步"));
    foldAssistantStreamFrame(view, end("a1"));
    foldEvent(view, { type: "assistant/message", seq: 30, time: 30, data: { message: { id: "m1", content: [{ type: "text", text: "第一步" }] } } });
    foldAssistantStreamFrame(view, start("a2"));
    foldAssistantStreamFrame(view, chunk("第二步"));
    expect(view.nodes).toHaveLength(2);
    expect(view.nodes[0]).toMatchObject({ text: "第一步", streaming: false });
    expect(view.nodes[1]).toMatchObject({ text: "第二步", streaming: true });
  });

  it("end(committed→assistant/message) 不自行收尾：由 durable 事件收尾，且不产生重复节点", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, start());
    foldAssistantStreamFrame(view, chunk("流式文本"));
    foldAssistantStreamFrame(view, end());
    // 仍处于流式：等待 durable assistant/message 结算
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ streaming: true });

    foldEvent(view, {
      type: "assistant/message",
      seq: 30,
      time: 30,
      data: { message: { id: "m1", content: [{ type: "text", text: "不同文本" }] } },
    });
    // 复用同一节点（不新建），text 已非空故不被 durable 文本覆盖
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ text: "流式文本", streaming: false });
  });

  it("end(committed→assistant/attempt 或 abandoned) 自行收尾（不会再有 assistant/message）", () => {
    for (const outcome of [{ kind: "committed", eventType: "assistant/attempt", seq: 30 } as const, { kind: "abandoned" } as const]) {
      const view = createSessionView("s1");
      foldAssistantStreamFrame(view, start());
      foldAssistantStreamFrame(view, chunk("中断内容"));
      foldAssistantStreamFrame(view, { type: "end", attemptId: "a1", revision: 9, index: 0, outcome });
      expect(view.nodes).toHaveLength(1);
      expect(view.nodes[0]).toMatchObject({ text: "中断内容", streaming: false });
    }
  });

  it("end 后无节点时不抛错（幂等边界）", () => {
    const view: SessionView = createSessionView("s1");
    expect(() => foldAssistantStreamFrame(view, end())).not.toThrow();
    expect(view.nodes).toHaveLength(0);
  });

  it("tool-call-delta：卡片落地前丢弃（既有语义），block-end 建卡后追加", () => {
    const view = createSessionView("s1");
    const delta = (args: string): AssistantStreamFrame => ({
      type: "chunk",
      attemptId: "a1",
      revision: 1,
      index: 0,
      time: 1,
      chunk: { type: "tool-call-delta", index: 0, id: "c1", argumentsDelta: args },
    });
    foldAssistantStreamFrame(view, start());
    foldAssistantStreamFrame(view, delta("early"));
    const afterEarly = view.nodes.find((n) => n.kind === "assistant");
    expect(afterEarly?.kind === "assistant" ? afterEarly.toolCards : null).toHaveLength(0);

    // block-end 携带完整 tool-call → 建卡
    foldAssistantStreamFrame(view, {
      type: "chunk",
      attemptId: "a1",
      revision: 2,
      index: 1,
      time: 2,
      chunk: { type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "read", arguments: '{"p":' } },
    });
    foldAssistantStreamFrame(view, delta("1}"));
    const node = view.nodes.find((n) => n.kind === "assistant");
    expect(node?.kind === "assistant" ? node.toolCards[0] : null).toMatchObject({ id: "c1", name: "read", status: "running", args: '{"p":1}' });
  });
});
