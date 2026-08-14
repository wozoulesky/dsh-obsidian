import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { MuxStream, backoffDelay, type MuxSink } from "../../src/transport/muxStream";
import type { MuxFrame } from "../../src/transport/types";

let wss: WebSocketServer;
let port = 0;
let connections: WebSocket[] = [];

function makeSink() {
  const frames: { rpcId: string; frame: MuxFrame }[] = [];
  const states: string[] = [];
  const sink: MuxSink = {
    onFrame: (rpcId, frame) => frames.push({ rpcId, frame }),
    onState: (s) => states.push(s),
  };
  return { sink, frames, states };
}

beforeAll(async () => {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  port = (wss.address() as { port: number }).port;
  wss.on("connection", (ws) => {
    connections.push(ws);
    const push = (payload: MuxFrame) => ws.send(JSON.stringify({ type: "server-request", rpcId: "r1", method: "events.mux", payload }));
    setTimeout(() => {
      push({ type: "session/subscribed", sessionId: "s1", lastSeq: 3 });
      push({ type: "session/event", sessionId: "s1", event: { type: "turn/start", seq: 4, time: 1, data: { turn: 1 } } });
    }, 10);
  });
});

afterAll(async () => {
  // 强制断开残留连接：fake timers 下 ws 的优雅关闭握手可能无法完成，导致 wss.close() 挂起。
  for (const client of wss.clients) client.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
});

describe("MuxStream", () => {
  it("连接后接收帧并报告状态", async () => {
    connections = [];
    const { sink, frames, states } = makeSink();
    const stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 20 });
    stream.start();
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(frames[0].frame).toMatchObject({ type: "session/subscribed", sessionId: "s1" });
    expect(states).toContain("connected");
    stream.stop();
  });

  it("坏帧被丢弃且不中断流", async () => {
    connections = [];
    const { sink, frames, states } = makeSink();
    const stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 20 });
    stream.start();
    await vi.waitFor(() => expect(connections.length).toBe(1), { timeout: 2000 });
    connections[0].send("not-json");
    await new Promise((r) => setTimeout(r, 50));
    // 坏帧被丢弃：仅服务端在连接后主动推送的 2 个合法帧被转发，流未被中断
    expect(frames.length).toBe(2);
    expect(states.filter((s) => s === "connected").length).toBe(1);
    stream.stop();
  });

  it("服务端断开后自动重连", async () => {
    connections = [];
    const { sink, states } = makeSink();
    const stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 20 });
    stream.start();
    await vi.waitFor(() => expect(connections.length).toBe(1), { timeout: 2000 });
    connections[0].close();
    await vi.waitFor(() => expect(connections.length).toBe(2), { timeout: 2000 });
    expect(states.filter((s) => s === "reconnecting").length).toBeGreaterThanOrEqual(1);
    stream.stop();
    await new Promise((r) => setTimeout(r, 100));
    const countAfterStop = connections.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(connections.length).toBe(countAfterStop);
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

  it("stop 阻止重连，restart 只建立一条新连接", async () => {
    vi.useFakeTimers();
    try {
      connections = [];
      const { sink } = makeSink();
      const stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 100 });
      stream.start();
      await vi.waitFor(() => expect(connections.length).toBe(1), { timeout: 2000 });
      connections[0].close();
      // 断开后不再产生新连接
      await vi.advanceTimersByTimeAsync(5000);
      stream.stop();
      const afterStop = connections.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(connections.length).toBe(afterStop);
      // 重启：建立恰好一条新连接，且陈旧定时器不触发第二条
      stream.start();
      await vi.waitFor(() => expect(connections.length).toBe(afterStop + 1), { timeout: 2000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(connections.length).toBe(afterStop + 1);
      stream.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
