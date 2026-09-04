import type { DshClient } from "../transport/client";
import type { RemoteEventDownlinkFrame, SessionControlFrame } from "../transport/types";
import type { ApprovalCenter } from "./approvalCenter";
import type { SessionStore } from "./store";

/**
 * 两条全局长流（$events / session/control）的生命周期管理。
 *
 * 与 physical connection 生命周期解耦：onState("connected") 每次触发（首次连接/断线重连）
 * 都重开两流——先 abort 旧代（AbortController 代际）再开新代；消费循环每帧检查 signal.aborted，
 * 防止旧代残留迭代与新代串流（重复入队/旧 clientId 污染）。
 * $events 重开会拿新 clientId（服务端每代铸造并重放 pending），ApprovalCenter 由 ready 帧重新绑定；
 * session/control 每代首帧重发 baseline，无需本地重建。
 */
export class GlobalStreams {
  private eventsGen: AbortController | null = null;
  private controlGen: AbortController | null = null;
  private stopped = false;

  constructor(
    private client: DshClient,
    private store: SessionStore,
    private approvals: ApprovalCenter
  ) {}

  /** 连接就绪（含重连）：重开两条全局流。幂等——多次调用先 abort 旧代。 */
  startAll(): void {
    if (this.stopped) return;
    this.startEvents();
    this.startControl();
  }

  /** 插件卸载：中止两代，之后 startAll 不再生效。 */
  stop(): void {
    this.stopped = true;
    this.eventsGen?.abort();
    this.controlGen?.abort();
    this.eventsGen = null;
    this.controlGen = null;
  }

  private startEvents(): void {
    const controller = new AbortController();
    this.eventsGen?.abort();
    this.eventsGen = controller;
    void (async () => {
      try {
        const stream = await this.client.openStream<RemoteEventDownlinkFrame>("$events", {}, controller.signal);
        for await (const frame of stream) {
          if (controller.signal.aborted) return;
          this.approvals.ingest(frame);
        }
      } catch {
        /* 断线（RemoteStreamCarrierError）/ abort / 流错误：静默结束；重连由 onState("connected") 触发重开 */
      }
    })();
  }

  private startControl(): void {
    const controller = new AbortController();
    this.controlGen?.abort();
    this.controlGen = controller;
    void (async () => {
      try {
        const stream = await this.client.openStream<SessionControlFrame>("session/control", {}, controller.signal);
        for await (const frame of stream) {
          if (controller.signal.aborted) return;
          this.store.applyControlFrame(frame);
        }
      } catch {
        /* 断线/异常：静默结束；重连由 onState("connected") 触发重开（服务端会重发 baseline） */
      }
    })();
  }
}
