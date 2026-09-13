/**
 * TASK-030 投影收窄层（`src/core/sessionProjections.ts`）单测。
 *
 * 线上样本逐字取自 2026-09-11 对本机 DSH 0.1.5-rc.1 的只读探针（tmp/probe-task030.notes.md）：
 * - `modelSelection` = {"lastUsed":{"provider":"commandcode-pro","model":"deepseek/deepseek-v4.1-flash","reasoningEffort":"high"},"next":{...同值...}}
 *   ——**不是**裸 ModelSelection，而是 `{lastUsed, next}` 两个可空分支；
 * - `imageLimits` = {"maxImageBytes":20971520,"maxImagesPerMessage":20,"maxMessageImageBytes":209715200,
 *   "maxImagePixels":64000000,"maxImageDimension":8192,"mediaTypes":["image/png","image/jpeg","image/webp","image/gif"]}；
 * - `goal` 真机为 null（无目标）——**null 是合法值**，畸形值才应被拒。
 *
 * 契约：合法 → 视图值（含合法的 null）；畸形 → undefined（调用方保持上一个可信值）。
 */
import { describe, expect, it } from "vitest";
import { effectiveModelSelection, narrowGoal, narrowImageLimits, narrowModelSelection } from "../../src/core/sessionProjections";

const REAL_SELECTION = {
  lastUsed: { provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "high" },
  next: { provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "high" },
};

const REAL_LIMITS = {
  maxImageBytes: 20971520,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 209715200,
  maxImagePixels: 64000000,
  maxImageDimension: 8192,
  mediaTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

const REAL_GOAL = {
  goal: { id: "goal-1", revision: 3, objective: "完成 TASK-030", phase: "active", maxGoalRounds: 12 },
  roundsStarted: 2,
  createdAt: 1789000000000,
  updatedAt: 1789000001000,
};

describe("narrowModelSelection", () => {
  it("消费真机样本（lastUsed/next 两分支）", () => {
    expect(narrowModelSelection(REAL_SELECTION)).toEqual(REAL_SELECTION);
  });

  it("两分支都可为 null（尚未选择/未消费），仍算合法", () => {
    expect(narrowModelSelection({ lastUsed: null, next: null })).toEqual({ lastUsed: null, next: null });
    expect(narrowModelSelection({ lastUsed: null, next: { provider: "p", model: "m" } })).toEqual({
      lastUsed: null,
      next: { provider: "p", model: "m" },
    });
  });

  it("缺任一分支 → 整体 undefined（线上 schema 两键皆必填）", () => {
    expect(narrowModelSelection({ next: { provider: "p", model: "m" } })).toBeUndefined();
    expect(narrowModelSelection({ lastUsed: { provider: "p", model: "m" } })).toBeUndefined();
  });

  it("reasoningEffort 缺省时不写入该键（避免 undefined 污染比较）", () => {
    const narrowed = narrowModelSelection({ lastUsed: null, next: { provider: "p", model: "m" } });
    expect(narrowed && "reasoningEffort" in (narrowed.next ?? {})).toBe(false);
  });

  it("任一分支畸形 → 整体 undefined（不拿半个对象覆盖好数据）", () => {
    for (const bad of [
      null,
      undefined,
      "next",
      7,
      [],
      { lastUsed: { provider: "", model: "m" }, next: null },
      { lastUsed: null, next: { provider: "p" } },
      { lastUsed: null, next: { provider: 1, model: "m" } },
      { lastUsed: { provider: "p", model: "m", reasoningEffort: 5 }, next: null },
      { lastUsed: 42, next: null },
      { lastUsed: null, next: [] },
    ]) {
      expect(narrowModelSelection(bad)).toBeUndefined();
    }
  });
});

describe("narrowImageLimits", () => {
  it("消费真机样本（六字段全保留）", () => {
    expect(narrowImageLimits(REAL_LIMITS)).toEqual(REAL_LIMITS);
  });

  it("六个上限字段缺一即不可信 → undefined（退回保守默认值）", () => {
    for (const key of ["maxImageBytes", "maxImagesPerMessage", "maxMessageImageBytes", "maxImagePixels", "maxImageDimension", "mediaTypes"]) {
      const partial: Record<string, unknown> = { ...REAL_LIMITS };
      delete partial[key];
      expect(narrowImageLimits(partial)).toBeUndefined();
    }
  });

  it("mediaTypes 逐个剔除非法成员（空数组合法：该部署不接受任何图片）", () => {
    const narrowed = narrowImageLimits({ ...REAL_LIMITS, mediaTypes: ["image/png", "image/tiff", 7, "image/webp"] });
    expect(narrowed?.mediaTypes).toEqual(["image/png", "image/webp"]);
    expect(narrowImageLimits({ ...REAL_LIMITS, mediaTypes: [] })?.mediaTypes).toEqual([]);
  });

  it("畸形负载（非对象/数组/NaN）→ undefined", () => {
    for (const bad of [null, undefined, "limits", 3, [], { ...REAL_LIMITS, maxImageBytes: Number.NaN }, { ...REAL_LIMITS, mediaTypes: "png" }]) {
      expect(narrowImageLimits(bad)).toBeUndefined();
    }
  });
});

describe("narrowGoal", () => {
  it("null 是合法值（无目标/已清除），不是畸形", () => {
    expect(narrowGoal(null)).toBeNull();
  });

  it("消费完整样本（含 blockedReason 与 phase）", () => {
    expect(narrowGoal(REAL_GOAL)).toEqual(REAL_GOAL);
    const blocked = {
      ...REAL_GOAL,
      goal: { ...REAL_GOAL.goal, phase: "blocked", blockedReason: { code: "waiting-input", message: "需要用户决策" } },
    };
    expect(narrowGoal(blocked)).toEqual(blocked);
  });

  it("缺关键字段 → undefined（objective/phase/id/revision/roundsStarted 等）", () => {
    for (const key of ["objective", "phase", "id", "revision", "maxGoalRounds"]) {
      const goal: Record<string, unknown> = { ...REAL_GOAL.goal };
      delete goal[key];
      expect(narrowGoal({ ...REAL_GOAL, goal })).toBeUndefined();
    }
    for (const key of ["roundsStarted", "createdAt", "updatedAt"]) {
      const outer: Record<string, unknown> = { ...REAL_GOAL };
      delete outer[key];
      expect(narrowGoal(outer)).toBeUndefined();
    }
  });

  it("未知 phase 一律拒绝（不猜阶段，避免 UI 显示错误的动作）", () => {
    expect(narrowGoal({ ...REAL_GOAL, goal: { ...REAL_GOAL.goal, phase: "running" } })).toBeUndefined();
  });

  it("blockedReason 畸形时丢弃该字段但保留目标（best-effort）", () => {
    const narrowed = narrowGoal({ ...REAL_GOAL, goal: { ...REAL_GOAL.goal, blockedReason: { code: 7 } } });
    expect(narrowed?.goal.blockedReason).toBeUndefined();
    expect(narrowed?.goal.objective).toBe("完成 TASK-030");
  });

  it("畸形负载（非对象/字符串/数组）→ undefined", () => {
    for (const bad of [undefined, "goal", 5, []]) expect(narrowGoal(bad)).toBeUndefined();
  });
});

describe("effectiveModelSelection（官方 next ?? lastUsed 语义）", () => {
  it("优先 next（用户刚切换但尚未被请求消费）", () => {
    const projection = { lastUsed: { provider: "a", model: "old" }, next: { provider: "b", model: "new" } };
    expect(effectiveModelSelection(projection, { provider: "d", model: "default" })).toEqual({ provider: "b", model: "new" });
  });

  it("next 为 null 时退回 lastUsed", () => {
    const projection = { lastUsed: { provider: "a", model: "old" }, next: null };
    expect(effectiveModelSelection(projection, { provider: "d", model: "default" })).toEqual({ provider: "a", model: "old" });
  });

  it("投影缺失/两分支皆空时退回目录默认；目录也没有 → undefined", () => {
    expect(effectiveModelSelection(undefined, { provider: "d", model: "default" })).toEqual({ provider: "d", model: "default" });
    expect(effectiveModelSelection({ lastUsed: null, next: null }, { provider: "d", model: "default" })).toEqual({ provider: "d", model: "default" });
    expect(effectiveModelSelection(undefined, undefined)).toBeUndefined();
  });
});
