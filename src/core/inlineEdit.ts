import { SessionManager } from "./sessionManager";
import { SessionStore } from "./store";
import { DshSettings } from "../settings";
import type { SessionView } from "./eventFold";
import { setTimer } from "../utils/timers";

export interface InlineEditDeps {
  manager: SessionManager;
  store: SessionStore;
  settings: DshSettings;
}

export type TurnState = { kind: "pending" } | { kind: "error"; message: string } | { kind: "ready"; view: SessionView };

/**
 * 依据 sinceSeq 判断一次内联编辑回合的状态：
 * - 本回合（turn/start.seq > sinceSeq）尚未开始 → pending（期间到达的旧回合收尾事件
 *   不能当作本轮结果——上次编辑超时但服务端回合仍在跑时，旧回合的流式内容会先于本回合到达）
 * - 本回合已开始后出现 seq > turnStart 的错误节点 → error（绝不能把旧结果当成新结果）
 * - 本回合已开始且已终结、有文本的 assistant 节点 → ready
 * - 否则 pending
 */
export function classifyTurnState(view: SessionView | undefined, sinceSeq: number): TurnState {
  if (!view || view.lastSeq <= sinceSeq) return { kind: "pending" };
  if (view.lastTurnStartSeq <= sinceSeq) return { kind: "pending" }; // 本回合尚未开始
  const floor = view.lastTurnStartSeq; // 只扫描本回合产生的新节点（旧回合残留 seq 可能 > sinceSeq）
  if (view.running) return { kind: "pending" };
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const n = view.nodes[i];
    if (n.seq <= floor) break;
    if (n.kind === "error") return { kind: "error", message: n.text };
    if (n.kind === "assistant" && !n.streaming && n.text.length > 0) return { kind: "ready", view };
  }
  if (view.lastTurnEndSeq > floor) {
    return { kind: "error", message: "回合已结束，但未产生可用的替换文本" };
  }
  return { kind: "pending" };
}

/** 提取 seq > sinceSeq 的最后一个已终结 assistant 节点的文本，并剥掉可能包裹的 markdown 围栏。 */
export function extractLastAssistantText(view: SessionView, sinceSeq: number): string {
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const n = view.nodes[i];
    if (n.seq <= sinceSeq) break;
    if (n.kind === "assistant" && !n.streaming && n.text.length > 0) {
      let text = n.text.trim();
      const fence = text.match(/^```[^\n]*\r?\n([\s\S]*?)\r?\n```$/);
      if (fence) text = fence[1];
      return text;
    }
  }
  throw new Error("DSH 没有产生可用的替换文本");
}

/** 内联编辑服务：专用会话 + 只输出替换文本的指令模板 + 等待回合结束。 */
export class InlineEditService {
  constructor(private deps: InlineEditDeps) {}

  private busy = false;

  async edit(selection: string, notePath: string, instruction: string): Promise<string> {
    if (this.busy) throw new Error("已有内联编辑正在进行，请稍候");
    this.busy = true;
    try {
      const sessionId = await this.ensureSession();
      const view = this.deps.store.ensureView(sessionId);
      const sinceSeq = view.lastSeq;
      const prompt = renderInlineEditPrompt(notePath, selection, instruction);
      const res = await this.deps.manager.prompt(sessionId, prompt, "queue");
      if (!res.ok) throw new Error(res.error.message);
      const done = await this.waitForTurnEnd(sessionId, sinceSeq, this.deps.settings.values.inlineEditTimeoutSec * 1000);
      return extractLastAssistantText(done, sinceSeq);
    } finally {
      this.busy = false;
    }
  }

  private async ensureSession(): Promise<string> {
    const stored = this.deps.settings.values.inlineEditSessionId;
    if (stored && (await this.deps.manager.exists(stored))) return stored;
    const id = await this.deps.manager.newSession();
    this.deps.settings.values.inlineEditSessionId = id;
    await this.deps.settings.save().catch(() => undefined); // 保存失败不阻塞（下次重建即可）
    return id;
  }

  /** 轮询 store，直到该会话的新回合出现确定性结果；错误立即抛出，超时抛错。 */
  private async waitForTurnEnd(sessionId: string, sinceSeq: number, timeoutMs: number): Promise<SessionView> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const view = this.deps.store.getView(sessionId);
      const state = classifyTurnState(view, sinceSeq);
      if (state.kind === "ready") return state.view;
      if (state.kind === "error") throw new Error(state.message);
      await sleep(500);
    }
    throw new Error(`内联编辑超时（${Math.round(timeoutMs / 1000)}s），已放弃`);
  }
}

export function renderInlineEditPrompt(notePath: string, selection: string, instruction: string): string {
  return [
    "你是 Obsidian 内联编辑助手。只输出替换后的文本：不要调用任何工具，不要解释，不要输出 markdown 代码块，不要省略原文的任何部分。",
    `文件：${notePath}`,
    "以下引号内是原始文本，请完整输出修改后的版本：",
    `<<<${selection}>>>`,
    `指令：${instruction}`,
  ].join("\n");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimer(resolve, ms));
}
