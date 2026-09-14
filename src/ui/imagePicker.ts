/**
 * vault 内图片选择器（TASK-030 项 3）。
 *
 * 读取路径（SPEC《约束》第 5 条）：`vault.getFiles()` 列候选 → `vault.readBinary(file)` 读字节
 * ——**全程 vault API，不用 Node fs**。选中的图片在内存里转成 base64 后作为
 * `PromptContentPart.image` 发送（host 收到后提升为 durable attachment 引用）。
 */
import { FuzzySuggestModal, type App, type TFile } from "obsidian";
import { encodeBase64, isImagePath, mediaTypeForPath, type ReadyImage } from "./imageAttach";

/** 图片选择结果：选中 → ReadyImage；取消/读取失败 → null。 */
export type PickImageResult = { ok: true; image: ReadyImage } | { ok: false; reason: "cancelled" | "readFailed" | "unsupported" };

/**
 * 弹出 vault 图片选择器（FuzzySuggestModal：Obsidian 原生模糊搜索，支持键盘操作）。
 * 读取失败（文件被删/权限）与取消都返回 `ok:false`，由调用方决定是否提示。
 *
 * @param placeholder - 输入框占位文案（由调用方传 i18n 文案，本模块不持有 UI 字符串）
 */
export function pickVaultImage(app: App, placeholder: string): Promise<PickImageResult> {
  return new Promise((resolve) => {
    new VaultImageSuggestModal(app, placeholder, resolve).open();
  });
}

class VaultImageSuggestModal extends FuzzySuggestModal<TFile> {
  private settled = false;

  /**
   * `onChooseItem` 是否已触发（已确认选中）。
   *
   * **为什么需要它 + 为什么必须在 `onClose` 里推迟判定**——Obsidian 的真实时序（2026-09-15 对照
   * `obsidian.asar` 源码逐行核实，路径 `useSelectedItem → chooser.selectSuggestion`，点击与回车共用）：
   *
   * ```js
   * selectSuggestion(item, evt) { this.close(); this.isOpen = false; this.onChooseSuggestion(item, evt); }
   * Modal.prototype.close()      { …; o(); }        // 桌面端 o() 同步执行 → 同步调用 onClose()
   * FuzzySuggestModal.onChooseSuggestion = (i, e) => this.onChooseItem(i.item, e)
   * ```
   *
   * 即 **`onClose()` 先于 `onChooseItem()` 同步触发**。所以原实现（在 onClose 里立即 resolve
   * `cancelled`）必然把随后到达的选中结果挡在 `settled` 之外——现象是模态框关闭、没有 chip、
   * 也没有任何提示（0.1.6/0.1.7 起对真实用户完全不可用，见 TASK-044）。
   * 任何"在 onChooseItem 里加个标记再让 onClose 让位"的写法都救不了：那个标记此刻还是 false。
   * 唯一稳的做法是**把取消判定推迟一个微任务**，让同一同步块内随后的 onChooseItem 有机会胜出。
   */
  private chosen = false;

  constructor(private appRef: App, placeholder: string, private settle: (result: PickImageResult) => void) {
    super(appRef);
    this.setPlaceholder(placeholder);
  }

  override getItems(): TFile[] {
    // 只列 vault 内可发送的图片；排序交给 FuzzySuggestModal 的模糊匹配
    return this.appRef.vault.getFiles().filter((file) => isImagePath(file.path));
  }

  override getItemText(file: TFile): string {
    return file.path;
  }

  override onChooseItem(file: TFile): void {
    this.chosen = true;
    void this.readImage(file);
  }

  override onClose(): void {
    // 未选择就关闭（Esc / 点遮罩）必须 resolve，否则调用方的 await 永久挂起；
    // 但判定要等当前同步块跑完——因为选中的回调就排在它后面（见 chosen 注释）。
    queueMicrotask(() => {
      if (!this.settled && !this.chosen) {
        this.settled = true;
        this.settle({ ok: false, reason: "cancelled" });
      }
    });
  }

  private async readImage(file: TFile): Promise<void> {
    const mediaType = mediaTypeForPath(file.path);
    if (mediaType === undefined) {
      this.finish({ ok: false, reason: "unsupported" });
      return;
    }
    try {
      const bytes = await this.appRef.vault.readBinary(file);
      this.finish({ ok: true, image: { path: file.path, mediaType, data: encodeBase64(bytes), byteLength: bytes.byteLength } });
    } catch {
      this.finish({ ok: false, reason: "readFailed" });
    }
  }

  private finish(result: PickImageResult): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(result);
    this.close();
  }
}
