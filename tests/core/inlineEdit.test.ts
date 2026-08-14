import { describe, expect, it } from "vitest";
import { extractLastAssistantText, renderInlineEditPrompt, sleep } from "../../src/core/inlineEdit";
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
    expect(extractLastAssistantText(view)).toBe("结果B");
  });

  it("去掉 markdown 代码围栏", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a", text: "```\n纯文本\n```", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    expect(extractLastAssistantText(view)).toBe("纯文本");
  });

  it("无 assistant 节点时抛错", () => {
    const view = createSessionView("s");
    expect(() => extractLastAssistantText(view)).toThrow();
  });
});

describe("sleep", () => {
  it("大约等待指定毫秒", async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});
