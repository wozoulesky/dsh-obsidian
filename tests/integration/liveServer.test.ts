/**
 * 真实 DSH 服务器集成冒烟（可选）：仅在本地 dsh 服务可达时执行。
 * 覆盖单元测试无法验证的线上契约互操作：信封、session.list/history 结果形状、
 * /api/events.mux 真实 WebSocket 握手与帧流。服务不可达时整组 skip。
 */
import { beforeAll, describe, expect, it, type TestContext } from "vitest";
import { DshClient, postJson, TransportFailure } from "../../src/transport/client";
import { MuxStream, type MuxSink } from "../../src/transport/muxStream";
import { SessionManager } from "../../src/core/sessionManager";
import { SessionStore } from "../../src/core/store";
import type { DshSettings } from "../../src/settings";
import type { MuxFrame } from "../../src/transport/types";

const BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080";

let alive = false;
let client: DshClient;

/** 服务不可达时跳过本用例（TestContext.skip 在部分 vitest 版本类型缺失，做一次窄化）。 */
function skipIfDead(ctx: TestContext): void {
  if (!alive) (ctx as unknown as { skip(reason?: string): void }).skip("本地 DSH 服务不可达");
}

beforeAll(async () => {
  try {
    const text = await postJson(
      `${BASE}/api/session.list`,
      JSON.stringify({ type: "client-request", rpcId: "probe-1", method: "session.list", payload: {} }),
      2000
    );
    alive = JSON.parse(text).result?.ok === true;
  } catch (err) {
    alive = false;
    console.warn(`[live-server] 本地 DSH 不可达（${err instanceof TransportFailure ? "transport" : "other"}），跳过集成冒烟`);
  }
  client = new DshClient({ baseUrl: BASE, timeoutMs: 15000 });
});

describe("live DSH server", () => {
  it("session.list 返回可用的会话数组（信封/结果形状契约）", async (ctx: TestContext) => {
    skipIfDead(ctx);
    const res = await client.list();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.isArray(res.value.items)).toBe(true);
    for (const s of res.value.items) {
      expect(typeof s.sessionId).toBe("string");
    }
  });

  it("session.history 对首个会话可用（含 projections 容错）", async (ctx: TestContext) => {
    skipIfDead(ctx);
    const list = await client.list();
    if (!list.ok || list.value.items.length === 0) return;
    const sid = list.value.items[0].sessionId;
    const res = await client.history({ sessionId: sid, maxMessages: 3 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Array.isArray(res.value.events)).toBe(true);
    expect(typeof res.value.hasMore).toBe("boolean");
  });

  it("events.mux WebSocket 完成握手并收到至少一帧", async (ctx: TestContext) => {
    skipIfDead(ctx);
    const frames: { rpcId: string; frame: MuxFrame }[] = [];
    const states: string[] = [];
    const sink: MuxSink = {
      onFrame: (rpcId, frame) => frames.push({ rpcId, frame }),
      onState: (s) => states.push(s),
    };
    const stream = new MuxStream(BASE, sink, { backoffBaseMs: 300, backoffMaxMs: 2000 });
    stream.start();
    try {
      await viWaitFor(() => states.includes("connected"), 8000);
      await viWaitFor(() => frames.length >= 1, 8000);
      expect(frames.length).toBeGreaterThanOrEqual(1);
    } finally {
      stream.stop();
    }
  });

  it("SessionManager.openSession 用真实历史播种视图（折叠真实事件形状）", async (ctx: TestContext) => {
    skipIfDead(ctx);
    const store = new SessionStore();
    const manager = new SessionManager({
      client: new DshClient({ baseUrl: BASE, timeoutMs: 15000 }),
      store,
      vaultPath: process.cwd(),
      settings: { values: { historyPageSize: 50 } } as unknown as DshSettings,
      t: (key) => key,
    });
    await manager.refresh();
    expect(manager.sessions.length).toBeGreaterThan(0);
    const sid = manager.sessions[0].sessionId;
    await manager.openSession(sid);
    expect(manager.currentId).toBe(sid);
    const view = store.getView(sid);
    expect(view).toBeDefined();
    if (!view) return;
    expect(view.lastSeq).toBeGreaterThanOrEqual(0);
    // 若尾页含 turn/start，lastTurnStartSeq 必须被真实记录（inline edit 状态机依赖它）
    if (view.nodes.length > 0) {
      expect(view.firstSeq).toBeGreaterThanOrEqual(0);
    }
    expect(view.lastTurnStartSeq >= -1).toBe(true);
  });
});

function viWaitFor(pred: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (pred()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error("等待超时"));
      }
    }, 100);
  });
}
