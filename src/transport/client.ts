/**
 * DSH 0.1.2-rc.1 客户端（批 2：RPC 层；批 3：openStream 事件流接线）。
 *
 * 契约事实（对照本机 0.1.2-rc.1 官方源码 + 真机实测核实）：
 * - 一元 RPC：POST /api/<namespace>/<method>（斜杠端点）；信封
 *   {type:"client-request", rpcId, method, payload:{args:{...}}}；args 键集合与描述符精确一致，
 *   多余/缺失键被 gateway/arguments-invalid 拒绝。
 * - 认证：请求携带 browser-session 自签 cookie（DshCookieAuth，批 1）。认证失败（DshAuthError）明确传播。
 * - $events/result：waterfall 应答一元 RPC，args {clientId, eventId, outcome}（三态）。
 * - 事件流（批 3）：openStream(endpoint, args, signal?) 走 WS remote.mux 打开流端点
 *   （物理层 RemoteMuxTransport，muxStream.ts），返回帧 AsyncIterable。
 */
import * as http from "http";
import * as https from "https";
import {
  mintId,
  isServerResponse,
  type CancelPayload,
  type CancelResult,
  type ClientRequest,
  type PromptPayload,
  type PromptRequestInput,
  type PromptResult,
  type RemoteEventOutcome,
  type RemoteEventResultArgs,
  type RpcResult,
  type SessionCreatePayload,
  type SessionCreateResult,
  type SessionListResult,
  type SessionPage,
  type SessionPageRequest,
} from "./types";
import { DshAuthError, type DshCookieAuth } from "./auth";
import { RemoteMuxTransport, type RemoteMuxTransportOptions } from "./muxStream";
import { clearTimer, setTimer } from "../utils/timers";

export class TransportFailure extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransportFailure";
  }
}

export interface PostJsonHeaders {
  [name: string]: string | number | undefined;
}

/**
 * Node http/https POST，返回响应文本；非 2xx 或提前断开抛 TransportFailure；硬超时兜底。
 * headers 用于注入 Cookie（批 1 的 DshCookieAuth.cookieHeader()）；保持向后兼容的默认参数。
 */
export function postJson(url: string, body: string, timeoutMs: number, headers?: PostJsonHeaders): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const fail = (err: TransportFailure) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimer(deadline); // 任何失败路径都要清掉硬超时定时器，避免泄漏
      reject(err);
    };
    try {
      const u = new URL(url);
      const isHttps = u.protocol === "https:";
      deadline = setTimer(() => fail(new TransportFailure(`timeout after ${timeoutMs}ms`)), timeoutMs);
      const req = (isHttps ? https : http).request(
        {
          hostname: u.hostname,
          port: u.port ? Number(u.port) : isHttps ? 443 : 80,
          path: u.pathname,
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            ...(headers ?? {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            if (settled) return;
            settled = true;
            if (deadline) clearTimer(deadline);
            const text = Buffer.concat(chunks).toString("utf8");
            if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(text);
            } else {
              reject(new TransportFailure(`HTTP ${String(res.statusCode)} for ${url}`));
            }
          });
          res.on("aborted", () => fail(new TransportFailure(`connection aborted for ${url}`)));
          res.on("close", () => fail(new TransportFailure(`connection closed prematurely for ${url}`)));
          res.on("error", (err) => fail(new TransportFailure(err.message, err)));
        }
      );
      req.setTimeout(timeoutMs, () => req.destroy(new TransportFailure(`timeout after ${timeoutMs}ms`)));
      req.on("error", (err) => fail(new TransportFailure(err.message, err)));
      req.write(body);
      req.end();
    } catch (err) {
      // new URL / http.request 对非法地址会同步抛错：转成 TransportFailure 而不是让调用方裸抛
      fail(new TransportFailure(err instanceof Error ? err.message : String(err), err));
    }
  });
}

export interface DshClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** 批 1 的 cookie 认证器；缺省时不带 Cookie（仅单测/裸探测用，真机必须注入）。 */
  auth?: DshCookieAuth;
  /** 测试注入：cookieHeader 函数（返回完整 Cookie 头值，不含 Cookie: 前缀）。 */
  cookieHeader?: () => Promise<string>;
  /**
   * 测试注入：流物理层（缺省内部构造 RemoteMuxTransport）。
   * 传入时忽略 transport 选项；auth/cookieHeader 若注入则透传给默认物理层。
   */
  streamTransport?: RemoteMuxTransport;
  /** 默认流物理层选项（backoff 参数 / onState 状态回调；批 4 main.ts 接状态栏）。 */
  transportOptions?: RemoteMuxTransportOptions;
}

export class DshClient {
  private readonly stream: RemoteMuxTransport | undefined;

  constructor(private opts: DshClientOptions) {
    if (!opts.streamTransport) {
      this.stream = new RemoteMuxTransport(opts.baseUrl, {
        auth: opts.auth,
        cookieHeader: opts.cookieHeader,
        onState: opts.transportOptions?.onState,
        backoffBaseMs: opts.transportOptions?.backoffBaseMs,
        backoffMaxMs: opts.transportOptions?.backoffMaxMs,
      });
    } else {
      this.stream = opts.streamTransport;
    }
  }

  /** 流物理层实例（批 4 main.ts 用 start()/stop()/state 接管生命周期）。 */
  get mux(): RemoteMuxTransport {
    return this.stream as RemoteMuxTransport;
  }

  private async authHeader(): Promise<PostJsonHeaders> {
    if (this.opts.cookieHeader) return { cookie: await this.opts.cookieHeader() };
    if (this.opts.auth) return { cookie: await this.opts.auth.cookieHeader() };
    return {};
  }

  /** 通用一元调用：铸造 rpcId → POST /api/<method>（payload 已包 {args:{...}}）→ 校验回显 → 返回 result。 */
  async call<T>(method: string, args: Record<string, unknown>, overrides?: { forceRpcId?: string }): Promise<RpcResult<T>> {
    const rpcId = overrides?.forceRpcId ?? mintId();
    const request: ClientRequest = { type: "client-request", rpcId, method, payload: { args } };
    const timeoutMs = this.opts.timeoutMs ?? 30000;
    let headers: PostJsonHeaders;
    try {
      headers = await this.authHeader();
    } catch (err) {
      // 认证失败（DshAuthError）明确传播，不静默吞：上层据此提示「DSH 凭据不可读」
      throw err instanceof DshAuthError ? err : new DshAuthError(err instanceof Error ? err.message : String(err), err);
    }
    const text = await postJson(`${this.opts.baseUrl}/api/${method}`, JSON.stringify(request), timeoutMs, headers);
    let full: unknown;
    try {
      full = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: { code: "internal", message: "DSH 返回了无法解析的响应" },
      };
    }
    if (!isServerResponse(full)) {
      return { ok: false, error: { code: "internal", message: "DSH 响应信封格式非法" } };
    }
    if (full.rpcId !== rpcId) {
      return {
        ok: false,
        error: { code: "internal", message: `rpcId 不匹配：发送 ${rpcId}，收到 ${full.rpcId}` },
      };
    }
    const result = full.result as RpcResult<T>;
    if (result.ok === false) {
      const err = (result as { error?: { code?: unknown; message?: unknown } }).error;
      if (!err || typeof err.message !== "string" || typeof err.code !== "string") {
        // 畸形错误结果（线上契约漂移）归一化，避免上层直接访问 error.message 崩溃
        return { ok: false, error: { code: "internal", message: "DSH 返回了非法的错误结果" } };
      }
    }
    return result;
  }

  /**
   * 打开一个远程流端点（session/follow、session/control、$events 等），返回帧 AsyncIterable。
   * 批 3 实现：remote.mux 物理层（WS 握手 + open/cancel/item/end/error 帧协议）。
   * - session/follow：args {request:{address, maxMessages?}} → SessionFollowFrame 帧
   * - session/control：args {} → SessionControlFrame 帧
   * - $events：args {} → RemoteEventDownlinkFrame 帧（首帧 {type:"ready"} 的 clientId 必须留存用于 answerEvent）
   * 参数透传语义：除 $events（恒空 args）外一律包 {request: args} 与线上描述符一致；
   * signal abort 会发 cancel 帧并终止迭代。
   */
  openStream<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<AsyncIterable<T>> {
    return Promise.resolve(this.mux.open<T>(endpoint, args, signal));
  }

  /**
   * waterfall 应答（$events/result 一元 RPC）：clientId 来自 $events 流 ready 帧，eventId 来自 waterfall 帧。
   * 成功值官方为 undefined（dispatchRpc 返回 {ok:true, value:void 0}），批 4 只关心 ok 与否。
   */
  answerEvent(clientId: string, eventId: string, outcome: RemoteEventOutcome): Promise<RpcResult<undefined>> {
    // RemoteEventResultArgs 无索引签名：需要转 Record<string, unknown>（接口化的契约类型不隐式兼容）
    const args: RemoteEventResultArgs = { clientId, eventId, outcome };
    return this.call<undefined>("$events/result", args as unknown as Record<string, unknown>);
  }

  list(): Promise<RpcResult<SessionListResult>> {
    return this.call<SessionListResult>("session/list", { _request: {} });
  }

  create(payload: SessionCreatePayload): Promise<RpcResult<SessionCreateResult>> {
    return this.call<SessionCreateResult>("session/create", { request: payload });
  }

  /** prompt：客户端自铸 requestId（UUID），必填；缺省时 mintId 补上。 */
  prompt(payload: PromptRequestInput): Promise<RpcResult<PromptResult>> {
    const request: PromptPayload = { ...payload, requestId: payload.requestId ?? mintId() };
    return this.call<PromptResult>("session/prompt", { request });
  }

  /** 分页历史（新契约）：address 为 {kind:"session", sessionId}，throughSeq 必填（-1 = 到尾）。 */
  page(payload: SessionPageRequest): Promise<RpcResult<SessionPage>> {
    return this.call<SessionPage>("session/page", { request: payload });
  }

  cancel(payload: CancelPayload): Promise<RpcResult<CancelResult>> {
    return this.call<CancelResult>("session/cancel", { request: payload });
  }
}
