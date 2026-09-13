import type { ViewNode } from "../core/eventFold";

/** 消息节点缓存键：包含 sessionId 防止跨会话 id 冲突。 */
export function nodeCacheKey(sessionId: string, node: ViewNode): string {
  return `${sessionId}:${node.id}`;
}

/**
 * 计算消息节点内容签名：签名不变时可直接复用 DOM，避免流式 chunk 全量重渲染。
 *
 * 只读 `kind|rev`——`rev` 由 eventFold 在**每次影响渲染的就地修改**时自增
 *（见 `bump()`），因此这里不再拼接正文/工具卡全文（旧实现每个节点每次渲染都要
 * 复制一遍文本，长会话下是 MB 级分配）。kind 前缀保留以便调试时辨认节点类型。
 */
export function nodeSignature(node: ViewNode): string {
  return `${node.kind}|${node.rev}`;
}

/** 节点 DOM 缓存条目。 */
export interface NodeCacheEntry {
  el: HTMLElement;
  /** 上一次渲染该节点时的签名（kind|rev）。 */
  sig: string;
  /**
   * 上一次渲染的节点对象本身。
   *
   * `kind|rev` 只对**同一节点对象**成立（rev 由该对象的折叠路径决定）。视图重建会让
   * 同一 id 换成新对象（`SessionStore.dropView` → 重连 resync / 重开会话），此时
   * 新旧对象的 rev 可能巧合相等而内容不同。用引用相等兜底，杜绝复用过期 DOM。
   */
  node: ViewNode;
}

/**
 * 能否复用缓存 DOM：必须是**同一个节点对象**且签名未变。
 * 对象被替换（视图重建）时一律重建，宁可有一次性重绘，也不显示过期内容。
 *
 * 注意：返回 false 只代表「不可复用」，不代表缓存缺失——调用方仍需判空后再取用。
 */
export function canReuseNode(cached: NodeCacheEntry | undefined, node: ViewNode): boolean {
  return cached !== undefined && cached.node === node && cached.sig === nodeSignature(node);
}
