import { describe, expect, it } from "vitest";
import { canReuseNode, nodeCacheKey, nodeSignature, type NodeCacheEntry } from "../../src/ui/chatNode";
import type { AssistantNode, CommandNode, ErrorNode, UserNode, ViewNode } from "../../src/core/eventFold";

function user(over: Partial<UserNode> = {}): UserNode {
  return { kind: "user", id: "u1", text: "hi", sourceKind: "user", imageCount: 0, seq: 1, rev: 0, ...over };
}

function command(over: Partial<CommandNode> = {}): CommandNode {
  return { kind: "command", id: "c1", name: "/plan", status: "running", seq: 2, rev: 0, ...over };
}

function error(over: Partial<ErrorNode> = {}): ErrorNode {
  return { kind: "error", id: "e1", text: "boom", seq: 4, rev: 0, ...over };
}

function assistant(over: Partial<AssistantNode> = {}): AssistantNode {
  return {
    kind: "assistant",
    id: "a1",
    text: "answer",
    reasoning: "",
    toolCards: [],
    streaming: true,
    seq: 3,
    rev: 0,
    ...over,
  };
}

describe("nodeCacheKey", () => {
  it("key 包含 sessionId 与 node.id，跨会话不冲突", () => {
    expect(nodeCacheKey("s1", user())).toBe("s1:u1");
    expect(nodeCacheKey("s2", user())).toBe("s2:u1");
  });

  it("缓存键不含 rev：同节点内容更新后仍复用同一缓存槽位", () => {
    expect(nodeCacheKey("s1", user({ rev: 7 }))).toBe(nodeCacheKey("s1", user({ rev: 0 })));
  });
});

describe("nodeSignature（rev 驱动）", () => {
  it("签名 = kind|rev：rev 不变则签名不变（正文/工具卡改动不参与签名计算）", () => {
    const base = nodeSignature(assistant({ rev: 3 }));
    expect(base).toBe("assistant|3");
    // 正文变化但 rev 未 bump：签名不变——rev 是唯一真相源，由 eventFold.bump 保证语义
    expect(nodeSignature(assistant({ text: "完全不同的正文", rev: 3 }))).toBe(base);
    expect(nodeSignature(assistant({ streaming: false, rev: 3 }))).toBe(base);
    expect(
      nodeSignature(assistant({ rev: 3, toolCards: [{ id: "t1", name: "read", args: "{}", status: "done", resultText: "ok" }] }))
    ).toBe(base);
  });

  it("rev 变化即签名变化（缓存失效 → 重建该节点 DOM）", () => {
    expect(nodeSignature(assistant({ rev: 4 }))).not.toBe(nodeSignature(assistant({ rev: 3 })));
  });

  it("kind 前缀保留：相同 rev 下不同节点类型签名不同", () => {
    const rev = 5;
    const sigs = [user({ rev }), command({ rev }), error({ rev }), assistant({ rev })].map(nodeSignature);
    expect(new Set(sigs).size).toBe(4);
  });

  it("签名长度与正文无关（旧实现拼接全文 + 4000 字截断的工具卡）", () => {
    const short = nodeSignature(assistant({ text: "a", rev: 1 }));
    const long = nodeSignature(
      assistant({
        rev: 1,
        text: "x".repeat(50000),
        toolCards: [{ id: "t1", name: "read", args: "y".repeat(50000), status: "done" }],
      })
    );
    expect(long).toBe(short);
    expect(long.length).toBeLessThan(32);
  });
});

describe("canReuseNode（复用判定）", () => {
  const el = {} as HTMLElement;

  function entry(node: ViewNode): NodeCacheEntry {
    return { el, sig: nodeSignature(node), node };
  }

  it("同一节点对象且签名未变 → 复用", () => {
    const node = assistant({ rev: 2 });
    expect(canReuseNode(entry(node), node)).toBe(true);
  });

  it("同一对象但 rev 变了 → 不复用（内容已更新需重绘）", () => {
    const node = assistant({ rev: 2 });
    const cached = entry(node);
    node.rev += 1;
    expect(canReuseNode(cached, node)).toBe(false);
  });

  it("缓存为空 → 不复用", () => {
    expect(canReuseNode(undefined, assistant())).toBe(false);
  });

  it("节点对象被替换（视图重建后同 id 新对象）→ 不复用，即使 kind 与 rev 巧合相等", () => {
    const oldNode = assistant({ id: "a1", text: "旧内容", rev: 3 });
    const cached = entry(oldNode);
    // 模拟 SessionStore.dropView → 重连 resync：同 id、同 rev，但对象与内容都不同
    const newNode = assistant({ id: "a1", text: "新内容", rev: 3 });
    expect(nodeSignature(newNode)).toBe(nodeSignature(oldNode)); // 签名确实相同
    expect(canReuseNode(cached, newNode)).toBe(false); // 但引用兜底拒绝复用
  });
});
