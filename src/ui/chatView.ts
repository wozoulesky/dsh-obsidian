import { App, ItemView, MarkdownRenderer, Modal, Notice, Setting, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { DshInputBox } from "./inputBox";
import { resolveMentions, truncate, isClearCommand } from "./prompts";
import { nodeCacheKey, nodeSignature } from "./chatNode";
import type { I18n } from "../i18n";
import { clearTimer, setTimer } from "../utils/timers";
import type { DshRuntime } from "../main";
import type { SessionView, ViewNode } from "../core/eventFold";
import type { PendingApproval, PendingQuestion } from "../core/approvalCenter";
import type { AskUserQuestionAnswerItem, RpcReceipt } from "../transport/types";

export const VIEW_TYPE_DSH_CHAT = "dsh-chat";

export class DshChatView extends ItemView {
  private headerEl!: HTMLElement;
  private planEl!: HTMLElement;
  private msgEl!: HTMLElement;
  private input!: DshInputBox;
  private lastRenderAt = 0;
  private renderPending = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalModalOpen = false;
  private questionModalOpen = false;
  private disposers: (() => void)[] = [];
  /** 消息节点 DOM 缓存：key=`${sessionId}:${node.id}`，避免流式时全量重建/重渲染 Markdown。 */
  private nodeCache = new Map<string, { el: HTMLElement; sig: string }>();
  private cachedSessionId: string | null = null;
  private olderBtn!: HTMLElement;
  private nodesEl!: HTMLElement;
  private runningEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  /** 「加载更早」进行中标志（防双击并发重复前插）；null=未知，false=无更多。 */
  private olderLoading = false;
  private olderHasMore: boolean | null = null;

  constructor(leaf: WorkspaceLeaf, private runtime: DshRuntime) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DSH_CHAT;
  }

  getDisplayText(): string {
    return "DSH";
  }

  getIcon(): string {
    return "bot";
  }

  private get view(): SessionView | undefined {
    return this.runtime.manager.currentId ? this.runtime.store.getView(this.runtime.manager.currentId) : undefined;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dsh-chat");

    this.headerEl = contentEl.createDiv({ cls: "dsh-chat-header" });
    this.renderHeader();
    this.planEl = contentEl.createDiv();
    this.msgEl = contentEl.createDiv({ cls: "dsh-chat-messages" });
    this.olderBtn = this.msgEl.createEl("button", { text: this.runtime.i18n.t("chat.older") });
    this.olderBtn.addEventListener("click", () => {
      void (async () => {
        const view = this.view;
        if (!view || this.olderLoading) return; // 加载中或已在处理，防重复前插
        this.olderLoading = true;
        this.olderBtn.setText(this.runtime.i18n.t("chat.loadingOlder"));
        try {
          const hasMore = await this.runtime.manager.loadOlder(view.sessionId);
          this.olderHasMore = hasMore;
          this.renderNow();
        } catch (err) {
          new Notice(this.runtime.i18n.t("chat.loadFailed", { message: err instanceof Error ? err.message : String(err) }));
        } finally {
          this.olderLoading = false;
          this.olderBtn.setText(this.runtime.i18n.t("chat.older"));
          // 用 visibility 隐藏而非 display：保留占位，避免消息列表整体上移贡献 CLS
          if (this.olderHasMore === false) this.olderBtn.style.visibility = "hidden";
        }
      })();
    });
    this.nodesEl = this.msgEl.createDiv({ cls: "dsh-chat-nodes" });
    this.runningEl = this.msgEl.createDiv({ cls: "dsh-chat-status", text: this.runtime.i18n.t("chat.running") });
    this.emptyEl = this.msgEl.createDiv({ cls: "dsh-chat-status", text: this.runtime.i18n.t("chat.noSession") });
    this.input = new DshInputBox(contentEl, this.runtime, () => this.view, (text) => this.send(text), (active) => this.applyPlanToggle(active));

    this.disposers.push(this.runtime.store.onChange(() => this.render()));
    this.disposers.push(
      this.runtime.approvals.onChange(() => {
        this.render();
        this.maybeShowNextApproval();
      })
    );

    try {
      await this.runtime.manager.refresh();
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.listLoadFailed", { message: err instanceof Error ? err.message : String(err) }));
    }
    this.renderHeader();
    if (this.runtime.manager.sessions.length > 0 && !this.runtime.manager.currentId) {
      const first = this.runtime.manager.sessions[0];
      await this.openConversation(first.sessionId);
    }
  }

  async onClose(): Promise<void> {
    if (this.renderTimer) {
      clearTimer(this.renderTimer);
      this.renderTimer = null;
    }
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  /**
   * 按 sessionId 打开会话。
   * 注意：不能命名为 `open`——Obsidian 视图生命周期（恢复工作区等）会调用
   * `view.open(state)`，若与我们的方法撞名会把视图状态对象 `{}` 当 sessionId 传给
   * `session.history`，导致 "invalid payload for session.history"。改名并防御非字符串入参。
   */
  private async openConversation(sessionId: string): Promise<void> {
    if (typeof sessionId !== "string" || sessionId.length === 0) return;
    try {
      await this.runtime.manager.openSession(sessionId);
      this.render();
      this.renderHeader();
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.openFailed", { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** Shift+Tab 切换成功后的本地乐观状态：rc.6 服务端不发送 plan 状态帧，按发送结果显示。 */
  private applyPlanToggle(active: boolean): void {
    const view = this.view;
    if (!view) return;
    view.plan.active = active;
    view.plan.pending = false;
    this.renderNow();
  }

  private async send(text: string): Promise<boolean> {
    // /clear：前端命令，不发给服务端（Claude Code 风格：建立干净会话，历史保留在 DSH 会话列表）
    if (isClearCommand(text)) {
      await this.handleClear();
      return true;
    }
    const sessionId = this.runtime.manager.currentId;
    if (!sessionId) {
      new Notice(this.runtime.i18n.t("chat.pleaseCreateSession"));
      return false;
    }
    const clearPendingPlan = (): void => {
      const view = this.view;
      if (view && view.plan.pending) {
        view.plan.pending = false;
        this.renderNow();
      }
    };
    try {
      const resolved = await resolveMentions(text, (path) => this.readVaultFile(path), this.runtime.settings.values.mentionMaxChars);
      const res = await this.runtime.manager.prompt(sessionId, resolved, "queue");
      if (!res.ok) {
        new Notice(this.runtime.i18n.t("chat.sendFailed", { message: res.error.message }));
        clearPendingPlan(); // 服务端拒绝时本地 pending 标记要回滚，否则「计划模式切换中…」永久卡住
        return false;
      }
      return true;
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.sendFailed", { message: err instanceof Error ? err.message : String(err) }));
      clearPendingPlan();
      return false;
    }
  }

  /** /clear：建立全新会话（顶替当前会话，上下文清空，历史保留在 DSH 会话列表），并重置内联编辑专用会话。 */
  private async handleClear(): Promise<void> {
    try {
      const id = await this.runtime.manager.newSession();
      this.runtime.settings.values.inlineEditSessionId = "";
      await this.runtime.settings.save().catch(() => undefined);
      await this.openConversation(id);
      new Notice(this.runtime.i18n.t("chat.clearDone"));
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.clearFailed", { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  private async readVaultFile(path: string): Promise<{ kind: "file" | "folder"; text: string } | null> {
    const abs = this.runtime.plugin.app.vault.getAbstractFileByPath(path);
    if (!abs) return null;
    if (abs instanceof TFolder) {
      return { kind: "folder", text: (await this.listTree(path, 0)).join("\n") };
    }
    if (!(abs instanceof TFile)) return null;
    try {
      // 读取走 Vault API（官方指引优先于 Adapter API：缓存与串行化保证）
      return { kind: "file", text: await this.runtime.plugin.app.vault.cachedRead(abs) };
    } catch {
      return null;
    }
  }

  /** 递归列出目录树（相对路径），深度限制 2 层。 */
  private async listTree(dir: string, depth: number): Promise<string[]> {
    const list = await this.runtime.plugin.app.vault.adapter.list(dir);
    const out: string[] = [];
    for (const f of list.files) out.push(f);
    for (const d of list.folders) {
      out.push(`${d}/`);
      if (depth < 2) out.push(...(await this.listTree(d, depth + 1)));
    }
    return out;
  }

  private renderHeader(): void {
    this.headerEl.empty();
    const row = this.headerEl.createDiv();
    const select = row.createEl("select");
    select.createEl("option", { text: this.runtime.i18n.t("chat.noSessionOption"), value: "" });
    for (const s of this.runtime.manager.sessions) {
      const opt = select.createEl("option", { text: this.runtime.manager.sessionTitle(s.sessionId) + (s.running ? " ⏳" : ""), value: s.sessionId });
      if (s.sessionId === this.runtime.manager.currentId) opt.selected = true;
    }
    select.addEventListener("change", () => {
      if (select.value) void this.openConversation(select.value);
    });
    const newBtn = row.createEl("button", { text: this.runtime.i18n.t("chat.new") });
    newBtn.addEventListener("click", () => {
      void (async () => {
        try {
          const id = await this.runtime.manager.newSession();
          await this.openConversation(id);
        } catch (err) {
          new Notice(this.runtime.i18n.t("chat.newSessionFailed", { message: err instanceof Error ? err.message : String(err) }));
        }
      })();
    });
    const stopBtn = row.createEl("button", { text: this.runtime.i18n.t("chat.stop") });
    stopBtn.addEventListener("click", () => {
      void (async () => {
        if (this.runtime.manager.currentId) {
          const res = await this.runtime.manager.cancel(this.runtime.manager.currentId);
          if (!res.ok) new Notice(this.runtime.i18n.t("chat.stopFailed", { message: res.error.message }));
        }
      })();
    });
  }

  /** 外部（如命令面板）触发会话列表变化后刷新头部下拉。 */
  refreshHeader(): void {
    this.renderHeader();
  }

  /** 渲染当前会话（限流：chunk 高频推送时每 150ms 最多重绘一次）。 */
  private render(): void {
    const now = Date.now();
    if (now - this.lastRenderAt < 150) {
      if (!this.renderPending) {
        this.renderPending = true;
        this.renderTimer = setTimer(() => {
          this.renderPending = false;
          this.renderTimer = null;
          this.renderNow();
        }, 150);
      }
      return;
    }
    this.lastRenderAt = now;
    this.renderNow();
  }

  private renderNow(): void {
    const view = this.view;
    this.planEl.empty();
    if (view) {
      if (view.plan.pending) this.planEl.createDiv({ cls: "dsh-plan-banner", text: this.runtime.i18n.t("chat.planPending") });
      else if (view.plan.active) this.planEl.createDiv({ cls: "dsh-plan-banner", text: this.runtime.i18n.t("chat.planActive") });
    }

    const msg = this.msgEl;
    const scrollTop = msg.scrollTop;
    const atBottom = msg.scrollTop + msg.clientHeight >= msg.scrollHeight - 4;

    if (!view) {
      this.cachedSessionId = null;
      this.nodeCache.clear();
      this.nodesEl.empty();
      this.olderBtn.style.display = "none";
      this.runningEl.style.display = "none";
      this.emptyEl.style.display = "";
      return;
    }

    if (this.cachedSessionId !== view.sessionId) {
      this.cachedSessionId = view.sessionId;
      this.nodeCache.clear();
      this.nodesEl.empty();
      // 「加载更早」状态是会话相关的：切会话后重置，避免旧会话的 hasMore=false 把按钮带没了
      this.olderHasMore = null;
    }

    this.olderBtn.style.visibility = this.olderHasMore === false ? "hidden" : "visible";
    this.runningEl.style.display = view.running ? "" : "none";
    this.emptyEl.style.display = "none";

    const seen = new Set<string>();
    for (const node of view.nodes) {
      const key = nodeCacheKey(view.sessionId, node);
      seen.add(key);
      const sig = nodeSignature(node);
      const cached = this.nodeCache.get(key);
      if (cached && cached.sig === sig) {
        // 复用已有 DOM：appendChild 会按当前遍历顺序移动，保证「加载更早」前插、节点顺序正确。
        this.nodesEl.appendChild(cached.el);
      } else {
        // 签名变化：先销毁旧 DOM！否则流式期间每个 chunk 都会残留一条重复消息
        //（旧节点未移除 → 消息列表无限增长 → CLS/INP 恶化、视口内容上跳）
        cached?.el.remove();
        const el = this.buildNodeEl(node);
        this.nodeCache.set(key, { el, sig });
        this.nodesEl.appendChild(el);
      }
    }
    for (const [key, cached] of this.nodeCache) {
      if (!seen.has(key)) {
        cached.el.remove();
        this.nodeCache.delete(key);
      }
    }

    if (atBottom) msg.scrollTop = msg.scrollHeight;
    else msg.scrollTop = scrollTop;
  }

  /** 构建单条消息 DOM；与缓存解耦，返回元素供 renderNow 复用或重建。 */
  private buildNodeEl(node: ViewNode): HTMLElement {
    if (node.kind === "user") {
      const el = document.createElement("div");
      el.className = node.sourceKind === "user" ? "dsh-msg-user" : "dsh-msg-context";
      el.setText(node.text);
      return el;
    }
    if (node.kind === "error") {
      const el = document.createElement("div");
      el.className = "dsh-msg-context";
      el.setText(this.runtime.i18n.t("chat.turnError", { message: node.text }));
      return el;
    }
    if (node.kind === "command") {
      const el = document.createElement("div");
      el.className = "dsh-msg-command";
      const statusText = node.status === "running" ? "⏳" : node.status === "success" ? "✓" : "✗";
      el.setText(node.text
        ? this.runtime.i18n.t("chat.commandLineWithText", { status: statusText, name: node.name, text: node.text })
        : this.runtime.i18n.t("chat.commandLine", { status: statusText, name: node.name }));
      return el;
    }
    const wrap = document.createElement("div");
    wrap.className = "dsh-msg-assistant";
    const body = wrap.createDiv();
    if (node.streaming) {
      // 流式中：纯文本即时更新（setText 极轻），Markdown 只在结束时渲染一次——
      // 避免每个 chunk 都全量解析 Markdown（阻塞主线程 → INP 高）与异步渲染撑开高度（CLS）。
      // dsh-streaming-text: white-space: pre-wrap，换行布局接近 Markdown 段落，减小结束渲染的高度突变。
      body.className = "dsh-streaming-text";
      body.setText(node.text.length > 0 ? node.text : "…");
    } else {
      const text = node.text.length > 0 ? node.text : this.runtime.i18n.t("chat.noText");
      void MarkdownRenderer.render(this.app, text, body, "", this);
    }
    for (const card of node.toolCards) {
      const details = wrap.createEl("details", { cls: "dsh-tool-card" });
      const suffix = card.status === "running" ? this.runtime.i18n.t("chat.toolRunning") : card.status === "error" ? this.runtime.i18n.t("chat.toolError") : "";
      details.createEl("summary", { text: `🛠 ${card.name}${suffix}` });
      const pre = details.createDiv({ cls: "dsh-tool-result" });
      pre.setText(truncate(card.resultText ?? card.args ?? "", 4000));
    }
    return wrap;
  }

  private maybeShowNextApproval(): void {
    const current = this.runtime.manager.currentId;
    const p = this.runtime.approvals.pendingApprovals.find((a) => a.sessionId === current) ?? this.runtime.approvals.pendingApprovals[0];
    if (p && !this.approvalModalOpen) {
      this.approvalModalOpen = true;
      new ApprovalModal(this.app, p, this.runtime.approvals, () => (this.approvalModalOpen = false), this.runtime.i18n).open();
    }
    const q = this.runtime.approvals.pendingQuestions.find((x) => x.sessionId === current) ?? this.runtime.approvals.pendingQuestions[0];
    if (q && !this.questionModalOpen) {
      this.questionModalOpen = true;
      new QuestionModal(this.app, q, this.runtime.approvals, () => (this.questionModalOpen = false), this.runtime.i18n).open();
    }
  }
}

export class ApprovalModal extends Modal {
  constructor(
    app: App,
    private p: PendingApproval,
    private center: { decideApproval(p: PendingApproval, outcome: "allowed-once" | "rejected"): Promise<RpcReceipt> },
    private onCloseCb: () => void,
    private i18n: I18n
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.i18n.t("approval.title", { toolName: this.p.toolName }));
    this.contentEl.createEl("p").setText(this.p.reason ?? this.i18n.t("approval.noReason"));
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(this.i18n.t("approval.reject")).onClick(() => void this.decide("rejected")))
      .addButton((b) => b.setButtonText(this.i18n.t("approval.allowOnce")).setCta().onClick(() => void this.decide("allowed-once")));
  }

  private async decide(outcome: "allowed-once" | "rejected"): Promise<void> {
    try {
      const receipt = await this.center.decideApproval(this.p, outcome);
      if (receipt.accepted) {
        this.close();
        return;
      }
      if (receipt.accepted === false && receipt.reason === "not-pending") {
        new Notice(this.i18n.t("approval.alreadyHandled"));
        this.close();
        return;
      }
      new Notice(this.i18n.t("approval.notAccepted")); // bad-response：保留弹窗供重试
    } catch (err) {
      new Notice(this.i18n.t("approval.failed", { message: err instanceof Error ? err.message : String(err) }));
      // 不关闭：按钮可再次点击重试
    }
  }

  onClose(): void {
    this.onCloseCb();
  }
}

export class QuestionModal extends Modal {
  private answers: AskUserQuestionAnswerItem[] = [];

  constructor(
    app: App,
    private p: PendingQuestion,
    private center: { answerQuestion(p: PendingQuestion, answers: AskUserQuestionAnswerItem[]): Promise<RpcReceipt> },
    private onCloseCb: () => void,
    private i18n: I18n
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.i18n.t("question.title"));
    for (const q of this.p.questions) {
      this.contentEl.createEl("h6").setText(q.header ?? q.question);
      if (q.detail) this.contentEl.createEl("p").setText(q.detail);
      const options = q.options ?? [];
      if (options.length === 0) {
        const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: this.i18n.t("question.freeAnswer") } });
        const answer: AskUserQuestionAnswerItem = { id: q.id, selected: [], custom: "" };
        this.answers.push(answer);
        input.addEventListener("input", () => {
          answer.custom = input.value;
        });
      } else {
        const selected = new Set<string>();
        for (const opt of options) {
          const label = this.contentEl.createEl("label");
          const cb = label.createEl("input", { attr: { type: q.multiSelect ? "checkbox" : "radio", name: `q-${q.id}` } });
          cb.addEventListener("change", () => {
            if (cb.checked) selected.add(opt.label);
            else selected.delete(opt.label);
          });
          label.appendText(opt.label + (opt.description ? `（${opt.description}）` : ""));
          this.contentEl.createEl("br");
        }
        const answer: AskUserQuestionAnswerItem = { id: q.id, selected: [] };
        this.answers.push(answer);
        this.contentEl.addEventListener("change", () => {
          answer.selected = [...selected];
        });
      }
    }
    new Setting(this.contentEl).addButton((b) => b.setButtonText(this.i18n.t("question.submit")).setCta().onClick(() => void this.submit()));
  }

  private async submit(): Promise<void> {
    try {
      const receipt = await this.center.answerQuestion(this.p, this.answers);
      if (receipt.accepted) {
        this.close();
        return;
      }
      if (receipt.accepted === false && receipt.reason === "not-pending") {
        new Notice(this.i18n.t("question.alreadyHandled"));
        this.close();
        return;
      }
      new Notice(this.i18n.t("question.notAccepted"));
    } catch (err) {
      new Notice(this.i18n.t("question.failed", { message: err instanceof Error ? err.message : String(err) }));
      // 不关闭：可重试
    }
  }

  onClose(): void {
    this.onCloseCb();
  }
}
