import { beforeEach, describe, expect, it } from "vitest";
import { mockModals } from "../mocks/obsidian";
import { pickVaultImage } from "../../src/ui/imagePicker";

/**
 * `pickVaultImage` 的选中时序回归（TASK-044）。
 *
 * 背景：Obsidian 的 `FuzzySuggestModal` 在选中后**自动关闭模态框**，真实时序为
 * `onChooseItem` → 基类 `close()` → `onClose()`；而读图是异步的，`onClose` 必然先到。
 * 修复前 `onClose` 把这次关闭当成"取消"，成功选中被静默丢弃 —— 真机表现为
 * **模态框关闭、没有 chip、也没有任何提示**（0.1.6/0.1.7 已发布版本均受影响）。
 *
 * 这些用例走的是**真实模态框类**（不经 mock 掉 pickVaultImage 的上层测试），
 * 因为缺陷只存在于这条时序里。
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

  it("选中后基类自动关闭 → 不得判定为取消，应返回选中的图片", async () => {
    const file = { path: "notes/a.png" };
    const promise = pickVaultImage(fakeApp([file]) as never, "选择图片");

    const modal = lastModal();
    modal.onChooseItem(file); // 用户选中（同步返回，读盘在飞）
    modal.onClose(); // 基类随后自动关闭——修复前这里会 settle 成 cancelled

    await expect(promise).resolves.toMatchObject({ ok: true, image: { path: "notes/a.png", mediaType: "image/png" } });
  });

  it("未选择就关闭（Esc / 点遮罩）→ 仍判为取消（不能因为修 bug 把这个路径弄丢）", async () => {
    const promise = pickVaultImage(fakeApp([]) as never, "选择图片");
    lastModal().onClose();
    await expect(promise).resolves.toEqual({ ok: false, reason: "cancelled" });
  });

  it("读盘失败也算有结果（readFailed），不得挂起", async () => {
    const file = { path: "notes/b.png" };
    const promise = pickVaultImage(
      fakeApp([file], async () => {
        throw new Error("ENOENT");
      }) as never,
      "选择图片"
    );
    const modal = lastModal();
    modal.onChooseItem(file);
    modal.onClose();
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
    modal.onChooseItem({ path: "notes/c.txt" });
    modal.onClose();
    await expect(promise).resolves.toEqual({ ok: false, reason: "unsupported" });
    expect(read).toBe(0);
  });
});
