/* DSH 线上契约类型（依据 @deepseek-ai/dsh 0.1.2-rc.1 源码 + 真机实测确认，2026-09-03 批 2 对齐）。
 *
 * 关键契约事实：
 * - 一元 RPC：POST /api/<namespace>/<method>（斜杠端点）；信封 {type:"client-request", rpcId, method, payload:{args:{...}}}；
 *   响应 {type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error:{code,message,details?}}}。
 *   args 键集合与描述符精确一致，多余/缺失键被 gateway/arguments-invalid 拒绝。
 * - 事件流：WS /api/remote.mux（批 3 实现）；帧类型（RemoteStreamServerMessage/SessionFollowFrame/SessionControlFrame）
 *   本批定义好，批 3 直接消费。
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

export type PromptContentPart = { type: "text"; text: string };

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

/** waterfall 取消帧。 */
export interface RemoteEventCancellationFrame {
  type: "cancel";
  eventId: string;
}

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

/** 服务端逻辑流帧：item 携带一个流值（首帧/事件帧）；end 流结束；error 流错误。 */
export type RemoteStreamItem = { type: "item"; streamId: string; value?: unknown };
export type RemoteStreamEnd = { type: "end"; streamId: string };
export type RemoteStreamError = {
  type: "error";
  streamId: string;
  error: { code: string; message: string; details?: Record<string, unknown> };
};
export type RemoteStreamServerMessage = RemoteStreamItem | RemoteStreamEnd | RemoteStreamError;

/** session/follow 流：首帧 snapshot（header/cursor/records/hasMore/projections）+ 后续 {type:"event", event} 帧。 */
export type SessionFollowFrame =
  | {
      type: "snapshot";
      header: {
        version: number;
        id: string;
        createdAt: number;
        cwd?: string;
        parentSession?: string;
        seedLength?: number;
        origin?: "subagent";
        delegationDepth?: number;
        agentPreset?: string;
      };
      cursor: number;
      records: SessionHistoryRecord[];
      hasMore: boolean;
      projections: ProjectionsBlock;
    }
  | { type: "event"; event: SessionEvent };

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

/* ---- 旧契约兼容层（批 3/4 文件过渡编译用；批 3/4 接线时删除） ---- */

/**
 * @deprecated 旧 events.mux 服务端请求信封（0.1.2-rc.1 已改为 remote.mux 帧协议）。
 * 仅 muxStream.ts（批 3 重写对象）过渡编译使用；批 3 完成后删除。
 */
export interface ServerRequest {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

/**
 * @deprecated 旧 /api/respond 回执模型（0.1.2-rc.1 已改为 answerEvent → $events/result）。
 * 仅 approvalCenter.ts / chatView.ts（批 4 接线对象）过渡编译使用；批 4 完成后删除。
 */
export type RpcReceipt = { accepted: true } | { accepted: false; reason: "not-pending" | "bad-response" };

/**
 * @deprecated 旧 session.history 端点类型（0.1.2-rc.1 已删除该端点，改为 follow snapshot + page）。
 * 仅 sessionManager.ts / store.ts（批 4 接线对象）过渡编译使用；批 4 完成后删除。
 */
export interface HistoryPayload {
  sessionId: string;
  beforeSeq?: number;
  maxMessages?: number;
}

/** @deprecated 见 HistoryPayload。 */
export interface HistoryResult {
  events: HistoryEntry[];
  hasMore: boolean;
  projections?: ProjectionsBlock;
}

/** @deprecated 见 HistoryPayload；批 4 迁移到 SessionHistoryRecord（chunks 先解包）。 */
export interface HistoryEntry {
  event: SessionEvent;
  view?: unknown;
}

/* ---- mux 帧（旧契约形状；批 3 会重写 MuxFrame 联合类型，本批不动它） ---- */

export type MuxFrame =
  | { type: "session/event"; sessionId: string; event: SessionEvent; view?: unknown }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | { type: "session/queue"; sessionId: string; items: QueuedInboxItem[] }
  | { type: "session/jobs"; sessionId: string; jobs: unknown[] }
  | { type: "session/projection"; sessionId: string; key: string; value: unknown; seq: number }
  | { type: "approval/requested"; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: "approval/resolved"; sessionId: string; approvalId: string; outcome: "allowed-once" | "rejected" | "cancelled" | "unavailable" }
  | { type: "question/requested"; sessionId: string; questions: AskUserQuestionItem[] }
  | { type: "question/resolved"; sessionId: string; questionRpcId: string; outcome: "answered" | "cancelled" }
  | { type: "stream/error"; error: RpcError };
