/**
 * TASK-030 项 4：Goal 面板纯规则单测（`src/ui/goalPanel.ts`）。
 *
 * 阶段语义来自官方 `GoalPhase = active | paused | blocked | complete`
 * （见 dsh-goal types：blocked 仅由 blockedReason 存在时出现；complete 为终态）。
 * 动作矩阵是这一层的核心契约：错一个按钮就会让用户点出必然失败的 CAS 请求。
 */
import { describe, expect, it } from "vitest";
import { GOAL_PHASE_GLYPH, goalActions, goalPanelSignature, goalPanelState, goalRefOf, goalSignature, goalSummaryText } from "../../src/ui/goalPanel";
import type { GoalPhase, GoalProjection } from "../../src/transport/types";

const t = (key: string, params?: Record<string, string | number>) => `${key}(${Object.values(params ?? {}).join("/")})`;

function goal(phase: GoalPhase, overrides: Partial<GoalProjection["goal"]> = {}, roundsStarted = 2): GoalProjection {
  return {
    goal: { id: "g1", revision: 4, objective: "完成 TASK-030", phase, maxGoalRounds: 12, ...overrides },
    roundsStarted,
    createdAt: 1,
    updatedAt: 2,
  };
}

describe("GOAL_PHASE_GLYPH", () => {
  it("四个阶段都有图标（无文案，不涉及 i18n）", () => {
    for (const phase of ["active", "paused", "blocked", "complete"] as const) {
      expect(GOAL_PHASE_GLYPH[phase]).toBeTruthy();
    }
  });
});

describe("goalActions（阶段 → 可用动作）", () => {
  it("active：可暂停/完成/编辑/清除，不可继续", () => {
    expect(goalActions("active")).toEqual({ canPause: true, canResume: false, canComplete: true, canEdit: true, canClear: true });
  });

  it("paused：可继续，不可暂停、不可完成（须先恢复）", () => {
    expect(goalActions("paused")).toEqual({ canPause: false, canResume: true, canComplete: false, canEdit: true, canClear: true });
  });

  it("blocked：可继续（resume 是解除阻塞的唯一入口），不可完成", () => {
    expect(goalActions("blocked")).toEqual({ canPause: false, canResume: true, canComplete: false, canEdit: true, canClear: true });
  });

  it("complete：终态只可编辑/清除", () => {
    expect(goalActions("complete")).toEqual({ canPause: false, canResume: false, canComplete: false, canEdit: true, canClear: true });
  });

  it("未知/缺省阶段：一律不可操作（不猜）", () => {
    expect(goalActions(undefined)).toEqual({ canPause: false, canResume: false, canComplete: false, canEdit: false, canClear: false });
  });
});

describe("goalSignature", () => {
  it("无目标（null/undefined）→ 空签名（UI 隐藏）", () => {
    expect(goalSignature(null)).toBe("");
    expect(goalSignature(undefined)).toBe("");
  });

  it("可见字段任一变化即签名变化（revision/phase/rounds/objective/上限）", () => {
    const base = goalSignature(goal("active"));
    expect(goalSignature(goal("active", { revision: 5 }))).not.toBe(base);
    expect(goalSignature(goal("paused"))).not.toBe(base);
    expect(goalSignature(goal("active", {}, 3))).not.toBe(base);
    expect(goalSignature(goal("active", { objective: "别的目标" }))).not.toBe(base);
    expect(goalSignature(goal("active", { maxGoalRounds: 20 }))).not.toBe(base);
  });

  it("内容相同 → 签名相同（不重建 DOM）", () => {
    expect(goalSignature(goal("active"))).toBe(goalSignature(goal("active")));
  });

  it("字段用不可见分隔符拼接：目标正文不同即签名不同", () => {
    const a = goalSignature(goal("active", { objective: "目标甲" }));
    const b = goalSignature(goal("active", { objective: "目标乙" }));
    expect(a).not.toBe(b);
  });
});

describe("goalSummaryText", () => {
  it("含目标正文与轮次，并按阶段附状态说明", () => {
    expect(goalSummaryText(goal("active"), t)).toBe("🎯 完成 TASK-030 · chat.goalRounds(2/12)");
    expect(goalSummaryText(goal("complete"), t)).toContain("chat.goalPhaseComplete");
    expect(goalSummaryText(goal("paused"), t)).toContain("chat.goalPhasePaused");
  });

  it("blocked 时展示服务端给的原因（比固定文案更有信息量）", () => {
    const text = goalSummaryText(goal("blocked", { blockedReason: { code: "waiting-input", message: "等待用户决策" } }), t);
    expect(text).toContain("等待用户决策");
    expect(text).not.toContain("chat.goalPhaseBlocked");
  });

  it("blocked 但缺原因时退回固定文案", () => {
    expect(goalSummaryText(goal("blocked"), t)).toContain("chat.goalPhaseBlocked");
  });
});

describe("goalRefOf", () => {
  it("直接复用投影里的 {id, revision} 作 CAS 身份", () => {
    expect(goalRefOf(goal("active", { id: "g-9", revision: 7 }))).toEqual({ id: "g-9", revision: 7 });
  });
});

describe("goalPanelState（三态）与签名", () => {
  it("undefined（从未收到投影）→ hidden，签名空串（不渲染空壳）", () => {
    const state = goalPanelState(undefined);
    expect(state).toEqual({ kind: "hidden" });
    expect(goalPanelSignature(state)).toBe("");
  });

  it("null（host 明确说没有目标）→ none，签名非空（渲染「新建目标」入口）", () => {
    const state = goalPanelState(null);
    expect(state).toEqual({ kind: "none" });
    expect(goalPanelSignature(state)).not.toBe("");
  });

  it("有目标 → goal，携带按阶段裁剪的动作", () => {
    const state = goalPanelState(goal("paused"));
    expect(state.kind).toBe("goal");
    if (state.kind === "goal") {
      expect(state.goal.goal.phase).toBe("paused");
      expect(state.actions.canResume).toBe(true);
      expect(state.actions.canPause).toBe(false);
    }
  });

  it("三态签名互不相同（切态必重绘）", () => {
    const sigs = [goalPanelSignature(goalPanelState(undefined)), goalPanelSignature(goalPanelState(null)), goalPanelSignature(goalPanelState(goal("active")))];
    expect(new Set(sigs).size).toBe(3);
  });

  it("同态同内容 → 签名相同（一帧 DOM 都不动）", () => {
    expect(goalPanelSignature(goalPanelState(goal("active")))).toBe(goalPanelSignature(goalPanelState(goal("active"))));
  });
});
