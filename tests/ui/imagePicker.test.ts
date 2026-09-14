import { beforeEach, describe, expect, it } from "vitest";
import { mockModals } from "../mocks/obsidian";
import { pickVaultImage } from "../../src/ui/imagePicker";

/**
 * `pickVaultImage` 的选中时序回归（TASK-044）。
 *
 * **教训（值得留在文件顶部）**：第一版回归测试只覆盖了「先 onChooseItem 后 onClose」——
 * 那是我**假设**的时序，测试因此全绿，而真机依旧坏的。真实时序来自 Obsidian 源码
 * （`obsidian.asar`：`selectSuggestion → close() → onClose()`，之后才 `onChooseSuggestion → onChooseItem`），
 * 即 **onClose 在前、onChooseItem 在后**。所以这里**两种顺序都要测**，真实顺序（close 在前）是主用例。
 *
 * 这些用例走**真实模态框类**（上层 `inputBox` 测试把 `pickVaultImage` 整体 mock 掉了，
 * 缺陷只存在于这条时序里，mock 掉就永远测不到）。
 */

interface ModalLike {
  onChooseItem(file: unknown): void;
  onClose(): void;
  getItems(): Array<{ path: string }>;
  getItemText(file: { path: string }): string;
}

/** 最小 App 替身：只提供选择器用到的 vault 能力。 */
function fakeApp(files: Array<{ path: string }>, readBinary?: () => Promise<ArrayBuffer>) {
  return {
    vault: {
      getFiles: () => files,
      readBinary: readBinary ?? (async () => new Uint8Array([1, 2, 3]).buffer),
    },
  };
}

function lastModal(): ModalLike {
  const modal = mockModals.at(-1) as unknown as ModalLike | undefined;
  if (!modal) throw new Error("未创建模态框");
  return modal;
}

describe("pickVaultImage 选中时序（TASK-044）", () => {
  beforeEach(() => {
    mockModals.length = 0;
  });

  it("【真实时序】onClose（基类先关）→ onChooseItem：必须返回选中的图片", async () => {
    const file = { path: "notes/a.png" };
    const promise = pickVaultImage(fakeApp([file]) as never, "选择图片");

    const modal = lastModal();
    modal.onClose(); // Obsidian：close() 先跑完（同步 onClose）
    modal.onChooseItem(file); // 之后才通知选中——修复前这一步的结果会被 settled 挡掉

    await expect(promise).resolves.toMatchObject({ ok: true, image: { path: "notes/a.png", mediaType: "image/png" } });
  });

  it("反向时序 onChooseItem → onClose 也必须成立（防御上游改序）", async () => {
    const file = { path: "notes/c.webp" };
    const promise = pickVaultImage(fakeApp([file]) as never, "选择图片");

    const modal = lastModal();
    modal.onChooseItem(file);
    modal.onClose();

    await expect(promise).resolves.toMatchObject({ ok: true, image: { path: "notes/c.webp", mediaType: "image/webp" } });
  });

  it("未选择就关闭（Esc / 点遮罩）→ 仍判为取消，且不会永久挂起", async () => {
    const promise = pickVaultImage(fakeApp([]) as never, "选择图片");
    lastModal().onClose();
    await expect(promise).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  it("真实时序下读盘失败 → readFailed（不得被误判成取消）", async () => {
    const file = { path: "notes/b.png" };
    const promise = pickVaultImage(
      fakeApp([file], async () => {
        throw new Error("ENOENT");
      }) as never,
      "选择图片"
    );
    const modal = lastModal();
    modal.onClose();
    modal.onChooseItem(file);
    await expect(promise).resolves.toEqual({ ok: false, reason: "readFailed" });
  });

  it("列表只含 vault 内的图片扩展名（非图片被过滤）", () => {
    const app = fakeApp([
      { path: "notes/a.png" },
      { path: "notes/b.md" },
      { path: "attachments/c.webp" },
      { path: "noext" },
    ]);
    pickVaultImage(app as never, "选择图片");
    expect(lastModal().getItems().map((f) => f.path)).toEqual(["notes/a.png", "attachments/c.webp"]);
  });

  it("选中非图片路径（列表外构造）→ unsupported，不尝试读盘", async () => {
    let read = 0;
    const app = fakeApp([], async () => {
      read += 1;
      return new Uint8Array([1]).buffer;
    });
    const promise = pickVaultImage(app as never, "选择图片");
    const modal = lastModal();
    modal.onClose();
    modal.onChooseItem({ path: "notes/c.txt" });
    await expect(promise).resolves.toEqual({ ok: false, reason: "unsupported" });
    expect(read).toBe(0);
  });
});
