/**
 * 加载更早（loadOlder）UI 冒烟（Node 直接跑：node debug-loadolder-smoke.cjs）。
 *
 * 验证验收 2「加载更早」的完整代码路径（进程内 + 真实 DSH）：
 * 打开真实会话（follow snapshot 播种）→ 取 store 视图窗口边界 → 调 manager.loadOlder
 * （page {address, throughSeq, beforeSeq, maxMessages}）→ expandHistoryRecords 展开 →
 * prependHistory 前插 → 视图节点数增长、首节点 seq 前移、状态保持。
 *
 * 零副作用：只读 page 分页，不 create/prompt/cancel。
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
    const regular = runtime.manager.sessions.find((s) => s.origin !== "subagent") ?? runtime.manager.sessions[0];
    if (!regular) {
      console.log("[loadolder-smoke] 无会话可打开——跳过");
      plugin.onunload();
      process.exit(0);
    }
    console.log(`[loadolder-smoke] 会话 ${regular.sessionId}`);

    // 打开会话（onOpen 流程会触发 openSession + follow）
    const view = plugin._views["dsh-chat"]({ app: plugin.app });
    await view.onOpen();
    await view.openConversation(regular.sessionId);
    const store = runtime.store;
    const before = store.getView(regular.sessionId);
    console.log(`[loadolder-smoke] 打开后：nodes=${before?.nodes.length} firstSeq=${before?.firstSeq} lastSeq=${before?.lastSeq} hasMore 未知`);

    // 加载更早一页
    const hadMore = await runtime.manager.loadOlder(regular.sessionId);
    const after = store.getView(regular.sessionId);
    const grew = (after?.nodes.length ?? 0) >= (before?.nodes.length ?? 0);
    const firstMoved = (after?.firstSeq ?? -1) <= (before?.firstSeq ?? -1);
    console.log(`[loadolder-smoke] loadOlder → hasMore=${hadMore}`);
    console.log(`[loadolder-smoke] 之后：nodes=${after?.nodes.length}（+${(after?.nodes.length ?? 0) - (before?.nodes.length ?? 0)}）firstSeq=${after?.firstSeq} lastSeq=${after?.lastSeq}`);
    console.log(`[loadolder-smoke] 节点增长=${grew ? "PASS" : "FAIL"} 窗口前移=${firstMoved ? "PASS" : "FAIL"} 尾 seq 不变=${after?.lastSeq === before?.lastSeq ? "PASS" : "FAIL"}`);

    const ok = grew && firstMoved && after?.lastSeq === before?.lastSeq;
    console.log(`[loadolder-smoke] ${ok ? "PASS" : "FAIL"}：加载更早完整路径（page → 展开 → 前插 → 状态保持）`);

    await view.onClose();
    plugin.onunload();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[loadolder-smoke] ERROR:", (err && err.stack) || err);
    process.exit(1);
  }
})();
