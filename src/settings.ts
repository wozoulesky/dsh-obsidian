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

/** 设置模型：负责 load/save 与便捷访问器；UI 面板在后续任务实现。 */
export class DshSettings {
  values: DshPluginSettings = { ...DEFAULT_SETTINGS };

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

  async save(): Promise<void> {
    await this.host.saveData(this.values);
  }

  /** 去掉尾部斜杠的 DSH 地址。 */
  get dshUrl(): string {
    return this.values.dshUrl.replace(/\/+$/, "");
  }
}
