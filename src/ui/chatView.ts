import { App, ItemView, MarkdownRenderer, Modal, Notice, Setting, TFolder, WorkspaceLeaf } from "obsidian";
import { DshInputBox } from "./inputBox";
import { resolveMentions, truncate } from "./prompts";
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
    this.input = new DshInputBox(contentEl, this.runtime, () => this.view, (text) => this.send(text));

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
      new Notice(`会话列表拉取失败：${err instanceof Error ? err.message : String(err)}`);
    }
    this.renderHeader();
    if (this.runtime.manager.sessions.length > 0 && !this.runtime.manager.currentId) {
      const first = this.runtime.manager.sessions[0];
      await this.open(first.sessionId);
    }
  }

  async onClose(): Promise<void> {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    for (const dispose of this.disposers) dispose();
    this.disposers = [];
  }

  private async open(sessionId: string): Promise<void> {
    try {
      await this.runtime.manager.openSession(sessionId);
      this.render();
      this.renderHeader();
    } catch (err) {
      new Notice(`打开会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async send(text: string): Promise<void> {
    const sessionId = this.runtime.manager.currentId;
    if (!sessionId) {
      new Notice("请先创建会话");
      return;
    }
    try {
      const resolved = await resolveMentions(text, (path) => this.readVaultFile(path), this.runtime.settings.values.mentionMaxChars);
      const res = await this.runtime.manager.prompt(sessionId, resolved, "queue");
      if (!res.ok) new Notice(`发送失败：${res.error.message}`);
    } catch (err) {
      new Notice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
      const view = this.view;
      if (view && view.plan.pending) {
        view.plan.pending = false;
        this.renderNow();
      }
    }
  }

  private async readVaultFile(path: string): Promise<{ kind: "file" | "folder"; text: string } | null> {
    const abs = this.runtime.plugin.app.vault.getAbstractFileByPath(path);
    if (!abs) return null;
    if (abs instanceof TFolder) {
      return { kind: "folder", text: (await this.listTree(path, 0)).join("\n") };
    }
    try {
      return { kind: "file", text: await this.runtime.plugin.app.vault.adapter.read(path) };
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
    select.createEl("option", { text: "（无会话）", value: "" });
    for (const s of this.runtime.manager.sessions) {
      const opt = select.createEl("option", { text: this.runtime.manager.sessionTitle(s.sessionId) + (s.running ? " ⏳" : ""), value: s.sessionId });
      if (s.sessionId === this.runtime.manager.currentId) opt.selected = true;
    }
    select.addEventListener("change", () => {
      if (select.value) void this.open(select.value);
    });
    const newBtn = row.createEl("button", { text: "新建" });
    newBtn.addEventListener("click", async () => {
      try {
        const id = await this.runtime.manager.newSession();
        await this.open(id);
      } catch (err) {
        new Notice(`新建会话失败：${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const stopBtn = row.createEl("button", { text: "停止" });
    stopBtn.addEventListener("click", async () => {
      if (this.runtime.manager.currentId) {
        const res = await this.runtime.manager.cancel(this.runtime.manager.currentId);
        if (!res.ok) new Notice(`停止失败：${res.error.message}`);
      }
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
        this.renderTimer = setTimeout(() => {
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
      if (view.plan.pending) this.planEl.createDiv({ cls: "dsh-plan-banner", text: "计划模式切换中…" });
      else if (view.plan.active) this.planEl.createDiv({ cls: "dsh-plan-banner", text: "计划模式已开启" });
    }
    this.msgEl.empty();
    if (!view) {
      this.msgEl.createDiv({ text: "尚无会话，点击「新建」开始。", cls: "dsh-chat-status" });
      return;
    }
    const olderBtn = this.msgEl.createEl("button", { text: "加载更早" });
    olderBtn.addEventListener("click", async () => {
      try {
        await this.runtime.manager.loadOlder(view.sessionId);
        this.renderNow();
      } catch (err) {
        new Notice(`加载失败：${err instanceof Error ? err.message : String(err)}`);
      }
    });
    for (const node of view.nodes) this.renderNode(node);
    if (view.running) this.msgEl.createDiv({ cls: "dsh-chat-status", text: "⏳ DSH 正在工作…" });
  }

  private renderNode(node: ViewNode): void {
    if (node.kind === "user") {
      const el = this.msgEl.createDiv({ cls: node.sourceKind === "user" ? "dsh-msg-user" : "dsh-msg-context" });
      el.setText(node.text);
      return;
    }
    if (node.kind === "error") {
      const el = this.msgEl.createDiv({ cls: "dsh-msg-context" });
      el.setText(node.text);
      return;
    }
    if (node.kind === "command") {
      const el = this.msgEl.createDiv({ cls: "dsh-msg-command" });
      const statusText = node.status === "running" ? "⏳" : node.status === "success" ? "✓" : "✗";
      el.setText(`${statusText} 命令 ${node.name}${node.text ? `：${node.text}` : ""}`);
      return;
    }
    const wrap = this.msgEl.createDiv({ cls: "dsh-msg-assistant" });
    const body = wrap.createDiv();
    const text = node.text.length > 0 ? node.text : (node.streaming ? "…" : "（无文本）");
    void MarkdownRenderer.render(this.app, text, body, "", this);
    for (const card of node.toolCards) {
      const details = wrap.createEl("details", { cls: "dsh-tool-card" });
      details.createEl("summary", { text: `🛠 ${card.name}${card.status === "running" ? "（执行中）" : card.status === "error" ? "（失败）" : ""}` });
      const pre = details.createDiv({ cls: "dsh-tool-result" });
      pre.setText(truncate(card.resultText ?? card.args ?? "", 4000));
    }
  }

  private maybeShowNextApproval(): void {
    const current = this.runtime.manager.currentId;
    const p = this.runtime.approvals.pendingApprovals.find((a) => a.sessionId === current) ?? this.runtime.approvals.pendingApprovals[0];
    if (p && !this.approvalModalOpen) {
      this.approvalModalOpen = true;
      new ApprovalModal(this.app, p, this.runtime.approvals, () => (this.approvalModalOpen = false)).open();
    }
    const q = this.runtime.approvals.pendingQuestions.find((x) => x.sessionId === current) ?? this.runtime.approvals.pendingQuestions[0];
    if (q && !this.questionModalOpen) {
      this.questionModalOpen = true;
      new QuestionModal(this.app, q, this.runtime.approvals, () => (this.questionModalOpen = false)).open();
    }
  }
}

export class ApprovalModal extends Modal {
  constructor(
    app: App,
    private p: PendingApproval,
    private center: { decideApproval(p: PendingApproval, outcome: "allowed-once" | "rejected"): Promise<RpcReceipt> },
    private onCloseCb: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`DSH 请求执行：${this.p.toolName}`);
    this.contentEl.createEl("p").setText(this.p.reason ?? "（未说明理由）");
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("拒绝").onClick(() => void this.decide("rejected")))
      .addButton((b) => b.setButtonText("允许一次").setCta().onClick(() => void this.decide("allowed-once")));
  }

  private async decide(outcome: "allowed-once" | "rejected"): Promise<void> {
    try {
      const receipt = await this.center.decideApproval(this.p, outcome);
      if (receipt.accepted) {
        this.close();
        return;
      }
      if (receipt.accepted === false && receipt.reason === "not-pending") {
        new Notice("该审批已在别处处理");
        this.close();
        return;
      }
      new Notice("应答未被接受，请重试"); // bad-response：保留弹窗供重试
    } catch (err) {
      new Notice(`审批应答失败，请重试：${err instanceof Error ? err.message : String(err)}`);
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
    private onCloseCb: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("DSH 想问你几个问题");
    for (const q of this.p.questions) {
      this.contentEl.createEl("h6").setText(q.header ?? q.question);
      if (q.detail) this.contentEl.createEl("p").setText(q.detail);
      const options = q.options ?? [];
      if (options.length === 0) {
        const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: "自由回答" } });
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
    new Setting(this.contentEl).addButton((b) => b.setButtonText("提交").setCta().onClick(() => void this.submit()));
  }

  private async submit(): Promise<void> {
    try {
      const receipt = await this.center.answerQuestion(this.p, this.answers);
      if (receipt.accepted) {
        this.close();
        return;
      }
      if (receipt.accepted === false && receipt.reason === "not-pending") {
        new Notice("该提问已在别处处理");
        this.close();
        return;
      }
      new Notice("应答未被接受，请重试");
    } catch (err) {
      new Notice(`提问应答失败，请重试：${err instanceof Error ? err.message : String(err)}`);
      // 不关闭：可重试
    }
  }

  onClose(): void {
    this.onCloseCb();
  }
}
