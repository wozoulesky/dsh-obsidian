import type { ContentBlock, SessionEvent, StreamChunk } from "../transport/types";

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
  seq: number;
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
}

export interface CommandNode {
  kind: "command";
  id: string;
  name: string;
  text?: string;
  status: "running" | "success" | "error";
  seq: number;
}

export interface ErrorNode {
  kind: "error";
  id: string;
  text: string;
  seq: number;
}

export type ViewNode = UserNode | AssistantNode | CommandNode | ErrorNode;

export interface SessionView {
  sessionId: string;
  nodes: ViewNode[];
  title: string | null;
  plan: { active: boolean; pending: boolean };
  queueItems: unknown[];
  lastSeq: number;
  running: boolean;
}

export function createSessionView(sessionId: string): SessionView {
  return { sessionId, nodes: [], title: null, plan: { active: false, pending: false }, queueItems: [], lastSeq: -1, running: false };
}

/** 从内容块提取可见文本（text 块以空行连接）。 */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
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

function findCard(view: SessionView, callId: string): ToolCard | undefined {
  for (const n of view.nodes) {
    if (n.kind === "assistant") {
      const card = n.toolCards.find((c) => c.id === callId);
      if (card) return card;
    }
  }
  return undefined;
}

function applyChunk(node: AssistantNode, chunk: StreamChunk): void {
  switch (chunk.type) {
    case "text-delta":
      node.text += chunk.text;
      break;
    case "reasoning-delta":
      node.reasoning += chunk.text;
      break;
    case "tool-call-delta": {
      const card = node.toolCards.find((c) => c.id === chunk.id) ?? node.toolCards[node.toolCards.length - 1];
      if (card && card.status === "running") card.args += chunk.argumentsDelta;
      break;
    }
    case "block-end": {
      if (chunk.block.type === "tool-call") {
        node.toolCards.push({ id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments, status: "running" });
      }
      break;
    }
    default:
      break;
  }
}

/** 把一个 SessionEvent 折叠进视图模型（纯函数，原地更新 view）。 */
export function foldEvent(view: SessionView, event: SessionEvent): void {
  if (event.seq > view.lastSeq) view.lastSeq = event.seq;
  const data = event.data;

  switch (event.type) {
    case "turn/start":
      view.running = true;
      break;
    case "turn/end": {
      view.running = false;
      const reason = data.reason as { kind?: string; error?: { message?: string; code?: string } };
      if (reason?.kind === "error") {
        view.nodes.push({ kind: "error", id: `err-${event.seq}`, text: `回合错误：${reason.error?.message ?? "未知错误"}`, seq: event.seq });
      }
      const node = lastAssistant(view);
      if (node) node.streaming = false;
      break;
    }
    case "user/message": {
      const sourceKind = ((data.source as { kind?: string }) ?? {}).kind ?? "user";
      if (sourceKind === "tool") break; // 工具结果走 tool/result 事件
      const text = blocksToText((data.content as ContentBlock[]) ?? []);
      view.nodes.push({ kind: "user", id: String(data.id ?? `u-${event.seq}`), text, sourceKind, seq: event.seq });
      break;
    }
    case "assistant/chunk": {
      const node = lastAssistant(view)?.streaming ? lastAssistant(view) : undefined;
      const target: AssistantNode = node ?? {
        kind: "assistant",
        id: `a-${event.seq}`,
        text: "",
        reasoning: "",
        toolCards: [],
        streaming: true,
        seq: event.seq,
      };
      if (!node) view.nodes.push(target);
      applyChunk(target, data.chunk as StreamChunk);
      break;
    }
    case "assistant/message": {
      const message = data.message as { id?: string; content?: ContentBlock[] };
      const content = message?.content ?? [];
      const text = blocksToText(content);
      const toolCalls = content.filter((b): b is Extract<ContentBlock, { type: "tool-call" }> => b.type === "tool-call");
      const existing = lastAssistant(view);
      const target: AssistantNode = existing?.streaming
        ? existing
        : {
            kind: "assistant",
            id: String(message?.id ?? `a-${event.seq}`),
            text: "",
            reasoning: "",
            toolCards: [],
            streaming: false,
            seq: event.seq,
          };
      if (!existing?.streaming) view.nodes.push(target);
      target.streaming = false;
      if (target.text.length === 0) target.text = text;
      for (const call of toolCalls) {
        if (!target.toolCards.some((c) => c.id === call.id)) {
          target.toolCards.push({ id: call.id, name: call.name, args: call.arguments, status: "running" });
        }
      }
      break;
    }
    case "tool/result": {
      const message = data.message as { content?: ContentBlock[]; source?: { callId?: string } };
      const callId = message?.source?.callId;
      if (!callId) break;
      const card = findCard(view, callId);
      if (card) {
        card.status = ((data.error ?? undefined) !== undefined ? "error" : "done") as ToolCard["status"];
        const toolResult = (message?.content ?? []).find(
          (b): b is Extract<ContentBlock, { type: "tool-result" }> => b.type === "tool-result",
        );
        card.resultText = blocksToText(toolResult?.content ?? []);
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
      });
      break;
    case "command/done": {
      const id = String(data.commandId ?? "");
      for (const n of view.nodes) {
        if (n.kind === "command" && n.id === id) {
          n.status = data.kind === "success" ? "success" : "error";
          n.text = typeof data.text === "string" ? data.text : undefined;
        }
      }
      break;
    }
    case "session/title":
      if (typeof data.title === "string" && data.title.length > 0) view.title = data.title;
      break;
    case "plan/mode":
      view.plan.active = data.active === true;
      view.plan.pending = false;
      break;
    default:
      break; // 未知事件类型（含可忽略扩展）直接跳过
  }
}
