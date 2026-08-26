// 测试用 obsidian 最小 stub：vitest 通过 resolve.alias 把 "obsidian" 指向本文件。
// obsidian npm 包仅有类型（main 为空），Node 环境下无法直接解析。
export class PluginSettingTab {
  containerEl: { empty: () => void };
  constructor(public app: unknown, public plugin: unknown) {
    this.containerEl = { empty: () => {} };
  }
}

export class Setting {
  constructor(_el: unknown) {}
  setName(_n: string) {
    return this;
  }
  setDesc(_d: string) {
    return this;
  }
  addText() {
    const t = { setValue: () => t, onChange: () => t };
    return t;
  }
  addButton() {
    const b = { setButtonText: () => b, setCta: () => b, onClick: () => b };
    return b;
  }
}
