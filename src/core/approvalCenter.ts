import type { DshClient } from "../transport/client";
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  RemoteEventDownlinkFrame,
  RpcReceipt,
} from "../transport/types";

/** 审批请求的 waterfall request 载荷（线上形状，批 4a-2 核实）。 */
interface ApprovalRequestShape {
  toolName: string;
  callId?: string;
  reason?: string;
}

/** 提问请求的 waterfall request 载荷（线上形状）。 */
interface QuestionRequestShape {
  questions: AskUserQuestionItem[];
}

/** 待决审批项：以 $events waterfall 帧的 eventId 为键（旧 rpcId/sessionId/approvalId 键全部废弃）。 */
export interface PendingApproval {
  eventId: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

/** 待答提问项：以 eventId 为键。 */
export interface PendingQuestion {
  eventId: string;
  sessionId: string;
  questions: AskUserQuestionItem[];
}

const REMOTE_EVENT_TYPES = new Set(["ready", "emit", "waterfall", "cancel"]);

function isRemoteEventFrame(x: unknown): x is RemoteEventDownlinkFrame {
  return typeof x === "object" && x !== null && REMOTE_EVENT_TYPES.has((x as { type?: unknown }).type as string);
}

export class ApprovalCenter {
  private approvals = new Map<string, PendingApproval>();
  private questions = new Map<string, PendingQuestion>();
  private listeners = new Set<() => void>();
  /** $events 流 ready 帧下发的 clientId，answerEvent 必填；流重开会换新值。 */
  private clientId?: string;

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

  /** 绑定 $events 流 clientId（ready 帧）；幂等，clientId 变化时覆盖（流重开换 id）。 */
  bindEventsClient(clientId: string): void {
    if (this.clientId !== clientId) this.clientId = clientId;
  }

  /**
   * 接入一帧 $events 下行帧（0.1.2-rc.1 waterfall 契约）：
   * ready → 绑定 clientId；waterfall → 按 event 入队；cancel → 按 eventId 出队；emit 忽略。
   */
  ingest(frame: RemoteEventDownlinkFrame): void;
  /**
   * @deprecated 旧双参形态（main.ts 过渡编译兼容：MuxStream 壳 onFrame 永不回调，实为死路径）。
   * 仅透传其中的新事件帧，批 4 接线（main.ts 改喂 RemoteEventDownlinkFrame）后删除本重载。
   */
  ingest(_rpcId: string, frame: unknown): void;
  ingest(frameOrRpcId: RemoteEventDownlinkFrame | string, maybeFrame?: unknown): void {
    if (typeof frameOrRpcId === "string") {
      if (maybeFrame !== undefined && isRemoteEventFrame(maybeFrame)) this.handleFrame(maybeFrame);
      return;
    }
    this.handleFrame(frameOrRpcId);
  }

  private handleFrame(frame: RemoteEventDownlinkFrame): void {
    switch (frame.type) {
      case "ready":
        this.bindEventsClient(frame.clientId);
        break;
      case "waterfall":
        this.handleWaterfall(frame);
        break;
      case "cancel":
        // 其它客户端认领后服务端广播；approvals/questions 两处按 eventId 移除。
        if (this.approvals.delete(frame.eventId) || this.questions.delete(frame.eventId)) this.notify();
        break;
      case "emit":
        break; // 本类忽略
      default:
        break;
    }
  }

  private handleWaterfall(frame: Extract<RemoteEventDownlinkFrame, { type: "waterfall" }>): void {
    if (frame.event === "approval/request") {
      const request = frame.request as unknown as ApprovalRequestShape;
      this.approvals.set(frame.eventId, {
        eventId: frame.eventId,
        sessionId: frame.agentId,
        toolName: request.toolName,
        callId: request.callId,
        reason: request.reason,
      });
      this.notify();
      return;
    }
    if (frame.event === "user-questions/request") {
      const request = frame.request as unknown as QuestionRequestShape;
      this.questions.set(frame.eventId, {
        eventId: frame.eventId,
        sessionId: frame.agentId,
        questions: request.questions,
      });
      this.notify();
      return;
    }
    // 其它 waterfall 事件忽略
  }

  /**
   * 应答审批（waterfall 三态之 result）：value = "allowed-once" | "rejected"。
   * 返回旧 RpcReceipt 形状（@deprecated，批 4b 改签名）；accepted:true 当且仅当 answerEvent ok。
   */
  async decideApproval(p: PendingApproval, outcome: "allowed-once" | "rejected"): Promise<RpcReceipt> {
    const clientId = this.requireClientId();
    const res = await this.client.answerEvent(clientId, p.eventId, { kind: "result", value: outcome });
    return res.ok ? { accepted: true } : { accepted: false, reason: "bad-response" };
  }

  /** 应答提问：value = {answers:[{id,selected,custom?}]}。返回旧 RpcReceipt 形状（批 4b 改签名）。 */
  async answerQuestion(p: PendingQuestion, answers: AskUserQuestionAnswerItem[]): Promise<RpcReceipt> {
    const clientId = this.requireClientId();
    const res = await this.client.answerEvent(clientId, p.eventId, { kind: "result", value: { answers } });
    return res.ok ? { accepted: true } : { accepted: false, reason: "bad-response" };
  }

  private requireClientId(): string {
    if (this.clientId === undefined) {
      throw new Error("[dsh-bridge] 尚未收到 $events ready 帧（clientId 未绑定），无法应答");
    }
    return this.clientId;
  }
}
