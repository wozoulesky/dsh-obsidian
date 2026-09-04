/**
 * 内联编辑全链冒烟（Node 直接跑：node debug-inlineedit-smoke.cjs）。
 *
 * 验证验收 2「内联编辑」的完整代码路径（进程内 + 真实 DSH）：
 * ensureSession（复用/新建专用会话 + resyncSession 开 follow 事件源，终审 Critical-1 修复点）→
 * prompt（内联编辑指令模板）→ waitForTurnEnd 轮询（classifyTurnState）→ extractLastAssistantText。
 *
 * 副作用（最小）：新建一个内联编辑专用会话 + 一次小 LLM 调用（指令：把"你好"改成"您好"）。
 * 会话可稍后在 DSH Web GUI 删除。
 */
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return require.resolve("./debug-ui-stub.cjs");
  return origResolve.call(this, request, ...args);
};

(async () => {
  try {
    globalThis.window = globalThis;
    const mod = require("./main.js");
    const PluginClass = mod.default || mod;
    const plugin = new PluginClass();
    await plugin.onload();
    const runtime = plugin.runtime;
    await runtime.manager.refresh();
    console.log(`[inlineedit-smoke] sessions = ${runtime.manager.sessions.length}`);

    // 真实内联编辑调用：选中"你好"，指令"改成您好"
    const before = Date.now();
    const result = await runtime.inlineEdit.edit("你好", "冒烟测试.md", "把这个词改成您好");
    const elapsed = Math.round((Date.now() - before) / 1000);
    console.log(`[inlineedit-smoke] 耗时 ${elapsed}s，结果：${JSON.stringify(result.slice(0, 120))}`);
    const ok = result.includes("您好");
    console.log(`[inlineedit-smoke] ${ok ? "PASS" : "FAIL"}：内联编辑全链（专用会话 + follow 事件源 + waitForTurnEnd + 提取替换文本）`);
    const sessionId = runtime.settings.values.inlineEditSessionId;
    console.log(`[inlineedit-smoke] 专用会话：${sessionId}（可稍后在 DSH Web GUI 删除）`);

    plugin.onunload();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[inlineedit-smoke] ERROR:", (err && err.stack) || err);
    process.exit(1);
  }
})();
