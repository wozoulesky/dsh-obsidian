/**
 * 批 3 remote.mux 物理层单测：真实 WS mock（WebSocketServer）。
 *
 * 覆盖：
 * - open/收 item/收 end；error 帧（RemoteStreamError）
 * - 多流复用（两个 streamId 互不串流）；item 无 value 合法
 * - 消费方提前 return → cancel 帧发出
 * - 坏帧 → 物理连接 close(4002) + 活跃流终止
 * - 断线 → 活跃流以错误终止 + 自动重连（状态转换）
 * - Cookie header 在握手头里（注入假 cookieHeader）
 * - backoffDelay 纯函数；stop 阻止重连
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import * as net from "net";
import {
  RemoteMuxTransport,
  RemoteStreamCarrierError,
  RemoteStreamError,
  backoffDelay,
  INVALID_FRAME_CLOSE_CODE,
  parseRemoteStreamServerMessage,
} from "../../src/transport/muxStream";

let wss: WebSocketServer;
let port = 0;
/** 每次测试重置：accept 的 socket + 收到客户端帧 + 握手头。 */
let sockets: WebSocket[] = [];
let received: Array<Record<string, unknown>> = [];
let headersSeen: Array<Record<string, string | string[] | undefined>> = [];

function waitFor<T>(fn: () => T, timeoutMs = 2000, label = "condition"): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      const value = fn();
      if (value !== undefined && value !== null && value !== false) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timeout waiting for ${label}`));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

beforeAll(async () => {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  port = (wss.address() as { port: number }).port;
  wss.on("connection", (ws, req) => {
    sockets.push(ws);
    headersSeen.push({ ...req.headers });
    ws.on("message", (data) => {
      try {
        received.push(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        received.push({ raw: data.toString() });
      }
    });
  });
});

afterAll(async () => {
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

beforeEach(() => {
  sockets = [];
  received = [];
  headersSeen = [];
});

const FIXED_COOKIE = "dsh-auth-fixed=fake.v1.cookie";

function makeTransport(extra?: {
  baseUrl?: string;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  cookieHeader?: () => Promise<string>;
  onState?: (s: string) => void;
}): { transport: RemoteMuxTransport; states: string[] } {
  const states: string[] = [];
  const transport = new RemoteMuxTransport(extra?.baseUrl ?? `http://127.0.0.1:${port}`, {
    backoffBaseMs: extra?.backoffBaseMs ?? 20,
    backoffMaxMs: extra?.backoffMaxMs ?? 500,
    cookieHeader: extra?.cookieHeader ?? (() => Promise.resolve(FIXED_COOKIE)),
    onState: extra?.onState ?? ((s) => states.push(s)),
  });
  return { transport, states };
}

/** 服务端对 streamId 发 item/end。 */
function serverSend(ws: WebSocket, frame: Record<string, unknown>): void {
  ws.send(JSON.stringify(frame));
}

describe("RemoteMuxTransport 物理连接不变量", () => {
  /**
   * 回归：`connect()` 内 `finish()` 闭包引用了 `const promise`，而 `finish` 可能在
   * `promise` 初始化完成之前被同步调用 —— 典型触发是 `new WebSocket()` 抛同步异常
   * （baseUrl 非法 / URL 拼装出错）。此时 `this.pendingConnect === promise` 会执行到
   * 「访问尚未初始化的 const」→ ReferenceError: Cannot access 'promise' before initialization。
   *
   * 这个错误比原始失败更糟：它替换掉了真正的原因（URL 非法），让排查方向跑偏。
   * 正确行为：连接尝试被拒绝、pendingConnect 被清空、可再次重试，且不得抛 ReferenceError。
   */
  it("new WebSocket() 同步抛错时不触发 TDZ ReferenceError，且允许后续重试", async () => {
    // 不注入 cookieHeader/auth：this.cookie 为 undefined，connect() 会**同步**走到
    // new WebSocket()，这正是 finish() 早于 const promise 初始化的唯一路径。
    //
    // 可观测的确定性差异：TDZ 版里 finish() 在给 pendingConnect 清空之前就抛了，
    // 于是 promise 永不结算、pendingConnect 被永久占位 —— 后续 open() 会一直挂住，
    // 插件从此再也无法重连（比原始「URL 非法」错误严重得多）。
    // 修复后：错误路径干净落地，open() 拿到 rejection 而不是永久挂起。
    const transport = new RemoteMuxTransport("not-a-url", {
      backoffBaseMs: 20,
      backoffMaxMs: 100,
      onState: () => {},
    });

    // 先让一次连接尝试失败（同步抛错路径）
    transport.start();
    await new Promise((r) => setTimeout(r, 30));

    // 关键断言：后续 open() 必须能落地（reject 或被重连打断），不能永久挂住。
    // 用 Promise.race 给 1s 预算：TDZ 版会超时（= 挂住），修复版会很快 reject。
    const iter = transport.open("session/follow", {})[Symbol.asyncIterator]();
    const outcome = await Promise.race([
      iter.next().then(
        () => "resolved",
        () => "rejected" as const
      ),
      new Promise((r) => setTimeout(() => r("hung" as const), 1000)),
    ]);

    expect(outcome).not.toBe("hung"); // 永久挂住 = TDZ 回归
    transport.stop();
  });

  /**
   * 回归：start() 与 open() 并发时只能发起一次连接尝试。
   *
   * 历史缺陷：start() 直接调 connect() 却没把这次尝试登记进 pendingConnect，
   * 于是紧随其后的 open() → streamIter() → waitForSocket() 看到 pendingConnect 为 null，
   * 又发起第二次 connect()。服务端因此 accept 两条 WS：item 帧回到 socket A，
   * 而 this.socket 指向 socket B，receive() 里的 `this.socket !== socket` 守卫把帧静默丢弃，
   * 迭代器永远等不到数据（真实表现就是「open 发 open 帧」那条用例 15s 超时）。
   *
   * 断言的确定性来源：`connect()` 每次进入都会先调一次 cookieHeader（见 muxStream.ts:336），
   * 所以「cookieHeader 被调用几次」== 「发起了几次连接尝试」，不依赖两个 socket 谁先握手成功。
   * 这里让 cookieHeader 先挂起，把窗口撑开，再在挂起期间调用 open()。
   */
  it("start() 与 open() 并发时只发起一次连接尝试（防双连丢帧）", async () => {
    let releaseCookie: (() => void) | null = null;
    const cookieGate = new Promise<void>((resolve) => {
      releaseCookie = resolve;
    });
    let cookieCalls = 0;
    const { transport } = makeTransport({
      cookieHeader: async () => {
        cookieCalls += 1;
        await cookieGate;
        return FIXED_COOKIE;
      },
    });

    transport.start();
    await new Promise((r) => setTimeout(r, 20)); // 让 start() 的 connect() 走到 await cookie()
    expect(cookieCalls).toBe(1);

    // 连接仍在挂起（pendingConnect 应为非 null）——此时 open() 不得再发一次连接
    const iter = transport.open<{ type: "snapshot" }>("session/follow", { request: {} })[Symbol.asyncIterator]();
    const first = iter.next();
    await new Promise((r) => setTimeout(r, 20));

    // 关键断言：一次 start + 一次 open == 一次连接尝试
    expect(cookieCalls).toBe(1);

    releaseCookie!();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");

    const openFrame = received.find((m) => m.type === "open") as Record<string, unknown>;
    serverSend(sockets[0], { type: "item", streamId: openFrame.streamId, value: { type: "snapshot" } });
    await expect(first).resolves.toEqual({ done: false, value: { type: "snapshot" } });
    expect(sockets.length).toBe(1);
    transport.stop();
  });
});

describe("RemoteMuxTransport 帧协议", () => {
  it("open 发 open 帧（endpoint/payload），收 item 帧产出 value", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");

    const iter = transport.open<{ type: "snapshot" }>("session/follow", {
      request: { address: { kind: "session", sessionId: "s1" }, maxMessages: 50 },
    })[Symbol.asyncIterator]();
    const first = iter.next();

    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const openFrame = received.find((m) => m.type === "open") as Record<string, unknown>;
    expect(openFrame.endpoint).toBe("session/follow");
    expect(openFrame.payload).toEqual({ args: { request: { address: { kind: "session", sessionId: "s1" }, maxMessages: 50 } } });
    expect(typeof openFrame.streamId).toBe("string");
    expect((openFrame.streamId as string).length).toBeGreaterThan(0);

    serverSend(sockets[0], { type: "item", streamId: openFrame.streamId, value: { type: "snapshot", cursor: 5 } });
    await expect(first).resolves.toEqual({ done: false, value: { type: "snapshot", cursor: 5 } });
    transport.stop();
  });

  it("服务端 end 帧正常结束迭代", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const iter = transport.open("session/control", {})[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const streamId = (received.find((m) => m.type === "open") as { streamId: string }).streamId;
    serverSend(sockets[0], { type: "end", streamId });
    await expect(first).resolves.toEqual({ done: true, value: undefined });
    transport.stop();
  });

  it("error 帧抛 RemoteStreamError（code/message/details）", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const iter = transport.open("session/follow", { request: { address: { kind: "session", sessionId: "gone" } } })[
      Symbol.asyncIterator
    ]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const rejection = expect(first).rejects.toBeInstanceOf(RemoteStreamError);
    const streamId = (received.find((m) => m.type === "open") as { streamId: string }).streamId;
    serverSend(sockets[0], {
      type: "error",
      streamId,
      error: { code: "session/not-found", message: 'session "gone" not found', details: { sessionId: "gone" } },
    });
    await rejection;
    await expect(first).rejects.toMatchObject({ code: "session/not-found", details: { sessionId: "gone" } });
    transport.stop();
  });

  it("item 无 value 也合法（value=undefined 产出）", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const iter = transport.open<unknown>("$events", {})[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const streamId = (received.find((m) => m.type === "open") as { streamId: string }).streamId;
    serverSend(sockets[0], { type: "item", streamId });
    await expect(first).resolves.toEqual({ done: false, value: undefined });
    transport.stop();
  });
});

describe("RemoteMuxTransport 多流复用", () => {
  it("两个逻辑流共用一条物理连接，帧互不串流", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");

    const a = transport.open<{ stream: string }>("session/control", {})[Symbol.asyncIterator]();
    const b = transport.open<{ stream: string }>("session/control", {})[Symbol.asyncIterator]();
    const an = a.next();
    const bn = b.next();
    await waitFor(() => received.filter((m) => m.type === "open").length === 2, 2000, "two open frames");
    const [openA, openB] = received.filter((m) => m.type === "open") as Array<{ streamId: string }>;

    serverSend(sockets[0], { type: "item", streamId: openB.streamId, value: { stream: "b1" } });
    await expect(bn).resolves.toEqual({ done: false, value: { stream: "b1" } });
    serverSend(sockets[0], { type: "item", streamId: openA.streamId, value: { stream: "a1" } });
    await expect(an).resolves.toEqual({ done: false, value: { stream: "a1" } });

    // 互不串流：各自继续收自己的帧
    const an2 = a.next();
    serverSend(sockets[0], { type: "item", streamId: openA.streamId, value: { stream: "a2" } });
    await expect(an2).resolves.toEqual({ done: false, value: { stream: "a2" } });
    serverSend(sockets[0], { type: "end", streamId: openB.streamId });
    const bn2 = b.next();
    await expect(bn2).resolves.toEqual({ done: true, value: undefined });

    expect(sockets.length).toBe(1); // 只有一个物理连接
    transport.stop();
  });
});

describe("RemoteMuxTransport cancel 与消费方终止", () => {
  it("消费方提前 return → 发 cancel 帧", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const iter = transport.open("session/control", {})[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const streamId = (received.find((m) => m.type === "open") as { streamId: string }).streamId;
    serverSend(sockets[0], { type: "item", streamId, value: { type: "baseline" } });
    await expect(first).resolves.toEqual({ done: false, value: { type: "baseline" } });
    await iter.return?.(undefined);
    await waitFor(() => received.some((m) => m.type === "cancel" && m.streamId === streamId), 2000, "cancel frame");
    transport.stop();
  });

  it("AbortSignal 中止 → 迭代抛错 + 发 cancel 帧", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const controller = new AbortController();
    const iter = transport.open("session/control", {}, controller.signal)[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const streamId = (received.find((m) => m.type === "open") as { streamId: string }).streamId;
    const rejection = expect(first).rejects.toThrow("user cancelled");
    controller.abort(new Error("user cancelled"));
    await rejection;
    await waitFor(() => received.some((m) => m.type === "cancel" && m.streamId === streamId), 2000, "cancel frame");
    transport.stop();
  });

  it("连接未建立（open 帧未发出）时 abort → 迭代立即抛错不挂起（!opened 哨兵路径）", async () => {
    // 无服务端口：socket 永远连不上，open 帧无从发出（opened=false）
    const tmpPort = await new Promise<number>((resolve) => {
      const probe = new net.Server();
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        probe.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
      });
    });
    const { transport } = makeTransport({ baseUrl: `http://127.0.0.1:${tmpPort}`, backoffBaseMs: 5000, backoffMaxMs: 5000 });
    const controller = new AbortController();
    transport.start();
    const iter = transport.open("session/control", {}, controller.signal)[Symbol.asyncIterator]();
    const first = iter.next();
    const rejection = expect(first).rejects.toThrow("user cancelled");
    controller.abort(new Error("user cancelled"));
    await rejection; // 若不立即抛错，本断言会超时失败
    transport.stop();
  });

  it("stop 后 start 复活：建立新连接且陈旧定时器不触发第二条", async () => {
    const { transport } = makeTransport({ backoffBaseMs: 100 });
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const countAfterStart = sockets.length;
    transport.stop();
    await new Promise((r) => setTimeout(r, 200));
    expect(sockets.length).toBe(countAfterStart); // stop 后不再新建连接
    transport.start();
    await waitFor(() => sockets.length === countAfterStart + 1, 2000, "reconnected after restart");
    await new Promise((r) => setTimeout(r, 300));
    expect(sockets.length).toBe(countAfterStart + 1); // 陈旧定时器不触发第二条
    transport.stop();
  });
});

describe("RemoteMuxTransport 坏帧与断线", () => {
  it("坏帧（非法 JSON）→ 物理连接 close(4002) + 活跃流以 RemoteStreamCarrierError 终止", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const iter = transport.open("session/control", {})[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    // 先挂上拒绝断言（流拒绝先于 close 事件触发，避免 unhandledRejection 噪音）
    const rejection = expect(first).rejects.toBeInstanceOf(RemoteStreamCarrierError);
    const closeCode = await new Promise<number>((resolve) => {
      sockets[0].on("close", (code) => resolve(code));
      sockets[0].send("not-json{{{");
    });
    expect(closeCode).toBe(INVALID_FRAME_CLOSE_CODE);
    await rejection;
    transport.stop();
  });

  it("结构非法帧（type 未知）同样 4002 + fail 流", async () => {
    const { transport } = makeTransport();
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const iter = transport.open("session/control", {})[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const rejection = expect(first).rejects.toBeInstanceOf(RemoteStreamCarrierError);
    const closeCode = await new Promise<number>((resolve) => {
      sockets[0].on("close", (code) => resolve(code));
      sockets[0].send(JSON.stringify({ type: "nonsense", streamId: "x" }));
    });
    expect(closeCode).toBe(INVALID_FRAME_CLOSE_CODE);
    await rejection;
    transport.stop();
  });

  it("断线 → 活跃流以 RemoteStreamCarrierError 终止（不挂起）+ 自动重连 + 状态转换", async () => {
    const { transport, states } = makeTransport({ backoffBaseMs: 20, backoffMaxMs: 200 });
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    await waitFor(() => states.includes("connected"), 2000, "connected state");
    const iter = transport.open("session/control", {})[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const rejection = expect(first).rejects.toBeInstanceOf(RemoteStreamCarrierError);

    sockets[0].close(); // 服务端断开
    await rejection;

    // 自动重连：出现第二条连接
    await waitFor(() => sockets.length >= 2, 4000, "reconnected socket");
    expect(states.filter((s) => s === "reconnecting").length).toBeGreaterThanOrEqual(1);
    // 重连后可以再开流
    const iter2 = transport.open("session/control", {})[Symbol.asyncIterator]();
    const first2 = iter2.next();
    await waitFor(() => received.filter((m) => m.type === "open").length >= 2, 4000, "second open frame");
    const secondOpen = received.filter((m) => m.type === "open").pop() as { streamId: string };
    serverSend(sockets[sockets.length - 1], { type: "item", streamId: secondOpen.streamId, value: { type: "baseline" } });
    await expect(first2).resolves.toEqual({ done: false, value: { type: "baseline" } });
    transport.stop();
  });

  it("stop 阻止重连且 fail 活跃流", async () => {
    const { transport } = makeTransport({ backoffBaseMs: 20 });
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    const iter = transport.open("session/control", {})[Symbol.asyncIterator]();
    const first = iter.next();
    await waitFor(() => received.some((m) => m.type === "open"), 2000, "open frame");
    const countAfterFirst = sockets.length;
    const rejection = expect(first).rejects.toBeInstanceOf(RemoteStreamCarrierError);
    transport.stop();
    await rejection;
    await new Promise((r) => setTimeout(r, 200));
    expect(sockets.length).toBe(countAfterFirst); // 不再新建连接
  });
});

describe("RemoteMuxTransport 握手与杂项", () => {
  it("握手头携带注入的 Cookie", async () => {
    const { transport } = makeTransport({ cookieHeader: () => Promise.resolve(FIXED_COOKIE) });
    transport.start();
    await waitFor(() => sockets.length > 0, 2000, "socket connected");
    expect(headersSeen[0]?.cookie).toBe(FIXED_COOKIE);
    transport.stop();
  });

  it("连接失败（端口无监听）后自动退避重连：服务器稍后出现 → connected", async () => {
    // 先占住一个端口再关掉：确保初始连接一定失败（ECONNREFUSED）
    const tmpPort = await new Promise<number>((resolve) => {
      const probe = new net.Server();
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        probe.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
      });
    });
    const states: string[] = [];
    const dead = new RemoteMuxTransport(`http://127.0.0.1:${tmpPort}`, {
      backoffBaseMs: 30,
      backoffMaxMs: 200,
      cookieHeader: () => Promise.resolve(FIXED_COOKIE),
      onState: (s) => states.push(s),
    });
    dead.start();
    expect(states).toContain("reconnecting");
    await new Promise((r) => setTimeout(r, 120)); // 经历 ≥1 次失败重试周期
    // 服务器出现：退避中的连接尝试随后成功
    const late = new WebSocketServer({ host: "127.0.0.1", port: tmpPort });
    await new Promise<void>((resolve) => late.once("listening", resolve));
    await waitFor(() => states.includes("connected"), 4000, "connected after retry");
    dead.stop();
    for (const client of late.clients) client.terminate();
    await new Promise<void>((resolve) => late.close(() => resolve()));
  });

  it("ECONNREFUSED 后必须重新通知状态，否则状态栏读不到 serviceDown、永远停在「重连中…」", async () => {
    // 真机复现（2026-10-01）：杀掉入口 35 秒后状态栏仍是「DSH 重连中…」，
    // 因为 serviceDown 在 onState 之后才翻 true，而 emitState 的去重把后续通知全吞了。
    // 断言写成「必须有一次回调时 serviceDown 已经为 true」——这才是 UI 能改口的前提。
    const tmpPort = await new Promise<number>((resolve) => {
      const probe = new net.Server();
      probe.listen(0, "127.0.0.1", () => {
        const addr = probe.address();
        probe.close(() => resolve(typeof addr === "object" && addr ? addr.port : 0));
      });
    });
    const downAtCallback: boolean[] = [];
    const dead = new RemoteMuxTransport(`http://127.0.0.1:${tmpPort}`, {
      backoffBaseMs: 30,
      backoffMaxMs: 200,
      cookieHeader: () => Promise.resolve(FIXED_COOKIE),
      onState: () => downAtCallback.push(dead.serviceDown),
    });
    dead.start();
    await waitFor(() => dead.serviceDown, 2000, "serviceDown");
    await waitFor(() => downAtCallback.includes(true), 2000, "带 serviceDown=true 的状态通知");
    dead.stop();
  });

  it("backoffDelay 是指数增长并封顶的纯函数", () => {
    expect(backoffDelay(1, 100, 1000)).toBe(100);
    expect(backoffDelay(2, 100, 1000)).toBe(200);
    expect(backoffDelay(3, 100, 1000)).toBe(400);
    expect(backoffDelay(4, 100, 1000)).toBe(800);
    expect(backoffDelay(5, 100, 1000)).toBe(1000); // cap
    expect(backoffDelay(10, 100, 1000)).toBe(1000); // 保持封顶
    expect(backoffDelay(0, 100, 1000)).toBe(100); // 防御：非正 attempt 按 1 处理
  });

  it("parseRemoteStreamServerMessage 严格校验（合法帧通过 / 非法帧抛错）", () => {
    expect(parseRemoteStreamServerMessage(JSON.stringify({ type: "item", streamId: "s" }))).toEqual({
      type: "item",
      streamId: "s",
    });
    expect(() => parseRemoteStreamServerMessage("not-json")).toThrow(/not JSON/);
    expect(() => parseRemoteStreamServerMessage(JSON.stringify({ type: "nonsense", streamId: "s" }))).toThrow(/invalid/);
    expect(() => parseRemoteStreamServerMessage(JSON.stringify({ type: "end", streamId: "" }))).toThrow(/invalid/);
    expect(() =>
      parseRemoteStreamServerMessage(JSON.stringify({ type: "error", streamId: "s", error: { code: "x" } }))
    ).toThrow(/invalid/);
    expect(() =>
      parseRemoteStreamServerMessage(JSON.stringify({ type: "item", streamId: "s", value: 1, extra: true }))
    ).toThrow(/invalid/);
  });
});

/**
 * 真机场景：DSH 桌面端每次启动都换随机端口（`--port 0`）。
 *
 * Obsidian 长时间开着 → 用户重启 DSH → 新端口 → 旧 baseUrl 上不再有服务。
 * mux 的重连是无限退避重试**同一个 baseUrl**（`scheduleReconnect` 只调 `connect()`，
 * 而 `baseUrl` 是构造参数、没有 setter），所以它会永远连一个死地址——
 * 状态栏停在「DSH 未运行」，且**永远不会重新发现新端口**。
 *
 * 这个文件钉住的是物理层的既有行为（它没有义务重新发现端口）：
 * 一旦 baseUrl 定死，重连只会打同一个地址。真正该补的兜底在 main.ts —— 连续重连失败后
 * 重新跑一次 discoverDshUrls() 并热替换 client。这条断言是那个兜底存在的理由。
 */
describe("RemoteMuxTransport 端口固定性（为什么 main.ts 需要重发现兜底）", () => {
  it("baseUrl 是构造期固定的：重连反复打同一个地址，不会自行改端口", async () => {
    const seenPorts: number[] = [];
    // 一个没有服务监听的端口，模拟「DSH 重启后旧端口已关闭」
    const deadPort = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });

    const transport = new RemoteMuxTransport(`http://127.0.0.1:${deadPort}`, {
      backoffBaseMs: 15,
      backoffMaxMs: 30,
    });
    // 记录每次实际拨号的目标端口
    const originalMuxUrl = transport.muxUrl.bind(transport);
    vi.spyOn(transport, "muxUrl").mockImplementation(() => {
      const url = originalMuxUrl();
      seenPorts.push(Number(new URL(url.replace(/^ws/, "http")).port));
      return url;
    });

    transport.start();
    await new Promise((r) => setTimeout(r, 3000));

    expect(seenPorts.length).toBeGreaterThan(1); // 确实在反复重连
    // 所有重试都打同一个死端口 —— 没有任何一次指向新端口
    expect(new Set(seenPorts)).toEqual(new Set([deadPort]));
    expect(transport.state).toBe("reconnecting");
    transport.stop();
  });
});

/**
 * 端口热切换：`rebindBaseUrl(newUrl)`。
 *
 * 场景（真机高频）：DSH 桌面端每次启动换随机端口，Obsidian 一直开着。
 * mux 的重连只会打构造期固定的 baseUrl，因此必须有人能**原地换地址**并立刻重连。
 *
 * 约束（都是踩过的坑）：
 * - 必须保持 transport 实例身份不变：manager/approvals/globalStreams 都持有它，
 *   换实例等于要重挂整条 runtime。
 * - 必须复位退避与 refused 粘性标记：否则新地址首连失败会沿用旧地址的退避档位，
 *   状态栏也会因为 refusedSinceOpen 仍为 true 而错误显示「DSH 未运行」。
 * - 旧 socket 必须关闭、在途代必须失效，否则旧地址的帧会串进新连接。
 */
describe("RemoteMuxTransport rebindBaseUrl（DSH 换端口后热切换）", () => {
  it("换地址后 muxUrl 指向新地址，且复位退避与 refused 标记", async () => {
    const deadPort = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });

    const transport = new RemoteMuxTransport(`http://127.0.0.1:${deadPort}`, {
      backoffBaseMs: 15,
      backoffMaxMs: 20,
    });
    transport.start();
    // 等它连续失败几次，把 attempt 推高并让 refusedSinceOpen 粘上
    await new Promise((r) => setTimeout(r, 600));
    expect(transport.serviceDown).toBe(true);

    const newUrl = `http://127.0.0.1:${port}`;
    transport.rebindBaseUrl(newUrl);

    expect(transport.muxUrl()).toBe(`ws://127.0.0.1:${port}/api/remote.mux`);
    // 换地址即代表「上一处的失败不再代表当前状态」
    expect(transport.serviceDown).toBe(false);

    // 新地址是这个测试文件里活着的 wss：应当能连上
    await waitFor(() => transport.state === "connected", 3000, "connected after rebind");
    transport.stop();
  });

  it("旧地址的 socket 会被关闭，不会把旧连接上的帧串进新连接", async () => {
    const before = sockets.length;
    const transport = new RemoteMuxTransport(`http://127.0.0.1:${port}`, { backoffBaseMs: 15, backoffMaxMs: 20 });
    transport.start();
    await waitFor(() => transport.state === "connected", 3000, "initial connected");
    expect(sockets.length).toBeGreaterThan(before);
    const firstSocket = sockets.at(-1)!;

    // 换到同一个地址也要走一遍关闭+重连（幂等且不留下双连）
    transport.rebindBaseUrl(`http://127.0.0.1:${port}`);
    await waitFor(() => firstSocket.readyState === 3 /* CLOSED */, 3000, "old socket closed");
    await waitFor(() => transport.state === "connected", 3000, "reconnected after rebind");
    transport.stop();
  });
});

/**
 * rebind 必须同时换凭据来源——这是本次最容易漏、且症状最误导人的一处。
 *
 * cookie 名是 `dsh-auth-<sha256(authority)>`，authority 里含端口。构造期写入的
 * `() => auth.cookieHeader()` 闭包捕获的是**旧 auth 对象**，换端口后它仍按旧 authority 签名，
 * 新地址一律 401。现场表现是"端口明明换对了还是连不上"，排查时极易误判成服务端问题。
 *
 * 故 rebindBaseUrl 允许（并鼓励）传入新的 cookie 生产者，且必须真的用新的去握手。
 */
describe("RemoteMuxTransport rebind 必须换凭据来源（旧 authority 会 401）", () => {
  it("rebind 后握手用的是新 cookie，而不是构造期那个闭包", async () => {
    const cookieCalls: string[] = [];
    const transport = new RemoteMuxTransport(`http://127.0.0.1:${port}`, {
      cookieHeader: async () => {
        cookieCalls.push("old");
        return "cookie-old";
      },
      backoffBaseMs: 15,
      backoffMaxMs: 20,
    });
    transport.start();
    await waitFor(() => headersSeen.some((h) => h.cookie === "cookie-old"), 3000, "old cookie seen");

    const before = headersSeen.length;
    transport.rebindBaseUrl(`http://127.0.0.1:${port}`, async () => {
      cookieCalls.push("new");
      return "cookie-new";
    });
    await waitFor(() => headersSeen.slice(before).some((h) => h.cookie === "cookie-new"), 3000, "new cookie seen");

    // 关键断言：rebind 之后不得再出现旧 cookie
    const after = headersSeen.slice(before);
    expect(after.every((h) => h.cookie !== "cookie-old")).toBe(true);
    expect(cookieCalls).toContain("new");
    transport.stop();
  });
});

/**
 * `onRefused` 必须**每次**被拒都回调，不能像 `onState` 那样去重。
 *
 * 真机复现（本次换端口自愈的拦路 bug）：杀掉旧端口后，状态栏正确显示
 * 「DSH 未运行（连接被拒绝）」，但插件**不会**去发现新端口，用户仍须重载 Obsidian。
 * 根因：`emitState` 对同值去重，"reconnecting" 只在状态翻转时通知一次，
 * 依赖「连续失败 N 次」的上层逻辑永远只收到 1 次，阈值永远达不到。
 *
 * 故这里钉住：连续多次被拒 → onRefused 的调用次数必须同步增长。
 */
describe("onRefused 不去重（失败次数必须可累计）", () => {
  it("连续被拒时 onRefused 每次回调，而 onState 去重只到一次", async () => {
    let refusedCount = 0;
    const states: string[] = [];
    const deadPort = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });

    const transport = new RemoteMuxTransport(`http://127.0.0.1:${deadPort}`, {
      onState: (s) => states.push(s),
      onRefused: () => {
        refusedCount += 1;
      },
      backoffBaseMs: 15,
      backoffMaxMs: 20,
    });
    transport.start();
    await waitFor(() => refusedCount >= 3, 5000, "3 refusals");

    expect(refusedCount).toBeGreaterThanOrEqual(3);
    // 对照组：onState 的通知次数远少于被拒次数（去重 + 首次拒绝那一次强制 notifyState），
    // 所以它**不能**用来累计失败次数。
    const reconnectingNotices = states.filter((s) => s === "reconnecting").length;
    expect(reconnectingNotices).toBeLessThan(refusedCount);
    transport.stop();
  });
});
