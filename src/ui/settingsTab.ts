import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type DshPlugin from "../main";

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DshPlugin) {
    super(app, plugin);
  }

  /** Obsidian 1.13+ 声明式设置定义（可被设置搜索索引）。 */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    return [
      {
        name: "DSH 地址",
        desc: "本地 DSH 服务地址（默认 http://127.0.0.1:3080）",
        control: {
          type: "text",
          key: "dshUrl",
          defaultValue: s.values.dshUrl,
          placeholder: "http://127.0.0.1:3080",
        },
      },
      {
        name: "@提及文件内容上限（字符）",
        desc: "提及文件时注入内容的最大长度，超长截断",
        control: { type: "number", key: "mentionMaxChars", defaultValue: s.values.mentionMaxChars, min: 1, step: 1 },
      },
      {
        name: "内联编辑超时（秒）",
        control: { type: "number", key: "inlineEditTimeoutSec", defaultValue: s.values.inlineEditTimeoutSec, min: 1, step: 1 },
      },
      {
        name: "历史页大小",
        desc: "每次拉取会话历史的条数",
        control: { type: "number", key: "historyPageSize", defaultValue: s.values.historyPageSize, min: 1, step: 1 },
      },
      {
        name: "重置内联编辑专用会话",
        desc: "下次内联编辑将创建全新会话",
        action: (el) => {
          const btn = el.createEl("button", { text: "重置" });
          btn.addEventListener("click", () => {
            void (async () => {
              s.values.inlineEditSessionId = "";
              await s.save();
            })();
          });
        },
      },
    ];
  }

  getControlValue(key: string): unknown {
    return (this.plugin.settings.values as unknown as Record<string, unknown>)[key];
  }

  setControlValue(key: string, value: unknown): void {
    const values = this.plugin.settings.values as unknown as Record<string, unknown>;
    if (key === "mentionMaxChars" || key === "inlineEditTimeoutSec" || key === "historyPageSize") {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      values[key] = Math.floor(n);
    } else {
      values[key] = typeof value === "string" ? (value as string).trim() : value;
    }
    void this.plugin.settings.save();
  }

  /** 1.13 以下版本回退到命令式 UI（声明式定义非空时框架不再调用本方法）。 */
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
