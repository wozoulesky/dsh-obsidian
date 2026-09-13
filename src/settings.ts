import { clearTimer, setTimer } from "./utils/timers";

export interface DshPluginSettings {
  dshUrl: string;
  mentionMaxChars: number;
  inlineEditTimeoutSec: number;
  historyPageSize: number;
  inlineEditSessionId: string;
}

export const DEFAULT_SETTINGS: DshPluginSettings = {
  dshUrl: "http://127.0.0.1:3080",
  mentionMaxChars: 8000,
  inlineEditTimeoutSec: 180,
  // 20 条消息/页：超长会话播种与「加载更早」的 Markdown 渲染量更轻（50 条大消息一次性渲染可能导致渲染进程卡死白屏，观察中）
  historyPageSize: 20,
  inlineEditSessionId: "",
};

/** 设置防抖落盘延迟（ms）：输入过程中只改内存值，停顿后写一次盘。 */
export const SETTINGS_SAVE_DEBOUNCE_MS = 300;

/** 设置模型：负责 load/save 与便捷访问器；UI 面板在后续任务实现。 */
export class DshSettings {
  values: DshPluginSettings = { ...DEFAULT_SETTINGS };
  /** 挂起的防抖落盘句柄；null = 无计时器在跑。 */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 是否有「内存已改、尚未落盘」的内容。
   * 与计时器分开记：防抖写入失败时计时器已清、内容仍然脏，`flush()` 才有机会重试
   *（否则「改完 → 防抖写失败 → 关面板」会静默丢掉最后一次改动）。
   */
  private dirty = false;

  constructor(
    private host: {
      loadData(): Promise<unknown>;
      saveData(data: unknown): Promise<void>;
    }
  ) {}

  async load(): Promise<void> {
    const raw = await this.host.loadData();
    const data =
      typeof raw === "object" && raw !== null && !Array.isArray(raw)
        ? (raw as Partial<DshPluginSettings>)
        : {};
    this.values = { ...DEFAULT_SETTINGS, ...data };
  }

  /**
   * 立即落盘，并取消任何挂起的防抖写入（挂起写入的内容与本次相同，重复写没必要）。
   *
   * 语义要求「写完即生效」的调用点必须走这里，不能走 `saveDebounced()`：
   * - `/clear`（`chatView.handleClear`）与内联编辑新建会话（`inlineEdit.ensureSession`）
   *   直接改写 `values.inlineEditSessionId`，若被防抖吞掉，紧接着的重建会拿到过期会话 id；
   * - 设置面板的「重置内联会话」按钮同理。
   */
  async save(): Promise<void> {
    this.cancelPendingSave();
    this.dirty = false;
    try {
      await this.host.saveData(this.values);
    } catch (err) {
      this.dirty = true; // 写失败：内容仍是脏的，交给下一次 flush 重试
      throw err;
    }
  }

  /**
   * 防抖落盘：连续调用只在**最后一次**调用后 ms 毫秒落盘一次（设置面板逐键输入用，
   * 避免每敲一个字符就写一次 data.json）。
   *
   * 落盘失败只记日志：防抖写入没有调用方能接住异常（`void` 路径），抛出会变成
   * unhandled rejection；内容保留脏标记，卸载/关面板的 `flush()` 会再试一次。
   */
  saveDebounced(ms: number = SETTINGS_SAVE_DEBOUNCE_MS): void {
    this.cancelPendingSave();
    this.dirty = true;
    this.saveTimer = setTimer(() => {
      this.saveTimer = null;
      this.writeNow();
    }, ms);
  }

  /** 有未落盘内容则立刻落盘，否则 no-op（插件卸载 / 设置面板关闭时调用）。 */
  async flush(): Promise<void> {
    if (!this.dirty && this.saveTimer === null) return;
    this.cancelPendingSave();
    this.dirty = false;
    try {
      await this.host.saveData(this.values);
    } catch (err) {
      this.dirty = true; // 与 save() 一致：失败后保留脏标记，后续 flush 可重试
      throw err;
    }
  }

  /** 触发一次落盘（防抖计时器到点）。此刻起新的改动会重新置脏。 */
  private writeNow(): void {
    this.dirty = false;
    void this.host.saveData(this.values).catch((err) => {
      this.dirty = true;
      console.error("[dsh-bridge] 设置保存失败:", err);
    });
  }

  private cancelPendingSave(): void {
    if (this.saveTimer === null) return;
    clearTimer(this.saveTimer);
    this.saveTimer = null;
  }

  /** 去掉尾部斜杠的 DSH 地址。 */
  get dshUrl(): string {
    return this.values.dshUrl.replace(/\/+$/, "");
  }
}
