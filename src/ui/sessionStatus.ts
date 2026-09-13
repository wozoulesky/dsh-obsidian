/**
 * 底部状态区（上下文占用 / 输出用量 / 待办清单）的纯函数层。
 *
 * 拆出来的目的与 `headerSelect.ts` 相同：把"显示什么"与"怎么写 DOM"分开，
 * 让这些规则能在 Node 测试环境里被直接驱动（chatView 本身没有 DOM 测试环境）。
 *
 * 三条不变量（TASK-029 验收要求）：
 * 1. 数据缺失/畸形一律返回 `null` → UI 完全不渲染（冷会话没有这些投影，不产生空壳元素）。
 * 2. 截断/格式化只影响展示，不影响视图模型里的原始值。
 * 3. 待办清单的渲染签名只由「内容 + 状态」决定：签名不变时 UI 一帧 DOM 都不动
 *    （保住用户手动展开的状态，也避免每次 renderNow 重建列表）。
 */
import type { ContextPressure, TodoItem, TokenUsage } from "../core/eventFold";
import { truncate, truncateTail } from "./prompts";

/** i18n 取词函数签名（与 `I18n.t` 一致；用回调注入以免本模块依赖具体实现）。 */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** 待办三态图标（官方 UI 语义：pending 未开始 / in_progress 进行中 / completed 已完成）。 */
export const TODO_GLYPH: Record<TodoItem["status"], string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
};

/** 紧凑数字：999 → "999"；1000 → "1k"；179238 → "179.2k"；1000000 → "1M"。 */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${trimTrailingZero(tokens / 1000)}k`;
  return `${trimTrailingZero(tokens / 1_000_000)}M`;
}

/** 保留一位小数并去掉多余的 ".0"（179.0 → "179"，179.24 → "179.2"）。 */
function trimTrailingZero(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** 上下文占用行的数值部分。 */
export interface ContextUsageLine {
  /** 展示用的 tokens：优先 projectedTokens（下一个请求的预估，占用感最强），退回 pressureTokens。 */
  tokens: number;
  /** 上下文窗口；缺省时 UI 只显示 tokens。 */
  window?: number;
}

/** 从 contextPressure 投影得出可展示的占用数值；无可用数字 → null（不渲染）。 */
export function contextUsageLine(pressure: ContextPressure | undefined): ContextUsageLine | null {
  if (!pressure) return null;
  const tokens = pressure.projectedTokens ?? pressure.pressureTokens;
  if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return null;
  const window = pressure.contextWindow;
  if (window === undefined || !Number.isFinite(window) || window <= 0) return { tokens };
  return { tokens, window };
}

/** 上下文占用行文案；无数据 → null。 */
export function contextUsageText(pressure: ContextPressure | undefined, t: Translate): string | null {
  const line = contextUsageLine(pressure);
  if (!line) return null;
  const used = formatTokens(line.tokens);
  if (line.window === undefined) return t("chat.contextUsageNoWindow", { used });
  return t("chat.contextUsage", { used, window: formatTokens(line.window) });
}

/** 输出用量文案（tokenUsage 投影）；缺失或为 0 → null（不渲染无信息量的 "输出 0"）。 */
export function tokenUsageText(usage: TokenUsage | undefined, t: Translate): string | null {
  const output = usage?.outputTokens;
  if (output === undefined || !Number.isFinite(output) || output <= 0) return null;
  return t("chat.usageOutput", { tokens: formatTokens(output) });
}

/** 待办三态计数。 */
export interface TodoCounts {
  done: number;
  active: number;
  pending: number;
}

/** 统计三态数量（未知状态不计入任何一段，只在签名里体现，避免摘要长度虚高）。 */
export function todoCounts(todos: readonly TodoItem[] | null | undefined): TodoCounts {
  if (!Array.isArray(todos)) return { done: 0, active: 0, pending: 0 };
  // 显式标注回真类型：Array.isArray 会把元素类型放宽成 any[]，否则 item.status 属 unsafe member access
  //（社区审核 sessionStatus.ts:88/89 已指出）。这是类型标注而非断言。
  const list: readonly TodoItem[] = todos;
  let done = 0;
  let active = 0;
  let pending = 0;
  for (const item of list) {
    if (item.status === "completed") done += 1;
    else if (item.status === "in_progress") active += 1;
    else pending += 1;
  }
  return { done, active, pending };
}

/**
 * 待办清单的渲染签名。空/null → ""（与"有内容"区分开，UI 据此隐藏面板）。
 * 用不可能出现在正文里的分隔符，避免 ["a\u0000b"] 与 ["a","b"] 撞签名。
 */
export function todosSignature(todos: readonly TodoItem[] | null | undefined): string {
  if (!Array.isArray(todos) || todos.length === 0) return "";
  // 同上：显式标注回真类型，避免 Array.isArray 放宽成 any[]（社区审核 sessionStatus.ts:101）
  const list: readonly TodoItem[] = todos;
  return list.map((item) => `${item.status}\u0001${item.content}`).join("\u0000");
}

/**
 * 待办进度摘要：按官方语义省略零计数段（非空列表至少保留一段，故结果不会为空串）。
 * 例："2 已完成 · 1 进行中"。
 */
export function todoSummaryText(todos: readonly TodoItem[], t: Translate): string {
  const counts = todoCounts(todos);
  return [
    ...(counts.done > 0 ? [t("chat.todosDone", { count: counts.done })] : []),
    ...(counts.active > 0 ? [t("chat.todosActive", { count: counts.active })] : []),
    ...(counts.pending > 0 ? [t("chat.todosPending", { count: counts.pending })] : []),
  ].join(" · ");
}

/**
 * 渲染新功能区所需的最小元素能力。
 *
 * Obsidian 给 `HTMLElement` 挂的 DOM 扩展天然满足它，因此生产代码零成本；
 * 测试用轻量替身驱动（同一思路见 `headerSelect.ts` 的 `HeaderSelectLike`）——
 * vitest 环境没有 DOM，这是让「思考过程 / 状态行 / 待办面板」的 DOM 结构
 * 可被真正断言的唯一途径。
 */
export interface PanelElement {
  empty(): void;
  setText(text: string): unknown;
  addClass(cls: string): void;
  removeClass(cls: string): void;
  toggleClass(cls: string, value: boolean): void;
  createEl(tag: string, options?: { cls?: string; text?: string; attr?: Record<string, string> }): PanelElement;
  createDiv(options?: { cls?: string; text?: string }): PanelElement;
  createSpan(options?: { cls?: string; text?: string }): PanelElement;
}

/**
 * 渲染「思考过程」折叠块（content 之上）。仅当 reasoning 非空时创建节点，返回是否创建。
 *
 * - 流式期间默认展开（`open` 属性）并取**尾部**文本：用户关心"现在想到哪"，
 *   只截头部会让长推理看起来卡住不动；
 * - 定格后默认折叠、取**头部**文本（从头读）；
 * - `reasoning` 可能极长，两个方向都按 maxChars 截断，节点 DOM 成本有上界。
 *
 * 已知取舍：流式期间节点每满一个节流窗重建一次（见 eventFold.REASONING_BUMP_INTERVAL_MS），
 * 因此用户在此期间手动折叠会被重置为展开。换来的收益是"每帧重建 DOM + 重解析 Markdown"
 * 被压到 ≤4 次/秒——TASK-013 的性能契约优先于这一处轻微交互抖动。
 */
export function renderReasoning(parent: PanelElement, reasoning: string, streaming: boolean, maxChars: number, t: Translate): boolean {
  if (reasoning.length === 0) return false;
  const details = parent.createEl("details", { cls: "dsh-reasoning", ...(streaming ? { attr: { open: "" } } : {}) });
  details.createEl("summary", { text: `💭 ${t("chat.reasoning")}${streaming ? t("chat.reasoningRunning") : ""}` });
  details.createDiv({ cls: "dsh-reasoning-body", text: streaming ? truncateTail(reasoning, maxChars) : truncate(reasoning, maxChars) });
  return true;
}

/**
 * 写底部状态行：文本未变则一帧 DOM 都不动；null 表示无数据（加 dsh-hidden，不占位）。
 * 返回本次生效的文本，供调用方保存脏检查值（状态由调用方持有，本函数无内部状态）。
 */
export function writeMetrics(el: PanelElement, text: string | null, previous: string | null): string | null {
  if (text === previous) return previous;
  el.toggleClass("dsh-hidden", text === null);
  el.setText(text ?? "");
  return text;
}

/**
 * 渲染待办清单面板（默认折叠，摘要给出三态计数）；空/null 不渲染。
 *
 * 签名未变时**完全不动 DOM**：既省掉每帧重建，也保住用户手动展开的状态。
 * 返回本次签名，供调用方保存（同样无内部状态）。
 */
export function writeTodos(el: PanelElement, todos: readonly TodoItem[] | null | undefined, t: Translate, previous: string | null): string | null {
  const list: readonly TodoItem[] = Array.isArray(todos) ? todos : [];
  const sig = todosSignature(list);
  if (sig === previous) return previous;
  el.empty();
  if (list.length === 0) {
    el.addClass("dsh-hidden");
    return sig;
  }
  el.removeClass("dsh-hidden");
  const details = el.createEl("details", { cls: "dsh-todos-panel" });
  details.createEl("summary", { text: `${t("chat.todos")} · ${todoSummaryText(list, t)}` });
  const ul = details.createEl("ul", { cls: "dsh-todos-list" });
  for (const item of list) {
    const li = ul.createEl("li", { cls: `dsh-todo-item dsh-todo-${item.status}` });
    li.createSpan({ cls: "dsh-todo-glyph", text: TODO_GLYPH[item.status] });
    li.createSpan({ text: item.content });
  }
  return sig;
}
