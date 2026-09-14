import { App, Notice, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
import { probeDshConnection } from "../core/diagnose";
import { DEFAULT_STRINGS, type I18nParams } from "../i18n";
import type DshPlugin from "../main";

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DshPlugin) {
    super(app, plugin);
  }

  /**
   * 诊断按钮的共用实现（声明式与命令式两条渲染路径都调它，避免两处逻辑漂移）。
   * 走一次真实的 `session.list`：同时穿过认证与 RPC 两层，通过即代表核心链路可用；
   * 失败则把 401/404/ECONNREFUSED 归类成可执行结论（见 core/diagnose.ts）。
   */
  private async runDiagnosis(): Promise<void> {
    const t = (key: string, params?: I18nParams) => this.plugin.runtime.i18n.t(key, params);
    const outcome = await probeDshConnection(() => this.plugin.runtime.client.list());
    if (outcome.ok) {
      new Notice(t("settings.diagnoseOk"));
      return;
    }
    new Notice(
      outcome.hintKey
        ? t("settings.diagnoseFailed", { hint: t(outcome.hintKey), detail: outcome.detail })
        : t("settings.diagnoseUnknown", { detail: outcome.detail })
    );
  }

  /** Obsidian 1.13+ 声明式设置定义（可被设置搜索索引）。 */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.plugin.settings;
    // 注意：必须箭头函数包装，裸提取 i18n.t 会丢失 this 导致 overrides 读取崩溃（真机回归，见 TASK-013/014 handoff）。
    const t = (key: string, params?: I18nParams) => this.plugin.runtime.i18n.t(key, params);
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
        name: t("settings.credentialsPathName"),
        desc: t("settings.credentialsPathDesc"),
        control: { type: "text", key: "dshCredentialsPath", defaultValue: s.values.dshCredentialsPath },
      },
      {
        name: t("settings.resetSessionName"),
        desc: t("settings.resetSessionDesc"),
        // 注意：声明式 action 的语义是「点击行时调用」，不是渲染回调——在其中 createEl 会在
        // 框架多次重渲染时累积重复按钮（真机 bug：导出按钮出现 4 个）。按钮类交互应使用 render。
        render: (setting) => {
          setting.addButton((b) =>
            b.setButtonText(t("settings.resetButton")).onClick(async () => {
              try {
                s.values.inlineEditSessionId = "";
                await s.save(); // 立即落盘：重置必须马上生效，不能进防抖队列
                new Notice(t("settings.resetDone"));
              } catch (err) {
                new Notice(t("settings.resetFailed", { message: err instanceof Error ? err.message : String(err) }));
              }
            })
          );
        },
      },
      {
        name: t("settings.exportI18nName"),
        desc: t("settings.exportI18nDesc"),
        render: (setting) => {
          setting.addButton((b) =>
            b.setButtonText(t("settings.exportI18nButton")).onClick(async () => {
              try {
                // 导出到 vault 根：Obsidian 文件树可见可编辑，用户不接触 .obsidian 隐藏目录
                await this.plugin.app.vault.adapter.write("dsh-bridge.i18n.json", JSON.stringify(DEFAULT_STRINGS, null, 2));
                new Notice(t("settings.exportI18nDone"));
              } catch (err) {
                new Notice(t("settings.exportI18nFailed", { message: err instanceof Error ? err.message : String(err) }));
              }
            })
          );
        },
      },
      {
        name: t("settings.diagnoseName"),
        desc: t("settings.diagnoseDesc"),
        render: (setting) => {
          setting.addButton((b) => b.setButtonText(t("settings.diagnoseButton")).onClick(() => this.runDiagnosis()));
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
    // 逐键输入走防抖：每敲一个字符写一次 data.json 是纯浪费（见 DshSettings.saveDebounced）。
    // 重置内联会话等「写完即生效」的路径仍用 save()，见下方按钮与声明式 render。
    this.plugin.settings.saveDebounced();
  }

  /**
   * 面板关闭：先走框架自己的隐藏逻辑，再把挂起的防抖写入落盘——
   * 否则「改完最后一项就直接关设置」会丢掉那次改动（防抖窗口内的写入还没发出去）。
   */
  hide(): void {
    super.hide();
    void this.plugin.settings.flush().catch((err) => console.error("[dsh-bridge] 设置落盘失败:", err));
  }

  /** 1.13 以下版本回退到命令式 UI（声明式定义非空时框架不再调用本方法）。 */
  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const t = (key: string, params?: I18nParams) => this.plugin.runtime.i18n.t(key, params);

    new Setting(containerEl).setName(t("settings.dshUrlName")).setDesc(t("settings.dshUrlDesc")).addText((text) =>
      text.setValue(s.values.dshUrl).onChange(async (v) => {
        s.values.dshUrl = v.trim();
        s.saveDebounced();
      })
    );

    new Setting(containerEl).setName(t("settings.mentionMaxCharsName")).setDesc(t("settings.mentionMaxCharsDesc")).addText((text) =>
      text.setValue(String(s.values.mentionMaxChars)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.mentionMaxChars = Math.floor(n);
          s.saveDebounced();
        }
      })
    );

    new Setting(containerEl).setName(t("settings.inlineEditTimeoutName")).addText((text) =>
      text.setValue(String(s.values.inlineEditTimeoutSec)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.inlineEditTimeoutSec = Math.floor(n);
          s.saveDebounced();
        }
      })
    );

    new Setting(containerEl).setName(t("settings.historyPageSizeName")).setDesc(t("settings.historyPageSizeDesc")).addText((text) =>
      text.setValue(String(s.values.historyPageSize)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.historyPageSize = Math.floor(n);
          s.saveDebounced();
        }
      })
    );

    new Setting(containerEl).setName(t("settings.credentialsPathName")).setDesc(t("settings.credentialsPathDesc")).addText((text) =>
      text.setValue(s.values.dshCredentialsPath).onChange(async (v) => {
        s.values.dshCredentialsPath = v.trim();
        s.saveDebounced();
      })
    );

    new Setting(containerEl).setName(t("settings.resetSessionName")).setDesc(t("settings.resetSessionDesc")).addButton((b) =>
      b.setButtonText(t("settings.resetButton")).onClick(async () => {
        try {
          s.values.inlineEditSessionId = "";
          await s.save(); // 立即落盘：重置必须马上生效，不能进防抖队列
          new Notice(t("settings.resetDone"));
        } catch (err) {
          new Notice(t("settings.resetFailed", { message: err instanceof Error ? err.message : String(err) }));
        }
      })
    );

    new Setting(containerEl).setName(t("settings.exportI18nName")).setDesc(t("settings.exportI18nDesc")).addButton((b) =>
      b.setButtonText(t("settings.exportI18nButton")).onClick(async () => {
        try {
          await this.plugin.app.vault.adapter.write("dsh-bridge.i18n.json", JSON.stringify(DEFAULT_STRINGS, null, 2));
          new Notice(t("settings.exportI18nDone"));
        } catch (err) {
          new Notice(t("settings.exportI18nFailed", { message: err instanceof Error ? err.message : String(err) }));
        }
      })
    );
    new Setting(containerEl).setName(t("settings.diagnoseName")).setDesc(t("settings.diagnoseDesc")).addButton((b) =>
      b.setButtonText(t("settings.diagnoseButton")).onClick(() => this.runDiagnosis())
    );
  }
}
