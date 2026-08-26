import { describe, expect, it } from "vitest";
import { nodeCacheKey, nodeSignature } from "../../src/ui/chatNode";
import type { AssistantNode, CommandNode, UserNode } from "../../src/core/eventFold";

function user(over: Partial<UserNode> = {}): UserNode {
  return { kind: "user", id: "u1", text: "hi", sourceKind: "user", seq: 1, ...over };
}

function command(over: Partial<CommandNode> = {}): CommandNode {
  return { kind: "command", id: "c1", name: "/plan", status: "running", seq: 2, ...over };
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
    ...over,
  };
}

describe("nodeCacheKey", () => {
  it("key 包含 sessionId 与 node.id，跨会话不冲突", () => {
    expect(nodeCacheKey("s1", user())).toBe("s1:u1");
    expect(nodeCacheKey("s2", user())).toBe("s2:u1");
  });
});

describe("nodeSignature", () => {
  it("user 签名随文本与来源变化", () => {
    const base = nodeSignature(user());
    expect(nodeSignature(user({ text: "changed" }))).not.toBe(base);
    expect(nodeSignature(user({ sourceKind: "context" }))).not.toBe(base);
  });

  it("command 签名随状态与文本变化", () => {
    const base = nodeSignature(command());
    expect(nodeSignature(command({ status: "success" }))).not.toBe(base);
    expect(nodeSignature(command({ text: "done" }))).not.toBe(base);
  });

  it("assistant 签名随文本/streaming/工具卡变化，相同内容保持不变", () => {
    const base = nodeSignature(assistant());
    expect(nodeSignature(assistant({ text: "updated" }))).not.toBe(base);
    expect(nodeSignature(assistant({ streaming: false }))).not.toBe(base);
    expect(
      nodeSignature(assistant({ toolCards: [{ id: "t1", name: "read", args: "{}", status: "running" }] }))
    ).not.toBe(base);
    expect(nodeSignature(assistant())).toBe(base);
  });

  it("assistant 工具卡状态/结果变化会触发签名变化", () => {
    const running = nodeSignature(
      assistant({ toolCards: [{ id: "t1", name: "read", args: "{}", status: "running" }] })
    );
    const done = nodeSignature(
      assistant({ toolCards: [{ id: "t1", name: "read", args: "{}", status: "done", resultText: "ok" }] })
    );
    expect(done).not.toBe(running);
  });
});
