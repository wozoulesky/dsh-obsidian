/**
 * `describeNode`：把 ViewNode 映射成「该如何呈现」的纯规格。
 *
 * 为什么需要它：`chatView.buildNodeEl` 是 60+ 行的分支瀑布（user/error/command/notice/assistant），
 * 而它依赖 `this.nodesEl` / `this.runtime`，在 node 环境下无法直接单测。
 * 结果是**渲染分类从未有过自动化保护** —— 分支顺序或 className 被改动只有真机才能发现。
 *
 * 本次 P1-4（回合静默丢失）正是加在其中的一个分支：notice 必须渲染成 `dsh-msg-context`
 * 且**不能落到 assistant 兜底**（否则会显示一个空助手气泡）。把分类抽成纯函数后，
 * 这类回归能被立即抓住。
 *
 * 注：只抽出「分类 + 类名 + 文本」这层决策；Markdown 渲染、工具卡 DOM、
 * 推理折叠等副作用仍留在 chatView 里（它们需要真实 DOM）。
 */
import { describe, expect, it } from "vitest";
import { describeNode } from "../../src/ui/nodeRender";
import type { Translate } from "../../src/ui/sessionStatus";
import type { ViewNode } from "../../src/core/eventFold";
import { EN_STRINGS } from "../../src/i18n";

const t: Translate = (key, params) => {
  const tpl = (EN_STRINGS as Record<string, string>)[key] ?? key;
  if (!params) return tpl;
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ""));
};

const user = (over: Partial<Extract<ViewNode, { kind: "user" }>> = {}) =>
  ({ kind: "user", id: "u1", text: "hi", sourceKind: "user", imageCount: 0, seq: 1, rev: 0, ...over }) as ViewNode;
const error = (over: Partial<Extract<ViewNode, { kind: "error" }>> = {}) =>
  ({ kind: "error", id: "e1", text: "boom", seq: 4, rev: 0, ...over }) as ViewNode;
const command = (over: Partial<Extract<ViewNode, { kind: "command" }>> = {}) =>
  ({ kind: "command", id: "c1", name: "/plan", status: "running", seq: 2, rev: 0, ...over }) as ViewNode;
const notice = (over: Partial<Extract<ViewNode, { kind: "notice" }>> = {}) =>
  ({ kind: "notice", id: "n1", reason: "blocked", seq: 5, rev: 0, ...over }) as ViewNode;
const assistant = (over: Partial<Extract<ViewNode, { kind: "assistant" }>> = {}) =>
  ({
    kind: "assistant",
    id: "a1",
    text: "answer",
    reasoning: "",
    toolCards: [],
    streaming: false,
    seq: 3,
    rev: 0,
    ...over,
  }) as ViewNode;

describe("describeNode 分类与类名", () => {
  it("user（本人）→ dsh-msg-user，正文原样", () => {
    const d = describeNode(user(), t);
    expect(d.cls).toBe("dsh-msg-user");
    expect(d.kind).toBe("user");
    expect(d.text).toBe("hi");
  });

  it("user（上下文注入）→ dsh-msg-context", () => {
    const d = describeNode(user({ sourceKind: "context" }), t);
    expect(d.cls).toBe("dsh-msg-context");
  });

  it("带图消息额外给出 imageCount 文案", () => {
    const d = describeNode(user({ imageCount: 2 }), t);
    expect(d.imageLabel).toContain("2");
  });

  it("无图消息不产出 imageLabel", () => {
    expect(describeNode(user({ imageCount: 0 }), t).imageLabel).toBeUndefined();
  });

  it("error → dsh-msg-context，且带 turnError 前缀文案", () => {
    const d = describeNode(error(), t);
    expect(d.cls).toBe("dsh-msg-context");
    expect(d.text).toContain("boom");
  });

  it("command running/success/error 三种状态的标记不同", () => {
    const running = describeNode(command({ status: "running" }), t);
    const ok = describeNode(command({ status: "success" }), t);
    const bad = describeNode(command({ status: "error" }), t);
    expect(running.cls).toBe("dsh-msg-command");
    expect(running.text).not.toBe(ok.text);
    expect(ok.text).not.toBe(bad.text);
    // 三者都必须带命令名
    for (const d of [running, ok, bad]) expect(d.text).toContain("/plan");
  });

  it("command 带正文时用 WithText 变体", () => {
    const d = describeNode(command({ status: "success", text: "done!" }), t);
    expect(d.text).toContain("done!");
  });
});

describe("describeNode：notice 不得落到 assistant 兜底（P1-4 回归保护）", () => {
  it("notice → dsh-msg-context，而不是 dsh-msg-assistant", () => {
    const d = describeNode(notice({ reason: "blocked" }), t);
    expect(d.kind).toBe("notice");
    expect(d.cls).toBe("dsh-msg-context");
    expect(d.cls).not.toBe("dsh-msg-assistant");
  });

  it("notice 渲染的是「未执行」语义，不带 Error 字样、不被当成助手回复", () => {
    const d = describeNode(notice({ reason: "blocked" }), t);
    expect(d.text.toLowerCase()).not.toContain("error");
    expect(d.text.length).toBeGreaterThan(0);
  });

  it("blocked / aborted / interrupted / max-tokens 文案互不相同", () => {
    const texts = ["blocked", "aborted", "interrupted", "max-tokens"].map((r) => describeNode(notice({ reason: r }), t).text);
    expect(new Set(texts).size).toBe(4);
  });

  it("未知 reason 也给出可读文案（不留空白）", () => {
    const d = describeNode(notice({ reason: "some-future-kind" }), t);
    expect(d.text.length).toBeGreaterThan(0);
    expect(d.text).toContain("some-future-kind");
  });
});

describe("describeNode：assistant 兜底", () => {
  it("assistant → dsh-msg-assistant，正文原样", () => {
    const d = describeNode(assistant({ text: "hello" }), t);
    expect(d.kind).toBe("assistant");
    expect(d.cls).toBe("dsh-msg-assistant");
    expect(d.text).toBe("hello");
  });

  it("assistant 正文为空时给出占位文案，不留空白气泡", () => {
    const d = describeNode(assistant({ text: "" }), t);
    expect(d.text.length).toBeGreaterThan(0);
  });
});
