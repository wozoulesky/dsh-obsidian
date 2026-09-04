/**
 * 审批/提问弹窗 UI 冒烟（Node 直接跑：node debug-approval-smoke.cjs）。
 *
 * 验证验收 3/4「审批弹窗 / 提问弹窗」的 UI 代码路径（此前只有 approvalCenter 单测，
 * 弹窗 Modal 从未在任何环境运行过）：
 *  - 仿真 waterfall 帧进 ApprovalCenter → chatView.maybeShowNextApproval → ApprovalModal.onOpen
 *    渲染（标题/理由/允许一次/拒绝按钮）→ 点击"允许一次" → decideApproval → answerEvent
 *    （mock 返回 ok）→ 弹窗 close + pending 出队。
 *  - 提问弹窗同路径（选项/提交 → answerQuestion → close）。
 *
 * 零副作用：answerEvent 用 mock client（不真连 DSH 的 $events/result——真机 $events/result
 * 需要真实 pending 事件，本冒烟验证 UI 层）。
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

    // 捕获弹窗实例：patch stub Modal.prototype.open（打包代码里的 ApprovalModal/QuestionModal 都继承它）
    const stubMod = require("./debug-ui-stub.cjs");
    const openedModals = [];
    const origOpen = stubMod.Modal.prototype.open;
    stubMod.Modal.prototype.open = function (...args) {
      openedModals.push(this);
      return origOpen.apply(this, args);
    };

    const mod = require("./main.js");
    const PluginClass = mod.default || mod;
    const plugin = new PluginClass();
    await plugin.onload();
    const runtime = plugin.runtime;

    // 视图 onOpen（注册 store/approvals 监听 + maybeShowNextApproval 挂钩）
    const view = plugin._views["dsh-chat"]({ app: plugin.app });
    await view.onOpen();
    // 设 currentId 使弹窗优先匹配当前会话
    runtime.manager.currentId = "s1";

    // --- 审批弹窗 ---
    let answerCalls = [];
    runtime.client.answerEvent = async (clientId, eventId, outcome) => {
      answerCalls.push({ clientId, eventId, outcome });
      return { ok: true };
    };
    runtime.approvals.ingest({ type: "ready", clientId: "c-smoke", host: { home: "h" } });
    runtime.approvals.ingest({
      type: "waterfall",
      event: "approval/request",
      eventId: "e-approval",
      agentId: "s1",
      request: { toolName: "write", callId: "c1", reason: "写入 vault/note.md" },
    });
    // onChange → maybeShowNextApproval 应同步打开弹窗
    await new Promise((r) => setTimeout(r, 10));
    const approvalModal = openedModals[0];
    const approvalTitle = approvalModal?.titleEl.text;
    const approvalButtons = approvalModal?.contentEl.queryByTag("button").map((b) => b.text) ?? [];
    console.log(`[approval-smoke] 审批弹窗：title=${JSON.stringify(approvalTitle)} buttons=${JSON.stringify(approvalButtons)}`);
    const approvalOpened = approvalTitle !== undefined && approvalButtons.includes("允许一次") && approvalButtons.includes("拒绝");
    // 点击"允许一次"
    approvalModal.clickButtonByText("允许一次");
    await new Promise((r) => setTimeout(r, 10));
    console.log(`[approval-smoke] answerEvent 调用：${JSON.stringify(answerCalls)}`);
    const approvalClosed = approvalModal._closed === true;
    const approvalDequeued = runtime.approvals.pendingApprovals.length === 0;
    console.log(`[approval-smoke] 审批：opened=${approvalOpened} closed=${approvalClosed} dequeue=${approvalDequeued} answerArgs=${JSON.stringify(answerCalls[0])}`);

    // --- 提问弹窗 ---
    answerCalls = [];
    runtime.approvals.ingest({
      type: "waterfall",
      event: "user-questions/request",
      eventId: "e-question",
      agentId: "s1",
      request: { questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }] },
    });
    await new Promise((r) => setTimeout(r, 10));
    const questionModal = openedModals[1];
    const questionTexts = questionModal?.contentEl.collectText() ?? [];
    console.log(`[question-smoke] 提问弹窗文本：${JSON.stringify(questionTexts.slice(0, 6))}`);
    const questionOpened = questionTexts.some((t) => t.includes("选哪个"));
    questionModal.clickButtonByText("提交");
    await new Promise((r) => setTimeout(r, 10));
    console.log(`[question-smoke] answerEvent 调用：${JSON.stringify(answerCalls)}`);
    const questionClosed = questionModal._closed === true;
    const questionDequeued = runtime.approvals.pendingQuestions.length === 0;
    console.log(`[question-smoke] 提问：opened=${questionOpened} closed=${questionClosed} dequeue=${questionDequeued}`);

    const ok = approvalOpened && approvalClosed && approvalDequeued && questionOpened && questionClosed && questionDequeued;
    console.log(`[approval-smoke] ${ok ? "PASS" : "FAIL"}：审批/提问弹窗 UI 全路径（waterfall → 弹窗 → 点击 → answerEvent → 关闭/出队）`);

    await view.onClose();
    plugin.onunload();
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error("[approval-smoke] ERROR:", (err && err.stack) || err);
    process.exit(1);
  }
})();
