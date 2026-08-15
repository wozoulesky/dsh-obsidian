/* DSH 线上契约类型（依据 @deepseek-ai/dsh 0.1.0-rc.6 源码确认）。 */

/* ---- RPC 信封 ---- */

// 注意：与 rc.6 严格 schema（closed code 联合 + 必填 details）相比，这里刻意放宽为透传形态。
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

export interface ServerRequest {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface ClientResponse {
  type: "client-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export type RpcReceipt = { accepted: true } | { accepted: false; reason: "not-pending" | "bad-response" };

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
  const cryptoObj = typeof window !== "undefined" ? window.crypto : globalThis.crypto;
  cryptoObj.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ---- 会话域 ---- */

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
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

export interface PromptPayload {
  sessionId: string;
  mode: "queue" | "steer";
  content: PromptContentPart[];
  clientTimeZone?: string;
}

export interface PromptResult {
  accepted: true;
  command?: { kind: "success"; text?: string };
}

export interface HistoryPayload {
  sessionId: string;
  beforeSeq?: number;
  maxMessages?: number;
}

export interface HistoryResult {
  events: HistoryEntry[];
  hasMore: boolean;
  projections?: ProjectionsBlock;
}

export interface HistoryEntry {
  event: SessionEvent;
  view?: unknown;
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

/* ---- mux 帧 ---- */

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
