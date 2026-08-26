import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import type DshPlugin from "../main";

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DshPlugin) {
    super(app, plugin);
  }

  /** Obsidian 1.13+ 声明式设置定义（可被设置搜索索引）。 */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    const t = this.plugin.runtime.i18n.t;
    return [
      {
        name: t("settings.dshUrlName"),
        desc: t("settings.dshUrlDesc"),
        control: {
          type: "text",
          key: "dshUrl",
          defaultValue: s.values.dshUrl,
          placeholder: "http://127.0.0.1:3080",
        },
      },
      {
        name: t("settings.mentionMaxCharsName"),
        desc: t("settings.mentionMaxCharsDesc"),
        control: { type: "number", key: "mentionMaxChars", defaultValue: s.values.mentionMaxChars, min: 1, step: 1 },
      },
      {
        name: t("settings.inlineEditTimeoutName"),
        control: { type: "number", key: "inlineEditTimeoutSec", defaultValue: s.values.inlineEditTimeoutSec, min: 1, step: 1 },
      },
      {
        name: t("settings.historyPageSizeName"),
        desc: t("settings.historyPageSizeDesc"),
        control: { type: "number", key: "historyPageSize", defaultValue: s.values.historyPageSize, min: 1, step: 1 },
      },
      {
        name: t("settings.resetSessionName"),
        desc: t("settings.resetSessionDesc"),
        action: (el) => {
          const btn = el.createEl("button", { text: t("settings.resetButton") });
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
      values[key] = typeof value === "string" ? value.trim() : value;
    }
    void this.plugin.settings.save();
  }

  /** 1.13 以下版本回退到命令式 UI（声明式定义非空时框架不再调用本方法）。 */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const t = this.plugin.runtime.i18n.t;

    new Setting(containerEl).setName(t("settings.dshUrlName")).setDesc(t("settings.dshUrlDesc")).addText((text) =>
      text.setValue(s.values.dshUrl).onChange(async (v) => {
        s.values.dshUrl = v.trim();
        await s.save();
      })
    );

    new Setting(containerEl).setName(t("settings.mentionMaxCharsName")).setDesc(t("settings.mentionMaxCharsDesc")).addText((text) =>
      text.setValue(String(s.values.mentionMaxChars)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.mentionMaxChars = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName(t("settings.inlineEditTimeoutName")).addText((text) =>
      text.setValue(String(s.values.inlineEditTimeoutSec)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.inlineEditTimeoutSec = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName(t("settings.historyPageSizeName")).setDesc(t("settings.historyPageSizeDesc")).addText((text) =>
      text.setValue(String(s.values.historyPageSize)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.historyPageSize = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName(t("settings.resetSessionName")).setDesc(t("settings.resetSessionDesc")).addButton((b) =>
      b.setButtonText(t("settings.resetButton")).onClick(async () => {
        s.values.inlineEditSessionId = "";
        await s.save();
      })
    );
  }
}
