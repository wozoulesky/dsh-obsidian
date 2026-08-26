import { App, Modal } from "obsidian";
import type { DiffOp } from "../core/wordDiff";
import type { I18n } from "../i18n";

export class DiffPreviewModal extends Modal {
  constructor(
    app: App,
    private ops: DiffOp[],
    private onApply: () => void,
    private i18n: I18n
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(this.i18n.t("diff.title"));
    const wrap = this.contentEl.createDiv({ cls: "dsh-diff-wrap" });
    for (const op of this.ops) {
      const span = wrap.createSpan({ cls: op.type === "add" ? "dsh-diff-add" : op.type === "del" ? "dsh-diff-del" : "dsh-diff-eq" });
      span.setText(op.text);
    }
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
