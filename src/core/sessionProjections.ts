/**
 * 会话投影的收窄层（TASK-030 新增键：`modelSelection` / `imageLimits` / `goal`）。
 *
 * 与 `eventFold` 的 narrow* 同一契约：
 * - 收到**合法**负载 → 返回视图值（含 `null` 这类"明确的空"语义，如 `goal: null`）；
 * - 收到**畸形**负载 → 返回 `undefined`，调用方（SessionStore.applyProjection）保持上一个可信值，
 *   于是"字段有值"恒等于"数据可信"，UI 无需再做防御。
 *
 * 收窄规则逐字对齐线上 schema（详见各函数注释与 tmp/probe-task030.notes.md 的真机样本）。
 */
import type {
  GoalBlockReason,
  GoalPhase,
  GoalProjection,
  GoalSnapshot,
  ImageAttachmentLimits,
  ImageMediaType,
  ModelSelection,
  ModelSelectionProjection,
} from "../transport/types";
import { isObject, nonEmptyStringField, numberField, readField } from "./narrow";

/** 线上允许的图片媒体类型（顺序无关，仅用于成员判定）。 */
const IMAGE_MEDIA_TYPES: readonly ImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** 三态之一的目标阶段（导出供 UI 判定动作可用性）。 */
const GOAL_PHASES: readonly GoalPhase[] = ["active", "paused", "blocked", "complete"];

function isGoalPhase(value: unknown): value is GoalPhase {
  return typeof value === "string" && GOAL_PHASES.some((phase) => phase === value);
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === "string" && IMAGE_MEDIA_TYPES.some((mediaType) => mediaType === value);
}

/**
 * 收窄一个 ModelSelection；`null`/缺省 → `null`（"无选择"是合法语义）；
 * 对象但字段非法 → `undefined`（畸形，调用方保持旧值）。
 * `reasoningEffort` 存在但非字符串同样算畸形（schema 为 `z.string().optional()`），
 * 空串则按"未指定档位"处理。
 */
function narrowSelection(value: unknown): ModelSelection | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) return undefined;
  const provider = nonEmptyStringField(value, "provider");
  const model = nonEmptyStringField(value, "model");
  if (provider === undefined || model === undefined) return undefined;
  const effortRaw = readField(value, "reasoningEffort");
  if (effortRaw !== undefined && typeof effortRaw !== "string") return undefined;
  const effort = typeof effortRaw === "string" && effortRaw.length > 0 ? effortRaw : undefined;
  return effort === undefined ? { provider, model } : { provider, model, reasoningEffort: effort };
}

/**
 * 收窄 `modelSelection` 投影。
 *
 * 真机样本：`{"lastUsed":{"provider":"commandcode-pro","model":"deepseek/deepseek-v4.1-flash","reasoningEffort":"high"},
 * "next":{...同值...}}`——注意**不是**裸 ModelSelection，两个分支都可能是 `null`
 * （官方 schema：`z.union([z.literal(null), z.object({...})])`，**两键皆必填**）。
 * 因此缺键、或任一分支畸形，都判为整体不可信 → `undefined`（不拿半个对象覆盖已有的好数据）。
 */
export function narrowModelSelection(value: unknown): ModelSelectionProjection | undefined {
  if (!isObject(value)) return undefined;
  if (!("lastUsed" in value) || !("next" in value)) return undefined;
  const lastUsed = narrowSelection(readField(value, "lastUsed"));
  const next = narrowSelection(readField(value, "next"));
  if (lastUsed === undefined || next === undefined) return undefined;
  return { lastUsed, next };
}

/**
 * 收窄 `imageLimits` 投影：六个上限字段**全部必填**（线上 schema 无可选字段），
 * 任何一项缺失/非正数即视为不可信 → `undefined`（UI 退回保守默认值，见 ui/imageAttach.ts）。
 * `mediaTypes` 允许为空数组（该部署不接受任何图片），非法成员被逐个剔除。
 */
export function narrowImageLimits(value: unknown): ImageAttachmentLimits | undefined {
  if (!isObject(value)) return undefined;
  const maxImageBytes = numberField(value, "maxImageBytes");
  const maxImagesPerMessage = numberField(value, "maxImagesPerMessage");
  const maxMessageImageBytes = numberField(value, "maxMessageImageBytes");
  const maxImagePixels = numberField(value, "maxImagePixels");
  const maxImageDimension = numberField(value, "maxImageDimension");
  const mediaTypes = readField(value, "mediaTypes");
  if (
    maxImageBytes === undefined ||
    maxImagesPerMessage === undefined ||
    maxMessageImageBytes === undefined ||
    maxImagePixels === undefined ||
    maxImageDimension === undefined ||
    !Array.isArray(mediaTypes)
  ) {
    return undefined;
  }
  return {
    maxImageBytes,
    maxImagesPerMessage,
    maxMessageImageBytes,
    maxImagePixels,
    maxImageDimension,
    mediaTypes: mediaTypes.filter(isImageMediaType),
  };
}

/** 收窄 blockedReason（仅在 phase === "blocked" 时由 host 下发）。 */
function narrowBlockedReason(value: unknown): GoalBlockReason | undefined {
  if (!isObject(value)) return undefined;
  const code = nonEmptyStringField(value, "code");
  const message = nonEmptyStringField(value, "message");
  if (code === undefined || message === undefined) return undefined;
  return { code, message };
}

/** 收窄 GoalSnapshot：id/revision/objective/phase/maxGoalRounds 缺一不可。 */
function narrowGoalSnapshot(value: unknown): GoalSnapshot | undefined {
  if (!isObject(value)) return undefined;
  const id = nonEmptyStringField(value, "id");
  const revision = numberField(value, "revision");
  const objective = nonEmptyStringField(value, "objective");
  const phase = readField(value, "phase");
  const maxGoalRounds = numberField(value, "maxGoalRounds");
  if (id === undefined || revision === undefined || objective === undefined || maxGoalRounds === undefined || !isGoalPhase(phase)) {
    return undefined;
  }
  const blockedReason = narrowBlockedReason(readField(value, "blockedReason"));
  const snapshot: GoalSnapshot = { id, revision, objective, phase, maxGoalRounds };
  if (blockedReason !== undefined) snapshot.blockedReason = blockedReason;
  return snapshot;
}

/**
 * 收窄 `goal` 投影：`null` 是**合法值**（尚未创建或已 clear），UI 据此隐藏目标条；
 * 畸形负载 → `undefined`（保持上一个可信目标，不用垃圾覆盖）。
 */
export function narrowGoal(value: unknown): GoalProjection | null | undefined {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  const goal = narrowGoalSnapshot(readField(value, "goal"));
  const roundsStarted = numberField(value, "roundsStarted");
  const createdAt = numberField(value, "createdAt");
  const updatedAt = numberField(value, "updatedAt");
  if (goal === undefined || roundsStarted === undefined || createdAt === undefined || updatedAt === undefined) return undefined;
  return { goal, roundsStarted, createdAt, updatedAt };
}

/**
 * 当前生效的模型选择：官方 UI 语义为 `next ?? catalog.default`——
 * `next` 是"下一次请求将使用"的选择（用户刚切换但尚未被模型请求消费），
 * `lastUsed` 只用于诊断，不参与展示。
 */
export function effectiveModelSelection(
  projection: ModelSelectionProjection | undefined,
  fallback: ModelSelection | undefined
): ModelSelection | undefined {
  return projection?.next ?? projection?.lastUsed ?? fallback;
}
