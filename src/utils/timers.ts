/**
 * 定时器工具：统一使用 window.setTimeout / window.clearTimeout
 * （Obsidian 目录评审要求：弹窗窗口兼容）。
 * 单元测试环境（Node 无 window）由 tests/setup-window.ts 注入 window 别名。
 */

export function setTimer(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
  return window.setTimeout(handler, ms) as unknown as ReturnType<typeof setTimeout>;
}

export function clearTimer(id: ReturnType<typeof setTimeout> | null | undefined): void {
  if (id === null || id === undefined) return;
  window.clearTimeout(id as unknown as number);
}
