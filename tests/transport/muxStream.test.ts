import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { MuxStream, type MuxSink } from "../../src/transport/muxStream";
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

  it("退避按指数增长并封顶，stop 后重启立即重连且无陈旧定时器", async () => {
    vi.useFakeTimers();
    let stream: MuxStream | undefined;
    try {
      connections = [];
      const { sink } = makeSink();
      // 在不推进假时钟的前提下等待 close 事件触发 scheduleReconnect（其会同步发出 "reconnecting"），
      // 从而在退避定时器已就绪、尚未触发的时刻精确推进假时钟来验证指数增长。
      let notifyReconnecting: (() => void) | null = null;
      const origOnState = sink.onState;
      sink.onState = (s) => {
        origOnState(s);
        if (s === "reconnecting" && notifyReconnecting) {
          notifyReconnecting();
          notifyReconnecting = null;
        }
      };
      const waitReconnecting = () =>
        new Promise<void>((resolve) => {
          notifyReconnecting = resolve;
        });

      stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 100, backoffMaxMs: 1000 });
      stream.start();
      await vi.waitFor(() => expect(connections.length).toBe(1), { timeout: 2000 });

      // 第一次断开 → 100ms 后重连
      const p1 = waitReconnecting();
      connections[0].close();
      await p1;
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(connections.length).toBe(2), { timeout: 2000 });

      // 第二次断开 → 200ms 后重连（指数增长）
      const p2 = waitReconnecting();
      connections[1].close();
      await p2;
      await vi.advanceTimersByTimeAsync(100);
      expect(connections.length).toBe(2); // 100ms 不足以触发 200ms 退避
      await vi.advanceTimersByTimeAsync(100);
      await vi.waitFor(() => expect(connections.length).toBe(3), { timeout: 2000 });

      stream.stop();
      const afterStop = connections.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(connections.length).toBe(afterStop);

      // 重启：立即连接，且旧定时器不会触发第二个连接
      stream.start();
      await vi.waitFor(() => expect(connections.length).toBe(afterStop + 1), { timeout: 2000 });
      await vi.advanceTimersByTimeAsync(5000);
      expect(connections.length).toBe(afterStop + 1);
    } finally {
      vi.useRealTimers();
      stream?.stop();
    }
  });
});
