import type { ViewNode } from "../core/eventFold";
import { truncate } from "./prompts";

/** 消息节点缓存键：包含 sessionId 防止跨会话 id 冲突。 */
export function nodeCacheKey(sessionId: string, node: ViewNode): string {
  return `${sessionId}:${node.id}`;
}

/** 计算消息节点内容签名：签名不变时可直接复用 DOM，避免流式 chunk 全量重渲染。 */
export function nodeSignature(node: ViewNode): string {
  switch (node.kind) {
    case "user":
      return `user|${node.text}|${node.sourceKind}`;
    case "error":
      return `error|${node.text}`;
    case "command":
      return `command|${node.name}|${node.status}|${node.text ?? ""}`;
    case "assistant": {
      const cards = node.toolCards
        .map((c) => `${c.id}:${c.name}:${c.status}:${truncate(c.resultText ?? c.args ?? "", 4000)}`)
        .join("|");
      return `assistant|${node.text}|${node.streaming}|${cards}`;
    }
  }
}
