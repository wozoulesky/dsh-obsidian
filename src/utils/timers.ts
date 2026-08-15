/**
 * 窗口感知的定时器工具。
 * Obsidian 评审要求使用 `window.setTimeout`/`window.clearTimeout`（弹窗窗口兼容）；
 * 单元测试运行在 Node（无 window），回退到全局定时器。
 */

export function setTimer(handler: () => void, ms: number): ReturnType<typeof setTimeout> {
  if (typeof window !== "undefined") return window.setTimeout(handler, ms) as unknown as ReturnType<typeof setTimeout>;
  return setTimeout(handler, ms);
}

export function clearTimer(id: ReturnType<typeof setTimeout> | null | undefined): void {
  if (id === null || id === undefined) return;
  if (typeof window !== "undefined") window.clearTimeout(id as unknown as number);
  else clearTimeout(id);
}
