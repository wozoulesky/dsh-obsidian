/**
 * TASK-028 项 1：设置落盘的防抖 / 立即两条路径。
 *
 * 契约：
 * - `saveDebounced()` 连续调用只写一次盘，写的是最后一次的内存值；
 * - `flush()` 立即落盘并取消挂起（不再有第二次写）；无挂起时是 no-op；
 * - **`save()` 必须立即落盘**——`/clear`（chatView.handleClear）、内联编辑新建会话
 *   （inlineEdit.ensureSession）与设置面板的重置按钮都直接改写 `values.inlineEditSessionId`，
 *   这条路径被防抖吞掉就会拿到过期会话 id（TASK-016 回归）。
 *
 * 用假计时器（vi.useFakeTimers）驱动，避免真实 setTimeout 的抖动。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, DshSettings } from "../src/settings";

function makeSettings(loaded: Record<string, unknown> = {}) {
  const writes: unknown[] = [];
  let failNext = false;
  const settings = new DshSettings({
    loadData: async () => loaded,
    saveData: async (data) => {
      if (failNext) {
        failNext = false;
        throw new Error("磁盘写入失败");
      }
      writes.push(data);
    },
  });
  return { settings, writes, failNextSave: () => (failNext = true) };
}

describe("DshSettings.load", () => {
  it("合并默认值并保留已存字段", async () => {
    const { settings } = makeSettings({ dshUrl: "http://loaded:3080/", historyPageSize: 5 });
    await settings.load();
    expect(settings.values.historyPageSize).toBe(5);
    expect(settings.values.mentionMaxChars).toBe(DEFAULT_SETTINGS.mentionMaxChars);
    expect(settings.dshUrl).toBe("http://loaded:3080"); // 访问器去掉尾部斜杠
  });
});

describe("DshSettings.saveDebounced / flush / save", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("连续 5 次调用只写 1 次，且写的是最后一次的内存值", async () => {
    const { settings, writes } = makeSettings();
    for (const n of [1, 2, 3, 4, 5]) {
      settings.values.historyPageSize = n;
      settings.saveDebounced(300);
      await vi.advanceTimersByTimeAsync(10); // 逐键输入：间隔远小于防抖窗口
    }
    expect(writes).toHaveLength(0); // 输入过程中一次都不写盘

    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ historyPageSize: 5 });
  });

  it("每次调用都重置计时器：窗口内持续输入时写入被一直推迟", async () => {
    const { settings, writes } = makeSettings();
    settings.saveDebounced(300);
    await vi.advanceTimersByTimeAsync(250);
    expect(writes).toHaveLength(0);
    settings.saveDebounced(300); // 重置
    await vi.advanceTimersByTimeAsync(250);
    expect(writes).toHaveLength(0); // 距首次调用已 500ms，但距最后一次只有 250ms
    await vi.advanceTimersByTimeAsync(60);
    expect(writes).toHaveLength(1);
  });

  it("flush() 立即落盘并取消挂起（之后不再有第二次写）", async () => {
    const { settings, writes } = makeSettings();
    settings.values.dshUrl = "http://typed";
    settings.saveDebounced(300);
    await settings.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ dshUrl: "http://typed" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1); // 计时器已被取消
  });

  it("无挂起写入时 flush() 是 no-op", async () => {
    const { settings, writes } = makeSettings();
    await settings.flush();
    await settings.flush();
    expect(writes).toHaveLength(0);
  });

  it("inlineEditSessionId 路径：save() 立即落盘，并吞掉挂起的防抖写入（只写一次）", async () => {
    const { settings, writes } = makeSettings();
    settings.values.dshUrl = "http://typed"; // 用户刚在设置面板输入过
    settings.saveDebounced(300);

    // /clear 与内联编辑新建会话走这条路径
    settings.values.inlineEditSessionId = "";
    await settings.save();

    expect(writes).toHaveLength(1); // 立刻落盘，不等防抖
    expect(writes[0]).toMatchObject({ dshUrl: "http://typed", inlineEditSessionId: "" });

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1); // 挂起的防抖写入已被取消，不重复写
  });

  it("save() 写失败会向调用方抛出（调用方自行 .catch），且内容保留脏标记供 flush 重试", async () => {
    const { settings, writes, failNextSave } = makeSettings();
    failNextSave();
    settings.values.dshUrl = "http://x";
    await expect(settings.save()).rejects.toThrow("磁盘写入失败");

    await settings.flush(); // 脏标记仍在 → 重试成功
    expect(writes).toHaveLength(1);
  });

  it("防抖写入失败只记日志（不产生未处理拒绝），且 flush 仍能补写", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { settings, writes, failNextSave } = makeSettings();
    failNextSave();
    settings.values.dshUrl = "http://failed";
    settings.saveDebounced(300);
    await vi.advanceTimersByTimeAsync(300);
    await Promise.resolve();
    expect(writes).toHaveLength(0);
    expect(spy).toHaveBeenCalled();

    await settings.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ dshUrl: "http://failed" });
  });
});
