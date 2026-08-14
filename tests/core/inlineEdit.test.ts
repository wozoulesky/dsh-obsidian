import { describe, expect, it } from "vitest";
import { classifyTurnState, extractLastAssistantText, renderInlineEditPrompt, sleep } from "../../src/core/inlineEdit";
import { createSessionView } from "../../src/core/eventFold";

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

  it("本轮错误节点立即判 error，不回落旧文本", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a0", text: "旧结果", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    view.lastSeq = 3;
    view.nodes.push({ kind: "error", id: "e2", text: "回合错误：模型挂了", seq: 3 });
    const state = classifyTurnState(view, 2);
    expect(state.kind).toBe("error");
  });

  it("本轮已终结 assistant 判 ready，旧 assistant 不算", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a0", text: "旧结果", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    view.lastSeq = 4;
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
});
