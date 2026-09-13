import { beforeEach, describe, expect, it } from "vitest";
import { I18n } from "../../src/i18n";
import { mockButtonOnClick, mockTextOnChange, resetMockSettingHandlers } from "../mocks/obsidian";
import { DshSettingTab } from "../../src/ui/settingsTab";
import type { DshPluginSettings } from "../../src/settings";

function fakePlugin() {
  return {
    settings: {
      values: {
        dshUrl: "http://127.0.0.1:3080",
        mentionMaxChars: 4000,
        inlineEditTimeoutSec: 120,
        historyPageSize: 50,
        inlineEditSessionId: "",
        dshCredentialsPath: "",
      } satisfies DshPluginSettings,
      save: async () => {},
    },
    runtime: { i18n: new I18n() },
  };
}

/** 带调用计数的设置替身：用于断言「逐键走防抖 / 重置走立即落盘」的路由选择。 */
function countingPlugin() {
  const calls = { save: 0, saveDebounced: 0, flush: 0 };
  const plugin = {
    settings: {
      values: { ...fakePlugin().settings.values },
      save: async () => {
        calls.save += 1;
      },
      saveDebounced: () => {
        calls.saveDebounced += 1;
      },
      flush: async () => {
        calls.flush += 1;
      },
    },
    runtime: { i18n: new I18n() },
  };
  return { plugin, calls };
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

describe("设置写入路径（TASK-028 项 1）", () => {
  beforeEach(() => resetMockSettingHandlers());

  it("声明式 setControlValue：逐键只改内存值 + 走防抖，不逐键立即落盘", () => {
    const { plugin, calls } = countingPlugin();
    const tab = new DshSettingTab(null as never, plugin as never);

    tab.setControlValue("dshUrl", "  http://127.0.0.1:3099  ");
    tab.setControlValue("dshUrl", "http://127.0.0.1:3100");
    tab.setControlValue("mentionMaxChars", 1234.7);
    tab.setControlValue("historyPageSize", 30);

    expect(calls.saveDebounced).toBe(4);
    expect(calls.save).toBe(0); // 一次都没有立即写盘
    expect(plugin.settings.values.dshUrl).toBe("http://127.0.0.1:3100"); // trim 语义不变
    expect(plugin.settings.values.mentionMaxChars).toBe(1234); // 取整语义不变
    expect(plugin.settings.values.historyPageSize).toBe(30);
  });

  it("非法数值被拒绝时既不落盘也不置脏", () => {
    const { plugin, calls } = countingPlugin();
    const tab = new DshSettingTab(null as never, plugin as never);
    tab.setControlValue("mentionMaxChars", 0);
    tab.setControlValue("historyPageSize", "abc");
    expect(calls.saveDebounced).toBe(0);
    expect(calls.save).toBe(0);
    expect(plugin.settings.values.mentionMaxChars).toBe(4000);
  });

  it("1.13 以下回退路径 display()：逐键 onChange 同样走防抖", () => {
    const { plugin, calls } = countingPlugin();
    const tab = new DshSettingTab(null as never, plugin as never);
    tab.display();

    expect(mockTextOnChange).toHaveLength(5); // 5 个文本输入（dshUrl / 提及上限 / 内联超时 / 历史页大小 / 凭据路径）
    for (const onChange of mockTextOnChange) {
      void onChange("1234");
      void onChange("1235");
    }
    expect(calls.saveDebounced).toBe(10);
    expect(calls.save).toBe(0);
  });

  it("重置内联会话按钮：立即落盘（不能被防抖吞掉）", async () => {
    const { plugin, calls } = countingPlugin();
    const tab = new DshSettingTab(null as never, plugin as never);
    tab.display();

    // display() 里第二个按钮是「重置内联会话」（第一个是导出 i18n 模板之外的重置，见实现顺序）
    const reset = mockButtonOnClick[0];
    expect(reset).toBeTypeOf("function");
    await reset();

    expect(calls.save).toBe(1);
    expect(calls.saveDebounced).toBe(0);
    expect(plugin.settings.values.inlineEditSessionId).toBe("");
  });

  it("hide()：关闭面板时把挂起的防抖写入落盘，且不吞掉框架自身的隐藏逻辑", () => {
    const { plugin, calls } = countingPlugin();
    const tab = new DshSettingTab(null as never, plugin as never);
    tab.setControlValue("dshUrl", "http://127.0.0.1:3200");
    tab.hide();
    expect(calls.flush).toBe(1);
    expect((tab as unknown as { hidden: number }).hidden).toBe(1); // super.hide() 仍被执行
  });
});
