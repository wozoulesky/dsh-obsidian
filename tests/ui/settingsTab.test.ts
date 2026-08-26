import { describe, expect, it } from "vitest";
import { I18n } from "../../src/i18n";
import { DshSettingTab } from "../../src/ui/settingsTab";

function fakePlugin() {
  return {
    settings: {
      values: {
        dshUrl: "http://127.0.0.1:3080",
        mentionMaxChars: 4000,
        inlineEditTimeoutSec: 120,
        historyPageSize: 50,
        inlineEditSessionId: "",
      },
      save: async () => {},
    },
    runtime: { i18n: new I18n() },
  };
}

describe("DshSettingTab.getSettingDefinitions", () => {
  it("调用 i18n.t 时不因裸提取方法丢失 this 而崩溃（Obsidian 1.13+ 在 addSettingTab 时 eager 调用）", () => {
    const tab = new DshSettingTab(null as never, fakePlugin() as never);
    expect(() => tab.getSettingDefinitions()).not.toThrow();
    const defs = tab.getSettingDefinitions();
    const first = defs[0] as { name?: string };
    const second = defs[1] as { name?: string };
    expect(first.name).toBe("DSH 地址");
    expect(second.name).toBe("@提及文件内容上限（字符）");
  });
});

describe("DshSettingTab.display", () => {
  it("回退命令式 UI 同样不因 i18n.t 的 this 丢失而崩溃", () => {
    const tab = new DshSettingTab(null as never, fakePlugin() as never);
    expect(() => tab.display()).not.toThrow();
  });
});
