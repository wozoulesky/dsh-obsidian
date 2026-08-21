import { describe, expect, it } from "vitest";
import { classifyTurnState, extractLastAssistantText, renderInlineEditPrompt, sleep } from "../../src/core/inlineEdit";
import { createSessionView, foldEvent } from "../../src/core/eventFold";

describe("renderInlineEditPrompt", () => {
  it("包含路径、选区与指令", () => {
    const p = renderInlineEditPrompt("notes/a.md", "原文", "改简洁");
    expect(p).toContain("notes/a.md");
    expect(p).toContain("原文");
    expect(p).toContain("改简洁");
    expect(p).toContain("只输出替换后的文本");
  });
});

describe("extractLastAssistantText", () => {
  it("提取最后一条已终结的 assistant 文本", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "user", id: "u", text: "x", sourceKind: "user", seq: 1 });
    view.nodes.push({ kind: "assistant", id: "a1", text: "```markdown\n结果A\n```", reasoning: "", toolCards: [], streaming: false, seq: 2 });
    view.nodes.push({ kind: "assistant", id: "a2", text: "结果B", reasoning: "", toolCards: [], streaming: false, seq: 3 });
    expect(extractLastAssistantText(view, 0)).toBe("结果B");
  });

  it("去掉 markdown 代码围栏", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a", text: "```\n纯文本\n```", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    expect(extractLastAssistantText(view, 0)).toBe("纯文本");
  });

  it("无 assistant 节点时抛错", () => {
    const view = createSessionView("s");
    expect(() => extractLastAssistantText(view, 0)).toThrow();
  });
});

describe("sleep", () => {
  it("大约等待指定毫秒", async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});

describe("classifyTurnState", () => {
  it("running 或未推进时为 pending", () => {
    const view = createSessionView("s");
    expect(classifyTurnState(view, 0).kind).toBe("pending");
    view.running = true;
    view.lastSeq = 5;
    expect(classifyTurnState(view, 0).kind).toBe("pending");
  });

  it("本回合（turn/start 在 sinceSeq 之后）未开始前恒为 pending，旧回合收尾不算结果", () => {
    // 上次内联编辑超时但服务端回合仍在跑：sinceSeq 后到达的旧回合节点（seq > sinceSeq）
    // 绝不能判 ready/error——本回合的 turn/start 还没出现。
    const view = createSessionView("s");
    view.lastSeq = 6;
    view.lastTurnStartSeq = 2; // 旧回合的 start，早于 sinceSeq
    view.lastTurnEndSeq = 6; // 旧回合已结束
    view.nodes.push({ kind: "assistant", id: "a5", text: "旧结果", reasoning: "", toolCards: [], streaming: false, seq: 5 });
    expect(classifyTurnState(view, 2).kind).toBe("pending");
  });

  it("本轮错误节点立即判 error，不回落旧文本", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a0", text: "旧结果", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    view.lastSeq = 3;
    view.lastTurnStartSeq = 2; // 本回合已开始
    view.nodes.push({ kind: "error", id: "e2", text: "回合错误：模型挂了", seq: 3 });
    const state = classifyTurnState(view, 1);
    expect(state.kind).toBe("error");
  });

  it("轮内旧回合残留（seq > sinceSeq 但早于本轮 turn/start）不参与判定", () => {
    const view = createSessionView("s");
    view.lastSeq = 8;
    view.lastTurnStartSeq = 5;
    view.lastTurnEndSeq = 6;
    // 旧回合残留：seq 3 > sinceSeq 2，但早于本回合 start（5）
    view.nodes.push({ kind: "assistant", id: "a3", text: "旧回合残留", reasoning: "", toolCards: [], streaming: false, seq: 3 });
    // 本回合结束但无文本 → error（而不是拿旧残留判 ready）
    expect(classifyTurnState(view, 2).kind).toBe("error");
  });

  it("本轮已终结 assistant 判 ready，旧 assistant 不算", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a0", text: "旧结果", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    view.lastSeq = 4;
    view.lastTurnStartSeq = 3;
    view.nodes.push({ kind: "assistant", id: "a2", text: "新结果", reasoning: "", toolCards: [], streaming: false, seq: 4 });
    expect(classifyTurnState(view, 2).kind).toBe("ready");
    // 旧节点不越过 sinceSeq：无新 assistant 时回落 pending 而非旧文本
    expect(classifyTurnState(view, 5).kind).toBe("pending");
  });

  it("extractLastAssistantText 不越过 sinceSeq", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a0", text: "旧结果", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    expect(() => extractLastAssistantText(view, 2)).toThrow();
  });

  it("本轮回合已结束但无文本时立即判 error", () => {
    const view = createSessionView("s");
    view.lastSeq = 5;
    view.lastTurnStartSeq = 4; // 本回合已开始
    view.lastTurnEndSeq = 5;
    const state = classifyTurnState(view, 0);
    expect(state.kind).toBe("error");
  });

  it("推理模型答案写在 thinking 里（真实线上形状）时全链路可判 ready 并提取文本", () => {
    const view = createSessionView("s");
    const ev = (type: string, seq: number, data: Record<string, unknown>) => ({ type, seq, time: seq * 1000, data });
    foldEvent(view, ev("turn/start", 10, { turn: 1 }));
    foldEvent(view, ev("assistant/message", 11, {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [{ type: "reasoning", text: "简单输出即可。成功。" }],
        source: { kind: "model", provider: "p", model: "m" },
      },
    }));
    foldEvent(view, ev("turn/end", 12, { turn: 1, reason: { kind: "completed" } }));
    const state = classifyTurnState(view, 9);
    expect(state.kind).toBe("ready");
    if (state.kind === "ready") {
      expect(extractLastAssistantText(state.view, 9)).toBe("简单输出即可。成功。");
    }
  });
});
