/**
 * Obsidian 渲染进程（nodeIntegration=false）垫片：
 * 打包进产物的 ws 依赖 Buffer/global/process.nextTick/setImmediate，这里补齐缺失的全局。
 * 仅在渲染进程调用（main.onload），window 恒存在。
 */
declare function require(module: string): unknown;

export function installNodeShims(): void {
  const g = window as unknown as Record<string, unknown>;
  if (typeof g.Buffer === "undefined") {
    const buffer = require("buffer") as { Buffer: unknown };
    g.Buffer = buffer.Buffer;
  }
  if (typeof g.global === "undefined") {
    g.global = g;
  }
  const proc = g.process as (NodeJS.Process & Record<string, unknown>) | undefined;
  if (proc) {
    if (typeof proc.nextTick !== "function") {
      proc.nextTick = (fn: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => fn(...args));
    }
  }
  if (typeof g.setImmediate === "undefined") {
    g.setImmediate = (fn: () => void) => window.setTimeout(fn, 0);
  }
  if (typeof g.clearImmediate === "undefined") {
    g.clearImmediate = (id: unknown) => window.clearTimeout(id as number);
  }
}
