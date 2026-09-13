/* DSH 线上契约类型（依据 @deepseek-ai/dsh 0.1.2-rc.1 源码 + 真机实测确认，2026-09-03 批 2 对齐；批 4b 清除全部旧契约残留）。
 *
 * 关键契约事实：
 * - 一元 RPC：POST /api/<namespace>/<method>（斜杠端点）；信封 {type:"client-request", rpcId, method, payload:{args:{...}}}；
 *   响应 {type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details?}}}。
 *   args 键集合与描述符精确一致，多余/缺失键被 gateway/arguments-invalid 拒绝。
 * - 事件流：WS /api/remote.mux；帧类型（RemoteStreamServerMessage/SessionFollowFrame/SessionControlFrame/
 *   RemoteEventDownlinkFrame）按流分发给 store/approvalCenter。
 * - 事件应答：$events/result 一元 RPC，args {clientId, eventId, outcome}（waterfall 三态）。
 */

/* ---- RPC 信封 ---- */

// 注意：与严格 schema（closed code 联合 + 必填 details）相比，这里刻意放宽为透传形态。
export interface RpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface ServerResponse {
  type: "server-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export function isServerResponse(x: unknown): x is ServerResponse {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (o.type !== "server-response" || typeof o.rpcId !== "string") return false;
  if (typeof o.result !== "object" || o.result === null) return false;
  return typeof (o.result as { ok?: unknown }).ok === "boolean";
}

/** 浏览器安全 UUID v4（不依赖 secure context，Electron 渲染进程可用）。 */
export function mintId(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ---- 会话域 ---- */

/** session/list 返回项（0.1.2-rc.1：agentPreset 字段已移除；projections 冷会话仅 sessionListMetadata 等键）。 */
export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  projections?: ProjectionsBlock;
}

export interface SessionListResult {
  items: SessionSummary[];
}

export interface SessionCreatePayload {
  cwd?: string;
  sessionId?: string;
  agentPreset?: string;
}

export interface SessionCreateResult {
  sessionId: string;
  agentPreset?: string;
}

/**
 * 图片媒体类型（网关联合，逐字对齐线上 schema；见 `PromptContentPart.image`）。
 * `imageLimits.mediaTypes` 是**部署相关子集**——发送前必须以投影为准再判一次。
 */
export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * session/prompt 的内容块（0.1.5 契约，`PromptContentPart`）：
 * - `text`：纯文本；
 * - `image`：**内联 base64**（host 收到后提升为 durable attachment 引用），data 不含 data URL 前缀；
 * - `file`：先前 `uploadFile` 拿到的 opaque receipt（插件 v1 不做文件上传，保留类型以对齐契约）。
 */
export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: ImageMediaType; data: string; name?: string }
  | { type: "file"; receiptId: string };

/**
 * session/prompt 线上 args.request 形状：requestId 必填（客户端自铸 UUID，
 * host 写入 user 消息 source.rpcId 用于提交回显配对）。
 * DshClient.prompt 的入参允许缺省 requestId（client 内部 mintId 补上）。
 */
export interface PromptPayload {
  requestId: string;
  sessionId: string;
  mode: "queue" | "steer";
  content: PromptContentPart[];
  clientTimeZone?: string;
}

export interface PromptResult {
  accepted: true;
}

/** DshClient.prompt 的入参：requestId 缺省时由 client 内部自铸 UUID；线上 args.request 形状是 PromptPayload（requestId 必填）。 */
export type PromptRequestInput = Omit<PromptPayload, "requestId"> & { requestId?: string };

/** 会话地址：{kind:"session", sessionId}（subagent 地址形态批 3/4 需要时再扩）。 */
export interface SessionAddress {
  kind: "session";
  sessionId: string;
}

/**
 * session/page 请求：throughSeq 必填（-1 = 取到尾/未知；正数 = 页面必须精确止于该 seq，
 * host 校验 throughSeq 不能超过当前 log 尾）。
 * 注意（真机核实）：throughSeq:-1 时 host 返回空页（官方 paginate end=min(0,0)=0），
 * 实际翻页要用 follow snapshot 给的 cursor。
 */
export interface SessionPageRequest {
  address: SessionAddress;
  throughSeq: number;
  beforeSeq?: number;
  maxMessages?: number;
}

/**
 * chunkrow 事件（线上 wire 形态，真机实测 + 官方 types/history.js L372-395 核实）：
 * type 为 `chunkrow/text-chunks | chunkrow/reasoning-chunks | chunkrow/tool-call-chunks`；
 * 字段名为 seq/time（承载行首 seq0/time0）；成员 k 重构为 seq+k / time+Σdt[0..k)。
 */
export type ChunkRowEvent =
  | {
      type: "chunkrow/text-chunks" | "chunkrow/reasoning-chunks";
      seq: number;
      time: number;
      data: { turn: number; step: number; index: number; dt: number[]; texts: string[] };
    }
  | {
      type: "chunkrow/tool-call-chunks";
      seq: number;
      time: number;
      data: { turn: number; step: number; index: number; dt: number[]; id: string; name?: string; args: string[] };
    };

/** 历史页记录：raw 事件或压缩的 assistant delta 行（chunks 解包是批 3 的工作）。 */
export type SessionHistoryRecord = { type: "event"; event: SessionEvent } | { type: "chunks"; event: ChunkRowEvent };

/** session/page 结果。 */
export interface SessionPage {
  records: SessionHistoryRecord[];
  hasMore: boolean;
}

export interface ProjectionsBlock {
  asOfSeq: number;
  values: Record<string, unknown>;
}

export interface CancelPayload {
  sessionId: string;
}

export interface CancelResult {
  accepted: true;
}

/* ---- 会话事件（最小子集 + 折叠所需的负载形状） ---- */

export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  ignorable?: true;
  sourceEventSeqs?: number[];
  /**
   * 线上事件表面的折叠替换标记（官方 SessionEvent wire 契约）。
   * 0.1.5 核实：replace 范围字段为 `startSeq`/`endSeq`（旧契约名 `start`/`end` 已废弃）。
   * 批 4 折叠器决定是否消费——当前仍未消费（见 eventFold 的长会话取舍）。
   */
  surfaceOp?: "append" | { op: "replace"; startSeq: number; endSeq: number };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; attachment: unknown }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "tool-result"; toolCallId: string; content: ContentBlock[]; isError?: boolean };

export interface UserMessage {
  id: string;
  role: "user";
  content: ContentBlock[];
  source: { kind: string };
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  source: { kind: "model"; provider: string; model: string };
}

export interface ToolResultMessage {
  id: string;
  role: "user";
  content: [{ type: "tool-result"; toolCallId: string; content: ContentBlock[]; isError?: boolean }];
  source: { kind: "tool"; callId: string };
}

export type StreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: ContentBlock }
  | { type: "usage"; usage: unknown }
  | { type: "finish"; reason: unknown };

/* ---- remote 事件流（$events 流 + $events/result 应答，批 3 建流 / 批 4 消费） ---- */

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
  intent?: { kind: "plan-review"; approve: string };
}

/** 对一个提问的作答（selected 为选项标签；custom 为自由回答文本）。 */
export interface AskUserQuestionAnswerItem {
  id: string;
  selected: string[];
  custom?: string;
}

export interface QueuedInboxItem {
  id: string;
  placement: "queued" | "steering" | "context";
  message: unknown;
}

/** $events 流首帧：clientId 必须留存用于 answerEvent。 */
export interface RemoteEventReadyFrame {
  type: "ready";
  clientId: string;
  host: { home: string };
}

/** waterfall 帧（approval/request、user-questions/request 等）：批 4 以 eventId 为键入队。 */
export interface RemoteEventWaterfallFrame {
  type: "waterfall";
  event: string;
  eventId: string;
  agentId: string;
  request: Record<string, unknown>;
}

/** emit 帧（api-session/added|removed|status|activity|error 等）。 */
export interface RemoteEventEmitFrame {
  type: "emit";
  event: string;
  args: unknown[];
}

/** waterfall 取消帧（官方以 eventId 关联：同一事件被其他监听者认领/取消后广播）。 */
export interface RemoteEventCancellationFrame {
  type: "cancel";
  eventId: string;
}

/** 官方 $events 流首个 item 就是 ready 帧本身（见 RemoteEventReadyFrame）；流内只有 ready/emit/waterfall/cancel 四型，无 watermark 帧（已对照 0.1.2-rc.1 官方源码核实）。 */
export type RemoteEventDownlinkFrame =
  | RemoteEventReadyFrame
  | RemoteEventEmitFrame
  | RemoteEventWaterfallFrame
  | RemoteEventCancellationFrame;

/**
 * waterfall 应答 outcome 三态：
 * - {kind:"next"}：不认领（传给下一个监听者）
 * - {kind:"result", value}：认领回值（审批 value = "allowed-once" | "rejected"；提问 value = {answers:[...]}）
 * - {kind:"rejected", error:{name,message,code?,details?}}：认领为失败
 */
export type RemoteEventOutcome =
  | { kind: "next" }
  | { kind: "result"; value: unknown }
  | { kind: "rejected"; error: { name: string; message: string; code?: string; details?: unknown } };

/** $events/result 一元 RPC 的 args（客户端自铸 clientId 与 eventId 来自 $events 流帧）。 */
export interface RemoteEventResultArgs {
  clientId: string;
  eventId: string;
  outcome: RemoteEventOutcome;
}

/* ---- remote.mux 流帧（批 3 直接用，本批只定义类型） ---- */

/** 客户端 → 服务端：打开一个逻辑流。payload 为该端点线上请求（session/* 为 {args:{request}}；$events 为 {args:{}}）。 */
export type RemoteStreamOpen = { type: "open"; streamId: string; endpoint: string; payload: unknown };
/** 客户端 → 服务端：取消/关闭一个逻辑流。 */
export type RemoteStreamCancel = { type: "cancel"; streamId: string };
export type RemoteStreamClientMessage = RemoteStreamOpen | RemoteStreamCancel;

/** 服务端逻辑流帧：item 携带一个流值（首帧/事件帧）；end 流结束；error 流错误。 */
export type RemoteStreamItem = { type: "item"; streamId: string; value?: unknown };
export type RemoteStreamEnd = { type: "end"; streamId: string };
export type RemoteStreamError = {
  type: "error";
  streamId: string;
  error: { code: string; message: string; details: Record<string, unknown> };
};
export type RemoteStreamServerMessage = RemoteStreamItem | RemoteStreamEnd | RemoteStreamError;

/** session/follow 请求参数（0.1.5 新增 `assistantStream` opt-in）。 */
export interface SessionFollowRequest {
  address: { kind: "session"; sessionId: string };
  maxMessages?: number;
  /**
   * 0.1.5 新增：请求进程内 assistant 呈现帧（`assistant-stream`）。
   * 服务端严格校验 args——旧版 DSH（如 0.1.2-rc.1）不认识该字段会整条拒绝
   * （gateway/arguments-invalid），故由 SessionManager 做能力探测后按需下发。
   */
  assistantStream?: true;
}

/**
 * 0.1.5 `assistant-stream` 帧的瞬时增量（非 durable 事件，不入 session log）。
 * 对照官方 `SessionAssistantStreamFrame`（dsh-api-session-controller typert 描述符）。
 */
export type AssistantStreamFrame =
  | { type: "start"; attemptId: string; revision: number; startedAfterSeq: number; turn: number; step: number }
  | { type: "chunk"; attemptId: string; revision: number; index: number; time: number; chunk: StreamChunk }
  | {
      type: "end";
      attemptId: string;
      revision: number;
      index: number;
      outcome: { kind: "committed"; eventType: "assistant/message" | "assistant/attempt"; seq: number } | { kind: "abandoned" };
    };

/** 重连开场快照里的在飞 attempt 基线（用于恢复流式中的文本）。 */
export interface AssistantStreamBaseline {
  revision: number;
  activeAttempt?: {
    attemptId: string;
    startedAfterSeq: number;
    turn: number;
    step: number;
    nextIndex: number;
    /** 压缩的 assistant 流记录（text-chunks/reasoning-chunks/tool-call-chunks/chunk）。 */
    stream: unknown[];
  };
}

/** session/follow 流：首帧 snapshot（header/cursor/records/hasMore/projections）+ 后续 event / assistant-stream 帧。 */
export type SessionFollowFrame =
  | {
      type: "snapshot";
      header: {
        version: number;
        id: string;
        createdAt: number;
        cwd?: string;
        parentSession?: string;
        /** 0.1.2-rc.1 字段（0.1.5 已移除，保留兼容读取）。 */
        seedLength?: number;
        /** 0.1.5 字段：会话是否已播种（替代 seedLength）。 */
        isSeeded?: boolean;
        origin?: "subagent";
        delegationDepth?: number;
        agentPreset?: string;
      };
      cursor: number;
      records: SessionHistoryRecord[];
      hasMore: boolean;
      projections: ProjectionsBlock;
      /** 0.1.5：仅当请求带 assistantStream 时下发。 */
      assistantStream?: AssistantStreamBaseline;
    }
  | { type: "event"; event: SessionEvent }
  | { type: "assistant-stream"; frame: AssistantStreamFrame };

/** session/control 流：每代一条 baseline（queues/jobs/projections 三个 Record）+ 增量 queue/jobs/projection 帧。 */
export type SessionControlFrame =
  | {
      type: "baseline";
      value: {
        queues: Record<string, QueuedInboxItem[]>;
        jobs: Record<string, unknown[]>;
        projections: Record<string, ProjectionsBlock>;
      };
    }
  | { type: "queue"; sessionId: string; items: QueuedInboxItem[] }
  | { type: "jobs"; sessionId: string; jobs: unknown[] }
  | { type: "projection"; sessionId: string; key: string; value: unknown; seq: number };

/* ---- 模型目录与选择（TASK-030 项 1；契约来源：dsh-api-session-controller 描述符 + 真机实测） ----
 *
 * 真机实测（tmp/probe-task030.notes.md）：
 * - `session/modelCatalog` 描述符**没有参数** → args 必须是 `{}`（传 `{request:{}}` 被
 *   `gateway/arguments-invalid` 拒绝）；
 * - `session/selectModel` 有参数 `request` → args 为 `{request:{sessionId,provider,model,reasoningEffort?}}`；
 * - 投影 `modelSelection` 的值不是裸 ModelSelection，而是 `{lastUsed, next}`。
 */

/** 一次完整的模型选择（投影与 selectModel 共用）。 */
export interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 一个适配器为该精确模型路由声明的推理档位。 */
export interface ModelReasoningEffort {
  id: string;
  name: string;
  description?: string;
}

/** 精确模型路由的可选推理元数据（`efforts` 恒为数组，可能为空）。 */
export interface ModelReasoning {
  efforts: ModelReasoningEffort[];
  defaultEffort?: string;
}

/** 提供方分组内的一款模型。 */
export interface ModelCatalogModel {
  id: string;
  name: string;
  description?: string;
  reasoning?: ModelReasoning;
}

/** 一个提供方及其成功加载的模型清单。 */
export interface ModelProviderGroup {
  id: string;
  name: string;
  models: ModelCatalogModel[];
}

/** 模型目录加载失败的提供方（UI 目前不展示，仅用于诊断）。 */
export interface ModelCatalogFailure {
  id: string;
  name: string;
  message: string;
}

/** `session/modelCatalog` 的返回值。 */
export interface ModelCatalog {
  /** 未配置会话使用的默认选择。 */
  default: ModelSelection;
  /** 当前可服务的提供方路由。 */
  routableProviders: string[];
  groups: ModelProviderGroup[];
  failures: ModelCatalogFailure[];
}

/**
 * `modelSelection` 投影（官方 `ModelSelectionProjection`）：
 * - `lastUsed`：最近一次真实模型请求消费掉的选择；
 * - `next`：下一次请求将使用的选择（未被消费的更新选择），官方 UI 取 `next ?? catalog.default`。
 */
export interface ModelSelectionProjection {
  lastUsed: ModelSelection | null;
  next: ModelSelection | null;
}

export interface SessionSelectModelRequest extends ModelSelection {
  sessionId: string;
}

/** `session/selectModel` 的返回值：host 归一化后的实际选择。 */
export interface SessionSelectModelValue {
  selected: ModelSelection;
}

/* ---- 附件（图片）---- */

/** `imageLimits` 投影：部署侧图片准入上限。 */
export interface ImageAttachmentLimits {
  maxImageBytes: number;
  maxImagesPerMessage: number;
  maxMessageImageBytes: number;
  maxImagePixels: number;
  maxImageDimension: number;
  mediaTypes: ImageMediaType[];
}

/** `session/attachment` 请求：读取本会话已引用的图片（args 为 `{request:{...}}`）。 */
export interface SessionAttachmentRequest {
  sessionId: string;
  attachmentId: string;
}

/** `session/attachment` 返回值：durable 引用 + base64 数据。 */
export interface SessionAttachmentValue {
  attachment: unknown;
  data: string;
}

/* ---- 命令（TASK-030 项 2）----
 *
 * 契约来源：`@deepseek-ai/dsh-commands` 的 typert 描述符（0.1.5-rc.1）+ 真机实测。
 * **参数是平铺的**（与 `session/*` 的 `{request:{...}}` 包裹方式不同）：
 *   commands/list    args = { agentId }
 *   commands/execute args = { agentId, line, submittedAttachments }（三者皆必填）
 * 反例实测：包裹成 `{request:{...}}` 或漏字段一律 `gateway/arguments-invalid`。
 */

/** 命令的输入声明（`hint` 为占位提示；`attachments` 为 true 表示接受附件）。 */
export interface CommandInputHint {
  hint: string;
  attachments?: boolean;
}

/** `commands/list` 的单项。 */
export interface CommandDescriptor {
  name: string;
  description: string;
  input?: CommandInputHint;
}

/** 提交给命令的附件（形状与 `PromptContentPart` 的 image/file 分支一致）。 */
export type CommandSubmitAttachment =
  | { type: "image"; mediaType: ImageMediaType; data: string; name?: string }
  | { type: "file"; receiptId: string };

/** 命令处理结果（`commands/execute` 返回值的 result 字段）。 */
export type CommandResult =
  | { kind: "success"; text?: string; sourceEventSeq?: number }
  | { kind: "error"; text: string };

/**
 * `commands/execute` 的返回值；**未命中命令时为 undefined**（词法不成立或名字未注册），
 * 此时 host 不写任何 session 日志——调用方据此回退为普通 prompt。
 */
export interface CommandExecution {
  commandId: string;
  result: CommandResult;
}

/* ---- Goal（TASK-030 项 4）----
 *
 * 契约来源：`@deepseek-ai/dsh-goal` 的 typert 描述符（0.1.5-rc.1）+ 真机实测。
 * 所有 `goals/*` 端点参数**平铺**，首个参数恒为 `agentId`。
 */

export type GoalPhase = "active" | "paused" | "blocked" | "complete";

/** blocked 阶段的机器可读 + 人可读说明。 */
export interface GoalBlockReason {
  code: string;
  message: string;
}

/** 一次目标修订的 CAS 身份（幂等/乐观并发的比较基准）。 */
export interface GoalRef {
  id: string;
  revision: number;
}

/** 持久化的目标快照。 */
export interface GoalSnapshot extends GoalRef {
  objective: string;
  phase: GoalPhase;
  blockedReason?: GoalBlockReason;
  maxGoalRounds: number;
}

/**
 * `goal` 投影值：当前目标 + 轮次计数；`null` 表示尚未创建或已 clear。
 * 进程内的 `activation` 字段**不在投影里**（官方刻意排除），仅 `goals/get` 返回。
 */
export interface GoalProjection {
  goal: GoalSnapshot;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
}

/** `goals/get` 的返回值：在投影之上多一个进程内激活态。 */
export interface GoalView extends GoalProjection {
  activation: "armed" | "disarmed";
}

export interface CreateGoalRequest {
  objective: string;
  maxGoalRounds?: number;
}

export interface CreateGoalResult {
  ref: GoalRef;
}

/** 至少提供一个字段；未提供的字段保持不变。 */
export interface EditGoalRequest {
  objective?: string;
  maxGoalRounds?: number;
}
