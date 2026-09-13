import type { AssistantStreamFrame, ContentBlock, GoalProjection, ImageAttachmentLimits, ModelSelectionProjection, SessionEvent, StreamChunk } from "../transport/types";
import { isObject, numberField, readField } from "./narrow";

/**
 * tokenUsage 投影（0.1.5 真机实测逐字样本）：
 * `{"uncachedInputTokens":503737,"outputTokens":54421,"cacheReadTokens":10560640,"cacheWriteTokens":0}`
 * ——扁平 totals（view 即全量累计），四键皆可能缺省（服务端按可用性省略）。
 */
export interface TokenUsage {
  uncachedInputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/**
 * contextPressure 投影（0.1.5 真机实测逐字样本）：
 * `{"pressureTokens":179009,"projectedTokens":179238,"contextWindow":1000000}`。
 * 三键皆可选，且**真机观察到 `{}`**（冷会话/无样本时会话）——空对象必须视作"无数据"。
 */
export interface ContextPressure {
  /** 下一个请求的提示词预估（官方：pressureTokens + 自采样以来的 surface 变化）。 */
  projectedTokens?: number;
  /** 最近一次提供方上报的提示词规模（仅提示词侧）。 */
  pressureTokens?: number;
  /** 模型上下文窗口（来自最新一条 request/context 记录）。 */
  contextWindow?: number;
}

/** 待办项（dsh-tool-todo 线上形状；整表替换、last-wins，条目无稳定 id）。 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

/** 收窄 tokenUsage 投影为视图值；非对象或无任何可用数字 → undefined（不覆盖既有视图值）。 */
export function narrowTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  const out: TokenUsage = {};
  const uncached = numberField(value, "uncachedInputTokens");
  const output = numberField(value, "outputTokens");
  const read = numberField(value, "cacheReadTokens");
  const write = numberField(value, "cacheWriteTokens");
  if (uncached !== undefined) out.uncachedInputTokens = uncached;
  if (output !== undefined) out.outputTokens = output;
  if (read !== undefined) out.cacheReadTokens = read;
  if (write !== undefined) out.cacheWriteTokens = write;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 收窄 contextPressure 投影；`{}` 与畸形值都 → undefined（真机确实下发空对象）。 */
export function narrowContextPressure(value: unknown): ContextPressure | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const out: ContextPressure = {};
  const projected = numberField(value, "projectedTokens");
  const pressure = numberField(value, "pressureTokens");
  const window = numberField(value, "contextWindow");
  if (projected !== undefined) out.projectedTokens = projected;
  if (pressure !== undefined) out.pressureTokens = pressure;
  // 服务端 schema 为 int().positive()：0/负数属畸形，按缺省处理（否则 UI 会渲染 "x / 0"）
  if (window !== undefined && window > 0) out.contextWindow = window;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 单条待办是否合法（content 非空字符串 + status 属三态之一）。 */
function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null) return false;
  const content = readField(value, "content");
  const status = readField(value, "status");
  return typeof content === "string" && content.length > 0 && (status === "pending" || status === "in_progress" || status === "completed");
}

/**
 * 收窄 todos 投影/事件负载：
 * - `null` → `null`（官方语义：该清单已被清空，UI 不渲染）
 * - 数组 → 仅保留合法项；过滤后为空 → `null`
 * - 其它畸形值 → `undefined`（**保持既有视图值**，不用垃圾覆盖好数据）
 */
export function narrowTodos(value: unknown): TodoItem[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(isTodoItem);
  return items.length > 0 ? items : null;
}

export interface ToolCard {
  id: string;
  name: string;
  args: string;
  status: "running" | "done" | "error";
  resultText?: string;
}

export interface UserNode {
  kind: "user";
  id: string;
  text: string;
  sourceKind: string;
  /**
   * 该用户消息附带的图片块数量（TASK-030）：>0 时气泡上渲染一个计数标记。
   * 历史里的图片本体不内联在事件里（只有 durable attachment 引用），v1 不回落 DOM 展示。
   */
  imageCount: number;
  seq: number;
  /** 渲染签名版本号：可见内容每次就地变更时自增（nodeSignature 只读 kind|rev）。 */
  rev: number;
}

export interface AssistantNode {
  kind: "assistant";
  id: string;
  text: string;
  reasoning: string;
  toolCards: ToolCard[];
  /** 是否还在流式输出（未收到 assistant/message 或 turn/end）。 */
  streaming: boolean;
  seq: number;
  /** 渲染签名版本号：见 UserNode.rev。 */
  rev: number;
  /**
   * 上一次因 reasoning 变化而 bump 的时间戳（节流用；缺省=尚未 bump 过）。
   *
   * 不参与 `nodeSignature`（只读 kind|rev），仅用于判断本次 reasoning 增量是否够格触发重绘。
   */
  reasoningBumpedAt?: number;
}

export interface CommandNode {
  kind: "command";
  id: string;
  name: string;
  text?: string;
  status: "running" | "success" | "error";
  seq: number;
  /** 渲染签名版本号：见 UserNode.rev。 */
  rev: number;
}

export interface ErrorNode {
  kind: "error";
  id: string;
  text: string;
  seq: number;
  /** 渲染签名版本号：见 UserNode.rev。 */
  rev: number;
}

export type ViewNode = UserNode | AssistantNode | CommandNode | ErrorNode;

export interface SessionView {
  sessionId: string;
  nodes: ViewNode[];
  title: string | null;
  plan: { active: boolean; pending: boolean };
  queueItems: unknown[];
  /**
   * tokenUsage 投影（TASK-029）：缺省=从未收到该投影（冷会话），UI 据此完全不渲染。
   * 畸形投影不写入，故"有值"即"可信"。
   */
  usage?: TokenUsage;
  /** contextPressure 投影（TASK-029）：缺省=从未收到/无数据；`{}` 不写入。 */
  contextPressure?: ContextPressure;
  /**
   * 待办清单（TASK-029）：`todo/write` 事件或 `todos` 投影的快照，两条路径共用同一字段
   * （last-wins）。`null`=已清空（官方语义：新回合 turn/start 清零），缺省=从未收到。
   */
  todos?: TodoItem[] | null;
  /** `modelSelection` 投影（TASK-030）：缺省=从未收到；窄化后的 `{lastUsed, next}`。 */
  modelSelection?: ModelSelectionProjection;
  /** `imageLimits` 投影（TASK-030）：缺省=从未收到（发图前退回保守默认上限）。 */
  imageLimits?: ImageAttachmentLimits;
  /** `goal` 投影（TASK-030）：`null`=无目标/已清除，缺省=从未收到。 */
  goal?: GoalProjection | null;
  lastSeq: number;
  /** 已折叠事件的最小 seq（-1 表示尚无事件）；翻页边界以此为准，避免与历史页重叠。 */
  firstSeq: number;
  /** 最近一次 turn/start 的 seq（-1 表示尚未开始过回合）；内联编辑按它判定"本轮回合"。 */
  lastTurnStartSeq: number;
  /** 最近一次 turn/end 的 seq（-1 表示尚未结束过回合）。 */
  lastTurnEndSeq: number;
  running: boolean;
}

export function createSessionView(sessionId: string): SessionView {
  return { sessionId, nodes: [], title: null, plan: { active: false, pending: false }, queueItems: [], lastSeq: -1, firstSeq: -1, lastTurnStartSeq: -1, lastTurnEndSeq: -1, running: false };
}

/** 从内容块提取可见文本（text 块以空行连接）。 */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => typeof b === "object" && b !== null && b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

function lastAssistant(view: SessionView): AssistantNode | undefined {
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const n = view.nodes[i];
    if (n.kind === "assistant") return n;
  }
  return undefined;
}

/**
 * 标记节点可见内容已变更。
 *
 * `nodeSignature` 只读 `kind|rev`，因此**任何影响 DOM 渲染**的就地修改都必须 bump，
 * 否则该次变更不会重绘；反之不影响渲染的修改不 bump（否则缓存白白失效）。
 */
/**
 * reasoning 增量触发重绘的最小时间间隔（ms）。
 *
 * 真机实测（0.1.5，22s 窗口，`tmp/probe-assistant-stream-fixed.notes.md`）：268 个增量帧里
 * 绝大多数是 reasoning-delta（约 11 帧/秒）。两种极端都不行：
 * - 每个 delta 都 bump → 节点缓存逐帧失效、每帧重建 DOM，正是 TASK-013 修掉的卡顿；
 * - 完全不 bump → 推理内容永不刷新（TASK-027 留下的旧约束，在本任务失效）。
 *
 * 故按时间窗节流：窗内累计的 reasoning 只触发一次重绘，窗外首个增量立即重绘。
 * 取值依据：≥ chatView 的 150ms 渲染闸门（更密的 bump 会被闸门直接丢弃，纯属浪费），
 * 又远低于用户可感知的延迟（思考文本以 ≤4 次/秒 的节奏增长已足够"跟随"）。
 */
export const REASONING_BUMP_INTERVAL_MS = 250;

function bump(node: ViewNode): void {
  node.rev += 1;
}

function findCard(view: SessionView, callId: string): { node: AssistantNode; card: ToolCard } | undefined {
  for (const n of view.nodes) {
    if (n.kind === "assistant") {
      const card = n.toolCards.find((c) => c.id === callId);
      if (card) return { node: n, card };
    }
  }
  return undefined;
}

function applyChunk(node: AssistantNode, chunk: StreamChunk): void {
  switch (chunk.type) {
    case "text-delta":
      if (chunk.text.length > 0) {
        node.text += chunk.text;
        bump(node);
      }
      break;
    case "reasoning-delta":
      // reasoning 参与 DOM 渲染（chatView 的「思考过程」折叠块），所以变化必须能到达 DOM；
      // 但不能逐帧 bump——真机 22s/268 帧里绝大多数是 reasoning-delta，逐帧 bump 会退化成
      // 每帧重建节点 DOM（TASK-013 的卡顿来源）。按 REASONING_BUMP_INTERVAL_MS 节流：
      // 文本始终完整累积，只是重绘频率受限；流式收尾时另有 streaming=false 的正式 bump 兜底，
      // 保证定格渲染拿到完整文本。
      node.reasoning += chunk.text;
      {
        const now = Date.now();
        if (node.reasoningBumpedAt === undefined || now - node.reasoningBumpedAt >= REASONING_BUMP_INTERVAL_MS) {
          node.reasoningBumpedAt = now;
          bump(node);
        }
      }
      break;
    case "tool-call-delta": {
      // 只允许精确 id 匹配；block-end 会携带完整 arguments，未命中的增量直接忽略
      const card = node.toolCards.find((c) => c.id === chunk.id);
      if (card && card.status === "running" && chunk.argumentsDelta.length > 0) {
        card.args += chunk.argumentsDelta;
        bump(node);
      }
      break;
    }
    case "block-end": {
      if (chunk.block.type === "tool-call") {
        node.toolCards.push({ id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments, status: "running" });
        bump(node);
      }
      break;
    }
    default:
      break;
  }
}

/**
 * 折叠 0.1.5 的 `assistant-stream` 瞬态帧（进程内增量，不入 session log）。
 *
 * - `start`：为本 attempt 建一个流式 assistant 节点（若当前节点已在流式中则复用），UI 立即出现流式气泡。
 * - `chunk`：追加增量，复用与 0.1.2 durable `assistant/chunk` 完全相同的 applyChunk。
 * - `end`：本 attempt 收尾，标记节点停止流式（触发一次 Markdown 渲染）；
 *   随后到达的 durable `assistant/message` 沿用既有语义（text 非空则不覆盖）。
 *
 * 与 0.1.2 的差别：0.1.2 的增量本身就是 durable 事件（`assistant/chunk`，带 seq），
 * 0.1.5 改由该瞬态通道下发，故两条路径共用同一节点与同一 applyChunk。
 */
export function foldAssistantStreamFrame(view: SessionView, frame: AssistantStreamFrame): void {
  if (frame.type === "start") {
    const existing = lastAssistant(view);
    if (!existing?.streaming) {
      view.nodes.push({
        kind: "assistant",
        id: `as-${frame.attemptId}`,
        text: "",
        reasoning: "",
        toolCards: [],
        streaming: true,
        seq: view.lastSeq,
        rev: 0,
      });
    }
    return;
  }
  if (frame.type === "chunk") {
    const existing = lastAssistant(view);
    if (existing?.streaming) {
      applyChunk(existing, frame.chunk);
      return;
    }
    const node: AssistantNode = {
      kind: "assistant",
      id: `as-${frame.attemptId}`,
      text: "",
      reasoning: "",
      toolCards: [],
      streaming: true,
      seq: view.lastSeq,
      rev: 0,
    };
    view.nodes.push(node);
    applyChunk(node, frame.chunk);
    return;
  }
  // end：本 attempt 收尾。
  // 若 outcome 声明由 durable `assistant/message` 结算，则**不能**在这里置 streaming=false——
  // 否则随后的 assistant/message 会走「非流式 → 新建节点」分支，产生一条重复消息
  //（即 TASK-013 修过的「每个 chunk 残留一条」同类缺陷）。交给 foldEvent 的既有分支收尾。
  // `assistant/attempt`（中断/重试，不再有 assistant/message）与 abandoned 则在此直接收尾。
  const settledByMessage = frame.outcome.kind === "committed" && frame.outcome.eventType === "assistant/message";
  if (settledByMessage) return;
  const node = lastAssistant(view);
  if (node?.streaming) {
    node.streaming = false;
    bump(node);
  }
}

/**
 * 压缩替换（`surfaceOp = { op: "replace", startSeq, endSeq }`）的实现。
 *
 * 语义（官方 `@deepseek-ai/dsh-session` types 核实）：该事件**替换**当前 surface 上
 * `startSeq`（含）到 `endSeq`（含）之间的节点；`startSeq === endSeq` 即替换单个节点。
 * 折叠时先按节点自身的 `seq` 把这些旧节点从视图移除，再按既有分支应用本事件——
 * 于是 compaction 替换旧内容后旧节点不再堆积，长会话的节点数/渲染成本拿到上界。
 *
 * 区间按原样使用，**不做 min/max 交换**：startSeq > endSeq 属异常载荷，
 * 此时不匹配任何节点（宁可不删，也不能删错）。
 */
function dropReplacedNodes(view: SessionView, startSeq: number, endSeq: number): void {
  // 倒序就地 splice：保持 view.nodes 的数组引用不变（store/UI 可能持有该引用）
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const seq = view.nodes[i].seq;
    if (seq >= startSeq && seq <= endSeq) view.nodes.splice(i, 1);
  }
}

/** 把一个 SessionEvent 折叠进视图模型（纯函数，原地更新 view）。 */
export function foldEvent(view: SessionView, event: SessionEvent): void {
  if (event.seq > view.lastSeq) view.lastSeq = event.seq;
  if (view.firstSeq === -1 || event.seq < view.firstSeq) view.firstSeq = event.seq;
  const data = event.data;

  // 压缩替换：先移除被替换区间的可见节点，再应用本事件（本事件自身若落在区间内，随后会被加回来，
  // 顺序不能颠倒）。
  const surfaceOp = event.surfaceOp;
  const isSurfaceReplace = typeof surfaceOp === "object" && surfaceOp !== null && surfaceOp.op === "replace";
  if (isSurfaceReplace) {
    dropReplacedNodes(view, surfaceOp.startSeq, surfaceOp.endSeq);
  }

  switch (event.type) {
    case "turn/start":
      view.lastTurnStartSeq = event.seq;
      view.running = true;
      // 官方 todos 投影 fold：整表在下一个回合开始时清零（turn/end 保留已完成的清单可见）。
      // 事件路径与投影路径共用 view.todos，故这里同步清零，二者语义一致。
      view.todos = null;
      break;
    case "turn/end": {
      view.running = false;
      view.lastTurnEndSeq = event.seq;
      const reason = data.reason as { kind?: string; error?: { message?: string; code?: string } };
      if (reason?.kind === "error") {
        // 只存服务端错误正文；本地化前缀由 UI 层渲染（见 chatView）。
        view.nodes.push({ kind: "error", id: `err-${event.seq}`, text: reason.error?.message ?? "未知错误", seq: event.seq, rev: 0 });
      }
      const node = lastAssistant(view);
      if (node) {
        if (node.streaming) {
          node.streaming = false;
          bump(node);
        }
        // 流式收尾兜底：turn 结束仍无 text 块但 thinking 有内容（推理模型答案在 think 里）
        if (node.text.length === 0 && node.reasoning.length > 0 && node.toolCards.length === 0) {
          node.text = node.reasoning;
          bump(node);
        }
      }
      break;
    }
    case "user/message": {
      const sourceKind = ((data.source as { kind?: string }) ?? {}).kind ?? "user";
      if (sourceKind === "tool") break; // 工具结果走 tool/result 事件
      const content = (data.content as ContentBlock[]) ?? [];
      const text = blocksToText(content);
      // 图片块个数（TASK-030 项 3）：发图时 host 把内联 base64 提升为 durable 引用，
      // 历史事件里只剩引用本体——v1 只标记数量，不异步拉取图片回到 DOM。
      const imageCount = content.filter((b) => typeof b === "object" && b !== null && b.type === "image").length;
      view.nodes.push({ kind: "user", id: String(data.id ?? `u-${event.seq}`), text, sourceKind, imageCount, seq: event.seq, rev: 0 });
      break;
    }
    case "assistant/chunk": {
      // 压缩替换落地时不得写进**仍在流式**的节点：那个节点属于正在进行的 attempt，
      // 不是被替换的历史表面节点。此时另建一个节点，避免流式文本被污染。
      const existing = lastAssistant(view);
      const node = existing?.streaming && !isSurfaceReplace ? existing : undefined;
      const target: AssistantNode = node ?? {
        kind: "assistant",
        id: `a-${event.seq}`,
        text: "",
        reasoning: "",
        toolCards: [],
        streaming: true,
        seq: event.seq,
        rev: 0,
      };
      if (!node) view.nodes.push(target);
      applyChunk(target, data.chunk as StreamChunk);
      break;
    }
    case "assistant/message": {
      const message = data.message as { id?: string; content?: ContentBlock[] };
      const content = message?.content ?? [];
      const text = blocksToText(content);
      const toolCalls = content.filter((b): b is Extract<ContentBlock, { type: "tool-call" }> => typeof b === "object" && b !== null && b.type === "tool-call");
      const existing = lastAssistant(view);
      // 同上：替换事件带完整 content，必须落成自己的节点，不能并进仍在流式的节点
      const target: AssistantNode = existing?.streaming && !isSurfaceReplace
        ? existing
        : {
            kind: "assistant",
            id: String(message?.id ?? `a-${event.seq}`),
            text: "",
            reasoning: "",
            toolCards: [],
            streaming: false,
            seq: event.seq,
            rev: 0,
          };
      // 注意用 target === existing 判定（而不是 `existing?.streaming`）：替换事件即使此刻确实复用了
      // 流式节点，也不能走「跳过新建」的路径。
      if (target !== existing) view.nodes.push(target);
      if (target.streaming) {
        target.streaming = false;
        bump(target);
      }
      if (target.text.length === 0 && text.length > 0) {
        target.text = text;
        bump(target);
      }
      if (target.reasoning.length === 0) {
        // durable message 携带流式通道没送到的 reasoning：节点此刻已结算（streaming 已置 false），
        // 一次 bump 就够，不必也不能再走节流路径（否则定格渲染会漏掉这段推理）。
        target.reasoning = content
          .filter((b): b is Extract<ContentBlock, { type: "reasoning" }> => typeof b === "object" && b !== null && b.type === "reasoning")
          .map((b) => b.text)
          .join("\n\n");
        if (target.reasoning.length > 0) bump(target);
      }
      for (const call of toolCalls) {
        if (!target.toolCards.some((c) => c.id === call.id)) {
          target.toolCards.push({ id: call.id, name: call.name, args: call.arguments, status: "running" });
          bump(target);
        }
      }
      // 推理模型可能把最终答案整体写在 thinking 里（content 只有 reasoning 块、无 text 块）。
      // 与 harness UI 语义一致：此时 thinking 就是可见回复——否则聊天/内联编辑会得到空文本。
      if (target.text.length === 0 && target.reasoning.length > 0 && target.toolCards.length === 0) {
        target.text = target.reasoning;
        bump(target);
      }
      break;
    }
    case "tool/call": {
      const callId = typeof data.callId === "string" ? data.callId : "";
      const name = typeof data.name === "string" ? data.name : "";
      const args = typeof data.arguments === "string" ? data.arguments : "";
      if (!callId) break;
      let target = lastAssistant(view);
      if (!target) {
        target = { kind: "assistant", id: `a-${event.seq}`, text: "", reasoning: "", toolCards: [], streaming: false, seq: event.seq, rev: 0 };
        view.nodes.push(target);
      }
      if (!target.toolCards.some((c) => c.id === callId)) {
        target.toolCards.push({ id: callId, name, args, status: "running" });
        bump(target);
      }
      break;
    }
    case "tool/result": {
      const message = data.message as { content?: ContentBlock[]; source?: { callId?: string } };
      const callId = message?.source?.callId;
      if (!callId) break;
      const found = findCard(view, callId);
      if (found) {
        const toolResult = (message?.content ?? []).find(
          (b): b is Extract<ContentBlock, { type: "tool-result" }> => typeof b === "object" && b !== null && b.type === "tool-result",
        );
        const hasError = (data.error ?? undefined) !== undefined || toolResult?.isError === true;
        const status: ToolCard["status"] = hasError ? "error" : "done";
        const resultText = blocksToText(toolResult?.content ?? []);
        if (found.card.status !== status || found.card.resultText !== resultText) {
          found.card.status = status;
          found.card.resultText = resultText;
          bump(found.node);
        }
      }
      break;
    }
    case "command/run":
      view.nodes.push({
        kind: "command",
        id: String(data.commandId ?? `cmd-${event.seq}`),
        name: String(data.name ?? ""),
        status: "running",
        seq: event.seq,
        rev: 0,
      });
      break;
    case "command/done": {
      const id = String(data.commandId ?? "");
      const status: CommandNode["status"] = data.kind === "success" ? "success" : "error";
      const text = typeof data.text === "string" ? data.text : undefined;
      for (const n of view.nodes) {
        if (n.kind === "command" && n.id === id) {
          if (n.status !== status || n.text !== text) {
            n.status = status;
            n.text = text;
            bump(n);
          }
        }
      }
      break;
    }
    case "session/title":
      if (typeof data.title === "string" && data.title.length > 0) view.title = data.title;
      break;
    case "todo/write": {
      // 整表快照、last-wins（dsh-tool-todo 语义）：不追加历史，只保留最新一份。
      // 与 `todos` 投影路径共用 view.todos——真机上两条路径可能只来其一
      //（新版推投影帧，旧版/裁掉 token-meter 的 profile 只有事件）。
      const todos = narrowTodos(data.todos);
      if (todos !== undefined) view.todos = todos; // undefined=畸形负载：保持既有值，不用垃圾覆盖
      break;
    }
    case "plan/mode":
      view.plan.active = data.active === true;
      view.plan.pending = false;
      break;
    // v1 已知取舍：压缩摘要（`compaction/summary`）的事件体渲染暂不处理：
    // replace 的**区间移除**已在 foldEvent 入口落实（见 dropReplacedNodes），
    // 摘要本身由替换事件（source.kind=plugin 的 user/message）呈现，不另建节点。
    default:
      break; // 未知事件类型（含可忽略扩展）直接跳过
  }
}
