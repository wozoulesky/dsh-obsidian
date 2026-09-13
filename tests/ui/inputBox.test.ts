/**
 * DshInputBox 联想防抖 / 提及缓存 / 命令联想 / 图片附件接线测试（TASK-027 + TASK-030）。
 *
 * 测试环境无 DOM，这里用最小假元素替身驱动真实的构造/事件路径——
 * 覆盖点：防抖只触发一次、缓存命中不重复读 vault、vault 变更后失效、dispose 注销；
 * 以及 TASK-030 的三条新路径：命令联想用服务端清单（离线退回兜底）、
 * 图片经 vault 选择后按 imageLimits 准入、发送成功清空 / 失败保留。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshInputBox, SUGGEST_DEBOUNCE_MS } from "../../src/ui/inputBox";
import type { SessionView } from "../../src/core/eventFold";
import type { DshRuntime } from "../../src/main";
import type { CommandDescriptor } from "../../src/transport/types";

/** vault 图片选择器被 mock：本文件验证的是 inputBox 侧的准入/渲染/清空逻辑（选择器本身在真机验收）。 */
const { pickMock } = vi.hoisted(() => ({ pickMock: vi.fn() }));
vi.mock("../../src/ui/imagePicker", () => ({ pickVaultImage: pickMock }));

type Listener = (event: unknown) => void;

/** 最小假元素：只实现 inputBox 实际调用到的 DOM 面。 */
class FakeEl {
  children: FakeEl[] = [];
  listeners = new Map<string, Listener[]>();
  text = "";
  value = "";
  selectionStart = 0;
  classes = new Set<string>();
  private parent: FakeEl | null = null;

  constructor(readonly tag = "div", readonly cls = "") {}

  private append(child: FakeEl): FakeEl {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  createDiv(opts?: { cls?: string; text?: string }): FakeEl {
    const el = this.append(new FakeEl("div", opts?.cls ?? ""));
    if (opts?.text !== undefined) el.text = opts.text;
    return el;
  }

  /** 真实 Obsidian 元素同时提供 createSpan（简写）——替身必须同样建模，否则实现改用简写即假失败。 */
  createSpan(opts?: { cls?: string; text?: string }): FakeEl {
    return this.createEl("span", opts);
  }

  createEl(tag: string, opts?: { cls?: string; text?: string }): FakeEl {
    const el = this.append(new FakeEl(tag, opts?.cls ?? ""));
    if (opts?.text !== undefined) el.text = opts.text;
    if (opts?.cls) el.classes.add(opts.cls);
    return el;
  }

  setText(text: string): void {
    this.text = text;
  }

  addEventListener(name: string, callback: Listener): void {
    const list = this.listeners.get(name) ?? [];
    list.push(callback);
    this.listeners.set(name, list);
  }

  remove(): void {
    // 与真实 DOM 一致：从父节点的 children 里摘掉自己（否则重绘后 wrap.children 会堆积旧弹层）
    if (!this.parent) return;
    const at = this.parent.children.indexOf(this);
    if (at >= 0) this.parent.children.splice(at, 1);
    this.parent = null;
  }

  empty(): void {
    this.children.length = 0;
  }

  addClass(cls: string): void {
    this.classes.add(cls);
  }

  removeClass(cls: string): void {
    this.classes.delete(cls);
  }

  toggleClass(cls: string, value?: boolean): void {
    if (value === false) this.classes.delete(cls);
    else this.classes.add(cls);
  }

  focus(): void {}

  dispatch(name: string, event: unknown = {}): void {
    for (const callback of this.listeners.get(name) ?? []) callback(event);
  }

  /** 输入文本并同步光标到末尾（updateSuggest 依赖 selectionStart）。 */
  type(value: string): void {
    this.value = value;
    this.selectionStart = value.length;
    this.dispatch("input");
  }

  /** 按 Enter（onKeydown 走发送路径）。 */
  pressEnter(): void {
    this.dispatch("keydown", { key: "Enter", shiftKey: false, preventDefault: () => undefined });
  }
}

interface SetupOptions {
  files?: string[];
  folders?: string[];
  /** 服务端命令清单；缺省 = null（尚未拉取 → 联想退回内置兜底清单）。 */
  commands?: CommandDescriptor[] | null;
}

/** 只带 vault 与 i18n 的最小 runtime（附件/命令路径都不碰网络）。 */
function fakeRuntime() {
  const vault = {
    getFiles: vi.fn(() => [] as Array<{ path: string }>),
    getAllFolders: vi.fn(() => [] as Array<{ path: string }>),
    on: vi.fn((_name: string, _cb: () => void) => ({})),
    offref: vi.fn(),
  };
  const runtime = {
    plugin: { app: { vault } },
    i18n: { t: (key: string) => key },
  } as unknown as DshRuntime;
  return { runtime, vault };
}

function setup(opts: SetupOptions = {}) {
  const files = opts.files ?? ["Notes/Alpha.md", "Notes/Beta.md"];
  const folders = opts.folders ?? ["Notes"];
  const vault = {
    getFiles: vi.fn(() => files.map((path) => ({ path }))),
    getAllFolders: vi.fn(() => folders.map((path) => ({ path }))),
    on: vi.fn((_name: string, _cb: () => void) => ({})),
    offref: vi.fn(),
  };
  const runtime = {
    plugin: { app: { vault } },
    i18n: { t: (key: string) => key },
  } as unknown as DshRuntime;
  const commands = opts.commands === undefined ? null : opts.commands;

  const container = new FakeEl();
  const box = new DshInputBox(
    container as unknown as HTMLElement,
    runtime,
    () => undefined,
    async () => true,
    () => undefined,
    () => commands
  );
  const wrap = container.children[0];
  const textarea = wrap.children[0];
  // 附件条挂在 wrap 之后（不影响联想弹层在 wrap 内的绝对定位）
  const attachBar = container.children[1];
  const chips = attachBar.children[0];
  const attachBtn = attachBar.children[1];
  return { box, wrap, textarea, attachBar, chips, attachBtn, vault, container };
}

/** 取已注册的 vault 事件回调。 */
function registeredCallback(vault: { on: ReturnType<typeof vi.fn> }, name: string): () => void {
  const call = vault.on.mock.calls.find(([eventName]) => eventName === name);
  if (!call) throw new Error(`未注册 vault 事件：${name}`);
  return call[1] as () => void;
}

/** 让 mock 的 Promise 链跑完（真实计时器）。 */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  pickMock.mockReset(); // 选择器 mock 跨用例重置（否则调用次数会串味）
});

describe("联想防抖", () => {
  it("窗口内连续输入只触发一次查询（防抖，非每次按键）", () => {
    vi.useFakeTimers();
    const { textarea, vault } = setup();

    textarea.type("@A");
    textarea.type("@Al");
    textarea.type("@Alp");
    expect(vault.getFiles).not.toHaveBeenCalled(); // 窗口内不查询

    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(vault.getFiles).toHaveBeenCalledTimes(1); // 只保留最后一次
  });

  it("多次输入被同一次防抖吞并后按最新文本查询", () => {
    vi.useFakeTimers();
    const { wrap, textarea } = setup({ files: ["Notes/Alpha.md", "Notes/Beta.md"] });

    textarea.type("@Al");
    textarea.type("@Beta"); // 覆盖前一次
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);

    // 第二个子元素是联想弹层（第一个是 textarea 的父 wrap 内首个 div）
    const suggest = wrap.children[1];
    expect(suggest.children.map((child) => child.text)).toEqual(["@file:Notes/Beta.md"]);
  });

  it("超出窗口的两次输入各触发一次查询", () => {
    vi.useFakeTimers();
    const { textarea, vault } = setup();

    textarea.type("@A");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    textarea.type("@Be");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(vault.getFiles).toHaveBeenCalledTimes(1); // 第二次命中缓存
  });
});

describe("提及候选缓存接线", () => {
  it("缓存命中：多次查询只读一次 vault", () => {
    vi.useFakeTimers();
    const { textarea, vault } = setup();

    textarea.type("@A");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    textarea.type("@Al");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    textarea.type("@Alpha");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);

    expect(vault.getFiles).toHaveBeenCalledTimes(1);
    expect(vault.getAllFolders).toHaveBeenCalledTimes(1);
  });

  it("vault 变更事件后缓存失效，下次查询重建", () => {
    vi.useFakeTimers();
    const { textarea, vault } = setup();

    textarea.type("@A");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(vault.getFiles).toHaveBeenCalledTimes(1);

    registeredCallback(vault, "create")(); // 模拟新建文件
    textarea.type("@Al");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(vault.getFiles).toHaveBeenCalledTimes(2);
  });

  it("create/delete/rename/modify 四个事件都已注册", () => {
    const { vault } = setup();
    expect(vault.on.mock.calls.map(([name]) => name)).toEqual(["create", "delete", "rename", "modify"]);
  });

  it("候选带 @file:/@folder: 前缀，渲染进弹层", () => {
    vi.useFakeTimers();
    const { wrap, textarea } = setup({ files: ["Notes/Alpha.md"], folders: ["Notes"] });

    textarea.type("@No");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);

    const suggest = wrap.children[1];
    expect(suggest.children.map((child) => child.text)).toEqual(["@file:Notes/Alpha.md", "@folder:Notes"]);
  });

  it("无匹配候选时不渲染弹层", () => {
    vi.useFakeTimers();
    const { wrap, textarea } = setup();
    textarea.type("@zzzz");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(wrap.children).toHaveLength(1); // 只有 textarea，没有弹层
  });
});

describe("dispose", () => {
  it("取消挂起查询，且不再读 vault", () => {
    vi.useFakeTimers();
    const { box, textarea, vault } = setup();

    textarea.type("@A");
    box.dispose();
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(vault.getFiles).not.toHaveBeenCalled();
  });

  it("注销全部 vault 订阅（避免 view 关闭后仍被回调持有）", () => {
    const { box, vault } = setup();
    box.dispose();
    expect(vault.offref).toHaveBeenCalledTimes(4);
  });

  it("dispose 清空待发图片（不把已读入的 base64 留在内存里）", async () => {
    pickMock.mockResolvedValue({ ok: true, image: { path: "a.png", mediaType: "image/png", data: "AAAA", byteLength: 4 } });
    const { box, attachBtn, chips } = setup();
    attachBtn.dispatch("click");
    await flush();
    expect(chips.children).toHaveLength(1);
    box.dispose();
    expect(chips.children).toHaveLength(0);
  });
});

/* ---- TASK-030 项 2：命令联想用服务端清单（离线退回内置兜底） ---- */

describe("命令联想（TASK-030）", () => {
  const serverCommands: CommandDescriptor[] = [
    { name: "compact", description: "Compact older conversation history" },
    { name: "goal", description: "set or view the goal", input: { hint: "[<objective>]", attachments: true } },
  ];

  it("在线清单：渲染 服务端命令 + 前端 /clear（描述用服务端原文）", () => {
    vi.useFakeTimers();
    const { wrap, textarea } = setup({ commands: serverCommands });
    textarea.type("/");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    const suggest = wrap.children[1];
    expect(suggest.children.map((c) => c.text)).toEqual([
      "/clear — command.clear.desc",
      "/compact — Compact older conversation history",
      "/goal — set or view the goal",
    ]);
  });

  it("清单未拉取（null）：退回内置兜底清单 + i18n 描述", () => {
    vi.useFakeTimers();
    const { wrap, textarea } = setup({ commands: null });
    textarea.type("/com");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(wrap.children[1].children.map((c) => c.text)).toEqual(["/compact — command.compact.desc"]);
  });

  it("按查询过滤（大小写不敏感、只匹配命令名）", () => {
    vi.useFakeTimers();
    const { wrap, textarea } = setup({ commands: serverCommands });
    textarea.type("/GO");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(wrap.children[1].children.map((c) => c.text)).toEqual(["/goal — set or view the goal"]);
  });

  it("refreshSuggest：清单在弹层打开后到达 → 立即用真实清单重绘", () => {
    vi.useFakeTimers();
    const commands: { value: CommandDescriptor[] | null } = { value: null };
    const { runtime } = fakeRuntime();
    const container = new FakeEl();
    const box = new DshInputBox(
      container as unknown as HTMLElement,
      runtime,
      () => undefined,
      async () => true,
      () => undefined,
      () => commands.value
    );
    const wrap = container.children[0];
    const textarea = wrap.children[0];

    textarea.type("/");
    vi.advanceTimersByTime(SUGGEST_DEBOUNCE_MS);
    expect(wrap.children[1].children.map((c) => c.text)).toContain("/compact — command.compact.desc");

    commands.value = serverCommands;
    box.refreshSuggest();
    expect(wrap.children[1].children.map((c) => c.text)).toContain("/compact — Compact older conversation history");
    expect(wrap.children).toHaveLength(2); // 旧弹层已摘除，没有堆积
  });
});

/* ---- TASK-030 项 3：图片附件（选择 → 准入 → chip → 随发送提交/清空） ---- */

describe("图片附件（TASK-030）", () => {
  /** 用给定的 imageLimits 投影建一个输入框（只驱动附件路径）。 */
  function attachSetup(
    limits: SessionView["imageLimits"],
    onSend: (text: string, images: unknown[]) => Promise<boolean> = async () => true
  ) {
    const { runtime } = fakeRuntime();
    const container = new FakeEl();
    const view = { imageLimits: limits } as unknown as SessionView;
    const box = new DshInputBox(container as unknown as HTMLElement, runtime, () => view, onSend, () => undefined);
    return {
      box,
      container,
      textarea: container.children[0].children[0],
      chips: container.children[1].children[0],
      attachBtn: container.children[1].children[1],
    };
  }

  it("选中 vault 图片 → 渲染 chip（含路径与体积）", async () => {
    pickMock.mockResolvedValue({ ok: true, image: { path: "notes/a.png", mediaType: "image/png", data: "AAAA", byteLength: 1536 } });
    const { attachBtn, chips } = setup();
    attachBtn.dispatch("click");
    await flush();
    expect(pickMock).toHaveBeenCalledTimes(1);
    expect(chips.children).toHaveLength(1);
    expect(chips.children[0].children[0].text).toBe("notes/a.png (1.5 KB)");
    expect(chips.children[0].children[1].text).toBe("✕");
  });

  it("取消选择（cancelled）→ 静默，不加 chip", async () => {
    pickMock.mockResolvedValue({ ok: false, reason: "cancelled" });
    const { attachBtn, chips } = setup();
    attachBtn.dispatch("click");
    await flush();
    expect(chips.children).toHaveLength(0);
  });

  it("读取失败（readFailed）→ 不加 chip（提示走 Notice）", async () => {
    pickMock.mockResolvedValue({ ok: false, reason: "readFailed" });
    const { attachBtn, chips } = setup();
    attachBtn.dispatch("click");
    await flush();
    expect(chips.children).toHaveLength(0);
  });

  it("chip 的 ✕ 移除该图（索引正确，不会误删别的）", async () => {
    pickMock
      .mockResolvedValueOnce({ ok: true, image: { path: "a.png", mediaType: "image/png", data: "A", byteLength: 1 } })
      .mockResolvedValueOnce({ ok: true, image: { path: "b.png", mediaType: "image/png", data: "B", byteLength: 1 } });
    const { attachBtn, chips } = setup();
    attachBtn.dispatch("click");
    await flush();
    attachBtn.dispatch("click");
    await flush();
    expect(chips.children).toHaveLength(2);
    chips.children[0].children[1].dispatch("click"); // 移除第一张
    expect(chips.children).toHaveLength(1);
    expect(chips.children[0].children[0].text).toContain("b.png");
  });

  it("Enter 发送：图片随文本一起交给 onSend；成功后清空 chip", async () => {
    pickMock.mockResolvedValue({ ok: true, image: { path: "a.png", mediaType: "image/png", data: "AAAA", byteLength: 4 } });
    const sent: Array<{ text: string; images: unknown[] }> = [];
    const { container, textarea, chips, attachBtn } = attachSetup(undefined, async (text, images) => {
      sent.push({ text, images });
      return true;
    });
    expect(container.children).toHaveLength(2); // wrap + 附件条
    attachBtn.dispatch("click");
    await flush();

    textarea.type("看这张图");
    textarea.pressEnter();
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toBe("看这张图");
    expect(sent[0].images).toHaveLength(1);
    expect(chips.children).toHaveLength(0); // 发送成功 → chip 清空
  });

  it("发送失败：保留 chip（用户不必重新选图）", async () => {
    pickMock.mockResolvedValue({ ok: true, image: { path: "a.png", mediaType: "image/png", data: "AAAA", byteLength: 4 } });
    const { textarea, chips, attachBtn } = attachSetup(undefined, async () => false);
    attachBtn.dispatch("click");
    await flush();

    textarea.type("看这张图");
    textarea.pressEnter();
    await flush();
    expect(chips.children).toHaveLength(1);
  });

  it("只有图片没有文本也能发送（正文为空串，由 content 组装层决定不发空文本块）", async () => {
    pickMock.mockResolvedValue({ ok: true, image: { path: "a.png", mediaType: "image/png", data: "AAAA", byteLength: 4 } });
    const sent: Array<{ text: string; images: unknown[] }> = [];
    const { textarea, attachBtn } = attachSetup(undefined, async (text, images) => {
      sent.push({ text, images });
      return true;
    });
    attachBtn.dispatch("click");
    await flush();
    textarea.pressEnter();
    await flush();
    expect(sent).toEqual([{ text: "", images: [expect.objectContaining({ path: "a.png" })] }]);
  });

  it("无文本且无图片时 Enter 不发送", async () => {
    const sent: unknown[] = [];
    const { textarea } = attachSetup(undefined, async (text, images) => {
      sent.push({ text, images });
      return true;
    });
    textarea.pressEnter();
    await flush();
    expect(sent).toHaveLength(0);
  });

  it("超过张数上限 → 不加 chip（上限来自会话 imageLimits 投影）", async () => {
    pickMock.mockResolvedValue({ ok: true, image: { path: "a.png", mediaType: "image/png", data: "AAAA", byteLength: 4 } });
    const { chips, attachBtn } = attachSetup({
      maxImageBytes: 100,
      maxImagesPerMessage: 1,
      maxMessageImageBytes: 100,
      maxImagePixels: 1,
      maxImageDimension: 1,
      mediaTypes: ["image/png"],
    });
    attachBtn.dispatch("click");
    await flush();
    attachBtn.dispatch("click");
    await flush();
    expect(chips.children).toHaveLength(1); // 第二张被 tooMany 拒绝
  });

  it("单张超上限 → 不加 chip", async () => {
    pickMock.mockResolvedValue({ ok: true, image: { path: "big.png", mediaType: "image/png", data: "AAAA", byteLength: 5000 } });
    const { chips, attachBtn } = attachSetup({
      maxImageBytes: 1024,
      maxImagesPerMessage: 5,
      maxMessageImageBytes: 100000,
      maxImagePixels: 1,
      maxImageDimension: 1,
      mediaTypes: ["image/png"],
    });
    attachBtn.dispatch("click");
    await flush();
    expect(chips.children).toHaveLength(0);
  });
});
