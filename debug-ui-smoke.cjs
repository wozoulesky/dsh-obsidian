/**
 * UI 层渲染冒烟（Node 直接跑：node debug-ui-smoke.cjs）。
 *
 * 目的：在进程内走真实 DSH 数据 + 真实 UI 代码路径（chatView.openConversation →
 * SessionManager.openSession → follow snapshot 播种 → renderNow 渲染节点 DOM），
 * 验证「打开真实会话并渲染历史消息」在 UI 层无运行时错误——这是除真实 Obsidian 外
 * 对验收 2「聊天/流式渲染」的最强可自动化证据。
 *
 * 与 debug-onload-smoke.cjs 的区别：前者只验证 onload 全链（不渲染消息），
 * 本脚本深入 chatView 渲染层（节点 DOM/标题/计划横幅/流式状态）。
 *
 * 只读 + 无副作用：只打开（follow）一个会话读历史，不 create/prompt/cancel。
 */
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return require.resolve("./debug-ui-stub.cjs");
  return origResolve.call(this, request, ...args);
};

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
console.log(`[ui-smoke] DSH = ${BASE}`);

(async () => {
  try {
    globalThis.window = globalThis;
    const mod = require("./main.js");
    const PluginClass = mod.default || mod;
    const plugin = new PluginClass();
    await plugin.onload();
    console.log("[ui-smoke] ONLOAD_OK");
    const runtime = plugin.runtime;

    // 拉回真实会话列表
    await runtime.manager.refresh();
    console.log(`[ui-smoke] sessions = ${runtime.manager.sessions.length}`);

    // 打开视图（registerView 工厂）→ onOpen → 渲染会话下拉等
    // 注意：VIEW_TYPE_DSH_CHAT 是打包后的内部常量，直接硬编码 "dsh-chat"（src/ui/chatView.ts L12）
    const factory = plugin._views["dsh-chat"];
    if (!factory) {
      console.error("[ui-smoke] FAIL：registerView 未注册 dsh-chat 视图");
      process.exit(1);
    }
    const leaf = { app: plugin.app };
    const view = factory(leaf);
    await view.onOpen();
    console.log("[ui-smoke] view.onOpen OK（header 下拉/输入框已构建）");

    // 打开第一个普通会话：走 openConversation → openSession → follow snapshot → renderNow
    const regular = runtime.manager.sessions.find((s) => s.origin !== "subagent") ?? runtime.manager.sessions[0];
    if (!regular) {
      console.log("[ui-smoke] 无会话可打开（列表为空）——渲染路径无法验证");
    } else {
      console.log(`[ui-smoke] 打开会话 ${regular.sessionId}（updatedAt=${regular.updatedAt}）`);
      await view.openConversation(regular.sessionId);
      const sessionView = runtime.store.getView(regular.sessionId);
      console.log(`[ui-smoke] store 视图：nodes=${sessionView?.nodes.length} lastSeq=${sessionView?.lastSeq} title=${JSON.stringify(sessionView?.title)}`);
      // 等待流式状态稳定（若该会话正在 running，store 会持续折叠）
      await new Promise((r) => setTimeout(r, 2000));
      const nodeTexts = view.nodesEl.collectText();
      console.log(`[ui-smoke] 渲染 DOM 文本条数 = ${nodeTexts.length}；前 3 条样本：`);
      for (const t of nodeTexts.slice(0, 3)) console.log(`  - ${t.slice(0, 80)}${t.length > 80 ? "…" : ""}`);
      const assistantRendered = view.nodesEl.queryByClass("dsh-msg-assistant").length;
      const userRendered = view.nodesEl.queryByClass("dsh-msg-user").length + view.nodesEl.queryByClass("dsh-msg-context").length;
      console.log(`[ui-smoke] 渲染节点：assistant=${assistantRendered} user/context=${userRendered}`);
      const ok = sessionView !== undefined && nodeTexts.length > 0;
      console.log(`[ui-smoke] ${ok ? "PASS" : "FAIL"}：真实会话打开 → follow 播种 → UI 渲染节点`);
    }

    await view.onClose();
    plugin.onunload();
    console.log("[ui-smoke] ONCLOSE/ONUNLOAD_OK");
    process.exit(0);
  } catch (err) {
    console.error("[ui-smoke] ERROR:", (err && err.stack) || err);
    process.exit(1);
  }
})();
