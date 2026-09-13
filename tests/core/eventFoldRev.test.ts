/**
 * TASK-027：`rev` 语义回归测试。
 *
 * 契约（nodeSignature 只读 `kind|rev`）：
 * - **内容变了 rev 必变** —— 否则该次变更不会重绘（消息停在旧内容）；
 * - **内容没变 rev 不变** —— 否则缓存白白失效，性能优化归零。
 *
 * 因此每个「影响渲染的就地修改」都必须被这里钉住。
 */
import { describe, expect, it } from "vitest";
import {
  createSessionView,
  foldAssistantStreamFrame,
  foldEvent,
  type AssistantNode,
  type CommandNode,
  type SessionView,
} from "../../src/core/eventFold";
import type { AssistantStreamFrame, SessionEvent } from "../../src/transport/types";

function ev(type: string, seq: number, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: seq * 1000, data };
}

/** 取最后一个节点（不用 Array.prototype.at：tsconfig lib 为 ES2018）。 */
function last(view: SessionView): { kind: string; rev: number } {
  const node = view.nodes[view.nodes.length - 1];
  if (!node) throw new Error("视图没有任何节点");
  return node;
}

function assistantAt(view: SessionView, index = 0): AssistantNode {
  const node = view.nodes[index];
  if (!node || node.kind !== "assistant") throw new Error(`节点 ${index} 不是 assistant`);
  return node;
}

function commandAt(view: SessionView, index = 0): CommandNode {
  const node = view.nodes[index];
  if (!node || node.kind !== "command") throw new Error(`节点 ${index} 不是 command`);
  return node;
}

/** 折叠一个 assistant 文本流（建立流式节点），返回该节点。 */
function streamText(view: SessionView, text: string, startSeq = 1): AssistantNode {
  foldEvent(view, ev("assistant/chunk", startSeq, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text } }));
  return assistantAt(view);
}

const streamChunk = (chunk: Record<string, unknown>, index = 0): AssistantStreamFrame => ({
  type: "chunk",
  attemptId: "a1",
  revision: index,
  index,
  time: 1,
  chunk: chunk as never,
});

describe("rev 初始值与新建节点", () => {
  it("各类新节点 rev 从 0 起，且不因无关事件漂移", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("user/message", 1, { id: "m1", content: [{ type: "text", text: "你好" }], source: { kind: "user" } }));
    foldEvent(view, ev("command/run", 2, { commandId: "cmd1", name: "/plan" }));
    expect(view.nodes.map((n) => [n.kind, n.rev])).toEqual([
      ["user", 0],
      ["command", 0],
    ]);

    // session/title 与未知事件不碰节点
    foldEvent(view, ev("session/title", 3, { title: "标题" }));
    foldEvent(view, ev("some/unknown-event", 4, {}));
    expect(view.nodes.map((n) => n.rev)).toEqual([0, 0]);
  });
});

describe("applyChunk（durable assistant/chunk 与瞬态 assistant-stream 共用）", () => {
  it("text-delta 追加文本并 bump", () => {
    const view = createSessionView("s1");
    const node = streamText(view, "你");
    expect(node.text).toBe("你");
    expect(node.rev).toBe(1);

    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "好" } }));
    expect(node.text).toBe("你好");
    expect(node.rev).toBe(2);
  });

  it("空 text-delta 不改内容也不 bump", () => {
    const view = createSessionView("s1");
    const node = streamText(view, "你");
    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "" } }));
    expect(node.text).toBe("你");
    expect(node.rev).toBe(1);
  });

  // TASK-029 改写了本用例原先的契约（原文："reasoning 不参与渲染，故不 bump"）：
  // 插件现在渲染「思考过程」折叠块，**不 bump 就等于推理内容永不刷新**；但逐帧 bump 会退回
  // TASK-013 的每帧重建 DOM。故改为按时间窗节流——本用例钉住"首个增量必 bump"，节流窗内的
  // 抑制与跨窗恢复由 tests/core/reasoningFold.test.ts 专门覆盖。
  it("reasoning-delta 累积到 reasoning 并触发一次 bump（TASK-029：reasoning 参与渲染）", () => {
    const view = createSessionView("s1");
    const node = streamText(view, "正文");
    const base = node.rev;
    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 1, text: "思考" } }));
    expect(node.reasoning).toBe("思考");
    expect(node.rev).toBe(base + 1); // 首次 reasoning 变化必须到达 DOM
    expect(node.reasoningBumpedAt).toBeTypeOf("number"); // 并记下节流窗口起点

    // 同一窗口内的后续增量：文本继续累积，但不再逐帧作废节点缓存
    foldEvent(view, ev("assistant/chunk", 3, { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 1, text: "更多" } }));
    expect(node.reasoning).toBe("思考更多");
    expect(node.rev).toBe(base + 1);
  });

  it("block-start / 未知 chunk 不 bump", () => {
    const view = createSessionView("s1");
    const node = streamText(view, "正文");
    const base = node.rev;
    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    foldEvent(view, ev("assistant/chunk", 3, { turn: 1, step: 1, chunk: { type: "usage", inputTokens: 1 } }));
    expect(node.rev).toBe(base);
  });

  it("block-end(tool-call) 建卡并 bump", () => {
    const view = createSessionView("s1");
    const node = streamText(view, "先查");
    const base = node.rev;
    foldEvent(view, ev("assistant/chunk", 2, {
      turn: 1,
      step: 1,
      chunk: { type: "block-end", index: 1, block: { type: "tool-call", id: "c1", name: "read", arguments: '{"p":"a"}' } },
    }));
    expect(node.toolCards).toHaveLength(1);
    expect(node.rev).toBe(base + 1);
  });

  it("tool-call-delta 命中运行中卡片才 bump；未命中 id / 空增量 / 已结算卡片均不 bump", () => {
    const view = createSessionView("s1");
    // 走真实线上顺序：流式节点上先由 block-end 建 running 卡
    foldEvent(view, ev("assistant/chunk", 1, {
      turn: 1, step: 1,
      chunk: { type: "block-end", index: 0, block: { type: "tool-call", id: "c1", name: "read", arguments: '{"p":' } },
    }));
    const node = assistantAt(view);
    const base = node.rev;

    // 未命中 id
    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 0, id: "nope", argumentsDelta: "x" } }));
    expect(node.rev).toBe(base);

    // 命中且 running
    foldEvent(view, ev("assistant/chunk", 3, { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 0, id: "c1", argumentsDelta: '"a"}' } }));
    expect(node.toolCards[0].args).toBe('{"p":"a"}');
    expect(node.rev).toBe(base + 1);

    // 空增量不 bump
    foldEvent(view, ev("assistant/chunk", 4, { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 0, id: "c1", argumentsDelta: "" } }));
    expect(node.rev).toBe(base + 1);

    // 已结算（status !== running）后到达的迟到增量不 bump
    foldEvent(view, ev("tool/result", 5, {
      turn: 1, step: 1,
      message: { id: "tr1", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "ok" }], isError: false }], source: { kind: "tool", callId: "c1" } },
    }));
    const settled = node.rev;
    foldEvent(view, ev("assistant/chunk", 6, { turn: 1, step: 1, chunk: { type: "tool-call-delta", index: 0, id: "c1", argumentsDelta: "迟到" } }));
    expect(node.rev).toBe(settled);
    expect(node.toolCards[0].args).toBe('{"p":"a"}');
  });
});

describe("assistant/message", () => {
  it("收尾流式节点（streaming true→false）bump，并补齐文本", () => {
    const view = createSessionView("s1");
    const node = streamText(view, "流式正文");
    const base = node.rev;
    foldEvent(view, ev("assistant/message", 2, {
      turn: 1, step: 1,
      message: { id: "am1", content: [{ type: "text", text: "流式正文" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    expect(node.streaming).toBe(false);
    expect(node.rev).toBe(base + 1);
  });

  it("重复同一 assistant/message（内容与状态均未变）不 bump", () => {
    const view = createSessionView("s1");
    const message = { id: "am1", content: [{ type: "text", text: "结果" }], source: { kind: "model", provider: "p", model: "m" } };
    foldEvent(view, ev("assistant/message", 1, { turn: 1, step: 1, message }));
    const node = assistantAt(view);
    const base = node.rev;
    foldEvent(view, ev("assistant/message", 2, { turn: 1, step: 1, message }));
    expect(node.text).toBe("结果");
    expect(node.rev).toBe(base);
  });

  it("新建非流式节点：空文本且无工具卡时 rev 保持 0", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, { turn: 1, step: 1, message: { id: "am1", content: [], source: { kind: "model", provider: "p", model: "m" } } }));
    expect(assistantAt(view).rev).toBe(0);
  });

  it("新增工具卡 bump；重复同一 call 不重复 bump", () => {
    const view = createSessionView("s1");
    const message = {
      id: "am1",
      content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }],
      source: { kind: "model", provider: "p", model: "m" },
    };
    foldEvent(view, ev("assistant/message", 1, { turn: 1, step: 1, message }));
    const node = assistantAt(view);
    const base = node.rev;
    expect(node.toolCards).toHaveLength(1);
    foldEvent(view, ev("assistant/message", 2, { turn: 1, step: 1, message }));
    expect(node.toolCards).toHaveLength(1);
    expect(node.rev).toBe(base);
  });

  it("推理模型答案全在 reasoning 里：提升为 text 时 bump", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: { id: "am1", content: [{ type: "reasoning", text: "简单输出即可。" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    const node = assistantAt(view);
    expect(node.text).toBe("简单输出即可。");
    expect(node.rev).toBeGreaterThan(0);
  });
});

describe("tool/result", () => {
  function seedCard(view: SessionView): AssistantNode {
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: { id: "am1", content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    return assistantAt(view);
  }

  const result = (seq: number, text: string) =>
    ev("tool/result", seq, {
      turn: 1, step: 1,
      message: { id: "tr1", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text }], isError: false }], source: { kind: "tool", callId: "c1" } },
    });

  it("结算状态与结果文本变化时 bump", () => {
    const view = createSessionView("s1");
    const node = seedCard(view);
    const base = node.rev;
    foldEvent(view, result(2, "文件内容"));
    expect(node.toolCards[0]).toMatchObject({ status: "done", resultText: "文件内容" });
    expect(node.rev).toBe(base + 1);
  });

  it("重复同一结果（状态与文本均未变）不 bump", () => {
    const view = createSessionView("s1");
    const node = seedCard(view);
    foldEvent(view, result(2, "文件内容"));
    const base = node.rev;
    foldEvent(view, result(3, "文件内容"));
    expect(node.rev).toBe(base);
  });

  it("未命中 callId 不 bump", () => {
    const view = createSessionView("s1");
    const node = seedCard(view);
    const base = node.rev;
    foldEvent(view, ev("tool/result", 2, {
      turn: 1, step: 1,
      message: { id: "tr1", content: [{ type: "tool-result", toolCallId: "other", content: [{ type: "text", text: "x" }] }], source: { kind: "tool", callId: "other" } },
    }));
    expect(node.rev).toBe(base);
  });
});

describe("turn/end", () => {
  it("收尾流式节点 bump；reasoning 兜底提升为 text 时再 bump", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/chunk", 1, { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "只有推理" } }));
    const node = assistantAt(view);
    const base = node.rev;

    foldEvent(view, ev("turn/end", 2, { turn: 1, reason: { kind: "completed" } }));
    expect(node.streaming).toBe(false);
    expect(node.text).toBe("只有推理");
    expect(node.rev).toBeGreaterThan(base);
  });

  it("已收尾节点再收一次不重复 bump", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: { id: "am1", content: [{ type: "text", text: "结果" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    const node = assistantAt(view);
    const base = node.rev;
    foldEvent(view, ev("turn/end", 2, { turn: 1, reason: { kind: "completed" } }));
    expect(node.rev).toBe(base);
  });

  it("错误回合新建 error 节点（rev 0）", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("turn/end", 1, { turn: 1, reason: { kind: "error", error: { message: "模型挂了" } } }));
    expect(last(view)).toMatchObject({ kind: "error", text: "模型挂了", rev: 0 });
  });
});

describe("command/done", () => {
  it("状态与文本变化时 bump", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("command/run", 1, { commandId: "cmd1", name: "/plan" }));
    const node = commandAt(view);
    foldEvent(view, ev("command/done", 2, { commandId: "cmd1", kind: "success", text: "已开启" }));
    expect(node.status).toBe("success");
    expect(node.text).toBe("已开启");
    expect(node.rev).toBe(1);
  });

  it("重复同一 command/done 不 bump", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("command/run", 1, { commandId: "cmd1", name: "/plan" }));
    const node = commandAt(view);
    foldEvent(view, ev("command/done", 2, { commandId: "cmd1", kind: "success", text: "已开启" }));
    const base = node.rev;
    foldEvent(view, ev("command/done", 3, { commandId: "cmd1", kind: "success", text: "已开启" }));
    expect(node.rev).toBe(base);
  });

  it("未命中 commandId 不 bump", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("command/run", 1, { commandId: "cmd1", name: "/plan" }));
    const node = commandAt(view);
    foldEvent(view, ev("command/done", 2, { commandId: "other", kind: "success" }));
    expect(node.rev).toBe(0);
  });
});

describe("foldAssistantStreamFrame（0.1.5 瞬态帧）", () => {
  it("start 建节点 rev 0；text-delta bump；end（非 message 结算）收尾并 bump", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, { type: "start", attemptId: "a1", revision: 0, startedAfterSeq: 0, turn: 1, step: 1 });
    const node = assistantAt(view);
    expect(node.rev).toBe(0);

    foldAssistantStreamFrame(view, streamChunk({ type: "text-delta", index: 0, text: "你" }, 1));
    foldAssistantStreamFrame(view, streamChunk({ type: "text-delta", index: 0, text: "好" }, 2));
    expect(node.text).toBe("你好");
    expect(node.rev).toBe(2);

    foldAssistantStreamFrame(view, {
      type: "end", attemptId: "a1", revision: 3, index: 2,
      outcome: { kind: "committed", eventType: "assistant/attempt", seq: 9 },
    });
    expect(node.streaming).toBe(false);
    expect(node.rev).toBe(3);
  });

  it("end 声明由 assistant/message 结算时不在此收尾（避免重复消息），也不 bump", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, { type: "start", attemptId: "a1", revision: 0, startedAfterSeq: 0, turn: 1, step: 1 });
    foldAssistantStreamFrame(view, streamChunk({ type: "text-delta", index: 0, text: "正文" }, 1));
    const node = assistantAt(view);
    const base = node.rev;

    foldAssistantStreamFrame(view, {
      type: "end", attemptId: "a1", revision: 2, index: 1,
      outcome: { kind: "committed", eventType: "assistant/message", seq: 30 },
    });
    expect(node.streaming).toBe(true);
    expect(node.rev).toBe(base);

    // 随后 durable assistant/message 收尾（唯一一次 bump）
    foldEvent(view, ev("assistant/message", 30, { turn: 1, step: 1, message: { id: "m1", content: [{ type: "text", text: "正文" }] } }));
    expect(view.nodes).toHaveLength(1);
    expect(node.streaming).toBe(false);
    expect(node.rev).toBe(base + 1);
  });

  // TASK-029：reasoning 参与渲染后本用例的旧契约（"同样不 bump"）已废弃，
  // 改为"首个增量 bump 一次、同窗内不再 bump"（节流细节见 reasoningFold.test.ts）。
  it("reasoning-delta 经瞬态帧累积并 bump 一次", () => {
    const view = createSessionView("s1");
    foldAssistantStreamFrame(view, { type: "start", attemptId: "a1", revision: 0, startedAfterSeq: 0, turn: 1, step: 1 });
    const node = assistantAt(view);
    foldAssistantStreamFrame(view, streamChunk({ type: "reasoning-delta", index: 0, text: "考虑" }, 1));
    expect(node.reasoning).toBe("考虑");
    expect(node.rev).toBe(1);

    foldAssistantStreamFrame(view, streamChunk({ type: "reasoning-delta", index: 0, text: "中" }, 2));
    expect(node.reasoning).toBe("考虑中");
    expect(node.rev).toBe(1); // 同窗抑制：不逐帧重建 DOM
  });
});
