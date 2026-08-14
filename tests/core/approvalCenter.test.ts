import { describe, expect, it } from "vitest";
import { ApprovalCenter } from "../../src/core/approvalCenter";
import type { MuxFrame } from "../../src/transport/types";
import type { DshClient } from "../../src/transport/client";

const fakeClient = {
  respond: async (rpcId: string, value: unknown) => {
    (fakeClient as unknown as { calls: unknown[] }).calls.push({ rpcId, value });
    return { accepted: true } as const;
  },
} as unknown as DshClient & { calls: { rpcId: string; value: unknown }[] };

(fakeClient as unknown as { calls: unknown[] }).calls = [];

describe("ApprovalCenter", () => {
  it("approval/requested 入队，decide 应答正确载荷，resolved 出队", async () => {
    const center = new ApprovalCenter(fakeClient);
    let changed = 0;
    center.onChange(() => changed++);
    const frame: MuxFrame = {
      type: "approval/requested",
      sessionId: "s1",
      approvalId: "a1",
      toolName: "write",
      callId: "c1",
      reason: "写入 vault/note.md",
    };
    center.ingest("rpc-approval-1", frame);
    expect(center.pendingApprovals).toHaveLength(1);
    expect(changed).toBe(1);

    const receipt = await center.decideApproval(center.pendingApprovals[0], "allowed-once");
    expect(receipt.accepted).toBe(true);
    const calls = (fakeClient as unknown as { calls: { rpcId: string; value: unknown }[] }).calls;
    expect(calls.at(-1)).toEqual({
      rpcId: "rpc-approval-1",
      value: { sessionId: "s1", approvalId: "a1", outcome: "allowed-once" },
    });

    center.ingest("rpc-resolve", { type: "approval/resolved", sessionId: "s1", approvalId: "a1", outcome: "allowed-once" });
    expect(center.pendingApprovals).toHaveLength(0);
  });

  it("question/requested 入队，answer 应答 answers 载荷", async () => {
    const center = new ApprovalCenter(fakeClient);
    center.ingest("rpc-q-1", {
      type: "question/requested",
      sessionId: "s1",
      questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(center.pendingQuestions).toHaveLength(1);
    await center.answerQuestion(center.pendingQuestions[0], [{ id: "q1", selected: ["A"] }]);
    const calls = (fakeClient as unknown as { calls: { rpcId: string; value: unknown }[] }).calls;
    expect(calls.at(-1)).toEqual({
      rpcId: "rpc-q-1",
      value: { sessionId: "s1", answer: { answers: [{ id: "q1", selected: ["A"] }] } },
    });
    center.ingest("rpc-q-resolve", { type: "question/resolved", sessionId: "s1", questionRpcId: "rpc-q-1", outcome: "answered" });
    expect(center.pendingQuestions).toHaveLength(0);
  });
});
