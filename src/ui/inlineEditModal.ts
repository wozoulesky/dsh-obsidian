import { App, Editor, Modal, Notice, Setting } from "obsidian";
import { wordDiff } from "../core/wordDiff";
import { DiffPreviewModal } from "./diffPreview";
import type { DshRuntime } from "../main";
import type { I18n } from "../i18n";

const LARGE_DIFF_CHARS = 10000;

export class InlineEditModal extends Modal {
  private instruction = "";
  private running = false;
  private closed = false;

  constructor(
    app: App,
    private runtime: DshRuntime,
    private editor: Editor
  ) {
    super(app);
  }

  onOpen(): void {
    const selection = this.editor.getSelection();
    if (selection.trim().length === 0) {
      this.contentEl.createEl("p", { text: this.runtime.i18n.t("inline.promptNoSelection") });
      return;
    }
    this.titleEl.setText(this.runtime.i18n.t("inline.title"));
    this.contentEl.createEl("p", { text: this.runtime.i18n.t("inline.selectedChars", { count: selection.length }) });
    const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: this.runtime.i18n.t("inline.placeholder") } });
    input.value = this.instruction;
    input.addEventListener("input", () => (this.instruction = input.value));
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText(this.runtime.i18n.t("inline.start")).setCta().onClick(() => void this.run(b))
    );
  }

  onClose(): void {
    this.closed = true; // 用户中途关闭（Esc/点击外部）：完成后不再弹后续窗口
  }

  private async run(button: { setDisabled(disabled: boolean): unknown }): Promise<void> {
    if (this.running) return;
    this.running = true;
    button.setDisabled(true);
    const selection = this.editor.getSelection();
    const path = this.runtime.plugin.app.workspace.getActiveFile()?.path ?? "";
    const notice = new Notice(this.runtime.i18n.t("inline.generating"), 0);
    try {
      const result = await this.runtime.inlineEdit.edit(selection, path, this.instruction || this.runtime.i18n.t("inline.defaultInstruction"));
      notice.hide();
      if (this.closed) return; // 用户已关闭弹窗：丢弃结果
      if (result.trim() === selection.trim()) {
        // 模型未做实质修改（如指令是询问式），给出明确反馈而非空 diff
        new Notice(this.runtime.i18n.t("inline.sameContent"));
        this.close();
        return;
      }
      if (selection.length > LARGE_DIFF_CHARS || result.length > LARGE_DIFF_CHARS) {
        // 超大内容跳过词级 diff（O(n·m) 内存），直接确认替换
        new ConfirmReplaceModal(this.app, () => this.apply(selection, result), this.runtime.i18n).open();
      } else {
        new DiffPreviewModal(this.app, wordDiff(selection, result), () => this.apply(selection, result), this.runtime.i18n).open();
      }
      this.close();
    } catch (err) {
      notice.hide();
      if (!this.closed) {
        new Notice(this.runtime.i18n.t("inline.editFailed", { message: err instanceof Error ? err.message : String(err) }));
      }
      this.close();
    }
  }

  /** 应用前重新校验：编辑器仍活跃且选区未变。 */
  private apply(selection: string, result: string): void {
    const active = this.runtime.plugin.app.workspace.activeEditor?.editor;
    if (!active || active !== this.editor || active.getSelection() !== selection) {
      new Notice(this.runtime.i18n.t("inline.selectionChanged"));
      return;
    }
    active.replaceSelection(result);
  }
}

/** 超大内容的简易确认替换弹窗（无 diff 预览）。 */
export class ConfirmReplaceModal extends Modal {
  constructor(
    app: App,
    private onApply: () => void,
    private i18n: I18n
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.i18n.t("inline.doneTitle"));
    this.contentEl.createEl("p", { text: this.i18n.t("inline.largeDiffConfirm") });
    const bar = this.contentEl.createDiv();
    const cancel = bar.createEl("button", { text: this.i18n.t("common.cancel") });
    cancel.addEventListener("click", () => this.close());
    const apply = bar.createEl("button", { text: this.i18n.t("common.apply") });
    apply.addEventListener("click", () => {
      this.onApply();
      this.close();
    });
  }
}
