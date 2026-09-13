/**
 * TASK-029 项 2/3 的展示层纯函数（`src/ui/sessionStatus.ts`）。
 *
 * 这一层承担三条用户可见的验收要求，故逐条钉住：
 * - 上下文用量：`projectedTokens / contextWindow`，缺 contextWindow 只显示 tokens；
 * - 数据缺失/畸形 → 返回 null → chatView 完全不渲染（不产生空壳元素）；
 * - 待办清单：三态计数摘要（零计数段省略）+ 渲染签名（签名不变时 chatView 一帧 DOM 都不动）。
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_STRINGS } from "../../src/i18n";
import {
  TODO_GLYPH,
  contextUsageLine,
  contextUsageText,
  formatTokens,
  renderReasoning,
  todoCounts,
  todoSummaryText,
  todosSignature,
  tokenUsageText,
  writeMetrics,
  writeTodos,
  type PanelElement,
  type Translate,
} from "../../src/ui/sessionStatus";
import type { TodoItem } from "../../src/core/eventFold";

/** 用内置中文默认文案充当 t（等价于 chatView 注入的 runtime.i18n.t，但无 Obsidian 依赖）。 */
const t: Translate = (key, params) => {
  let text = DEFAULT_STRINGS[key] ?? key;
  if (params) text = text.replace(/\{(\w+)\}/g, (m, name: string) => (params[name] !== undefined ? String(params[name]) : m));
  return text;
};

describe("formatTokens", () => {
  it("千位以下原样、千位与百万位紧凑显示", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(179238)).toBe("179.2k");
    expect(formatTokens(1000000)).toBe("1M");
    expect(formatTokens(10560640)).toBe("10.6M");
  });

  it("零头为 0 时省略小数（179000 → 179k 而非 179.0k）", () => {
    expect(formatTokens(179000)).toBe("179k");
    expect(formatTokens(2000000)).toBe("2M");
  });

  it("畸形输入不外抛（NaN/负数）", () => {
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("contextUsageLine / contextUsageText", () => {
  it("缺省投影 → null（冷会话完全不渲染）", () => {
    expect(contextUsageLine(undefined)).toBeNull();
    expect(contextUsageText(undefined, t)).toBeNull();
  });

  it("只有 pressureTokens 时用它（projectedTokens 缺省的 provider）", () => {
    expect(contextUsageLine({ pressureTokens: 1000 })).toEqual({ tokens: 1000 });
  });

  it("优先 projectedTokens（下一个请求的预估），并带上 contextWindow", () => {
    expect(contextUsageLine({ pressureTokens: 179009, projectedTokens: 179238, contextWindow: 1000000 })).toEqual({ tokens: 179238, window: 1000000 });
  });

  it("无 contextWindow → 只显示 tokens；有 → `used / window`", () => {
    expect(contextUsageText({ projectedTokens: 179238 }, t)).toBe("上下文 179.2k");
    expect(contextUsageText({ projectedTokens: 179238, contextWindow: 1000000 }, t)).toBe("上下文 179.2k / 1M");
  });

  it("contextWindow 非正数/NaN 视为缺失（不渲染 `x / 0`）", () => {
    expect(contextUsageLine({ projectedTokens: 5, contextWindow: 0 })).toEqual({ tokens: 5 });
    expect(contextUsageLine({ projectedTokens: 5, contextWindow: -3 })).toEqual({ tokens: 5 });
    expect(contextUsageText({ projectedTokens: 5, contextWindow: Number.NaN }, t)).toBe("上下文 5");
  });

  it("空对象（真机形态）与全畸形 → null", () => {
    expect(contextUsageLine({})).toBeNull();
    expect(contextUsageLine({ projectedTokens: Number.NaN })).toBeNull();
    expect(contextUsageLine({ projectedTokens: -1 })).toBeNull();
  });
});

describe("tokenUsageText", () => {
  it("缺失或 0 → null（不渲染无信息量的「输出 0」）", () => {
    expect(tokenUsageText(undefined, t)).toBeNull();
    expect(tokenUsageText({}, t)).toBeNull();
    expect(tokenUsageText({ outputTokens: 0 }, t)).toBeNull();
  });

  it("有输出量时给出紧凑文案", () => {
    expect(tokenUsageText({ uncachedInputTokens: 503737, outputTokens: 54421 }, t)).toBe("输出 54.4k");
  });

  it("畸形 input 不影响（只有 outputTokens 参与）", () => {
    expect(tokenUsageText({ outputTokens: Number.NaN }, t)).toBeNull();
    expect(tokenUsageText({ outputTokens: -1 }, t)).toBeNull();
  });
});

describe("待办计数与摘要", () => {
  const list: TodoItem[] = [
    { content: "A", status: "completed" },
    { content: "B", status: "completed" },
    { content: "C", status: "in_progress" },
    { content: "D", status: "pending" },
  ];

  it("三态计数", () => {
    expect(todoCounts(list)).toEqual({ done: 2, active: 1, pending: 1 });
    expect(todoCounts(null)).toEqual({ done: 0, active: 0, pending: 0 });
    expect(todoCounts([])).toEqual({ done: 0, active: 0, pending: 0 });
  });

  it("摘要按官方语义省略零计数段", () => {
    expect(todoSummaryText(list, t)).toBe("2 已完成 · 1 进行中 · 1 待处理");
    expect(todoSummaryText([{ content: "A", status: "pending" }], t)).toBe("1 待处理");
    expect(todoSummaryText([{ content: "A", status: "in_progress" }], t)).toBe("1 进行中");
    expect(todoSummaryText([{ content: "A", status: "completed" }], t)).toBe("1 已完成");
  });

  it("三态图标齐全（UI 用 TODO_GLYPH[status] 直接取）", () => {
    expect(Object.keys(TODO_GLYPH).sort()).toEqual(["completed", "in_progress", "pending"]);
    expect(new Set(Object.values(TODO_GLYPH)).size).toBe(3);
  });
});

describe("todosSignature（DOM 重建的判据）", () => {
  const a: TodoItem = { content: "A", status: "pending" };
  const b: TodoItem = { content: "B", status: "completed" };

  it("空/null/undefined 归一为同一个空签名（UI 隐藏面板）", () => {
    expect(todosSignature([])).toBe("");
    expect(todosSignature(null)).toBe("");
    expect(todosSignature(undefined)).toBe("");
  });

  it("内容或状态变化 → 签名变化（UI 必须重建）", () => {
    expect(todosSignature([a])).not.toBe(todosSignature([b]));
    expect(todosSignature([a])).not.toBe(todosSignature([{ content: "A", status: "completed" }]));
    expect(todosSignature([a])).not.toBe(todosSignature([a, b]));
    expect(todosSignature([a, b])).not.toBe(todosSignature([b, a])); // 顺序也算变化
  });

  it("内容不变 → 签名不变（UI 一帧 DOM 都不动，保住展开状态）", () => {
    expect(todosSignature([a, b])).toBe(todosSignature([{ content: "A", status: "pending" }, { content: "B", status: "completed" }]));
  });

  it("签名带分隔符：不会把单条含分隔符的内容与两条撞签名", () => {
    expect(todosSignature([{ content: "a\u0000b", status: "pending" }])).not.toBe(todosSignature([{ content: "a", status: "pending" }, { content: "b", status: "pending" }]));
  });
});

/**
 * 轻量元素替身：只实现 `PanelElement` 契约，记录结构变更次数——
 * 于是"是否重建 DOM"这件事在 Node 里可被直接断言（vitest 环境无 DOM）。
 */
interface FakeOptions {
  cls?: string;
  text?: string;
  attr?: Record<string, string>;
}

class FakeElement implements PanelElement {
  children: FakeElement[] = [];
  classes = new Set<string>();
  text = "";
  attrs: Record<string, string>;
  /** 结构变更计数：empty/createEl 调用次数即"是否重建了 DOM"的证据。 */
  stats = { emptied: 0, created: 0, setTextCalls: 0 };

  constructor(readonly tag = "div", options: FakeOptions = {}) {
    this.text = options.text ?? "";
    this.attrs = options.attr ?? {};
    for (const cls of (options.cls ?? "").split(" ")) if (cls.length > 0) this.classes.add(cls);
  }

  empty(): void {
    this.stats.emptied += 1;
    this.children = [];
  }
  setText(text: string): void {
    this.stats.setTextCalls += 1;
    this.text = text;
  }
  addClass(cls: string): void {
    this.classes.add(cls);
  }
  removeClass(cls: string): void {
    this.classes.delete(cls);
  }
  toggleClass(cls: string, value: boolean): void {
    if (value) this.classes.add(cls);
    else this.classes.delete(cls);
  }
  createEl(tag: string, options: FakeOptions = {}): FakeElement {
    this.stats.created += 1;
    const el = new FakeElement(tag, options);
    this.children.push(el);
    return el;
  }
  createDiv(options: FakeOptions = {}): FakeElement {
    return this.createEl("div", options);
  }
  createSpan(options: FakeOptions = {}): FakeElement {
    return this.createEl("span", options);
  }

  has(cls: string): boolean {
    return this.classes.has(cls);
  }
  /** 深度优先找第一个带该类名的后代。 */
  find(cls: string): FakeElement | undefined {
    for (const child of this.children) {
      if (child.has(cls)) return child;
      const nested = child.find(cls);
      if (nested) return nested;
    }
    return undefined;
  }
  findAll(cls: string): FakeElement[] {
    return this.children.flatMap((child) => [...(child.has(cls) ? [child] : []), ...child.findAll(cls)]);
  }
}

describe("renderReasoning（思考过程折叠块）", () => {
  it("reasoning 为空 → 不创建任何节点（无空壳）", () => {
    const wrap = new FakeElement();
    expect(renderReasoning(wrap, "", false, 4000, t)).toBe(false);
    expect(wrap.children).toHaveLength(0);
  });

  it("流式期间默认展开（open 属性）且摘要标注生成中", () => {
    const wrap = new FakeElement();
    expect(renderReasoning(wrap, "先想想", true, 4000, t)).toBe(true);
    const details = wrap.children[0];
    expect(details.tag).toBe("details");
    expect(details.has("dsh-reasoning")).toBe(true);
    expect(details.attrs.open).toBe("");
    expect(details.children[0].tag).toBe("summary");
    expect(details.children[0].text).toBe("💭 思考过程（生成中）");
    expect(details.find("dsh-reasoning-body")?.text).toBe("先想想");
  });

  it("定格后默认折叠且摘要不带生成中", () => {
    const wrap = new FakeElement();
    renderReasoning(wrap, "想完了", false, 4000, t);
    const details = wrap.children[0];
    expect(details.attrs.open).toBeUndefined();
    expect(details.children[0].text).toBe("💭 思考过程");
    expect(details.find("dsh-reasoning-body")?.text).toBe("想完了");
  });

  it("超长推理：流式取尾部（看到最新思考）、定格取头部（从头读），都受 maxChars 约束", () => {
    const head = "H".repeat(30);
    const tail = "T".repeat(30);
    const long = `${head}${tail}`;

    const streaming = new FakeElement();
    renderReasoning(streaming, long, true, 10, t);
    const streamedBody = streaming.find("dsh-reasoning-body")?.text ?? "";
    expect(streamedBody.endsWith("T".repeat(10))).toBe(true);
    expect(streamedBody).toHaveLength(11); // "…" + 10

    const settled = new FakeElement();
    renderReasoning(settled, long, false, 10, t);
    const settledBody = settled.find("dsh-reasoning-body")?.text ?? "";
    expect(settledBody.startsWith("H".repeat(10))).toBe(true);
    expect(settledBody).toHaveLength(11);
  });

  it("结构顺序：details 先于正文（chatView 先调它再建正文节点）", () => {
    const wrap = new FakeElement();
    renderReasoning(wrap, "思考", true, 4000, t);
    const body = wrap.createDiv();
    expect(wrap.children.map((c) => c.tag)).toEqual(["details", "div"]);
    expect(body.has("dsh-reasoning")).toBe(false);
  });
});

describe("writeMetrics（上下文用量行：数据缺失完全不渲染）", () => {
  it("无数据 → 加 dsh-hidden 且文本清空", () => {
    const el = new FakeElement();
    expect(writeMetrics(el, null, null)).toBeNull();
    expect(el.has("dsh-hidden")).toBe(false); // 首次已是 null（初始态）：一帧都不动
    expect(writeMetrics(el, null, "上下文 1k")).toBeNull();
    expect(el.has("dsh-hidden")).toBe(true);
    expect(el.text).toBe("");
  });

  it("有数据 → 移除 dsh-hidden 并写入文案", () => {
    const el = new FakeElement();
    el.addClass("dsh-hidden");
    expect(writeMetrics(el, "上下文 179.2k / 1M", null)).toBe("上下文 179.2k / 1M");
    expect(el.has("dsh-hidden")).toBe(false);
    expect(el.text).toBe("上下文 179.2k / 1M");
  });

  it("文案未变 → 完全不碰 DOM（renderNow 每帧都调它）", () => {
    const el = new FakeElement();
    writeMetrics(el, "上下文 1k", null);
    const before = { ...el.stats };
    expect(writeMetrics(el, "上下文 1k", "上下文 1k")).toBe("上下文 1k");
    expect(el.stats).toEqual(before);
  });
});

describe("writeTodos（待办面板 DOM）", () => {
  const list: TodoItem[] = [
    { content: "读代码", status: "completed" },
    { content: "写实现", status: "in_progress" },
    { content: "补测试", status: "pending" },
  ];

  it("空/null → 隐藏且不建面板（不渲染空壳）", () => {
    const el = new FakeElement();
    expect(writeTodos(el, null, t, null)).toBe("");
    expect(el.has("dsh-hidden")).toBe(true);
    expect(el.children).toHaveLength(0);
    expect(writeTodos(el, [], t, "")).toBe("");
    expect(el.children).toHaveLength(0);
  });

  it("有清单 → 折叠面板 + 摘要（三态计数）+ 三项带状态 class 与图标", () => {
    const el = new FakeElement();
    writeTodos(el, list, t, null);
    expect(el.has("dsh-hidden")).toBe(false);
    const panel = el.children[0];
    expect(panel.tag).toBe("details");
    expect(panel.has("dsh-todos-panel")).toBe(true);
    expect(panel.attrs.open).toBeUndefined(); // 默认折叠（与官方 TodoPanel 一致）
    expect(panel.children[0].text).toBe("待办 · 1 已完成 · 1 进行中 · 1 待处理");

    const items = panel.findAll("dsh-todo-item");
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.has("dsh-todo-completed") || i.has("dsh-todo-in_progress") || i.has("dsh-todo-pending"))).toEqual([true, true, true]);
    expect(items.map((i) => i.find("dsh-todo-glyph")?.text)).toEqual([TODO_GLYPH.completed, TODO_GLYPH.in_progress, TODO_GLYPH.pending]);
    expect(items.map((i) => i.children[1].text)).toEqual(["读代码", "写实现", "补测试"]);
  });

  it("内容未变 → 一帧 DOM 都不动（保住用户展开状态）", () => {
    const el = new FakeElement();
    const sig = writeTodos(el, list, t, null);
    const before = { ...el.stats };
    expect(writeTodos(el, list.map((i) => ({ ...i })), t, sig)).toBe(sig);
    expect(el.stats).toEqual(before);
  });

  it("状态变化 → 重建面板（进度摘要更新）", () => {
    const el = new FakeElement();
    let sig = writeTodos(el, list, t, null);
    const createdBefore = el.stats.created;
    sig = writeTodos(el, [{ content: "读代码", status: "completed" }, { content: "写实现", status: "completed" }, { content: "补测试", status: "in_progress" }], t, sig);
    expect(el.stats.created).toBeGreaterThan(createdBefore);
    expect(el.children[0].children[0].text).toBe("待办 · 2 已完成 · 1 进行中");
  });

  it("清单清空（null）→ 收起并清空面板内容", () => {
    const el = new FakeElement();
    const sig = writeTodos(el, list, t, null);
    expect(writeTodos(el, null, t, sig)).toBe("");
    expect(el.has("dsh-hidden")).toBe(true);
    expect(el.children).toHaveLength(0);
  });
});
