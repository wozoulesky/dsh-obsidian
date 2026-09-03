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
