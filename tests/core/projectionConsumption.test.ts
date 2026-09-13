/**
 * TASK-029 项 2/3：投影消费层（`store.applyProjection`）与待办的两条路径。
 *
 * 线上形状全部取自 2026-09-11 对本机 DSH 0.1.5-rc.1 的只读探针
 * （`tmp/probe-projections.notes.md`），逐字而非推测：
 * - `tokenUsage`  = {"uncachedInputTokens":503737,"outputTokens":54421,"cacheReadTokens":10560640,"cacheWriteTokens":0}
 * - `contextPressure` = {"pressureTokens":179009,"projectedTokens":179238,"contextWindow":1000000}
 * - **真机确实下发 `contextPressure: {}`**（无样本的会话）→ 必须视作无数据，不可写入视图
 * - `todos` 键存在于全部 22/22 个快照（值为 null；清单非空时由 turn 内写入）
 *
 * 三条契约：
 * 1. 三个键被消费且**保持既有 higher-seq-wins 语义**（旧 seq 不覆盖新值）；
 * 2. 事件路径（`todo/write` / `turn/start`）与投影路径（`todos`）都覆盖——真机上二者可能只来其一；
 * 3. 畸形负载不崩、不写入（视图保持上一个可信值，"有值"恒等于"可信"）。
 */
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/store";
import { narrowContextPressure, narrowTodos, narrowTokenUsage } from "../../src/core/eventFold";
import type { SessionControlFrame, SessionFollowFrame } from "../../src/transport/types";

function userEvent(seq: number, text: string) {
  return { type: "user/message", seq, time: seq, data: { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } } };
}

function projection(store: SessionStore, key: string, value: unknown, seq: number): void {
  store.applyControlFrame({ type: "projection", sessionId: "s1", key, value, seq });
}

/** 真机样本（逐字）。 */
const REAL_USAGE = { uncachedInputTokens: 503737, outputTokens: 54421, cacheReadTokens: 10560640, cacheWriteTokens: 0 };
const REAL_PRESSURE = { pressureTokens: 179009, projectedTokens: 179238, contextWindow: 1000000 };

describe("投影消费：tokenUsage", () => {
  it("消费真机样本并收窄为可选数字字段", () => {
    const store = new SessionStore();
    projection(store, "tokenUsage", REAL_USAGE, 10);
    expect(store.ensureView("s1").usage).toEqual(REAL_USAGE);
  });

  it("缺省键不写入 undefined（部分字段也能用）", () => {
    const store = new SessionStore();
    projection(store, "tokenUsage", { outputTokens: 12 }, 1);
    const usage = store.ensureView("s1").usage;
    expect(usage).toEqual({ outputTokens: 12 });
    expect(usage && "cacheReadTokens" in usage).toBe(false);
  });

  it("全零也是合法数据（真机冷会话观测到四键皆 0），不当作缺失", () => {
    const store = new SessionStore();
    projection(store, "tokenUsage", { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, 1);
    expect(store.ensureView("s1").usage).toEqual({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it("畸形负载不写入：null / 字符串 / 数组 / 全非数字 → 不崩且视图保持原值", () => {
    const store = new SessionStore();
    projection(store, "tokenUsage", REAL_USAGE, 5);
    for (const bad of [null, "511", 42, [1, 2], { outputTokens: "many" }, { outputTokens: Number.NaN }, { outputTokens: Number.POSITIVE_INFINITY }, true]) {
      let changed = false;
      expect(() => {
        changed = store.applyProjection("s1", "tokenUsage", bad, 99);
      }).not.toThrow();
      expect(changed).toBe(false);
      expect(store.ensureView("s1").usage).toEqual(REAL_USAGE); // 上一个可信值不被垃圾覆盖
    }
  });

  it("保持 higher-seq-wins：旧 seq 的投影不覆盖新值", () => {
    const store = new SessionStore();
    projection(store, "tokenUsage", { outputTokens: 100 }, 20);
    projection(store, "tokenUsage", { outputTokens: 1 }, 3);
    expect(store.ensureView("s1").usage).toEqual({ outputTokens: 100 });
  });
});

describe("投影消费：contextPressure", () => {
  it("消费真机样本（projectedTokens/pressureTokens/contextWindow）", () => {
    const store = new SessionStore();
    projection(store, "contextPressure", REAL_PRESSURE, 10);
    expect(store.ensureView("s1").contextPressure).toEqual(REAL_PRESSURE);
  });

  it("真机空对象 `{}` 视作无数据：不写入、不触发 notify", () => {
    const store = new SessionStore();
    let changed = 0;
    store.onChange(() => changed++);
    expect(store.applyProjection("s1", "contextPressure", {}, 7)).toBe(false);
    expect(store.ensureView("s1").contextPressure).toBeUndefined();
    expect(changed).toBe(0);
  });

  it("缺 contextWindow 时仍写入（UI 只显示 tokens）", () => {
    const store = new SessionStore();
    projection(store, "contextPressure", { projectedTokens: 1234 }, 1);
    expect(store.ensureView("s1").contextPressure).toEqual({ projectedTokens: 1234 });
  });

  it("contextWindow 非正数按畸形丢弃（避免 UI 渲染 `x / 0`），其余键保留", () => {
    const store = new SessionStore();
    projection(store, "contextPressure", { projectedTokens: 5, contextWindow: 0 }, 1);
    expect(store.ensureView("s1").contextPressure).toEqual({ projectedTokens: 5 });
    projection(store, "contextPressure", { projectedTokens: 6, contextWindow: -1 }, 2);
    expect(store.ensureView("s1").contextPressure).toEqual({ projectedTokens: 6 });
  });

  it("畸形负载（null/数组/字符串）不崩不写入", () => {
    const store = new SessionStore();
    projection(store, "contextPressure", REAL_PRESSURE, 3);
    for (const bad of [null, [], "x", 9, { projectedTokens: {} }]) {
      expect(() => store.applyProjection("s1", "contextPressure", bad, 100)).not.toThrow();
      expect(store.ensureView("s1").contextPressure).toEqual(REAL_PRESSURE);
    }
  });
});

describe("待办 - 投影路径", () => {
  const list = [
    { content: "读代码", status: "completed" },
    { content: "写实现", status: "in_progress" },
    { content: "补测试", status: "pending" },
  ];

  it("消费 TodoItem[] 投影（三态原样保留）", () => {
    const store = new SessionStore();
    projection(store, "todos", list, 4);
    expect(store.ensureView("s1").todos).toEqual(list);
  });

  it("null 表示已清空：写入 null（UI 不渲染），而不是「忽略」", () => {
    const store = new SessionStore();
    projection(store, "todos", list, 4);
    projection(store, "todos", null, 5);
    expect(store.ensureView("s1").todos).toBeNull();
  });

  it("过滤畸形条目：非对象/空 content/未知 status 被剔除，合法项保留", () => {
    const store = new SessionStore();
    projection(store, "todos", [list[0], null, { content: "", status: "pending" }, { content: "x", status: "doing" }, "y", 7, list[1]], 1);
    expect(store.ensureView("s1").todos).toEqual([list[0], list[1]]);
  });

  it("过滤后为空 → null（不渲染空壳列表）", () => {
    const store = new SessionStore();
    projection(store, "todos", [{ content: "x", status: "???" }], 1);
    expect(store.ensureView("s1").todos).toBeNull();
  });

  it("非数组畸形负载不写入（保持上一个可信清单）", () => {
    const store = new SessionStore();
    projection(store, "todos", list, 2);
    for (const bad of ["todos", 5, { todos: list }, true]) {
      expect(() => store.applyProjection("s1", "todos", bad, 50)).not.toThrow();
      expect(store.ensureView("s1").todos).toEqual(list);
    }
  });
});

describe("待办 - 事件路径（todo/write 与 turn/start 清零）", () => {
  const list = [{ content: "A", status: "pending" }, { content: "B", status: "completed" }];

  it("todo/write 整表快照折叠进视图（last-wins，不累积历史）", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 10, time: 10, data: { todos: [{ content: "旧", status: "pending" }] } } });
    expect(store.ensureView("s1").todos).toEqual([{ content: "旧", status: "pending" }]);
    store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 11, time: 11, data: { todos: list } } });
    expect(store.ensureView("s1").todos).toEqual(list);
  });

  it("turn/start 清零清单（官方投影 fold 语义；turn/end 保留已完成清单可见）", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 10, time: 10, data: { todos: list } } });
    store.applyFollowEvent("s1", { type: "event", event: { type: "turn/end", seq: 11, time: 11, data: { reason: { kind: "completed" } } } });
    expect(store.ensureView("s1").todos).toEqual(list); // turn/end 不动清单
    store.applyFollowEvent("s1", { type: "event", event: { type: "turn/start", seq: 12, time: 12, data: { turn: 2 } } });
    expect(store.ensureView("s1").todos).toBeNull(); // 新回合开始 → 清零
  });

  it("todo/write 畸形负载不崩不写入", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 1, time: 1, data: { todos: list } } });
    for (const bad of [undefined, null, "x", 3, { content: "A", status: "pending" }]) {
      expect(() => store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 2, time: 2, data: { todos: bad } } })).not.toThrow();
    }
    // null 是合法语义（清空）；其余畸形保持既有值 → 最终为 null
    expect(store.ensureView("s1").todos).toBeNull();
  });
});

describe("待办 - 两条路径合并（真机上可能只来其一）", () => {
  const fromEvent = [{ content: "事件路径", status: "in_progress" }];
  const fromProjection = [{ content: "投影路径", status: "pending" }];

  it("只有事件：todo/write 后视图有清单", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 5, time: 5, data: { todos: fromEvent } } });
    expect(store.ensureView("s1").todos).toEqual(fromEvent);
  });

  it("只有投影：baseline/projection 后视图有清单", () => {
    const store = new SessionStore();
    projection(store, "todos", fromProjection, 5);
    expect(store.ensureView("s1").todos).toEqual(fromProjection);
  });

  it("两者都来：后到的覆盖（同一字段，last-wins）", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 5, time: 5, data: { todos: fromEvent } } });
    projection(store, "todos", fromProjection, 6);
    expect(store.ensureView("s1").todos).toEqual(fromProjection);
    store.applyFollowEvent("s1", { type: "event", event: { type: "todo/write", seq: 7, time: 7, data: { todos: fromEvent } } });
    expect(store.ensureView("s1").todos).toEqual(fromEvent);
  });
});

describe("投影播种：follow 快照 / control baseline / 前插历史", () => {
  it("applyFollowSnapshot 的 projections 块逐键播种三键（asOfSeq 为水位）", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 42,
      records: [{ type: "event", event: userEvent(42, "hi") }],
      hasMore: false,
      projections: { asOfSeq: 33640, values: { title: "标题", tokenUsage: REAL_USAGE, contextPressure: REAL_PRESSURE, todos: [{ content: "X", status: "pending" }] } },
    });
    const view = store.ensureView("s1");
    expect(view.usage).toEqual(REAL_USAGE);
    expect(view.contextPressure).toEqual(REAL_PRESSURE);
    expect(view.todos).toEqual([{ content: "X", status: "pending" }]);
  });

  it("快照里的事件先折叠、投影后覆盖：turn/start 清零不会盖掉快照里的清单", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 20,
      records: [
        { type: "event", event: { type: "todo/write", seq: 9, time: 9, data: { todos: [{ content: "旧清单", status: "pending" }] } } },
        { type: "event", event: { type: "turn/start", seq: 10, time: 10, data: { turn: 2 } } }, // 事件路径清零
      ],
      hasMore: false,
      // 投影是 asOfSeq 处的权威折叠结果：本回合内写入的清单
      projections: { asOfSeq: 20, values: { todos: [{ content: "当前清单", status: "in_progress" }] } },
    });
    expect(store.ensureView("s1").todos).toEqual([{ content: "当前清单", status: "in_progress" }]);
  });

  it("control baseline 播种三键（未打开会话也播种，与 title/plan 同语义）", () => {
    const store = new SessionStore();
    const baseline: SessionControlFrame = {
      type: "baseline",
      value: {
        queues: {},
        jobs: {},
        projections: { s9: { asOfSeq: 77, values: { tokenUsage: REAL_USAGE, contextPressure: REAL_PRESSURE, todos: null } } },
      },
    };
    store.applyControlFrame(baseline);
    const view = store.ensureView("s9");
    expect(view.usage).toEqual(REAL_USAGE);
    expect(view.contextPressure).toEqual(REAL_PRESSURE);
    expect(view.todos).toBeNull();
  });

  it("prependHistory 前插更早一页后，三键以尾页视图为准（不被旧页的过期 todo/write 覆盖）", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 50,
      records: [{ type: "event", event: userEvent(50, "新消息") }],
      hasMore: true,
      projections: { asOfSeq: 50, values: { tokenUsage: REAL_USAGE, contextPressure: REAL_PRESSURE, todos: [{ content: "当前", status: "in_progress" }] } },
    });
    // 旧页里有一条过期的 todo/write
    store.prependHistory("s1", [{ type: "todo/write", seq: 3, time: 3, data: { todos: [{ content: "过期", status: "completed" }] } }]);
    const view = store.ensureView("s1");
    expect(view.todos).toEqual([{ content: "当前", status: "in_progress" }]);
    expect(view.usage).toEqual(REAL_USAGE);
    expect(view.contextPressure).toEqual(REAL_PRESSURE);
  });

  it("尾页从未收到投影（undefined）时，前插历史不把旧页折叠结果擦掉", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.prependHistory("s1", [{ type: "todo/write", seq: 3, time: 3, data: { todos: [{ content: "旧页清单", status: "pending" }] } }]);
    expect(store.ensureView("s1").todos).toEqual([{ content: "旧页清单", status: "pending" }]);
  });

  it("dropView 清掉三键的投影水位：重建后低 seq 也能重新播种", () => {
    const store = new SessionStore();
    projection(store, "contextPressure", REAL_PRESSURE, 900);
    store.dropView("s1");
    projection(store, "contextPressure", { projectedTokens: 1 }, 2); // 旧水位已清 → 2 也能写入
    expect(store.ensureView("s1").contextPressure).toEqual({ projectedTokens: 1 });
  });
});

describe("收窄函数直接契约（供 store 与测试共用）", () => {
  it("narrowTokenUsage：非对象 → undefined；只保留有限数字", () => {
    expect(narrowTokenUsage(null)).toBeUndefined();
    expect(narrowTokenUsage([])).toBeUndefined();
    expect(narrowTokenUsage({})).toBeUndefined();
    expect(narrowTokenUsage({ outputTokens: 3, extra: "ignored" })).toEqual({ outputTokens: 3 });
  });

  it("narrowContextPressure：空对象 → undefined（真机形态）", () => {
    expect(narrowContextPressure({})).toBeUndefined();
    expect(narrowContextPressure({ pressureTokens: 1 })).toEqual({ pressureTokens: 1 });
  });

  it("narrowTodos：null→null，数组→过滤，非法→undefined", () => {
    expect(narrowTodos(null)).toBeNull();
    expect(narrowTodos("x")).toBeUndefined();
    expect(narrowTodos([])).toBeNull();
    expect(narrowTodos([{ content: "ok", status: "completed" }])).toEqual([{ content: "ok", status: "completed" }]);
  });
});

/* ---- TASK-030：三个新投影键的消费（真机样本见 tmp/probe-task030.notes.md） ---- */

/** 真机 modelSelection（next 与 lastUsed 同值）。 */
const REAL_MODEL_SELECTION = {
  lastUsed: { provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "high" },
  next: { provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "high" },
};

/** 真机 imageLimits。 */
const REAL_IMAGE_LIMITS = {
  maxImageBytes: 20971520,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 209715200,
  maxImagePixels: 64000000,
  maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

const REAL_GOAL = {
  goal: { id: "goal-1", revision: 1, objective: "完成 TASK-030", phase: "active", maxGoalRounds: 12 },
  roundsStarted: 0,
  createdAt: 1789000000000,
  updatedAt: 1789000000000,
};

describe("投影消费：modelSelection / imageLimits / goal（TASK-030）", () => {
  it("modelSelection 消费真机样本（{lastUsed,next} 而非裸 ModelSelection）", () => {
    const store = new SessionStore();
    projection(store, "modelSelection", REAL_MODEL_SELECTION, 10);
    expect(store.ensureView("s1").modelSelection).toEqual(REAL_MODEL_SELECTION);
  });

  it("imageLimits 消费真机样本（六字段全保留）", () => {
    const store = new SessionStore();
    projection(store, "imageLimits", REAL_IMAGE_LIMITS, 10);
    expect(store.ensureView("s1").imageLimits).toEqual(REAL_IMAGE_LIMITS);
  });

  it("goal=null 是合法值：写入 null 并触发 notify（UI 据此隐藏目标条）", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    let changed = 0;
    store.onChange(() => changed++);
    store.applyControlFrame({ type: "projection", sessionId: "s1", key: "goal", value: null, seq: 3 });
    expect(store.ensureView("s1").goal).toBeNull();
    expect(changed).toBe(1);
  });

  it("goal 消费完整样本并在 clear 后回到 null", () => {
    const store = new SessionStore();
    projection(store, "goal", REAL_GOAL, 5);
    expect(store.ensureView("s1").goal).toEqual(REAL_GOAL);
    projection(store, "goal", null, 9);
    expect(store.ensureView("s1").goal).toBeNull();
  });

  it("三键都保持 higher-seq-wins（旧 seq 不覆盖新值）", () => {
    const store = new SessionStore();
    projection(store, "modelSelection", REAL_MODEL_SELECTION, 20);
    projection(store, "modelSelection", { lastUsed: null, next: { provider: "old", model: "old" } }, 3);
    expect(store.ensureView("s1").modelSelection).toEqual(REAL_MODEL_SELECTION);

    projection(store, "imageLimits", REAL_IMAGE_LIMITS, 20);
    projection(store, "imageLimits", { ...REAL_IMAGE_LIMITS, maxImageBytes: 1 }, 3);
    expect(store.ensureView("s1").imageLimits?.maxImageBytes).toBe(REAL_IMAGE_LIMITS.maxImageBytes);

    projection(store, "goal", REAL_GOAL, 20);
    projection(store, "goal", null, 3);
    expect(store.ensureView("s1").goal).toEqual(REAL_GOAL);
  });

  it("畸形负载不写入（不崩、不触发 notify、保持上一个可信值）", () => {
    const store = new SessionStore();
    projection(store, "modelSelection", REAL_MODEL_SELECTION, 5);
    projection(store, "imageLimits", REAL_IMAGE_LIMITS, 5);
    projection(store, "goal", REAL_GOAL, 5);
    let changed = 0;
    store.onChange(() => changed++);

    for (const bad of [null, undefined, "x", 9, [], { lastUsed: null }, { lastUsed: null, next: { provider: 1, model: "m" } }]) {
      expect(() => store.applyProjection("s1", "modelSelection", bad, 99)).not.toThrow();
      expect(store.applyProjection("s1", "modelSelection", bad, 99)).toBe(false);
    }    for (const bad of [null, "x", {}, { ...REAL_IMAGE_LIMITS, maxImageDimension: undefined }]) {
      expect(store.applyProjection("s1", "imageLimits", bad, 99)).toBe(false);
    }
    for (const bad of ["x", 5, {}, { ...REAL_GOAL, roundsStarted: "many" }, { ...REAL_GOAL, goal: null }]) {
      expect(store.applyProjection("s1", "goal", bad, 99)).toBe(false);
    }
    expect(changed).toBe(0);
    const view = store.ensureView("s1");
    expect(view.modelSelection).toEqual(REAL_MODEL_SELECTION);
    expect(view.imageLimits).toEqual(REAL_IMAGE_LIMITS);
    expect(view.goal).toEqual(REAL_GOAL);
  });

  it("follow 快照的投影块逐键播种（含新键）", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot("s1", {
      type: "snapshot",
      header: { version: 1, id: "s1", createdAt: 1 },
      cursor: 12,
      records: [],
      hasMore: false,
      projections: { asOfSeq: 12, values: { modelSelection: REAL_MODEL_SELECTION, imageLimits: REAL_IMAGE_LIMITS, goal: REAL_GOAL } },
    });
    const view = store.ensureView("s1");
    expect(view.modelSelection).toEqual(REAL_MODEL_SELECTION);
    expect(view.imageLimits).toEqual(REAL_IMAGE_LIMITS);
    expect(view.goal).toEqual(REAL_GOAL);
  });

  it("prependHistory 沿用尾页的新键（goal 的 null 也算有值）", () => {
    const store = new SessionStore();
    projection(store, "modelSelection", REAL_MODEL_SELECTION, 40);
    projection(store, "imageLimits", REAL_IMAGE_LIMITS, 40);
    projection(store, "goal", null, 40);
    store.prependHistory("s1", [userEvent(1, "更早")]);
    const view = store.ensureView("s1");
    expect(view.modelSelection).toEqual(REAL_MODEL_SELECTION);
    expect(view.imageLimits).toEqual(REAL_IMAGE_LIMITS);
    expect(view.goal).toBeNull();
  });
});

describe("user/message 的图片块计数（TASK-030 项 3）", () => {
  it("只算 image 块（文本/推理块不计），无图片时为 0", () => {
    const store = new SessionStore();
    store.ensureView("s1"); // applyFollowEvent 只折叠进已存在的视图（未打开会话不物化）
    store.applyFollowEvent("s1", {
      type: "event",
      event: {
        type: "user/message",
        seq: 1,
        time: 1,
        data: {
          id: "m1",
          role: "user",
          content: [
            { type: "text", text: "看图" },
            { type: "image", attachment: { id: "att-1" } },
            { type: "image", attachment: { id: "att-2" } },
          ],
          source: { kind: "user" },
        },
      },
    });
    store.ensureView("s1");
    store.applyFollowEvent("s1", {
      type: "event",
      event: { type: "user/message", seq: 2, time: 2, data: { id: "m2", role: "user", content: [{ type: "text", text: "纯文本" }], source: { kind: "user" } } },
    });
    const nodes = store.ensureView("s1").nodes.filter((n) => n.kind === "user");
    expect(nodes.map((n) => (n.kind === "user" ? n.imageCount : -1))).toEqual([2, 0]);
    expect(nodes[0].kind === "user" && nodes[0].text).toBe("看图"); // 图片块不污染正文
  });
});
