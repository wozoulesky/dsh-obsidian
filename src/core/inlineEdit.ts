import { SessionManager } from "./sessionManager";
import { SessionStore } from "./store";
import { DshSettings } from "../settings";
import type { SessionView } from "./eventFold";

export interface InlineEditDeps {
  manager: SessionManager;
  store: SessionStore;
  settings: DshSettings;
}

/** 内联编辑服务：专用会话 + 只输出替换文本的指令模板 + 等待回合结束。 */
export class InlineEditService {
  constructor(private deps: InlineEditDeps) {}

  async edit(selection: string, notePath: string, instruction: string): Promise<string> {
    const sessionId = await this.ensureSession();
    const view = this.deps.store.ensureView(sessionId);
    const sinceSeq = view.lastSeq;
    const prompt = renderInlineEditPrompt(notePath, selection, instruction);
    const res = await this.deps.manager.prompt(sessionId, prompt, "queue");
    if (!res.ok) throw new Error(res.error.message);
    const done = await this.waitForTurnEnd(sessionId, sinceSeq, this.deps.settings.values.inlineEditTimeoutSec * 1000);
    return extractLastAssistantText(done);
  }

  private async ensureSession(): Promise<string> {
    const stored = this.deps.settings.values.inlineEditSessionId;
    if (stored && (await this.deps.manager.exists(stored))) return stored;
    const id = await this.deps.manager.newSession();
    this.deps.settings.values.inlineEditSessionId = id;
    await this.deps.settings.save();
    return id;
  }

  /** 轮询 store，直到该会话出现新回合结束且生成了终结的 assistant 文本；超时抛错。 */
  private async waitForTurnEnd(sessionId: string, sinceSeq: number, timeoutMs: number): Promise<SessionView> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const view = this.deps.store.getView(sessionId);
      const lastAssistant = view ? [...view.nodes].reverse().find((n) => n.kind === "assistant") : undefined;
      if (
        view &&
        !view.running &&
        view.lastSeq > sinceSeq &&
        lastAssistant &&
        lastAssistant.kind === "assistant" &&
        !lastAssistant.streaming &&
        lastAssistant.text.length > 0
      ) {
        return view;
      }
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

/** 提取最后一个已终结 assistant 节点的文本，并剥掉可能包裹的 markdown 围栏。 */
export function extractLastAssistantText(view: SessionView): string {
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const n = view.nodes[i];
    if (n.kind === "assistant" && !n.streaming && n.text.length > 0) {
      let text = n.text.trim();
      const fence = text.match(/^```[^\n]*\n([\s\S]*)\n```$/);
      if (fence) text = fence[1];
      return text;
    }
  }
  throw new Error("DSH 没有产生可用的替换文本");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
