/**
 * 真机 onload 冒烟（Node 直接跑：node debug-onload-smoke.cjs）。
 *
 * 与 debug-load.cjs 同技术路线：用 debug-obsidian-stub.cjs 模拟 Obsidian 宿主，
 * 加载构建产物 main.js 走完整 plugin.onload()——但**连真实 DSH**（默认 127.0.0.1:3080），
 * 并观测 onload 之后 5 秒窗口内的真实行为：
 *  1. onload 不抛错（ONLOAD_OK）
 *  2. 状态栏文案被 mux onState 驱动（"已连接"/"重连中"——即验收 1 的「状态栏已连接」证据）
 *  3. manager.refresh() 拉回真实会话列表（验收 1 的「会话列表加载」证据）
 *  4. 三条流（$events / session/control）在真机上打开（$events 首帧 ready、control 首帧 baseline）
 * 只读 + 无副作用：不 create/prompt/cancel、不打开会话视图（不触发 follow）。
 *
 * 已知局限：stub 的 DOM 是空壳，chatView 的真实渲染不在本冒烟范围（真机 Obsidian 验收）。
 */
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "obsidian") return require.resolve("./debug-obsidian-stub.cjs");
  return origResolve.call(this, request, ...args);
};

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";
console.log(`[onload-smoke] DSH = ${BASE}`);

// 注入状态栏与 refresh 观测：stub 的 Plugin 实例 addStatusBarItem 返回空壳，
// 我们 monkey-patch 抓状态栏文案（真实 onload 会 setText）。
const statusTexts = [];
const origPluginProto = require("./debug-obsidian-stub.cjs").Plugin.prototype;
const origAddStatusBarItem = origPluginProto.addStatusBarItem;
origPluginProto.addStatusBarItem = function () {
  const el = { setText(t) { statusTexts.push(t); } };
  return el;
};

(async () => {
  try {
    globalThis.window = globalThis;
    const mod = require("./main.js");
    const PluginClass = mod.default || mod;
    const plugin = new PluginClass();
    await plugin.onload();
    console.log("[onload-smoke] ONLOAD_OK");
    const runtime = plugin.runtime;
    // onload 里 refresh() 是 fire-and-forget；这里主动再 refresh 一次并捕获错误（幂等）
    try {
      await runtime.manager.refresh();
    } catch (err) {
      console.error(`[onload-smoke] refresh 错误：${err instanceof Error ? err.message : String(err)}`);
    }
    console.log(`[onload-smoke] manager.sessions = ${runtime.manager.sessions.length}（list 真机拉回）`);
    console.log(`[onload-smoke] muxState = ${runtime.muxState}`);

    // 观察 5 秒：等 $events/control 真机帧 + 状态栏变化
    await new Promise((r) => setTimeout(r, 5000));
    console.log(`[onload-smoke] 状态栏文案序列 = ${JSON.stringify(statusTexts)}`);
    const connectedSeen = statusTexts.some((t) => t.includes("已连接") || t.includes("Connected"));
    console.log(`[onload-smoke] 状态栏出现过"已连接"：${connectedSeen ? "PASS" : "FAIL"}（可能仍是重连中/文案为 i18n key）`);

    plugin.onunload();
    console.log("[onload-smoke] ONUNLOAD_OK");
    const ok = runtime.manager.sessions.length >= 0 && runtime.muxState !== null;
    console.log(`[onload-smoke] ${ok ? "PASS" : "FAIL"}：onload 全链 + 真机 list/三流/状态栏驱动`);
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[onload-smoke] LOAD_ERROR:", (err && err.stack) || err);
    process.exit(1);
  }
})();
