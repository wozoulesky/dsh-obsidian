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
   * `onChooseItem` 是否已触发。
   *
   * **为什么必须有这个标记**：Obsidian 的 `FuzzySuggestModal` 在选中后**会自动关闭模态框**，
   * 即真实时序是 `onChooseItem` → 基类 `close()` → `onClose()`；而 `readBinary` 是异步的
   * （`await` 至少推迟一个微任务），所以 `onClose` 一定先于读盘完成到达。
   * 若把这次关闭当作"用户取消"，成功选中会被 `settled` 静默丢弃——模态框关闭、没有 chip、
   * 也没有任何提示（真机复现与根因见 TASK-044）。故选中后必须让 `onClose` 让位。
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
    // 未选择就关闭（Esc/点遮罩）：必须 resolve，否则 await 永久挂起。
    // 已选择时**不得**在此结算：读盘还在飞，结果由 readImage 自己 finish（见 chosen 注释）。
    if (!this.settled && !this.chosen) {
      this.settled = true;
      this.settle({ ok: false, reason: "cancelled" });
    }
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
