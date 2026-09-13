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
    void this.readImage(file);
  }

  override onClose(): void {
    // 未选择就关闭（Esc/点遮罩）：必须 resolve，否则 await 永久挂起
    if (!this.settled) {
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
