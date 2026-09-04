/**
 * DSH 0.1.2-rc.1 remote.mux 物理连接层（批 3 重写）。
 *
 * 契约事实（对照本机 0.1.2-rc.1 官方源码核实）：
 * - WS 端点 `/api/remote.mux`（URL 由 baseUrl http→ws 转换）；握手带 Cookie header
 *   （DshCookieAuth.cookieHeader() 或注入的 cookieHeader 函数，与 DshClient 一致）。
 * - 帧协议（stream-protocol.js）：
 *   客户端 → 服务端：{type:"open", streamId, endpoint, payload} | {type:"cancel", streamId}
 *   服务端 → 客户端：{type:"item", streamId, value?} | {type:"end", streamId} |
 *                   {type:"error", streamId, error:{code,message,details}}
 * - 一个物理 WS 承载多个逻辑流（streamId 多路复用）。语义要点（stream-client.js）：
 *   - 连接断开 → 所有活跃流 fail（RemoteStreamCarrierError）；逻辑层决定重连/重开（批 4 负责）
 *   - 无效帧（非法 JSON/非法结构/二进制）→ 整个物理连接判定损坏，close(4002) 并 fail 所有流
 *   - 逻辑流终止（迭代器 return / abort）→ 发 {type:"cancel", streamId}（尽力而为）
 * - 复杂度取舍（批 3 YAGNI）：不做官方 RemoteStream 的 generation/自动重开协议——
 *   断线后活跃流以明确错误终止（绝不挂起），物理层指数退避自动重连，重连后上层可再 open
 *   （批 4 用 follow snapshot 的 cursor 续传）。
 */
import WebSocket from "ws";
import type { DshCookieAuth } from "./auth";
import { mintId, type RemoteStreamClientMessage, type RemoteStreamServerMessage } from "./types";
import { clearTimer, setTimer } from "../utils/timers";

export type MuxState = "connected" | "reconnecting";

/** 物理载体故障（连接断开/坏帧/停用）：可重试的流终止原因，与官方 RemoteStreamCarrierError 对应。 */
export class RemoteStreamCarrierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteStreamCarrierError";
  }
}

/** 服务端 error 帧还原的逻辑流错误：按 code 判别（session/not-found 等），details 原样携带。 */
export class RemoteStreamError extends Error {
  constructor(readonly code: string, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RemoteStreamError";
  }
}

export interface RemoteMuxTransportOptions {
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** 批 1 的 cookie 认证器（与 DshClient 一致；真机必须注入）。 */
  auth?: DshCookieAuth;
  /** 测试注入：cookieHeader 函数（返回完整 Cookie 头值，不含 Cookie: 前缀）。 */
  cookieHeader?: () => Promise<string>;
  /** 状态变化（去重后的转换）：main.ts 接状态栏。 */
  onState?: (state: MuxState) => void;
}

/** 指数退避延迟（纯函数）：attempt 从 1 起算，cap 封顶。 */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number): number {
  const n = Math.max(attempt - 1, 0);
  return Math.min(maxMs, baseMs * 2 ** n);
}

/** 坏帧触发物理连接关闭的协议码（与官方 stream-client.js 一致）。 */
export const INVALID_FRAME_CLOSE_CODE = 4002;

const WS_OPEN = 1; // WebSocket.OPEN（避免直接依赖 ws 运行时常量）

interface StreamInbox {
  queue: RemoteStreamServerMessage[];
  waiters: Array<{ resolve: (frame: RemoteStreamServerMessage) => void }>;
  /** 载体故障观察者：fail 时立即拒绝（唤醒阻塞在「等待 socket」阶段的流，避免挂起）。 */
  failureWaiters: Array<(error: Error) => void>;
  failure: Error | null;
}

function createInbox(): StreamInbox {
  return { queue: [], waiters: [], failureWaiters: [], failure: null };
}

function inboxPush(inbox: StreamInbox, frame: RemoteStreamServerMessage): void {
  if (inbox.failure) return;
  inbox.queue.push(frame);
  inbox.waiters.shift()?.resolve(frame);
}

function inboxFail(inbox: StreamInbox, error: Error): void {
  if (inbox.failure) return;
  inbox.failure = error;
  inbox.queue = [];
  for (const waiter of inbox.waiters.splice(0)) waiter.resolve(undefined as unknown as RemoteStreamServerMessage);
  for (const reject of inbox.failureWaiters.splice(0)) reject(error);
}

async function inboxNext(inbox: StreamInbox): Promise<RemoteStreamServerMessage> {
  while (inbox.queue.length === 0) {
    if (inbox.failure) throw inbox.failure;
    await new Promise<RemoteStreamServerMessage>((resolve) => inbox.waiters.push({ resolve }));
  }
  return inbox.queue.shift() as RemoteStreamServerMessage;
}

/** 流级故障承诺：inbox.fail 时拒绝（永不 resolve），供与 socket 等待竞速。 */
function inboxFailure(inbox: StreamInbox): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (inbox.failure) reject(inbox.failure);
    else inbox.failureWaiters.push(reject);
  });
}

/** AbortSignal.reason → Error（非 Error reason 归一化，避免上层拿到裸字符串 throw）。 */
function abortError(reason?: unknown): Error {
  return reason instanceof Error ? reason : new Error(reason === undefined ? "stream aborted" : String(reason));
}

/** 严格校验服务端帧（镜像官方 parseRemoteStreamServerMessage 的 exact-keys 校验；非法即抛）。 */
export function parseRemoteStreamServerMessage(text: string): RemoteStreamServerMessage {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (cause) {
    throw new Error(`Remote stream message is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("Remote stream message must be an object");
  }
  const value = decoded as Record<string, unknown>;
  const keys = Reflect.ownKeys(value).map(String);
  const exact = (...expected: string[]) =>
    keys.length === expected.length && expected.every((k) => Object.prototype.hasOwnProperty.call(value, k));
  const validId = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (value.type === "item" && (exact("type", "streamId") || exact("type", "streamId", "value")) && validId(value.streamId)) {
    return value as unknown as RemoteStreamServerMessage;
  }
  if (value.type === "end" && exact("type", "streamId") && validId(value.streamId)) {
    return value as unknown as RemoteStreamServerMessage;
  }
  if (
    value.type === "error" &&
    exact("type", "streamId", "error") &&
    validId(value.streamId) &&
    isRecord(value.error) &&
    Reflect.ownKeys(value.error).length === 3 &&
    Object.prototype.hasOwnProperty.call(value.error, "code") &&
    Object.prototype.hasOwnProperty.call(value.error, "message") &&
    Object.prototype.hasOwnProperty.call(value.error, "details") &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string" &&
    isRecord(value.error.details)
  ) {
    return value as unknown as RemoteStreamServerMessage;
  }
  throw new Error("invalid Remote stream server message");
}

/**
 * remote.mux 物理连接：一个 WS 多路复用多个逻辑流。
 *
 * - `open(endpoint, args, signal?)` → AsyncIterable<T>（一个逻辑流；item.value 逐帧产出）
 * - 断线/坏帧/stop 时活跃流以 RemoteStreamCarrierError 终止（不挂起），物理层自动退避重连
 * - 重连后上层可再 open（批 4 用 cursor 续传）
 */
export class RemoteMuxTransport {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastState: MuxState | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingConnect: Promise<WebSocket> | null = null;
  private generation = 0;
  private readonly streams = new Map<string, StreamInbox>();
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly cookie: (() => Promise<string>) | undefined;
  private readonly onState: ((state: MuxState) => void) | undefined;
  private focusCleanup: (() => void) | null = null;
  /** 最近一次连接失败是否为 ECONNREFUSED（服务未启动）：决定退避策略。 */
  private lastRefused = false;

  constructor(
    private baseUrl: string,
    options: RemoteMuxTransportOptions = {}
  ) {
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    // 封顶 8s（旧 30s 使 DSH 重启期间 attempt 推到高位后恢复等待最长 30~32 秒，真机验收 #5「33 秒未恢复」根因）：
    // 本地 DSH 启动约 10~30 秒，期间会失败数次推高 attempt；8s 封顶保证服务就绪后最坏 8 秒内恢复。
    this.backoffMaxMs = options.backoffMaxMs ?? 8000;
    this.onState = options.onState;
    const auth = options.auth;
    if (options.cookieHeader) this.cookie = options.cookieHeader;
    else if (auth) this.cookie = () => auth.cookieHeader();
  }

  /** 当前状态（最近一次去重后的转换）。 */
  get state(): MuxState | null {
    return this.lastState;
  }

  /** 物理 WS 地址：baseUrl http(s)→ws(s) + /api/remote.mux。 */
  muxUrl(): string {
    return this.baseUrl.replace(/\/+$/, "").replace(/^http/, "ws") + "/api/remote.mux";
  }

  /** 开始物理连接保持（空闲也保持连接，与官方「keeps it connected while idle」一致）。 */
  start(): void {
    if (this.stopped) this.stopped = false;
    if (!this.focusCleanup) this.installFocusReconnect(); // 渲染进程挂失焦重连兜底（Node 测试环境 window 为测试注入的别名）
    if (this.socket?.readyState === WS_OPEN || this.pendingConnect) return;
    void this.connect().catch(() => {
      /* 失败已由 close 路径调度退避重试 */
    });
  }

  /** 停止：fail 所有活跃流、关闭 socket、清除重连定时器（停用后不再重连）。 */
  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.focusCleanup?.();
    this.focusCleanup = null;
    this.generation++; // 在途 socket 与连接尝试全部失效
    const socket = this.socket;
    this.socket = null;
    this.pendingConnect = null;
    this.failAll(new RemoteStreamCarrierError("api gateway: Remote stream transport stopped"));
    socket?.close(1000, "disposed");
  }

  /**
   * 打开一个逻辑流。args 为该端点的线上 args（session/* 为 {request:{...}}；session/control 与 $events 恒为空对象 {}），
   * 物理层原样包装为 payload {args}。返回 AsyncIterable<T>（item.value 逐帧产出；end 结束；error 抛 RemoteStreamError；
   * 断线/坏帧/abort/stop 抛 RemoteStreamCarrierError 或 abort reason）。
   */
  open<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): AsyncIterable<T> {
    if (this.stopped) throw new RemoteStreamCarrierError("api gateway: Remote stream transport disposed");
    if (signal?.aborted) throw abortError(signal.reason);
    return this.streamIter<T>(endpoint, { args }, signal);
  }

  private async *streamIter<T>(endpoint: string, payload: unknown, signal?: AbortSignal): AsyncIterable<T> {
    const streamId = mintId();
    const inbox = createInbox();
    this.streams.set(streamId, inbox);
    if (!this.socket || this.socket.readyState !== WS_OPEN) this.start();
    let opened = false;
    let sentCancel = false;
    const sendCancel = () => {
      if (sentCancel || !opened) return;
      sentCancel = true;
      const socket = this.socket;
      if (socket && socket.readyState === WS_OPEN) {
        try {
          socket.send(JSON.stringify({ type: "cancel", streamId } satisfies RemoteStreamClientMessage));
        } catch {
          /* 尽力而为：取消帧失败由物理层关闭兜底 */
        }
      }
    };
    const onAbort = () => inboxFail(inbox, abortError(signal?.reason));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // inboxFailure 是竞速落败方：race 结束后其拒绝由 no-op handler 承接（防 unhandledRejection 噪音）。
      const failPromise = inboxFailure(inbox);
      failPromise.catch(() => {});
      const socketPromise = this.waitForSocket();
      socketPromise.catch(() => {}); // 竞速落败方（如 abort 先到而连接稍后失败）
      const socket = await Promise.race([
        socketPromise,
        failPromise,
        ...(signal?.aborted ? [Promise.reject(abortError(signal.reason))] : []),
      ]);
      if (signal?.aborted) throw abortError(signal.reason);
      if (socket.readyState !== WS_OPEN) throw new RemoteStreamCarrierError("api gateway: Remote stream socket closed before opening");
      socket.send(
        JSON.stringify({ type: "open", streamId, endpoint, payload } satisfies RemoteStreamClientMessage)
      );
      opened = true;
      while (true) {
        const frame = await Promise.race([inboxNext(inbox), ...(signal ? [abortPromise(signal)] : [])]);
        if (signal?.aborted) throw abortError(signal.reason);
        if (frame.type === "item") {
          yield frame.value as T;
          continue;
        }
        if (frame.type === "error") {
          throw new RemoteStreamError(frame.error.code, frame.error.message, frame.error.details ?? {});
        }
        return; // end：逻辑流正常终止
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.streams.delete(streamId);
      sendCancel();
    }
  }

  private waitForSocket(): Promise<WebSocket> {
    if (this.socket?.readyState === WS_OPEN) return Promise.resolve(this.socket);
    if (this.stopped) return Promise.reject(new RemoteStreamCarrierError("api gateway: Remote stream transport disposed"));
    if (!this.pendingConnect) this.pendingConnect = this.connect();
    return this.pendingConnect;
  }

  /** 建立一次物理连接（带 Cookie 握手头）；失败由 close 路径调度退避重试。 */
  private connect(): Promise<WebSocket> {
    const gen = ++this.generation;
    this.emitState("reconnecting");
    const promise = new Promise<WebSocket>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (this.pendingConnect === promise) this.pendingConnect = null;
        fn();
      };
      /** 无 socket 的失败路径：拒绝在途等待者并调度退避重试（凭据稍后可能出现，DshCookieAuth 失败后自动重读）。 */
      const failWithoutSocket = (err: Error) => {
        finish(() => reject(err));
        this.scheduleReconnect();
      };
      void (async () => {
        let headers: { cookie?: string } | undefined;
        if (this.cookie) {
          try {
            headers = { cookie: await this.cookie() };
          } catch (err) {
            failWithoutSocket(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
        if (gen !== this.generation || this.stopped) {
          finish(() => reject(new RemoteStreamCarrierError("api gateway: Remote stream connection attempt superseded")));
          return;
        }
        let socket: WebSocket;
        try {
          socket = new WebSocket(this.muxUrl(), { handshakeTimeout: 5000, headers: headers ?? {} });
        } catch (err) {
          failWithoutSocket(
            new RemoteStreamCarrierError(`WebSocket 构造失败：${err instanceof Error ? err.message : String(err)}`)
          );
          return;
        }
        socket.on("open", () => {
          if (gen !== this.generation || this.stopped) {
            // 被更新的连接尝试取代：拒绝等待者（绝不悬挂）并关闭多余 socket
            finish(() => reject(new RemoteStreamCarrierError("api gateway: Remote stream connection attempt superseded")));
            socket.close(1000, "superseded");
            return;
          }
          finish(() => {
            this.socket = socket;
            this.attempt = 0;
            this.emitState("connected");
            resolve(socket);
          });
        });
        socket.on("message", (data, isBinary) => this.receive(socket, data, isBinary));
        socket.on("close", () => {
          if (gen !== this.generation) return;
          finish(() => reject(new RemoteStreamCarrierError("api gateway: Remote stream WebSocket closed before opening")));
          this.onLost(socket);
        });
        socket.on("error", (err) => {
          /* close 事件随后触发；记录 ECONNREFUSED 供 close 路径选择退避策略（服务未启动时固定短间隔轮询） */
          if (err && typeof err === "object" && (err as { code?: string }).code === "ECONNREFUSED") {
            this.lastRefused = true;
          }
        });
      })();
    });
    return promise;
  }

  /** 收到一帧：严格校验后按 streamId 分发；坏帧判定物理连接损坏 → close(4002) + fail 所有流。 */
  private receive(socket: WebSocket, data: unknown, isBinary: boolean): void {
    if (this.socket !== socket) return;
    let frame: RemoteStreamServerMessage;
    try {
      if (isBinary) throw new Error("Remote stream WebSocket requires text messages");
      frame = parseRemoteStreamServerMessage(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
    } catch (err) {
      const failure = new RemoteStreamCarrierError(
        `api gateway: invalid Remote stream frame: ${err instanceof Error ? err.message : String(err)}`
      );
      this.socket = null;
      this.failAll(failure);
      socket.close(INVALID_FRAME_CLOSE_CODE, "invalid Remote stream frame");
      return;
    }
    const inbox = this.streams.get(frame.streamId);
    if (inbox) inboxPush(inbox, frame);
    // 未知 streamId 静默丢弃（官方语义：streams.get(streamId)?.push）
  }

  /** 物理连接丢失：fail 所有活跃流 + 状态切 reconnecting + 退避重连。 */
  private onLost(socket: WebSocket): void {
    if (this.socket === socket) this.socket = null;
    this.failAll(new RemoteStreamCarrierError("api gateway: Remote stream WebSocket closed"));
    this.emitState("reconnecting");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.attempt += 1;
    // 服务未启动（ECONNREFUSED）：固定 2s 轮询（DSH 启动通常 10~30 秒，2s 间隔保证就绪后最坏 2 秒发现）；
    // 其它失败（握手失败/坏帧/凭据）才指数退避。
    const delay = this.lastRefused ? 2000 : backoffDelay(this.attempt, this.backoffBaseMs, this.backoffMaxMs);
    this.lastRefused = false;
    this.reconnectTimer = setTimer(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this.socket) {
        void this.connect().catch(() => {
          /* close 路径已调度下一次重试 */
        });
      }
    }, delay);
  }

  /**
   * 窗口失焦时 Electron/Chromium 会节流 setTimeout（background timer throttling），
   * 退避定时器可能被拖慢到远超预期（真机复测 #5：封顶 8s 仍 +11.6s 未恢复）。
   * 挂 window focus 监听：窗口重新激活/聚焦时立即尝试重连，绕开被节流的定时器。
   * 无 addEventListener 的环境（Node 测试）静默跳过——测试由 scheduleReconnect 退避覆盖。
   */
  private installFocusReconnect(): void {
    const win = window as unknown as { addEventListener?: (t: string, h: () => void) => void; removeEventListener?: (t: string, h: () => void) => void };
    if (!win.addEventListener) return;
    const handler = () => {
      if (this.stopped || this.socket) return;
      if (this.reconnectTimer !== null) {
        clearTimer(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      void this.connect().catch(() => {
        /* 失败继续走 close 路径退避 */
      });
    };
    win.addEventListener("focus", handler);
    // visibilitychange 兜底（某些 Electron 版本 focus 不触发时，切回可见也重连）
    // 用 typeof 探测（避免 global 对象；Node 测试环境无 document → 跳过 visibility 路径，focus 已覆盖）
    const doc: { visibilityState?: string; addEventListener?: (t: string, h: () => void) => void; removeEventListener?: (t: string, h: () => void) => void } | undefined = typeof document === "undefined" ? undefined : document;
    if (doc?.addEventListener) {
      const visHandler = () => {
        if (doc.visibilityState === "visible") handler();
      };
      doc.addEventListener("visibilitychange", visHandler);
      this.focusCleanup = () => {
        win.removeEventListener?.("focus", handler);
        doc.removeEventListener?.("visibilitychange", visHandler);
      };
    } else {
      this.focusCleanup = () => {
        win.removeEventListener?.("focus", handler);
      };
    }
  }

  private failAll(error: Error): void {
    for (const inbox of this.streams.values()) inboxFail(inbox, error);
  }

  private emitState(state: MuxState): void {
    if (this.lastState !== state) {
      this.lastState = state;
      this.onState?.(state);
    }
  }
}

/** signal.aborted 时立即拒绝的承诺（避免逐轮轮询 abort 状态）。 */
function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) reject(abortError(signal.reason));
    else signal.addEventListener("abort", () => reject(abortError(signal.reason)), { once: true });
  });
}
