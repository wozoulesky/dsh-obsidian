import WebSocket from "ws";
import type { MuxFrame, ServerRequest } from "./types";
import { clearTimer, setTimer } from "../utils/timers";

export type MuxState = "connected" | "reconnecting";

export interface MuxSink {
  /** 每帧：信封 rpcId + MuxFrame payload。 */
  onFrame(rpcId: string, frame: MuxFrame): void;
  /** 状态变化（去重后的转换）。 */
  onState(state: MuxState): void;
}

export interface MuxStreamOptions {
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** 指数退避延迟（纯函数）：attempt 从 1 起算，cap 封顶。 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const n = Math.max(attempt - 1, 0);
  return Math.min(maxMs, baseMs * 2 ** n);
}

/** 与 /api/events.mux 的纯下行 WebSocket 连接，指数退避自动重连。 */
export class MuxStream {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastState: MuxState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(
    private baseUrl: string,
    private sink: MuxSink,
    options: MuxStreamOptions = {}
  ) {
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 30000;
  }

  start(): void {
    this.stopped = false;
    this.lastState = null;
    this.attempt = 0;
    if (this.timer) {
      clearTimer(this.timer);
      this.timer = null;
    }
    this.connect();
  }

  private connect(): void {
    this.emitState("reconnecting");
    let socket: WebSocket;
    try {
      const url = this.baseUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/api/events.mux";
      socket = new WebSocket(url, { handshakeTimeout: 5000 });
    } catch (err) {
      // 配置非法 URL 时 ws 构造器同步抛错；若不兜底，重连循环会永久停摆（状态栏停在「重连中」）。
      console.error("[dsh-bridge] WebSocket 构造失败（检查 DSH 地址设置）:", err);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      this.attempt = 0;
      this.emitState("connected");
    });
    socket.on("message", (data) => {
      let msg: ServerRequest;
      try {
        msg = JSON.parse(data.toString()) as ServerRequest;
      } catch (err) {
        console.error("[dsh-bridge] 丢弃非法 mux 帧:", err);
        return;
      }
      if (typeof msg?.rpcId !== "string" || typeof msg?.payload !== "object" || msg?.payload === null) {
        console.error("[dsh-bridge] 丢弃结构非法的 mux 帧:", JSON.stringify(msg));
        return;
      }
      try {
        this.sink.onFrame(msg.rpcId, msg.payload as MuxFrame);
      } catch (err) {
        console.error("[dsh-bridge] mux 帧处理回调异常（帧已丢弃，流继续）:", err);
      }
    });
    socket.on("close", () => this.scheduleReconnect());
    socket.on("error", () => {
      /* close 事件随后触发；这里不直接重连，避免与 close 重复调度 */
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.emitState("reconnecting");
    this.attempt += 1;
    const delay = backoffDelay(this.attempt, this.backoffBaseMs, this.backoffMaxMs);
    this.timer = setTimer(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  private emitState(state: MuxState): void {
    if (this.lastState !== state) {
      this.lastState = state;
      this.sink.onState(state);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimer(this.timer);
      this.timer = null;
    }
    this.socket?.close();
    this.socket = null;
  }
}
