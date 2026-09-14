import { beforeEach, describe, expect, it } from "vitest";
import { I18n } from "../../src/i18n";
import { mockButtonOnClick, mockNotices, mockTextOnChange, resetMockSettingHandlers } from "../mocks/obsidian";
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

describe("诊断连接按钮", () => {
  /** 诊断按钮需要一个能调 session.list 的 client；其余设置项沿用默认替身。 */
  function pluginWithList(list: () => Promise<unknown>) {
    return {
      settings: {
        values: { ...fakePlugin().settings.values },
        save: async () => {},
        saveDebounced: () => {},
        flush: async () => {},
      },
      runtime: { i18n: new I18n(), client: { list } },
    };
  }

  const DIAGNOSE_BUTTON_INDEX = 2; // display() 顺序：重置内联会话 / 导出 i18n / 诊断连接

  it("连接被拒绝 → 给出「DSH 似乎没有运行」的可执行结论，而不是原始错误码", async () => {
    resetMockSettingHandlers();
    mockNotices.length = 0;
    const tab = new DshSettingTab(
      null as never,
      pluginWithList(async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3080");
      }) as never
    );
    tab.display();
    await mockButtonOnClick[DIAGNOSE_BUTTON_INDEX]();

    expect(mockNotices.at(-1)).toContain("本机 DSH 似乎没有在运行");
    expect(mockNotices.at(-1)).toContain("ECONNREFUSED"); // 技术细节仍保留，便于求助
  });

  it("HTTP 404 → 指向版本兼容结论（这是竞品 README 里最高频的用户困惑）", async () => {
    resetMockSettingHandlers();
    mockNotices.length = 0;
    const tab = new DshSettingTab(
      null as never,
      pluginWithList(async () => ({ ok: false, error: { code: "gateway/not-found", message: "HTTP 404 for /api/session/list" } })) as never
    );
    tab.display();
    await mockButtonOnClick[DIAGNOSE_BUTTON_INDEX]();

    expect(mockNotices.at(-1)).toContain("版本过旧");
  });

  it("探测成功 → 明确说连接正常", async () => {
    resetMockSettingHandlers();
    mockNotices.length = 0;
    const tab = new DshSettingTab(null as never, pluginWithList(async () => ({ ok: true, value: { items: [] } })) as never);
    tab.display();
    await mockButtonOnClick[DIAGNOSE_BUTTON_INDEX]();

    expect(mockNotices.at(-1)).toContain("连接正常");
  });

  it("无法归类时保留原始错误并说明未归类，不编造结论", async () => {
    resetMockSettingHandlers();
    mockNotices.length = 0;
    const tab = new DshSettingTab(
      null as never,
      pluginWithList(async () => {
        throw new Error("something unexpected");
      }) as never
    );
    tab.display();
    await mockButtonOnClick[DIAGNOSE_BUTTON_INDEX]();

    expect(mockNotices.at(-1)).toContain("未能归类");
    expect(mockNotices.at(-1)).toContain("something unexpected");
  });

  it("声明式定义里也带诊断项（1.13+ 路径不会漏掉该功能）", () => {
    const tab = new DshSettingTab(null as never, fakePlugin() as never);
    const names = tab.getSettingDefinitions().map((d) => (d as { name?: string }).name);
    expect(names).toContain("诊断连接");
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
