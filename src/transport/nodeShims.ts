/**
 * Obsidian 渲染进程以 nodeIntegration=false 运行，但插件运行时仍可 require 内置模块。
 * 打包进产物的 `ws` 依赖 Buffer/global/process.nextTick，这里补齐缺失的全局。
 */
declare function require(module: string): unknown;

export function installNodeShims(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Buffer === "undefined") {
    const buffer = require("buffer") as { Buffer: unknown };
    g.Buffer = buffer.Buffer;
  }
  if (typeof g.global === "undefined") {
    g.global = g;
  }
  const proc = g.process as (NodeJS.Process & Record<string, unknown>) | undefined;
  if (proc && typeof proc.nextTick !== "function") {
    proc.nextTick = (fn: () => void) => queueMicrotask(fn);
  }
}
