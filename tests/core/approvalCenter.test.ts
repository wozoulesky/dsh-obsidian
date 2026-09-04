import { describe, expect, it } from "vitest";
import { ApprovalCenter, type PendingApproval, type PendingQuestion } from "../../src/core/approvalCenter";
import type { DshClient } from "../../src/transport/client";
import type { RemoteEventDownlinkFrame, RemoteEventOutcome } from "../../src/transport/types";

/** 只 mock answerEvent：记录 args、可配置返回。 */
type AnswerEventCall = { clientId: string; eventId: string; outcome: RemoteEventOutcome };
function makeClient(opts?: { answerEvent?: (call: AnswerEventCall) => Promise<{ ok: boolean }> }) {
  const calls: AnswerEventCall[] = [];
  const client = {
    answerEvent: async (clientId: string, eventId: string, outcome: RemoteEventOutcome) => {
      const call = { clientId, eventId, outcome };
      calls.push(call);
      if (opts?.answerEvent) return opts.answerEvent(call);
      return { ok: true } as const;
    },
  } as unknown as DshClient;
  return { client, calls };
}

function waterfall(event: string, eventId: string, agentId: string, request: Record<string, unknown>): RemoteEventDownlinkFrame {
  return { type: "waterfall", event, eventId, agentId, request };
}

const approvalRequest = { toolName: "write", callId: "c1", reason: "写入 vault/note.md" };
const questionRequest = {
  questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }],
};

describe("ApprovalCenter（0.1.2-rc.1 waterfall 契约）", () => {
  it("ready 帧绑定 clientId（可覆盖）", () => {
    const { client, calls } = makeClient();
    const center = new ApprovalCenter(client);
    center.ingest({ type: "ready", clientId: "c-1", host: { home: "C:/Users/test" } });
    center.ingest({ type: "ready", clientId: "c-2", host: { home: "C:/Users/test" } }); // 流重开换 id，覆盖
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    void center.decideApproval(center.pendingApprovals[0], "allowed-once");
    expect(calls[0].clientId).toBe("c-2");
  });

  it("approval waterfall 入队：agentId→sessionId、request 字段映射、eventId 为键", () => {
    const { client } = makeClient();
    const center = new ApprovalCenter(client);
    let changed = 0;
    center.onChange(() => changed++);
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    expect(center.pendingApprovals).toEqual([
      { eventId: "e1", sessionId: "s1", toolName: "write", callId: "c1", reason: "写入 vault/note.md" },
    ]);
    expect(changed).toBe(1);
    // eventId 覆盖同键（旧信封键语义已废弃）
    center.ingest(waterfall("approval/request", "e1", "s2", { toolName: "read" }));
    expect(center.pendingApprovals).toHaveLength(1);
    expect(center.pendingApprovals[0].toolName).toBe("read");
  });

  it("question waterfall 入队：questions 原样透传、eventId 为键", () => {
    const { client } = makeClient();
    const center = new ApprovalCenter(client);
    center.ingest(waterfall("user-questions/request", "e2", "s1", questionRequest));
    expect(center.pendingQuestions).toEqual([
      { eventId: "e2", sessionId: "s1", questions: questionRequest.questions },
    ]);
  });

  it("cancel 帧按 eventId 移除（approval 与 question 两条）", () => {
    const { client } = makeClient();
    const center = new ApprovalCenter(client);
    let changed = 0;
    center.onChange(() => changed++);
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    center.ingest(waterfall("user-questions/request", "e2", "s1", questionRequest));
    expect(changed).toBe(2);
    center.ingest({ type: "cancel", eventId: "e1" });
    expect(center.pendingApprovals).toHaveLength(0);
    expect(center.pendingQuestions).toHaveLength(1);
    center.ingest({ type: "cancel", eventId: "e2" });
    expect(center.pendingApprovals).toHaveLength(0);
    expect(center.pendingQuestions).toHaveLength(0);
    expect(changed).toBe(4);
  });

  it("emit 帧忽略", () => {
    const { client } = makeClient();
    const center = new ApprovalCenter(client);
    let changed = 0;
    center.onChange(() => changed++);
    center.ingest({ type: "emit", event: "api-session/status", args: [{}] });
    expect(center.pendingApprovals).toHaveLength(0);
    expect(center.pendingQuestions).toHaveLength(0);
    expect(changed).toBe(0);
  });

  it("decideApproval → answerEvent 精确载荷 {clientId,eventId,outcome:{kind:result,value:allowed-once}}；成功认领本地出队", async () => {
    const { client, calls } = makeClient();
    const center = new ApprovalCenter(client);
    center.ingest({ type: "ready", clientId: "c-1", host: { home: "C:/Users/test" } });
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    expect(center.pendingApprovals).toHaveLength(1);
    const claimed = await center.decideApproval(center.pendingApprovals[0], "allowed-once");
    expect(claimed).toBe(true);
    // 官方 finishRemoteEvent 只向其它 client 广播 cancel：认领方必须自己移除待决项
    expect(center.pendingApprovals).toHaveLength(0);
    expect(calls).toEqual([
      { clientId: "c-1", eventId: "e1", outcome: { kind: "result", value: "allowed-once" } },
    ]);
  });

  it("answerQuestion → value {answers} 精确载荷；成功认领本地出队", async () => {
    const { client, calls } = makeClient();
    const center = new ApprovalCenter(client);
    center.ingest({ type: "ready", clientId: "c-1", host: { home: "C:/Users/test" } });
    center.ingest(waterfall("user-questions/request", "e2", "s1", questionRequest));
    const claimed = await center.answerQuestion(center.pendingQuestions[0], [{ id: "q1", selected: ["A"] }]);
    expect(claimed).toBe(true);
    expect(center.pendingQuestions).toHaveLength(0);
    expect(calls).toEqual([
      { clientId: "c-1", eventId: "e2", outcome: { kind: "result", value: { answers: [{ id: "q1", selected: ["A"] }] } } },
    ]);
  });

  it("answerEvent 失败 → 返回 false 且待决项保留（弹窗可重试）", async () => {
    const { client } = makeClient({ answerEvent: async () => ({ ok: false }) });
    const center = new ApprovalCenter(client);
    center.ingest({ type: "ready", clientId: "c-1", host: { home: "C:/Users/test" } });
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    const claimed = await center.decideApproval(center.pendingApprovals[0], "allowed-once");
    expect(claimed).toBe(false);
    expect(center.pendingApprovals).toHaveLength(1); // 保留供重试
  });

  it("clientId 未绑定时 decideApproval/answerQuestion 抛明确错误", async () => {
    const { client, calls } = makeClient();
    const center = new ApprovalCenter(client);
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    center.ingest(waterfall("user-questions/request", "e2", "s1", questionRequest));
    const p: PendingApproval = center.pendingApprovals[0];
    const q: PendingQuestion = center.pendingQuestions[0];
    await expect(center.decideApproval(p, "rejected")).rejects.toThrow(/clientId 未绑定/);
    await expect(center.answerQuestion(q, [])).rejects.toThrow(/clientId 未绑定/);
    expect(calls).toHaveLength(0);
  });

  it("$events 流重开换新 clientId：旧代 pending 项在新代下应答用新 clientId（批 4b 重开竞态语义）", async () => {
    const { client, calls } = makeClient();
    const center = new ApprovalCenter(client);
    center.ingest({ type: "ready", clientId: "gen-1", host: { home: "C:/Users/test" } });
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    // 断线 → 重开：服务端换新 clientId 并重放 pending 事件（官方 openRemoteEvents 语义）
    center.ingest({ type: "ready", clientId: "gen-2", host: { home: "C:/Users/test" } });
    // 重放同一 eventId（服务端 pending 重放）：入队覆盖同键，不产生重复弹窗
    center.ingest(waterfall("approval/request", "e1", "s1", approvalRequest));
    expect(center.pendingApprovals).toHaveLength(1);
    const claimed = await center.decideApproval(center.pendingApprovals[0], "allowed-once");
    expect(claimed).toBe(true);
    expect(calls[0].clientId).toBe("gen-2"); // 应答用最新代 clientId
    expect(calls[0].eventId).toBe("e1");
  });
});
