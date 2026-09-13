import { App, ItemView, MarkdownRenderer, Modal, Notice, Setting, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { DshInputBox } from "./inputBox";
import { resolveMentions, truncate, routeInput } from "./prompts";
import { canReuseNode, nodeCacheKey, nodeSignature, type NodeCacheEntry } from "./chatNode";
import { headerOptions, syncSelectOptions } from "./headerSelect";
import {
  currentSelection,
  decodeSelectionValue,
  effortForModel,
  effortOptions,
  encodeSelectionValue,
  modelOptions,
  reasoningChoice,
  selectionRequest,
  syncEffortSelect,
  syncModelSelect,
} from "./modelSelect";
import { buildPromptContent, toCommandAttachments, type ReadyImage } from "./imageAttach";
import { classifyCommandResult } from "../core/commands";
import { goalPanelSignature, goalPanelState, goalRefOf, goalSummaryText } from "./goalPanel";
import { contextUsageText, renderReasoning, tokenUsageText, writeMetrics, writeTodos, type Translate } from "./sessionStatus";
import type { I18n } from "../i18n";
import { clearTimer, setTimer } from "../utils/timers";
import type { DshRuntime } from "../main";
import type { SessionView, ViewNode } from "../core/eventFold";
import type { PendingApproval, PendingQuestion } from "../core/approvalCenter";
import type { AskUserQuestionAnswerItem, CommandDescriptor, GoalProjection, ModelCatalog } from "../transport/types";

export const VIEW_TYPE_DSH_CHAT = "dsh-chat";

/**
 * 钉底写入值：赋一个必然超过最大滚动量的值，由浏览器钳到最大值——
 * 这样「滚到底部」不需要在 DOM 变更后再读一次 `scrollHeight`（那会触发强制同步布局）。
 */
const SCROLL_TO_BOTTOM = 1e7;

/** 思考过程正文的展示上限（与工具卡结果同一量级）：推理可能极长，节点上界要可控。 */
const REASONING_MAX_CHARS = 4000;

export class DshChatView extends ItemView {
  private headerEl!: HTMLElement;
  /** 头部会话下拉：只建一次，之后由 syncSelectOptions 增量同步（见 headerSelect.ts）。 */
  private headerSelect: HTMLSelectElement | null = null;
  private planEl!: HTMLElement;
  private msgEl!: HTMLElement;
  private input!: DshInputBox;
  private lastRenderAt = 0;
  private renderPending = false;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  /** 挂起的合帧句柄：rAF 优先，不可用时回退定时器；两者互斥，null=无挂起帧。 */
  private frameRaf: number | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private approvalModalOpen = false;
  private questionModalOpen = false;
  private disposers: (() => void)[] = [];
  /** 消息节点 DOM 缓存：key=`${sessionId}:${node.id}`，避免流式时全量重建/重渲染 Markdown。 */
  private nodeCache = new Map<string, NodeCacheEntry>();
  private cachedSessionId: string | null = null;
  private olderBtn!: HTMLElement;
  private nodesEl!: HTMLElement;
  private runningEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  /** 底部状态行（上下文占用 + 输出用量）：无数据时整行 dsh-hidden，不占位。 */
  private metricsEl!: HTMLElement;
  /** 待办清单容器（输入框上方）：空/null 时 dsh-hidden。 */
  private todosEl!: HTMLElement;
  /** 已写入状态行的文案；相同则不再写 DOM（null=当前不可见）。 */
  private metricsText: string | null = null;
  /** 已渲染待办清单的签名；相同则完全不动 DOM（保住用户展开状态）。 */
  private todosSig: string | null = null;
  /** 「加载更早」进行中标志（防双击并发重复前插）；null=未知，false=无更多。 */
  private olderLoading = false;
  private olderHasMore: boolean | null = null;
  /** 模型选择区（TASK-030 项 1）：模型下拉 + 推理档位下拉；目录未加载时整行隐藏。 */
  private modelRow: HTMLElement | null = null;
  private modelSelect: HTMLSelectElement | null = null;
  private effortSelect: HTMLSelectElement | null = null;
  /** 宿主模型目录（`session/modelCatalog`，宿主级、与会话无关）；null=未加载/加载失败。 */
  private catalog: ModelCatalog | null = null;
  /** 模型选择区已渲染的签名（避免每帧重建 <option>）。 */
  private modelSig: string | null = null;
  /** 目标面板（TASK-030 项 4）：容器 + 已渲染签名（签名未变则一帧 DOM 都不动）。 */
  private goalEl!: HTMLElement;
  private goalSig: string | null = null;
  private goalInputEl: HTMLInputElement | null = null;
  /** 目标操作的进行中标志（防连点导致同一 revision 被提交两次）。 */
  private goalBusy = false;

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
          this.scheduleFrame();
        } catch (err) {
          new Notice(this.runtime.i18n.t("chat.loadFailed", { message: err instanceof Error ? err.message : String(err) }));
        } finally {
          this.olderLoading = false;
          this.olderBtn.setText(this.runtime.i18n.t("chat.older"));
          // 用 visibility 隐藏而非 display：保留占位，避免消息列表整体上移贡献 CLS
          if (this.olderHasMore === false) this.olderBtn.addClass("dsh-hidden-visually");
        }
      })();
    });
    this.nodesEl = this.msgEl.createDiv({ cls: "dsh-chat-nodes" });
    this.runningEl = this.msgEl.createDiv({ cls: "dsh-chat-status", text: this.runtime.i18n.t("chat.running") });
    this.emptyEl = this.msgEl.createDiv({ cls: "dsh-chat-status", text: this.runtime.i18n.t("chat.noSession") });
    // 底部状态区（待办面板 → 目标面板 → 用量行 → 输入框）：建在 input 之前，故输入框恒在最下方。
    // 初始 dsh-hidden：有数据才移除（数据缺失时完全不渲染，不产生空壳元素）。
    this.todosEl = contentEl.createDiv({ cls: "dsh-todos dsh-hidden" });
    this.goalEl = contentEl.createDiv({ cls: "dsh-goal dsh-hidden" });
    this.metricsEl = contentEl.createDiv({ cls: "dsh-chat-metrics dsh-hidden" });
    this.input = new DshInputBox(
      contentEl,
      this.runtime,
      () => this.view,
      (text, images) => this.send(text, images),
      (active) => this.applyPlanToggle(active),
      () => this.cachedCommands()
    );

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
    // 宿主级模型目录（TASK-030 项 1）：与是否已有会话无关，打开面板即拉一次；失败静默隐藏选择区
    void this.loadModelCatalog();
  }

  async onClose(): Promise<void> {
    this.cancelFrame();
    if (this.renderTimer) {
      clearTimer(this.renderTimer);
      this.renderTimer = null;
    }
    // input 在 onOpen 中创建：onOpen 提前抛错时 onClose 仍可能被调用，故用可选链防御
    this.input?.dispose();
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
      void this.loadCommands(sessionId); // 命令清单随会话加载（联想与路由都需要）
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.openFailed", { message: err instanceof Error ? err.message : String(err) }));
    }
  }

  /** 当前会话已缓存的命令清单（未拉取 → null，联想退回内置兜底清单）。 */
  private cachedCommands(): readonly CommandDescriptor[] | null {
    const sessionId = this.runtime.manager.currentId;
    return sessionId === undefined ? null : this.runtime.manager.cachedCommands(sessionId);
  }

  /** 拉取命令清单（失败静默：联想退回内置兜底清单，不打扰用户）。 */
  private async loadCommands(sessionId: string): Promise<void> {
    try {
      await this.runtime.manager.loadCommands(sessionId);
      this.input.refreshSuggest(); // 弹层开着时立刻用真实清单重绘
    } catch (err) {
      console.error("[dsh-bridge] 命令清单拉取失败:", err);
    }
  }

  /** Shift+Tab 切换成功后的本地乐观状态：rc.6 服务端不发送 plan 状态帧，按发送结果显示。 */
  private applyPlanToggle(active: boolean): void {
    const view = this.view;
    if (!view) return;
    view.plan.active = active;
    view.plan.pending = false;
    this.scheduleFrame();
  }

  /**
   * 发送一条输入（TASK-030 项 2/3）：
   * 1. `/clear` → 前端命令，本地处理；
   * 2. 词法上是斜杠命令 → 先 `commands/execute`（服务端裁决是否注册）；
   *    返回 `undefined` 表示未命中 → **回退为普通 prompt**（不能吞掉用户输入）；
   * 3. 其余（或未命中）→ 解析 @提及 + 组装文本/图片 content 发送。
   */
  private async send(text: string, images: readonly ReadyImage[] = []): Promise<boolean> {
    const route = routeInput(text);
    if (route.kind === "clear") {
      await this.handleClear();
      return true;
    }
    const sessionId = this.runtime.manager.currentId;
    if (!sessionId) {
      new Notice(this.runtime.i18n.t("chat.pleaseCreateSession"));
      return false;
    }
    if (route.kind === "command") {
      const outcome = await this.runCommandLine(sessionId, text, images);
      if (outcome !== "not-a-command") return outcome === "ok";
      // 未命中命令：继续按普通消息发送（例如 "/tmp/foo 看看" 这类正文）
    }
    return this.sendPrompt(sessionId, text, images);
  }

  /** 执行斜杠命令；返回 `not-a-command` 表示服务端不认识这行（调用方回退为普通 prompt）。 */
  private async runCommandLine(sessionId: string, line: string, images: readonly ReadyImage[] = []): Promise<"ok" | "failed" | "not-a-command"> {
    const name = line.trim().split(/\s/u)[0] ?? line;
    try {
      // 附件随命令提交：`/goal`、`/plan` 声明了 input.attachments（真机实测），
      // 不收附件的命令由 host 明确报错——插件不猜。
      const res = await this.runtime.manager.runCommand(sessionId, line, toCommandAttachments(images));
      const outcome = classifyCommandResult(res);
      if (outcome === "fallback") return "not-a-command"; // 词法成立但名字未注册：按普通消息处理
      if (outcome === "failed") {
        if (!res.ok) new Notice(this.runtime.i18n.t("chat.commandSendFailed", { message: res.error.message }));
        else if (res.value !== undefined && res.value.result.kind === "error") {
          // 命令存在但执行失败：提示失败原因，**不**把命令行当正文重发
          new Notice(this.runtime.i18n.t("chat.commandFailed", { name, text: res.value.result.text }));
        }
        return "failed";
      }
      const resultText = res.ok && res.value !== undefined ? res.value.result.text : undefined;
      new Notice(
        resultText === undefined
          ? this.runtime.i18n.t("chat.commandDone", { name })
          : this.runtime.i18n.t("chat.commandDoneWithText", { name, text: truncate(resultText, 200) })
      );
      return "ok";
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.commandSendFailed", { message: err instanceof Error ? err.message : String(err) }));
      return "failed";
    }
  }

  /** 普通 prompt：解析 @提及 → 组装 content（文本 + 图片）→ session/prompt。 */
  private async sendPrompt(sessionId: string, text: string, images: readonly ReadyImage[]): Promise<boolean> {
    const clearPendingPlan = (): void => {
      const view = this.view;
      if (view && view.plan.pending) {
        view.plan.pending = false;
        this.scheduleFrame();
      }
    };
    try {
      const resolved = await resolveMentions(text, (path) => this.readVaultFile(path), this.runtime.settings.values.mentionMaxChars);
      const content = buildPromptContent(resolved, images);
      const res = await this.runtime.manager.promptContent(sessionId, content, "queue");
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
    const select = this.headerSelect ?? this.buildHeaderRow();
    // 增量：会话集合未变就不重建 <option>（头部在每次切会话/命令面板新建会话后都会被刷新）
    syncSelectOptions(
      select,
      headerOptions(this.runtime.manager.sessions, (id) => this.runtime.manager.sessionTitle(id), this.runtime.i18n.t("chat.noSessionOption")),
      this.runtime.manager.currentId ?? ""
    );
  }

  /** 建头部行（下拉 + 新建 + 停止）：只在首次渲染时调用一次，之后复用同一批 DOM。 */
  private buildHeaderRow(): HTMLSelectElement {
    const row = this.headerEl.createDiv();
    const select = row.createEl("select");
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
    this.headerSelect = select;
    return select;
  }

  /** 外部（如命令面板）触发会话列表变化后刷新头部下拉。 */
  refreshHeader(): void {
    this.renderHeader();
  }

  /* ---- 模型选择区（TASK-030 项 1）---- */

  /** 建模型选择行（模型下拉 + 推理档位下拉）：只在首次渲染时建一次，之后增量同步。 */
  private buildModelRow(): void {
    const row = this.headerEl.createDiv({ cls: "dsh-model-row dsh-hidden" });
    const modelSelect = row.createEl("select", { cls: "dsh-model-select" });
    modelSelect.addEventListener("change", () => void this.applyModelChange());
    const effortSelect = row.createEl("select", { cls: "dsh-model-effort dsh-hidden" });
    effortSelect.addEventListener("change", () => void this.applyEffortChange());
    this.modelRow = row;
    this.modelSelect = modelSelect;
    this.effortSelect = effortSelect;
  }

  /** 拉取宿主模型目录（失败静默隐藏选择区：不因为一个可选功能打扰用户）。 */
  private async loadModelCatalog(): Promise<void> {
    try {
      const res = await this.runtime.manager.modelCatalog();
      if (!res.ok) throw new Error(res.error.message);
      this.catalog = res.value;
      this.modelSig = null; // 目录变化 → 强制下一次同步重建选项
      this.scheduleFrame();
    } catch (err) {
      console.error("[dsh-bridge] 模型目录拉取失败:", err);
      this.catalog = null;
      this.scheduleFrame();
    }
  }

  /**
   * 同步模型选择区（每帧调用，靠签名做脏检查）。
   *
   * 签名 = 目录版本 + 当前会话 + 当前选择 + 档位集合：任一项变化才重建 `<option>`，
   * 否则连 DOM 都不碰（与会话头部下拉、待办面板同一策略）。
   */
  private renderModelRow(view: SessionView | undefined): void {
    if (!this.modelRow || !this.modelSelect || !this.effortSelect) {
      if (!this.headerEl) return;
      this.buildModelRow();
    }
    const row = this.modelRow;
    const modelSelect = this.modelSelect;
    const effortSelect = this.effortSelect;
    if (!row || !modelSelect || !effortSelect) return;
    const options = modelOptions(this.catalog ?? undefined);
    if (options.length === 0 || !this.runtime.manager.currentId) {
      row.addClass("dsh-hidden"); // 未加载/加载失败/无会话：整行不占位
      this.modelSig = null;
      return;
    }
    const sessionId = this.runtime.manager.currentId;
    const selection = currentSelection(view?.modelSelection, this.catalog ?? undefined);
    const choice = reasoningChoice(this.catalog ?? undefined, selection);
    const effortOpts = effortOptions(choice, this.runtime.i18n.t("chat.effortDefault"));
    const sig = [sessionId, String(this.catalog === null), selection?.provider ?? "", selection?.model ?? "", selection?.reasoningEffort ?? "", choice.selected, effortOpts.length].join("\u0001");
    if (sig !== this.modelSig) {
      this.modelSig = sig;
      row.removeClass("dsh-hidden");
      syncModelSelect(modelSelect, options, selection === undefined ? "" : encodeSelectionValue(selection));
      syncEffortSelect(effortSelect, effortOpts, choice.selected);
      effortSelect.toggleClass("dsh-hidden", effortOpts.length === 0);
    }
  }

  /** 用户切换模型：提交 provider/model + 新模型的 defaultEffort（与官方客户端一致）。 */
  private async applyModelChange(): Promise<void> {
    const sessionId = this.runtime.manager.currentId;
    const value = this.modelSelect?.value ?? "";
    if (!sessionId || value.length === 0) return;
    const decoded = decodeSelectionValue(value);
    if (!decoded) return;
    const request = selectionRequest(sessionId, value, effortForModel(this.catalog ?? undefined, decoded));
    if (!request) return;
    try {
      const res = await this.runtime.manager.selectModel(sessionId, {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      });
      if (!res.ok) {
        new Notice(this.runtime.i18n.t("chat.modelSwitchFailed", { message: res.error.message }));
        // 失败：下一次渲染把下拉拨回 modelSelection 投影里的真实选择
        this.modelSig = null;
        this.scheduleFrame();
      }
      // 成功：**不动** modelSig —— 保持用户所选，等 host 的 modelSelection 投影回来再对齐
      //（提前清签名会让下拉在下一次渲染时闪回旧值）
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.modelSwitchFailed", { message: err instanceof Error ? err.message : String(err) }));
      this.modelSig = null;
      this.scheduleFrame();
    }
  }

  /** 用户切换推理档位：空串 = 不下发该字段（服务端默认）。 */
  private async applyEffortChange(): Promise<void> {
    const sessionId = this.runtime.manager.currentId;
    const modelSelect = this.modelSelect;
    if (!sessionId || !modelSelect) return;
    const value = modelSelect.value;
    const effort = this.effortSelect?.value ?? "";
    const request = selectionRequest(sessionId, value, effort);
    if (!request) return;
    try {
      const res = await this.runtime.manager.selectModel(sessionId, {
        provider: request.provider,
        model: request.model,
        ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
      });
      if (!res.ok) {
        new Notice(this.runtime.i18n.t("chat.modelSwitchFailed", { message: res.error.message }));
        this.modelSig = null;
        this.scheduleFrame();
      }
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.modelSwitchFailed", { message: err instanceof Error ? err.message : String(err) }));
      this.modelSig = null;
      this.scheduleFrame();
    }
  }

  /* ---- 目标面板（TASK-030 项 4）---- */

  /**
   * 渲染目标面板（每帧调用，靠签名脏检查）。
   *
   * 三种状态：
   * - `goal === undefined`（从未收到投影）→ 隐藏（不产生空壳，与用量/待办同一原则）；
   * - `goal === null`（host 明确告知"没有目标"）→ 只给一个「新建目标」按钮
   *   （不常驻输入框，避免视觉噪音；创建走 `goals/create`）；
   * - 有目标 → 目标条 + 阶段动作按钮（写操作全部走 `goals/*`）。
   */
  private renderGoal(view: SessionView | undefined): void {
    const state = goalPanelState(view?.goal);
    const sig = goalPanelSignature(state);
    if (sig === this.goalSig) return;
    this.goalSig = sig;
    this.goalEl.empty();
    this.goalInputEl = null;
    if (state.kind === "hidden") {
      this.goalEl.addClass("dsh-hidden");
      return;
    }
    this.goalEl.removeClass("dsh-hidden");
    if (state.kind === "none") {
      const row = this.goalEl.createDiv({ cls: "dsh-goal-bar" });
      const create = row.createEl("button", { cls: "dsh-goal-create", text: this.runtime.i18n.t("chat.goalCreate"), attr: { type: "button" } });
      create.addEventListener("click", () => this.showGoalInput(null));
      return;
    }
    const goal = state.goal;
    const bar = this.goalEl.createDiv({ cls: "dsh-goal-bar" });
    bar.createDiv({ cls: `dsh-goal-summary dsh-goal-${goal.goal.phase}`, text: goalSummaryText(goal, this.translate) });
    const actions = state.actions;
    const buttons = bar.createDiv({ cls: "dsh-goal-actions" });
    const add = (label: string, run: () => void, enabled: boolean): void => {
      const btn = buttons.createEl("button", { text: label, attr: { type: "button" } });
      btn.toggleClass("dsh-hidden", !enabled);
      btn.addEventListener("click", () => {
        if (this.goalBusy) return; // 防连点：同一个 revision 提交两次会被 CAS 拒绝
        run();
      });
    };
    add(this.runtime.i18n.t("chat.goalPause"), () => void this.runGoalAction("pause"), actions.canPause);
    add(this.runtime.i18n.t("chat.goalResume"), () => void this.runGoalAction("resume"), actions.canResume);
    add(this.runtime.i18n.t("chat.goalComplete"), () => void this.runGoalAction("complete"), actions.canComplete);
    add(this.runtime.i18n.t("chat.goalEdit"), () => this.showGoalInput(goal), actions.canEdit);
    add(this.runtime.i18n.t("chat.goalClear"), () => void this.runGoalAction("clear"), actions.canClear);
  }

  /** 展开目标输入行（无目标时用于 create，有目标时用于 edit）。 */
  private showGoalInput(goal: GoalProjection | null): void {
    if (this.goalInputEl) return;
    const wrap = this.goalEl.createDiv({ cls: "dsh-goal-input-row" });
    const input = wrap.createEl("input", {
      attr: { type: "text", placeholder: this.runtime.i18n.t("chat.goalPlaceholder"), value: goal?.goal.objective ?? "" },
    });
    this.goalInputEl = input;
    const submit = wrap.createEl("button", {
      text: goal === null ? this.runtime.i18n.t("chat.goalCreate") : this.runtime.i18n.t("chat.goalSave"),
      attr: { type: "button" },
    });
    submit.addEventListener("click", () => {
      void this.submitGoalInput(goal, input.value.trim());
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submitGoalInput(goal, input.value.trim());
      }
    });
    input.focus();
  }

  private async submitGoalInput(goal: GoalProjection | null, objective: string): Promise<void> {
    const sessionId = this.runtime.manager.currentId;
    if (!sessionId || objective.length === 0) return;
    this.goalBusy = true;
    try {
      const res = goal === null
        ? await this.runtime.manager.goalCreate(sessionId, { objective })
        : await this.runtime.manager.goalEdit(sessionId, goalRefOf(goal), { objective });
      if (!res.ok) new Notice(this.runtime.i18n.t("chat.goalFailed", { message: res.error.message }));
      else this.goalSig = null; // 成功：等投影回来重绘（并收起输入行）
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.goalFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.goalBusy = false;
      this.scheduleFrame();
    }
  }

  /** 目标生命周期动作（pause/resume/complete/clear），全部以投影里的 {id,revision} 作 CAS 身份。 */
  private async runGoalAction(action: "pause" | "resume" | "complete" | "clear"): Promise<void> {
    const sessionId = this.runtime.manager.currentId;
    const goal = this.view?.goal;
    if (!sessionId || goal === null || goal === undefined) return;
    this.goalBusy = true;
    try {
      const ref = goalRefOf(goal);
      const res =
        action === "pause"
          ? await this.runtime.manager.goalPause(sessionId, ref)
          : action === "resume"
            ? await this.runtime.manager.goalResume(sessionId, ref)
            : action === "complete"
              ? await this.runtime.manager.goalComplete(sessionId, ref)
              : await this.runtime.manager.goalClear(sessionId, ref);
      if (!res.ok) new Notice(this.runtime.i18n.t("chat.goalFailed", { message: res.error.message }));
      else this.goalSig = null; // 成功：投影随后到达 → 重绘（goal=null 时自动隐藏）
    } catch (err) {
      new Notice(this.runtime.i18n.t("chat.goalFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      this.goalBusy = false;
      this.scheduleFrame();
    }
  }

  /**
   * 渲染当前会话（限流：chunk 高频推送时每 150ms 最多提交一次）。
   * 限流只负责压低请求频率；实际 DOM 写入统一交给 scheduleFrame() 合帧。
   */
  private render(): void {
    const now = Date.now();
    if (now - this.lastRenderAt < 150) {
      if (!this.renderPending) {
        this.renderPending = true;
        this.renderTimer = setTimer(() => {
          this.renderPending = false;
          this.renderTimer = null;
          this.scheduleFrame();
        }, 150);
      }
      return;
    }
    this.lastRenderAt = now;
    this.scheduleFrame();
  }

  /**
   * 把同一帧内的多次渲染请求合并为一次 DOM 写入。
   * 优先 requestAnimationFrame（与浏览器绘制对齐）；不可用时（后台窗口/测试环境）回退 16ms 定时器。
   */
  private scheduleFrame(): void {
    if (this.frameRaf !== null || this.frameTimer !== null) return; // 已有挂起帧：本次请求被合并
    if (typeof window.requestAnimationFrame === "function") {
      this.frameRaf = window.requestAnimationFrame(() => {
        this.frameRaf = null;
        this.renderNow();
      });
      return;
    }
    this.frameTimer = setTimer(() => {
      this.frameTimer = null;
      this.renderNow();
    }, 16);
  }

  /** 取消挂起帧：view 关闭时调用，避免销毁后仍写 DOM。 */
  private cancelFrame(): void {
    if (this.frameRaf !== null) {
      window.cancelAnimationFrame(this.frameRaf);
      this.frameRaf = null;
    }
    if (this.frameTimer !== null) {
      clearTimer(this.frameTimer);
      this.frameTimer = null;
    }
  }

  private renderNow(): void {
    const view = this.view;
    const msg = this.msgEl;
    // 几何只在 DOM 变更**之前**读一次（此刻无待提交的样式/布局变更，量取不触发强制同步布局）；
    // 变更之后只写一次 scrollTop，绝不再读 scrollHeight。
    const scrollTop = msg.scrollTop;
    const atBottom = scrollTop + msg.clientHeight >= msg.scrollHeight - 4;

    this.planEl.empty();
    if (view) {
      if (view.plan.pending) this.planEl.createDiv({ cls: "dsh-plan-banner", text: this.runtime.i18n.t("chat.planPending") });
      else if (view.plan.active) this.planEl.createDiv({ cls: "dsh-plan-banner", text: this.runtime.i18n.t("chat.planActive") });
    }

    // 状态区在「无视图」分支之前渲染：切到无会话时同样要收起（否则会留着上个会话的用量/待办）
    this.renderStatus(view);
    this.renderGoal(view);
    this.renderModelRow(view);

    if (!view) {
      this.cachedSessionId = null;
      this.nodeCache.clear();
      this.nodesEl.empty();
      this.olderBtn.addClass("dsh-hidden");
      this.runningEl.addClass("dsh-hidden");
      this.emptyEl.removeClass("dsh-hidden");
      return;
    }

    if (this.cachedSessionId !== view.sessionId) {
      this.cachedSessionId = view.sessionId;
      this.nodeCache.clear();
      this.nodesEl.empty();
      // 「加载更早」状态是会话相关的：切会话后重置，避免旧会话的 hasMore=false 把按钮带没了
      this.olderHasMore = null;
    }

    this.olderBtn.removeClass("dsh-hidden"); // 有视图时移除初始无视图分支留下的 display:none（真机验收 #4 根因：按钮永远不可见）
    this.olderBtn.toggleClass("dsh-hidden-visually", this.olderHasMore === false);
    this.runningEl.toggleClass("dsh-hidden", !view.running);
    this.emptyEl.addClass("dsh-hidden");

    const seen = new Set<string>();
    for (const node of view.nodes) {
      const key = nodeCacheKey(view.sessionId, node);
      seen.add(key);
      const cached = this.nodeCache.get(key);
      if (cached && canReuseNode(cached, node)) {
        // 复用已有 DOM：appendChild 会按当前遍历顺序移动，保证「加载更早」前插、节点顺序正确。
        this.nodesEl.appendChild(cached.el);
      } else {
        // 签名变化或节点对象被替换（视图重建）：先销毁旧 DOM！否则流式期间每个 chunk 都会残留一条重复消息
        //（旧节点未移除 → 消息列表无限增长 → CLS/INP 恶化、视口内容上跳）
        cached?.el.remove();
        const el = this.buildNodeEl(node);
        this.nodeCache.set(key, { el, sig: nodeSignature(node), node });
        this.nodesEl.appendChild(el);
      }
    }
    for (const [key, cached] of this.nodeCache) {
      if (!seen.has(key)) {
        cached.el.remove();
        this.nodeCache.delete(key);
      }
    }

    // 变更后只写一次 scrollTop：钉底写钳位哨兵值，否则原样写回用户位置——均不读取布局。
    msg.scrollTop = atBottom ? SCROLL_TO_BOTTOM : scrollTop;
  }

  /** 构建单条消息 DOM；与缓存解耦，返回元素供 renderNow 复用或重建。 */
  private buildNodeEl(node: ViewNode): HTMLElement {
    // 统一用 this.nodesEl.createDiv（Obsidian helper 与社区审核规则 obsidianmd/prefer-create-el）；
    // 创建即挂载到 nodesEl 末尾，renderNow 随后按遍历顺序 appendChild 调整，最终顺序正确，与缓存复用兼容。
    if (node.kind === "user") {
      const el = this.nodesEl.createDiv({ cls: node.sourceKind === "user" ? "dsh-msg-user" : "dsh-msg-context" });
      // 图片消息：正文里没有图片本体（事件只带 durable 引用），用计数标记提示"这条带图"
      if (node.imageCount > 0) {
        el.createDiv({ cls: "dsh-msg-images", text: this.runtime.i18n.t("chat.imageCount", { count: node.imageCount }) });
      }
      if (node.text.length > 0) el.createDiv({ text: node.text });
      return el;
    }
    if (node.kind === "error") {
      return this.nodesEl.createDiv({ cls: "dsh-msg-context", text: this.runtime.i18n.t("chat.turnError", { message: node.text }) });
    }
    if (node.kind === "command") {
      const statusText = node.status === "running" ? "⏳" : node.status === "success" ? "✓" : "✗";
      return this.nodesEl.createDiv({
        cls: "dsh-msg-command",
        text: node.text
          ? this.runtime.i18n.t("chat.commandLineWithText", { status: statusText, name: node.name, text: node.text })
          : this.runtime.i18n.t("chat.commandLine", { status: statusText, name: node.name }),
      });
    }
    const wrap = this.nodesEl.createDiv({ cls: "dsh-msg-assistant" });
    // 思考过程折叠块（正文上方）：仅当有推理内容时渲染。流式期间默认展开并跟随更新
    // （与官方 DSH 语义一致：回合进行中 reasoning 保持展开，收尾后折叠）；流式取尾部
    // （用户在看"现在想到哪"），定格取头部（从头读）。推理可能极长，必须截断。
    renderReasoning(wrap, node.reasoning, node.streaming, REASONING_MAX_CHARS, this.translate);
    const body = wrap.createDiv();
    if (node.streaming) {
      // 流式中：纯文本即时更新（setText 极轻），Markdown 只在结束时渲染一次——
      // 避免每个 chunk 都全量解析 Markdown（阻塞主线程 → INP 高）与异步渲染撑开高度（CLS）。
      // dsh-streaming-text: white-space: pre-wrap，换行布局接近 Markdown 段落，减小结束渲染的高度突变。
      body.addClass("dsh-streaming-text");
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

  /** 取词函数（sessionStatus 的渲染函数要求注入 translate，避免依赖 I18n 实例）。 */
  private translate: Translate = (key, params) => this.runtime.i18n.t(key, params);

  /**
   * 渲染底部状态区（上下文占用 / 输出用量 / 待办清单）。
   *
   * 「数据缺失 = 完全不渲染」在视图层落成两条 dsh-hidden 判定；两处写入都带脏检查
   * （见 writeMetrics/writeTodos），因此 renderNow 每帧调用也不会反复碰 DOM——
   * 待办面板尤其重要：重建会丢掉用户的展开状态。
   */
  private renderStatus(view: SessionView | undefined): void {
    const parts: string[] = [];
    if (view) {
      const context = contextUsageText(view.contextPressure, this.translate);
      if (context) parts.push(context);
      const tokens = tokenUsageText(view.usage, this.translate);
      if (tokens) parts.push(tokens);
    }
    this.metricsText = writeMetrics(this.metricsEl, parts.length > 0 ? parts.join(" · ") : null, this.metricsText);
    this.todosSig = writeTodos(this.todosEl, view?.todos, this.translate, this.todosSig);
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
    private center: { decideApproval(p: PendingApproval, outcome: "allowed-once" | "rejected"): Promise<boolean> },
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
      const claimed = await this.center.decideApproval(this.p, outcome);
      if (claimed) {
        this.close();
        return;
      }
      // 应答未被接受（bad-response）：保留弹窗供重试（旧交互保留）
      new Notice(this.i18n.t("approval.notAccepted"));
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
    private center: { answerQuestion(p: PendingQuestion, answers: AskUserQuestionAnswerItem[]): Promise<boolean> },
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
      const claimed = await this.center.answerQuestion(this.p, this.answers);
      if (claimed) {
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
