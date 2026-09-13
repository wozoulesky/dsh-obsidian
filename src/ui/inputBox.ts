import { filterCommandSuggestions, matchSuggestToken, mergeCommandSuggestions } from "./prompts";
import { FALLBACK_IMAGE_LIMITS, formatBytes, validateImage, type ImageRejection, type ReadyImage } from "./imageAttach";
import { pickVaultImage } from "./imagePicker";
import { MentionIndex } from "./mentionIndex";
import { Notice } from "obsidian";
import { clearTimer, setTimer } from "../utils/timers";
import type { EventRef } from "obsidian";
import type { CommandDescriptor, ImageAttachmentLimits } from "../transport/types";
import type { DshRuntime } from "../main";
import type { SessionView } from "../core/eventFold";

/** 联想防抖窗口：窗口内连续输入只保留最后一次查询，避免每次按键都触发 `@` 全库扫描。 */
export const SUGGEST_DEBOUNCE_MS = 120;

/**
 * 多行输入框 + `/` 与 `@` 联想弹层 + 图片附件 + Shift+Tab 计划模式切换。
 *
 * DOM 布局（顺序有约束，勿随意调整）：`wrap`（textarea + 联想弹层）是容器的**第一个**子元素，
 * 附件条（📎 + 已选图片 chip）挂在 wrap **之后**——联想弹层用绝对定位贴着 textarea，
 * 附件条另起一行放在输入框下方。
 */
export class DshInputBox {
  private wrap: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private suggestEl: HTMLElement | null = null;
  private suggestKind: "slash" | "mention" | null = null;
  private suggestItems: string[] = [];
  private suggestIndex = 0;
  /** `@` 提及候选缓存（惰性重建，vault 集合变化时失效）。 */
  private mentionIndex: MentionIndex;
  /** vault 变更订阅句柄：由 dispose() 统一注销，避免 view 关闭后回调仍持引用。 */
  private mentionEventRefs: EventRef[] = [];
  private suggestTimer: ReturnType<typeof setTimeout> | null = null;
  /** 已选待发送图片（发送成功后清空；发送失败保留，便于重试）。 */
  private pendingImages: ReadyImage[] = [];
  private attachBar!: HTMLElement;
  private chipsEl!: HTMLElement;
  /** 已渲染的 chip 数量：为 0 且无待清理项时完全不碰 DOM（也避免无谓的 empty()）。 */
  private renderedChips = 0;

  constructor(
    private container: HTMLElement,
    private runtime: DshRuntime,
    private getView: () => SessionView | undefined,
    private onSend: (text: string, images: ReadyImage[]) => Promise<boolean>,
    private onPlanToggle: (active: boolean) => void,
    /** 服务端命令清单提供者（`null` = 尚未拉取 → 联想退回内置兜底清单）。 */
    private getCommands: () => readonly CommandDescriptor[] | null = () => null
  ) {
    this.wrap = container.createDiv({ cls: "dsh-input-wrap" });
    this.textarea = this.wrap.createEl("textarea", { cls: "dsh-input", attr: { placeholder: this.runtime.i18n.t("input.placeholder") } });
    this.textarea.addEventListener("keydown", (e) => {
      void this.onKeydown(e);
    });
    this.textarea.addEventListener("input", () => this.scheduleSuggest());
    this.buildAttachBar();

    const vault = this.runtime.plugin.app.vault;
    this.mentionIndex = new MentionIndex(vault);
    const invalidate = (): void => this.mentionIndex.invalidate();
    // 文件集合（路径）变化即失效；逐个注册——各事件回调签名不同，无法传联合类型的事件名。
    // 注意：Vault 没有 "changed" 事件（那是 MetadataCache 的），内容修改对应 "modify"；
    // "modify" 不改路径集合，保留它只是保守兜底。
    this.mentionEventRefs = [
      vault.on("create", invalidate),
      vault.on("delete", invalidate),
      vault.on("rename", invalidate),
      vault.on("modify", invalidate),
    ];
  }

  /** view 关闭时调用：取消挂起的联想查询、注销 vault 订阅并释放提及缓存与弹层。 */
  dispose(): void {
    if (this.suggestTimer !== null) {
      clearTimer(this.suggestTimer);
      this.suggestTimer = null;
    }
    const vault = this.runtime.plugin.app.vault;
    for (const ref of this.mentionEventRefs) vault.offref(ref);
    this.mentionEventRefs = [];
    this.mentionIndex.invalidate();
    this.pendingImages = [];
    this.renderChips(); // 同步清掉 chip（视图销毁前不留悬空 UI）
    this.closeSuggest();
  }

  focus(): void {
    this.textarea.focus();
  }

  /** 命令清单/目录加载完成后刷新联想（弹层开着时立刻用新数据重绘）。 */
  refreshSuggest(): void {
    this.updateSuggest();
  }

  /* ---- 图片附件（TASK-030 项 3）---- */

  /** 附件条：已选图片 chip + 📎 按钮（建在 wrap 之后，不影响联想弹层的绝对定位）。 */
  private buildAttachBar(): void {
    this.attachBar = this.container.createDiv({ cls: "dsh-attach-bar" });
    this.chipsEl = this.attachBar.createDiv({ cls: "dsh-attach-chips" });
    const addBtn = this.attachBar.createEl("button", { cls: "dsh-attach-add", text: this.runtime.i18n.t("input.attachImage"), attr: { type: "button" } });
    addBtn.addEventListener("click", () => void this.attachImage());
  }

  /** 选中 vault 内图片：vault API 读字节 → 按 imageLimits 校验 → 入待发队列。 */
  private async attachImage(): Promise<void> {
    const result = await pickVaultImage(this.runtime.plugin.app, this.runtime.i18n.t("input.imagePlaceholder"));
    if (!result.ok) {
      if (result.reason === "readFailed") new Notice(this.runtime.i18n.t("input.imageReadFailed"));
      else if (result.reason === "unsupported") new Notice(this.runtime.i18n.t("input.imageUnsupportedType", { types: FALLBACK_IMAGE_LIMITS.mediaTypes.join(", ") }));
      return; // 取消：静默
    }
    // 上限以会话投影为准；投影尚未到达时用保守默认值（见 imageAttach.FALLBACK_IMAGE_LIMITS）
    const limits = this.getView()?.imageLimits ?? FALLBACK_IMAGE_LIMITS;
    const rejection = validateImage(this.pendingImages, result.image, limits);
    if (rejection !== null) {
      new Notice(this.rejectionText(rejection, limits));
      return;
    }
    this.pendingImages.push(result.image);
    this.renderChips();
  }

  private rejectionText(rejection: ImageRejection, limits: ImageAttachmentLimits): string {
    switch (rejection) {
      case "tooMany":
        return this.runtime.i18n.t("input.imageTooMany", { count: limits.maxImagesPerMessage });
      case "tooLarge":
        return this.runtime.i18n.t("input.imageTooLarge", { size: formatBytes(limits.maxImageBytes) });
      case "totalTooLarge":
        return this.runtime.i18n.t("input.imageTotalTooLarge", { size: formatBytes(limits.maxMessageImageBytes) });
      default:
        return this.runtime.i18n.t("input.imageUnsupportedType", { types: limits.mediaTypes.join(", ") });
    }
  }

  /** 重绘 chip（数量未变且无残留时不碰 DOM）。 */
  private renderChips(): void {
    if (this.pendingImages.length === 0 && this.renderedChips === 0) return;
    this.chipsEl.empty();
    this.pendingImages.forEach((image, index) => {
      // 用 Obsidian 简写 createSpan（社区审核 prefer-create-el：字面量 "span"/"div" 不应传给 createEl）
      const chip = this.chipsEl.createSpan({ cls: "dsh-attach-chip" });
      chip.createSpan({ text: `${image.path} (${formatBytes(image.byteLength)})` });
      const remove = chip.createEl("button", { cls: "dsh-attach-remove", text: "✕", attr: { type: "button" } });
      remove.addEventListener("click", () => {
        this.pendingImages.splice(index, 1);
        this.renderChips();
      });
    });
    this.renderedChips = this.pendingImages.length;
  }

  private async onKeydown(e: KeyboardEvent): Promise<void> {
    if (this.suggestEl) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.suggestIndex = (this.suggestIndex + 1) % this.suggestItems.length;
        this.renderSuggest();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.suggestIndex = (this.suggestIndex - 1 + this.suggestItems.length) % this.suggestItems.length;
        this.renderSuggest();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        this.acceptSuggest();
        return;
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        this.acceptSuggest();
        return;
      }
      if (e.key === "Escape") {
        this.closeSuggest();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = this.textarea.value.trim();
      const images = this.pendingImages;
      if (text.length === 0 && images.length === 0) return;
      this.textarea.value = "";
      this.closeSuggest();
      const ok = await this.onSend(text, images);
      if (ok) {
        // 发送成功才清空待发图片；失败保留（用户不必重新选一遍）
        this.pendingImages = [];
        this.renderChips();
      }
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      await this.togglePlan();
    }
  }

  private async togglePlan(): Promise<void> {
    const view = this.getView();
    if (!view) return;
    const target = !view.plan.active;
    view.plan.pending = true; // 本地乐观标记；服务端 rc.6 不推送 plan 状态帧，不能依赖投影回执
    const ok = await this.onSend(target ? "/plan" : "/plan off", []);
    if (ok) {
      this.onPlanToggle(target); // 发送成功即显示切换结果，避免「切换中」永久卡住
    } else {
      view.plan.pending = false; // 失败回滚（onSend 内已提示）
    }
  }

  /** 防抖入口：窗口内重复输入只重置定时器，回调时读取最新文本（只保留最后一次查询）。 */
  private scheduleSuggest(): void {
    if (this.suggestTimer !== null) clearTimer(this.suggestTimer);
    this.suggestTimer = setTimer(() => {
      this.suggestTimer = null;
      this.updateSuggest();
    }, SUGGEST_DEBOUNCE_MS);
  }

  private updateSuggest(): void {
    const value = this.textarea.value;
    const cursor = this.textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const token = matchSuggestToken(before);
    if (!token) {
      this.closeSuggest();
      return;
    }
    const i18n = this.runtime.i18n;
    const items = token.kind === "slash"
      ? filterCommandSuggestions(mergeCommandSuggestions(this.getCommands(), (key, params) => i18n.t(key, params)), token.query).map(
          (c) => `${c.name} — ${c.description}`
        )
      : this.mentionIndex.candidates(token.query);
    if (items.length === 0) {
      this.closeSuggest();
      return;
    }
    this.suggestKind = token.kind;
    this.suggestItems = items;
    this.suggestIndex = 0;
    this.renderSuggest();
  }

  private renderSuggest(): void {
    this.closeSuggest();
    this.suggestEl = this.wrap.createDiv({ cls: "dsh-suggest" });
    this.suggestItems.forEach((item, i) => {
      const el = this.suggestEl!.createDiv({ cls: "dsh-suggest-item" + (i === this.suggestIndex ? " dsh-active" : "") });
      el.setText(item);
      el.addEventListener("click", () => {
        this.suggestIndex = i;
        this.acceptSuggest();
      });
    });
  }

  private acceptSuggest(): void {
    if (!this.suggestEl) return;
    const item = this.suggestItems[this.suggestIndex];
    if (item === undefined) return;
    const value = this.textarea.value;
    const cursor = this.textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const startMatch = before.match(/(@(?:file|folder):[^\s@]*|@[^\s@/]*|\/[^\s@/]*)$/);
    const start = startMatch ? before.length - startMatch[0].length : Math.max(before.lastIndexOf("@"), before.lastIndexOf("/"));
    const insert = this.suggestKind === "mention" ? item : item.split(" — ")[0];
    this.textarea.value = before.slice(0, start) + insert + value.slice(cursor);
    this.closeSuggest();
    this.textarea.focus();
  }

  private closeSuggest(): void {
    this.suggestEl?.remove();
    this.suggestEl = null;
    this.suggestKind = null;
    // 注意：不能清空 suggestItems/suggestIndex —— renderSuggest 渲染时依赖它们；
    // 旧实现先 closeSuggest 再 forEach 导致列表永远为空（弹窗从不出项）。
    // 列表由 updateSuggest 在每次输入时整体替换。
  }
}
