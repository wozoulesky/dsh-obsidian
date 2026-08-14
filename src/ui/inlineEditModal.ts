import { App, Editor, Modal, Notice, Setting } from "obsidian";
import { wordDiff } from "../core/wordDiff";
import { DiffPreviewModal } from "./diffPreview";
import type { DshRuntime } from "../main";

export class InlineEditModal extends Modal {
  private instruction = "";

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
      b.setButtonText("开始").setCta().onClick(() => void this.run())
    );
  }

  private async run(): Promise<void> {
    const selection = this.editor.getSelection();
    const path = this.runtime.plugin.app.workspace.getActiveFile()?.path ?? "";
    const notice = new Notice("DSH 正在生成修改…", 0);
    try {
      const result = await this.runtime.inlineEdit.edit(selection, path, this.instruction || "优化这段文本");
      notice.hide();
      new DiffPreviewModal(this.app, wordDiff(selection, result), () => {
        this.editor.replaceSelection(result);
      }).open();
      this.close();
    } catch (err) {
      notice.hide();
      new Notice(`内联编辑失败：${err instanceof Error ? err.message : String(err)}`);
      this.close();
    }
  }
}
