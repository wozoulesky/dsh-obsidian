/**
 * Goal 面板（TASK-030 项 4）：读 `goal` 投影展示目标与轮次，写操作走 `goals/*`。
 *
 * 投影形状（真机 + 官方 schema 核实）：
 * `{ goal: {id, revision, objective, phase, blockedReason?, maxGoalRounds}, roundsStarted, createdAt, updatedAt } | null`
 * ——`null` 表示"没有目标"（尚未 create 或已 clear），是**合法值**而非"数据缺失"。
 *
 * 这一层只做"显示什么"的纯规则；DOM 写入与 RPC 调用由 chatView 侧接线。
 */
import type { GoalPhase, GoalProjection, GoalRef } from "../transport/types";
import type { Translate } from "./sessionStatus";

/** 阶段图标（与待办面板的 glyph 风格一致；不涉及文案，无需 i18n）。 */
export const GOAL_PHASE_GLYPH: Record<GoalPhase, string> = {
  active: "🎯",
  paused: "⏸",
  blocked: "⛔",
  complete: "✅",
};

/** 目标条上可用的动作（UI 据此显隐按钮；写操作本身由 chatView 调 goals/*）。 */
export interface GoalActions {
  canPause: boolean;
  canResume: boolean;
  canComplete: boolean;
  canEdit: boolean;
  canClear: boolean;
}

/**
 * 按阶段决定动作可用性：
 * - `active`：可暂停 / 可编辑 / 可完成 / 可清除；
 * - `paused`：可继续（恢复）/ 可编辑 / 可清除（**不可**"完成"——恢复后才能完成）；
 * - `blocked`：可继续（解除阻塞的唯一入口是 resume）/ 可编辑 / 可清除；
 * - `complete`：只能编辑或清除（已完结的目标不能再次完成）。
 */
export function goalActions(phase: GoalPhase | undefined): GoalActions {
  switch (phase) {
    case "active":
      return { canPause: true, canResume: false, canComplete: true, canEdit: true, canClear: true };
    case "paused":
    case "blocked":
      return { canPause: false, canResume: true, canComplete: false, canEdit: true, canClear: true };
    case "complete":
      return { canPause: false, canResume: false, canComplete: false, canEdit: true, canClear: true };
    default:
      return { canPause: false, canResume: false, canComplete: false, canEdit: false, canClear: false };
  }
}

/** 目标条的渲染签名：任一可见字段变化即需重绘（内容相同则一帧 DOM 都不动）。 */
export function goalSignature(goal: GoalProjection | null | undefined): string {
  if (goal === null || goal === undefined) return "";
  const { goal: snapshot, roundsStarted } = goal;
  return [snapshot.id, snapshot.revision, snapshot.phase, snapshot.maxGoalRounds, roundsStarted, snapshot.objective].join("\u0001");
}

/**
 * 目标面板的三态（供渲染层直接消费，规则本身可单测）：
 * - `hidden`：从未收到 `goal` 投影（冷会话/旧版 DSH）→ 完全不渲染，不产生空壳；
 * - `none`：host 明确告知"当前没有目标"（投影为 `null`）→ 给一个「新建目标」入口；
 * - `goal`：有目标 → 目标条 + 按阶段裁剪过的动作。
 */
export type GoalPanelState =
  | { kind: "hidden" }
  | { kind: "none" }
  | { kind: "goal"; goal: GoalProjection; actions: GoalActions };

export function goalPanelState(goal: GoalProjection | null | undefined): GoalPanelState {
  if (goal === undefined) return { kind: "hidden" };
  if (goal === null) return { kind: "none" };
  return { kind: "goal", goal, actions: goalActions(goal.goal.phase) };
}

/** 目标面板的脏检查签名（三态各自一个稳定值）。 */
export function goalPanelSignature(state: GoalPanelState): string {
  if (state.kind === "hidden") return "";
  if (state.kind === "none") return "\u0000none";
  return goalSignature(state.goal);
}

/** 目标条主文案：`🎯 objective · 第 N 轮 / 上限 M`；complete 阶段附"已完成"。 */
export function goalSummaryText(goal: GoalProjection, t: Translate): string {
  const { goal: snapshot, roundsStarted } = goal;
  const head = `${GOAL_PHASE_GLYPH[snapshot.phase]} ${snapshot.objective}`;
  const rounds = t("chat.goalRounds", { rounds: roundsStarted, max: snapshot.maxGoalRounds });
  const parts = [head, rounds];
  if (snapshot.phase === "complete") parts.push(t("chat.goalPhaseComplete"));
  if (snapshot.phase === "paused") parts.push(t("chat.goalPhasePaused"));
  if (snapshot.phase === "blocked") parts.push(snapshot.blockedReason?.message ?? t("chat.goalPhaseBlocked"));
  return parts.join(" · ");
}

/** 写操作的 CAS 身份：投影里的 goal 自带 {id, revision}，直接复用（每次变更 revision+1）。 */
export function goalRefOf(goal: GoalProjection): GoalRef {
  return { id: goal.goal.id, revision: goal.goal.revision };
}
