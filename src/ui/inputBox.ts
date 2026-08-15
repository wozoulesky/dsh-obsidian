import { BUILTIN_COMMANDS } from "./prompts";
import type { DshRuntime } from "../main";
import type { SessionView } from "../core/eventFold";

/** 多行输入框 + `/` 与 `@` 联想弹层 + Shift+Tab 计划模式切换。 */
export class DshInputBox {
  private wrap: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private suggestEl: HTMLElement | null = null;
  private suggestKind: "slash" | "mention" | null = null;
  private suggestItems: string[] = [];
  private suggestIndex = 0;

  constructor(
    private container: HTMLElement,
    private runtime: DshRuntime,
    private getView: () => SessionView | undefined,
    private onSend: (text: string) => Promise<void>
  ) {
    this.wrap = container.createDiv({ cls: "dsh-input-wrap" });
    this.textarea = this.wrap.createEl("textarea", { cls: "dsh-input", attr: { placeholder: "给 DSH 发任务…（/ 命令，@ 提及文件，Shift+Tab 计划模式）" } });
    this.textarea.addEventListener("keydown", (e) => {
      void this.onKeydown(e);
    });
    this.textarea.addEventListener("input", () => this.updateSuggest());
  }

  focus(): void {
    this.textarea.focus();
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
      if (e.key === "Escape") {
        this.closeSuggest();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = this.textarea.value.trim();
      if (text.length === 0) return;
      this.textarea.value = "";
      this.closeSuggest();
      await this.onSend(text);
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
    const target = view.plan.active ? "/plan off" : "/plan";
    view.plan.pending = true; // 本地兜底：投影帧到达时（higher-seq-wins）覆盖为权威值
    await this.onSend(target);
  }

  private updateSuggest(): void {
    const value = this.textarea.value;
    const cursor = this.textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const tokenMatch = before.match(/(?:^|\s)(@(?:file|folder):([^\s@]*)|@([^\s@/]*)|(\/)([^\s@/]*))$/);
    if (!tokenMatch) {
      this.closeSuggest();
      return;
    }
    const kind = tokenMatch[1].startsWith("@") ? "mention" : "slash";
    const query = (kind === "mention" ? (tokenMatch[2] ?? tokenMatch[3]) : tokenMatch[5] ?? "").toLowerCase();
    const items = kind === "slash"
      ? BUILTIN_COMMANDS.filter((c) => c.name.startsWith(query)).map((c) => `${c.name} — ${c.description}`)
      : this.mentionCandidates(query).slice(0, 20);
    if (items.length === 0) {
      this.closeSuggest();
      return;
    }
    this.suggestKind = kind;
    this.suggestItems = items;
    this.suggestIndex = 0;
    this.renderSuggest();
  }

  private mentionCandidates(query: string): string[] {
    const vault = this.runtime.plugin.app.vault;
    const lower = query.toLowerCase();
    const files = vault.getFiles()
      .filter((f) => f.path.toLowerCase().includes(lower))
      .map((f) => `@file:${f.path}`);
    const folders = vault.getAllFolders()
      .filter((d) => d.path !== "/" && d.path.toLowerCase().includes(lower))
      .map((d) => `@folder:${d.path}`);
    return [...files, ...folders].slice(0, 20);
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
    this.suggestItems = [];
  }
}
