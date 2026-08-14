import { App, Modal } from "obsidian";
import type { DiffOp } from "../core/wordDiff";

export class DiffPreviewModal extends Modal {
  constructor(
    app: App,
    private ops: DiffOp[],
    private onApply: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("内联编辑预览");
    const wrap = this.contentEl.createDiv({ cls: "dsh-diff-wrap" });
    for (const op of this.ops) {
      const span = wrap.createSpan({ cls: op.type === "add" ? "dsh-diff-add" : op.type === "del" ? "dsh-diff-del" : "dsh-diff-eq" });
      span.setText(op.text);
    }
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
