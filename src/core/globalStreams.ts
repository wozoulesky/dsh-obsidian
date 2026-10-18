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
/**
 * 全局流的可观测性钩子。
 *
 * 为什么要它：两条流此前用**空 catch** 静默吞掉所有异常，导致 `applyControlFrame()`
 * 里真正的编程错误（真实案例：DSH 0.2.1 的 baseline 只有 projections，旧代码
 * `Object.entries(undefined)` 抛 TypeError）完全无声——数据进了一半、UI 不重绘、流死掉，
 * 而用户和开发者都拿不到任何线索。预期内的断线仍需静默（否则每次重连都刷一行日志）。
 */
export interface GlobalStreamsOptions {
  /** 消费循环里出现**非预期**异常时调用（断线/abort 不算）。默认写 console.error。 */
  onUnexpectedError?: (err: unknown) => void;
}

/** 预期内的流终止：断线载体错误、abort、以及插件卸载。这些不该刷日志。 */
function isExpectedStreamEnd(err: unknown): boolean {
  if (err === null || err === undefined) return true;
  // 必须用 `err.name`（实例属性，muxStream 里以字符串字面量赋值，压不掉），
  // **不能**用 `err.constructor.name`：生产构建 minify 会把 class 名压成短名（实测 "e"），
  // 于是判定永远 false，每次正常断线重连都会被当成「非预期异常」刷日志——
  // 正好把这个钩子想解决的「噪音掩盖真 bug」问题重新引进来。单测跑未压缩 TS，发现不了。
  const errName = (err as { name?: string }).name;
  if (errName === "AbortError") return true;
  if (errName === "RemoteStreamCarrierError" || errName === "RemoteStreamError") return true;
  return false;
}

export class GlobalStreams {
  private eventsGen: AbortController | null = null;
  private controlGen: AbortController | null = null;
  private stopped = false;

  constructor(
    private client: DshClient,
    private store: SessionStore,
    private approvals: ApprovalCenter,
    private options: GlobalStreamsOptions = {}
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
      } catch (err) {
        /* 断线（RemoteStreamCarrierError）/ abort / 流错误：静默结束；重连由 onState("connected") 触发重开。
           但非预期异常必须上报——否则帧处理代码的 bug 会被一起吞掉。 */
        this.reportUnexpected(err);
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
      } catch (err) {
        /* 断线：静默，重连由 onState("connected") 触发重开（服务端会重发 baseline）。
           但 applyControlFrame 抛出的编程错误必须上报——它意味着帧契约变了或解析有 bug。 */
        this.reportUnexpected(err);
      }
    })();
  }

  /** 预期内的流结束静默；其余异常交给注入的钩子（默认 console.error），绝不静默吞掉。 */
  private reportUnexpected(err: unknown): void {
    if (isExpectedStreamEnd(err)) return;
    if (this.options.onUnexpectedError) {
      this.options.onUnexpectedError(err);
      return;
    }
    console.error("[dsh-bridge] 全局流消费异常（非断线）", err);
  }
}
