import * as http from "http";
import { mintId, isServerResponse, type ClientRequest, type ClientResponse, type RpcResult, type RpcReceipt, type ServerResponse, type HistoryPayload, type HistoryResult, type PromptPayload, type PromptResult, type SessionCreatePayload, type SessionCreateResult, type SessionListResult, type CancelPayload, type CancelResult } from "./types";

export class TransportFailure extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransportFailure";
  }
}

/** Node http POST，返回响应文本；非 2xx 或提前断开抛 TransportFailure；硬超时兜底。 */
export function postJson(url: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const u = new URL(url);
    let settled = false;
    const fail = (err: TransportFailure) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const deadline = setTimeout(() => fail(new TransportFailure(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 80,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          clearTimeout(deadline);
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
    req.on("error", (err) => {
      clearTimeout(deadline);
      fail(new TransportFailure(err.message, err));
    });
    req.write(body);
    req.end();
  });
}

export interface DshClientOptions {
  baseUrl: string;
  timeoutMs?: number;
}

export class DshClient {
  constructor(private opts: DshClientOptions) {}

  /** 通用一元调用：铸造 rpcId → POST /api/<method> → 校验回显 → 返回 result。 */
  async call<T>(method: string, payload: unknown, overrides?: { forceRpcId?: string }): Promise<RpcResult<T>> {
    const rpcId = overrides?.forceRpcId ?? mintId();
    const request: ClientRequest = { type: "client-request", rpcId, method, payload };
    const timeoutMs = this.opts.timeoutMs ?? 30000;
    const text = await postJson(`${this.opts.baseUrl}/api/${method}`, JSON.stringify(request), timeoutMs);
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
    return full.result as RpcResult<T>;
  }

  /** 应答服务端请求（审批/提问），rpcId 必须回显请求帧的信封 rpcId。 */
  async respond<T>(rpcId: string, value: T): Promise<RpcReceipt> {
    const message: ClientResponse = { type: "client-response", rpcId, result: { ok: true, value } };
    const timeoutMs = this.opts.timeoutMs ?? 30000;
    const text = await postJson(`${this.opts.baseUrl}/api/respond`, JSON.stringify(message), timeoutMs);
    let receipt: RpcReceipt;
    try {
      receipt = JSON.parse(text) as RpcReceipt;
    } catch {
      return { accepted: false, reason: "bad-response" };
    }
    if (receipt.accepted === true) return receipt;
    if (receipt.accepted === false) return receipt;
    return { accepted: false, reason: "bad-response" };
  }

  list(): Promise<RpcResult<SessionListResult>> {
    return this.call<SessionListResult>("session.list", {});
  }

  create(payload: SessionCreatePayload): Promise<RpcResult<SessionCreateResult>> {
    return this.call<SessionCreateResult>("session.create", payload);
  }

  prompt(payload: PromptPayload): Promise<RpcResult<PromptResult>> {
    return this.call<PromptResult>("session.prompt", payload);
  }

  history(payload: HistoryPayload): Promise<RpcResult<HistoryResult>> {
    return this.call<HistoryResult>("session.history", payload);
  }

  cancel(payload: CancelPayload): Promise<RpcResult<CancelResult>> {
    return this.call<CancelResult>("session.cancel", payload);
  }
}
