/**
 * TASK-028 项 2：会话头部下拉的增量同步。
 *
 * 契约（见 src/ui/headerSelect.ts）：
 * - 选项集合变化（新增/移除/换序会话）→ 重建 `<option>`；
 * - 选项集合未变 → **不碰 DOM 结构**，只在标签文本（标题/运行态）变化时逐个改 `text`；
 * - 选中项单独同步。
 *
 * 用轻量替身驱动（无需 DOM / jsdom），`empty()` 与 `createEl()` 的调用次数即是「是否重建 DOM」的证据。
 */
import { describe, expect, it } from "vitest";
import { headerOptions, syncSelectOptions, type HeaderOption, type HeaderSelectLike } from "../../src/ui/headerSelect";

function fakeSelect() {
  const options: Array<{ value: string; text: string }> = [];
  const stats = { emptied: 0, created: 0 };
  const select: HeaderSelectLike = {
    value: "",
    options,
    empty() {
      stats.emptied += 1;
      options.length = 0;
    },
    createEl(_tag, o) {
      stats.created += 1;
      options.push({ value: o?.value ?? "", text: o?.text ?? "" });
      return undefined;
    },
  };
  return { select, options, stats };
}

const titleOf = (id: string) => `标题-${id}`;

describe("headerOptions", () => {
  it("首项恒为「无会话」占位；运行中会话追加 ⏳", () => {
    const options = headerOptions(
      [
        { sessionId: "s1", running: true },
        { sessionId: "s2", running: false },
      ],
      titleOf,
      "（无会话）"
    );
    expect(options).toEqual<HeaderOption[]>([
      { value: "", label: "（无会话）" },
      { value: "s1", label: "标题-s1 ⏳" },
      { value: "s2", label: "标题-s2" },
    ]);
  });
});

describe("syncSelectOptions", () => {
  it("首次同步：重建全部选项并选中当前会话", () => {
    const { select, options, stats } = fakeSelect();
    const rebuilt = syncSelectOptions(select, headerOptions([{ sessionId: "s1" }, { sessionId: "s2" }], titleOf, "（无会话）"), "s2");
    expect(rebuilt).toBe(true);
    expect(stats.emptied).toBe(1);
    expect(stats.created).toBe(3);
    expect(options.map((o) => o.value)).toEqual(["", "s1", "s2"]);
    expect(select.value).toBe("s2");
  });

  it("会话集合与选中项都没变 → 完全不重建 DOM（empty/createEl 不再被调用）", () => {
    const { select, stats } = fakeSelect();
    const sessions = [{ sessionId: "s1" }, { sessionId: "s2" }];
    syncSelectOptions(select, headerOptions(sessions, titleOf, "（无会话）"), "s1");
    const after = { ...stats };
    const rebuilt = syncSelectOptions(select, headerOptions(sessions, titleOf, "（无会话）"), "s1");
    expect(rebuilt).toBe(false);
    expect(stats).toEqual(after); // 结构没动
  });

  it("数据变化（标题或运行态）→ 不重建结构，但选项文本确实更新", () => {
    const { select, options, stats } = fakeSelect();
    syncSelectOptions(select, headerOptions([{ sessionId: "s1", running: false }], titleOf, "（无会话）"), "");
    expect(options[1].text).toBe("标题-s1");
    const createdBefore = stats.created;

    // 运行态变化（数据变了，必须反映到 UI）
    const rebuilt = syncSelectOptions(select, headerOptions([{ sessionId: "s1", running: true }], titleOf, "（无会话）"), "");
    expect(rebuilt).toBe(false);
    expect(stats.created).toBe(createdBefore); // 未重建
    expect(options[1].text).toBe("标题-s1 ⏳"); // 但文本更新了

    // 标题变化
    syncSelectOptions(select, headerOptions([{ sessionId: "s1", running: true }], () => "新标题", "（无会话）"), "");
    expect(options[1].text).toBe("新标题 ⏳");
  });

  it("会话集合变化（命令面板新建会话后 refreshHeader）→ 重建并出现新会话", () => {
    const { select, options, stats } = fakeSelect();
    syncSelectOptions(select, headerOptions([{ sessionId: "s1" }], titleOf, "（无会话）"), "s1");
    expect(stats.created).toBe(2);

    const rebuilt = syncSelectOptions(select, headerOptions([{ sessionId: "new-1" }, { sessionId: "s1" }], titleOf, "（无会话）"), "new-1");
    expect(rebuilt).toBe(true);
    expect(stats.emptied).toBe(2);
    expect(options.map((o) => o.value)).toEqual(["", "new-1", "s1"]);
    expect(select.value).toBe("new-1");
  });

  it("会话被移除 / 列表清空 → 重建为占位项", () => {
    const { select, options } = fakeSelect();
    syncSelectOptions(select, headerOptions([{ sessionId: "s1" }], titleOf, "（无会话）"), "s1");
    syncSelectOptions(select, headerOptions([], titleOf, "（无会话）"), "");
    expect(options.map((o) => o.value)).toEqual([""]);
    expect(select.value).toBe("");
  });

  it("仅选中项变化 → 不重建结构", () => {
    const { select, stats } = fakeSelect();
    const sessions = [{ sessionId: "s1" }, { sessionId: "s2" }];
    syncSelectOptions(select, headerOptions(sessions, titleOf, "（无会话）"), "s1");
    const createdBefore = stats.created;
    const rebuilt = syncSelectOptions(select, headerOptions(sessions, titleOf, "（无会话）"), "s2");
    expect(rebuilt).toBe(false);
    expect(stats.created).toBe(createdBefore);
    expect(select.value).toBe("s2");
  });
});
