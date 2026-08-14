import { App, PluginSettingTab, Setting } from "obsidian";
import type DshPlugin from "../main";

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DshPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("DSH 地址").setDesc("本地 DSH 服务地址（默认 http://127.0.0.1:3080）").addText((t) =>
      t.setValue(s.values.dshUrl).onChange(async (v) => {
        s.values.dshUrl = v.trim();
        await s.save();
      })
    );

    new Setting(containerEl).setName("@提及文件内容上限（字符）").setDesc("提及文件时注入内容的最大长度，超长截断").addText((t) =>
      t.setValue(String(s.values.mentionMaxChars)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.mentionMaxChars = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName("内联编辑超时（秒）").addText((t) =>
      t.setValue(String(s.values.inlineEditTimeoutSec)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.inlineEditTimeoutSec = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName("历史页大小").setDesc("每次拉取会话历史的条数").addText((t) =>
      t.setValue(String(s.values.historyPageSize)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.historyPageSize = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName("重置内联编辑专用会话").setDesc("下次内联编辑将创建全新会话").addButton((b) =>
      b.setButtonText("重置").onClick(async () => {
        s.values.inlineEditSessionId = "";
        await s.save();
      })
    );
  }
}
