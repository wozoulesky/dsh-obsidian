/**
 * 真实 DSH 服务器集成冒烟（可选）：仅在本地 dsh 服务可达时执行。
 * 批 2（RPC 层）范围：探测改为新契约（cookie 认证 + 斜杠端点 + args 包装），
 * 只保留 session/list 形状用例；WS 流（remote.mux）与 SessionManager 播种用例依赖
 * 批 3/4 交付物，届时补回。服务不可达/凭据不可读时整组 skip。
 */
import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import { DshClient, TransportFailure } from "../../src/transport/client";
import { DshCookieAuth, DshAuthError } from "../../src/transport/auth";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

let alive = false;
let client: DshClient;

/** 服务不可达时跳过本用例（TestContext.skip 在部分 vitest 版本类型缺失，做一次窄化）。 */
function skipIfDead(ctx: TestContext): void {
  if (!alive) (ctx as unknown as { skip(reason?: string): void }).skip("本地 DSH 服务不可达");
}

beforeAll(async () => {
  try {
    const auth = new DshCookieAuth({ baseUrl: BASE });
    const cookie = await auth.cookieHeader();
    client = new DshClient({ baseUrl: BASE, timeoutMs: 15000, cookieHeader: () => Promise.resolve(cookie) });
    const res = await client.list();
    alive = res.ok === true;
    if (!alive && !res.ok) {
      console.warn(`[live-server] 本地 DSH 探测失败（业务错误 ${res.error.code}），跳过集成冒烟`);
    }
  } catch (err) {
    alive = false;
    if (err instanceof DshAuthError) {
      console.warn(`[live-server] DSH 凭据不可读（${err.message}），跳过集成冒烟`);
    } else {
      console.warn(`[live-server] 本地 DSH 不可达（${err instanceof TransportFailure ? "transport" : "other"}），跳过集成冒烟`);
    }
  }
});

describe("live DSH server", () => {
  it("session.list（新契约）返回可用的会话数组（信封/结果形状契约）", async (ctx: TestContext) => {
    skipIfDead(ctx);
    const res = await client.list();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.isArray(res.value.items)).toBe(true);
    for (const s of res.value.items) {
      expect(typeof s.sessionId).toBe("string");
      expect(typeof s.updatedAt).toBe("number");
      expect(typeof s.running).toBe("boolean");
      expect(typeof s.blank).toBe("boolean");
      if (s.projections) {
        expect(typeof s.projections.asOfSeq).toBe("number");
        expect(typeof s.projections.values).toBe("object");
      }
    }
  });

  it("session/page 对 throughSeq:-1 返回合法空页形状（records 数组 + hasMore 布尔）", async (ctx: TestContext) => {
    skipIfDead(ctx);
    const list = await client.list();
    if (!list.ok || list.value.items.length === 0) return;
    // 只对普通会话探测（subagent 会话的 page 需要 parent 地址形态）
    const regular = list.value.items.find((s) => s.origin !== "subagent");
    if (!regular) return;
    const res = await client.page({ address: { kind: "session", sessionId: regular.sessionId }, throughSeq: -1, maxMessages: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.isArray(res.value.records)).toBe(true);
    expect(typeof res.value.hasMore).toBe("boolean");
  });
});
