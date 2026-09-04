/**
 * 最小 DOM 仿真：满足 dsh-bridge UI 层（chatView/inputBox）渲染所需的 DOM 面。
 * 只做「能运行 + 可断言」级别：元素树、文本、class、事件注册、滚动尺寸。
 */
class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.parent = null;
    this.text = "";
    this.classes = new Set();
    this.listeners = new Map();
    this.style = {};
    this.value = "";
    this.selectionStart = null;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.scrollHeight = 0;
  }

  empty() { this.children = []; return this; }
  appendChild(child) { child.parent?.removeChild(child); child.parent = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parent = null; return child; }
  remove() { this.parent?.removeChild(this); }
  setText(t) { this.text = String(t); return this; }
  addClass(c) { this.classes.add(c); return this; }
  removeClass(c) { this.classes.delete(c); return this; }
  toggleClass(c, on) { if (on) this.classes.add(c); else this.classes.delete(c); return this; }
  hasClass(c) { return this.classes.has(c); }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
    return this;
  }
  focus() {}
  createDiv(opts) { return this.createEl("div", opts); }
  createEl(tag, opts) {
    const el = new FakeElement(tag);
    if (opts?.cls) el.addClass(opts.cls);
    if (opts?.text !== undefined) el.setText(opts.text);
    this.appendChild(el);
    return el;
  }
  createSpan(opts) { return this.createEl("span", opts); }
  /** 深度优先收集子树全部文本。 */
  collectText() {
    const out = [];
    const walk = (el) => {
      if (el.text.length > 0) out.push(el.text);
      for (const c of el.children) walk(c);
    };
    walk(this);
    return out;
  }
  /** 深度优先收集带指定 class 的元素。 */
  queryByClass(cls) {
    const out = [];
    const walk = (el) => {
      if (el.hasClass(cls)) out.push(el);
      for (const c of el.children) walk(c);
    };
    walk(this);
    return out;
  }
}

/**
 * 增强版 Obsidian stub：比 debug-obsidian-stub.cjs 多两个能力——
 * 1. 真实 DOM 仿真（FakeElement）供 chatView 渲染可断言；
 * 2. registerView 把 view 工厂暴露出来，冒烟脚本可手动 open 视图。
 */
class Plugin {
  constructor() {
    this.app = {
      vault: {
        adapter: {
          read: async () => { throw new Error("ENOENT"); },
          list: async () => ({ files: [], folders: [] }),
          getBasePath: () => "E:\\obsidian-plugin",
        },
        getAbstractFileByPath: () => null,
        cachedRead: async () => "",
        getFiles: () => [],
        getAllFolders: () => [],
      },
      workspace: {
        getLeavesOfType: () => [],
        getRightLeaf: () => null,
        revealLeaf: async () => {},
      },
    };
    this.manifest = { id: "dsh-bridge", dir: ".obsidian/plugins/dsh-bridge" };
    this._views = {};
  }
  async loadData() { return null; }
  async saveData() {}
  addStatusBarItem() { return { setText() {} }; }
  registerView(type, factory) { this._views[type] = factory; }
  addRibbonIcon() {}
  addCommand() {}
  addSettingTab() {}
}
class ItemView {
  constructor(leaf) { this.leaf = leaf; this.contentEl = new FakeElement("div"); }
  get app() { return this.leaf.app; }
}
class PluginSettingTab {
  constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = new FakeElement("div"); }
}
class Modal {
  constructor(app) { this.app = app; this.contentEl = new FakeElement("div"); this.titleEl = { setText() {} }; }
  open() {}
  close() {}
}
class Notice { constructor() {} }
class Setting {
  constructor() { this.container = new FakeElement("div"); }
  setName() { return this; }
  setDesc() { return this; }
  addText() { return this; }
  addButton() { return { setButtonText() { return this; }, setCta() { return this; }, onClick() { return this; } }; }
}
class MarkdownRenderer { static render(app, text, el, path, component) { el.setText(text); return Promise.resolve(); } }
class TFile {}
class TFolder {}
class WorkspaceLeaf { constructor(app) { this.app = app; } }
class Editor {}

module.exports = {
  Plugin,
  ItemView,
  PluginSettingTab,
  Modal,
  Notice,
  Setting,
  MarkdownRenderer,
  TFile,
  TFolder,
  WorkspaceLeaf,
  Editor,
  App: class {},
  __FakeElement: FakeElement,
};
