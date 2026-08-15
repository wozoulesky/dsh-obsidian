import type { DshClient } from "../transport/client";
import type { AskUserQuestionAnswerItem, AskUserQuestionItem, MuxFrame, RpcReceipt } from "../transport/types";

export interface PendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export interface PendingQuestion {
  rpcId: string;
  sessionId: string;
  questions: AskUserQuestionItem[];
}

export class ApprovalCenter {
  private approvals = new Map<string, PendingApproval>();
  private questions = new Map<string, PendingQuestion>();
  private listeners = new Set<() => void>();

  constructor(private client: DshClient) {}

  /** 注册变更监听，返回解除函数（视图关闭时必须调用，避免泄漏）。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[dsh-bridge] approval 监听器异常:", err);
      }
    }
  }

  get pendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()];
  }

  get pendingQuestions(): PendingQuestion[] {
    return [...this.questions.values()];
  }

  /** 接入一帧 mux：审批/提问入队或出队。 */
  ingest(rpcId: string, frame: MuxFrame): void {
    switch (frame.type) {
      case "approval/requested": {
        this.approvals.set(`${frame.sessionId}/${frame.approvalId}`, {
          rpcId,
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          callId: frame.callId,
          reason: frame.reason,
        });
        this.notify();
        break;
      }
      case "approval/resolved": {
        if (this.approvals.delete(`${frame.sessionId}/${frame.approvalId}`)) this.notify();
        break;
      }
      // 提问以信封 rpcId 为键（线上无内容键）；若服务端重放会轮换 rpcId，需在重连时清理（v1 已知取舍）。
      case "question/requested": {
        this.questions.set(rpcId, { rpcId, sessionId: frame.sessionId, questions: frame.questions });
        this.notify();
        break;
      }
      case "question/resolved": {
        if (this.questions.delete(frame.questionRpcId)) this.notify();
        break;
      }
      default:
        break;
    }
  }

  decideApproval(p: PendingApproval, outcome: "allowed-once" | "rejected"): Promise<RpcReceipt> {
    return this.client.respond(p.rpcId, { sessionId: p.sessionId, approvalId: p.approvalId, outcome });
  }

  answerQuestion(p: PendingQuestion, answers: AskUserQuestionAnswerItem[]): Promise<RpcReceipt> {
    return this.client.respond(p.rpcId, { sessionId: p.sessionId, answer: { answers } });
  }
}
