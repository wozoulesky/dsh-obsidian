/**
 * 会话头部下拉的增量同步。
 *
 * 背景（TASK-028）：`renderHeader` 原先每次 `headerEl.empty()` 重建整行 DOM，
 * 而它在 `openConversation` / `refreshHeader()`（命令面板新建会话）等路径上被频繁调用。
 * 现在头部行只建一次，会话数据变化时只更新 `<option>`：集合未变则连 DOM 结构都不碰。
 *
 * 这里刻意用**结构类型**描述只用到的那点元素表面（value/options/empty/createEl），
 * 真实的 `HTMLSelectElement` 天然满足它，单测可以用轻量替身驱动——不需要 DOM 环境，
 * 也不需要 "as unknown as" 之类的断言（见 SPEC《约束》第 5 条）。
 */

/** 下拉元素的最小表面。 */
export interface HeaderSelectLike {
  value: string;
  options: ArrayLike<{ readonly value: string; text: string }>;
  empty(): void;
  createEl(tag: "option", o?: { text?: string; value?: string }): unknown;
}

/** 一个下拉选项（value 为 sessionId，空串代表「无会话」占位项）。 */
export interface HeaderOption {
  value: string;
  label: string;
}

/** 会话下拉的选项集合：首项恒为「无会话」占位，其余按 `sessions` 顺序，运行中追加 ⏳。 */
export function headerOptions(
  sessions: ReadonlyArray<{ sessionId: string; running?: boolean }>,
  titleOf: (sessionId: string) => string,
  noSessionLabel: string
): HeaderOption[] {
  const options: HeaderOption[] = [{ value: "", label: noSessionLabel }];
  for (const s of sessions) {
    options.push({ value: s.sessionId, label: titleOf(s.sessionId) + (s.running ? " ⏳" : "") });
  }
  return options;
}

/**
 * 把 `<select>` 同步为目标选项集合与选中项；返回是否**重建**了 `<option>` 结构。
 *
 * - 选项集合（数量与各 value）未变：不重建，只在标签文本变化时逐个改 `text`（标题/运行态变化）；
 * - 选项集合变化：`empty()` 后重建全部 `<option>`；
 * - 选中项：集合未重建时也只写一次 `value`（写相同值不产生布局影响）。
 */
export function syncSelectOptions(select: HeaderSelectLike, options: HeaderOption[], selected: string): boolean {
  const count = select.options.length;
  let sameShape = count === options.length;
  if (sameShape) {
    for (let i = 0; i < count; i++) {
      if (select.options[i].value !== options[i].value) {
        sameShape = false;
        break;
      }
    }
  }
  if (!sameShape) {
    select.empty();
    for (const option of options) select.createEl("option", { text: option.label, value: option.value });
  } else {
    for (let i = 0; i < count; i++) {
      const el = select.options[i];
      if (el.text !== options[i].label) el.text = options[i].label;
    }
  }
  if (select.value !== selected) select.value = selected;
  return !sameShape;
}
