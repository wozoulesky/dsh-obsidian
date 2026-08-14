import { App, Editor, Modal, Notice, Setting } from "obsidian";
import { wordDiff } from "../core/wordDiff";
import { DiffPreviewModal } from "./diffPreview";
import type { DshRuntime } from "../main";

const LARGE_DIFF_CHARS = 10000;

export class InlineEditModal extends Modal {
  private instruction = "";
  private running = false;

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
      this.contentEl.createEl("p", { text: "请先在编辑器中选择要修改的文本。" });
      return;
    }
    this.titleEl.setText("DSH 内联编辑");
    this.contentEl.createEl("p", { text: `已选择 ${selection.length} 个字符，输入修改指令：` });
    const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: "例如：改写得更简洁" } });
    input.value = this.instruction;
    input.addEventListener("input", () => (this.instruction = input.value));
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("开始").setCta().onClick(() => void this.run(b))
    );
  }

  private async run(button: { setDisabled(disabled: boolean): unknown }): Promise<void> {
    if (this.running) return;
    this.running = true;
    button.setDisabled(true);
    const selection = this.editor.getSelection();
    const path = this.runtime.plugin.app.workspace.getActiveFile()?.path ?? "";
    const notice = new Notice("DSH 正在生成修改…", 0);
    try {
      const result = await this.runtime.inlineEdit.edit(selection, path, this.instruction || "优化这段文本");
      notice.hide();
      if (selection.length > LARGE_DIFF_CHARS || result.length > LARGE_DIFF_CHARS) {
        // 超大内容跳过词级 diff（O(n·m) 内存），直接确认替换
        new ConfirmReplaceModal(this.app, () => this.apply(selection, result)).open();
      } else {
        new DiffPreviewModal(this.app, wordDiff(selection, result), () => this.apply(selection, result)).open();
      }
      this.close();
    } catch (err) {
      notice.hide();
      new Notice(`内联编辑失败：${err instanceof Error ? err.message : String(err)}`);
      this.close();
    }
  }

  /** 应用前重新校验：编辑器仍活跃且选区未变。 */
  private apply(selection: string, result: string): void {
    const active = this.runtime.plugin.app.workspace.activeEditor?.editor;
    if (!active || active !== this.editor || active.getSelection() !== selection) {
      new Notice("编辑器选区已变化，未应用替换");
      return;
    }
    active.replaceSelection(result);
  }
}

/** 超大内容的简易确认替换弹窗（无 diff 预览）。 */
export class ConfirmReplaceModal extends Modal {
  constructor(app: App, private onApply: () => void) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("内联编辑完成");
    this.contentEl.createEl("p", { text: "内容较大，已跳过词级预览。确认替换所选内容？" });
    const bar = this.contentEl.createDiv();
    const cancel = bar.createEl("button", { text: "放弃" });
    cancel.addEventListener("click", () => this.close());
    const apply = bar.createEl("button", { text: "应用替换" });
    apply.addEventListener("click", () => {
      this.onApply();
      this.close();
    });
  }
}
