// Node 测试环境注入 window 别名：渲染进程 window 恒存在，产品代码统一使用 window.*
// （Obsidian 目录评审要求），测试环境用 globalThis 充当 window。
if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}
