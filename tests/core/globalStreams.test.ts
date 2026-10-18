import { describe, expect, it } from "vitest";
import { GlobalStreams } from "../../src/core/globalStreams";
import type { DshClient } from "../../src/transport/client";
import type { SessionStore } from "../../src/core/store";
import type { ApprovalCenter } from "../../src/core/approvalCenter";
import type { RemoteEventDownlinkFrame, SessionControlFrame } from "../../src/transport/types";

/** 可控异步流。 */
function makeStream<T>() {
  const queue: Array<{ kind: "value"; value: T } | { kind: "done" }> = [];
  const waiters: Array<() => void> = [];
  const push = (value: T) => {
    queue.push({ kind: "value", value });
    for (const w of waiters.splice(0)) w();
  };
  const end = () => {
    queue.push({ kind: "done" });
    for (const w of waiters.splice(0)) w();
  };
  const iterator: AsyncIterator<T> = {
    next: () =>
      new Promise<IteratorResult<T>>((resolve) => {
        const take = () => {
          const item = queue.shift();
          if (!item) {
            waiters.push(take);
            return;
          }
          if (item.kind === "value") resolve({ done: false, value: item.value });
          else resolve({ done: true, value: undefined as never });
        };
        take();
      }),
  };
  const iterable: AsyncIterable<T> = { [Symbol.asyncIterator]: () => iterator };
  return { push, end, iterable };
}

describe("GlobalStreams", () => {
  function make() {
    const events = makeStream<RemoteEventDownlinkFrame>();
    const control = makeStream<SessionControlFrame>();
    const ingested: RemoteEventDownlinkFrame[] = [];
    const controls: SessionControlFrame[] = [];
    const openCalls: string[] = [];
    let eventsRound = 0;
    let controlRound = 0;
    const client = {
      openStream: async <T>(endpoint: string) => {
        openCalls.push(endpoint);
        if (endpoint === "$events") {
          eventsRound++;
          return events.iterable as unknown as AsyncIterable<T>;
        }
        controlRound++;
        return control.iterable as unknown as AsyncIterable<T>;
      },
    } as unknown as DshClient;
    const store = { applyControlFrame: (f: SessionControlFrame) => controls.push(f) } as unknown as SessionStore;
    const approvals = { ingest: (f: RemoteEventDownlinkFrame) => ingested.push(f) } as unknown as ApprovalCenter;
    return { streams: new GlobalStreams(client, store, approvals), events, control, ingested, controls, openCalls, rounds: () => ({ eventsRound, controlRound }) };
  }

  it("startAll 开两条流并分发帧", async () => {
    const { streams, events, control, ingested, controls, openCalls } = make();
    streams.startAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(openCalls).toEqual(["$events", "session/control"]);
    events.push({ type: "ready", clientId: "c1", host: { home: "h" } });
    control.push({ type: "queue", sessionId: "s1", items: [] });
    await new Promise((r) => setTimeout(r, 10));
    expect(ingested).toHaveLength(1);
    expect(controls).toHaveLength(1);
  });

  it("重复 startAll（onState connected 多次触发）abort 旧代开新代", async () => {
    const { streams, rounds } = make();
    streams.startAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(rounds()).toEqual({ eventsRound: 1, controlRound: 1 });
    streams.startAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(rounds()).toEqual({ eventsRound: 2, controlRound: 2 });
  });

  /**
   * 回归：control 流消费循环曾用**空 catch** 吞掉所有异常。
   *
   * 危害：`store.applyControlFrame()` 抛出的编程错误（真实案例：DSH 0.2.1 的 baseline
   * 只有 projections，旧代码 Object.entries(undefined) 抛 TypeError）会被完全静默吞掉——
   * 数据进了一半、UI 不重绘、流死掉，而用户和开发者都看不到任何线索。
   *
   * 正确行为：预期内的断线/abort 保持静默，但**非预期异常必须上报**（否则等于把 bug 埋起来）。
   */
  it("applyControlFrame 抛非预期异常时会上报，而不是静默吞掉", async () => {
    const events = makeStream<RemoteEventDownlinkFrame>();
    const control = makeStream<SessionControlFrame>();
    const errors: unknown[] = [];
    const client = {
      openStream: async <T>(endpoint: string) =>
        (endpoint === "$events" ? events.iterable : control.iterable) as unknown as AsyncIterable<T>,
    } as unknown as DshClient;
    // 模拟「帧处理代码有 bug」：applyControlFrame 抛 TypeError
    const store = {
      applyControlFrame: () => {
        throw new TypeError("Cannot convert undefined or null to object");
      },
    } as unknown as SessionStore;
    const approvals = { ingest: () => {} } as unknown as ApprovalCenter;

    const streams = new GlobalStreams(client, store, approvals, { onUnexpectedError: (e) => errors.push(e) });
    streams.startAll();
    await new Promise((r) => setTimeout(r, 10));
    control.push({ type: "baseline", value: {} });

    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("Cannot convert undefined");
    streams.stop();
  });

  /**
   * 回归（生产构建专属陷阱）：判定「预期断线」必须用 `err.name`，**不能**用 `err.constructor.name`。
   *
   * 生产构建 `minify: true` 会把 class 名压成短名（实测 `RemoteStreamCarrierError` → `"e"`），
   * 于是 `constructor.name` 比较永远为 false —— 每次正常断线重连都会被误判成「非预期异常」，
   * 刷 console.error 并往 stream-error.log 写堆栈，把真正的 bug 埋进噪音里。
   * 单测跑的是未压缩 TS，`constructor.name` 恰好是对的，所以必须**显式模拟压后短名**才能锁住。
   */
  it("模拟 minify 压短构造器名后，正常断线仍被判定为预期、不上报", async () => {
    const events = makeStream<RemoteEventDownlinkFrame>();
    const control = makeStream<SessionControlFrame>();
    const errors: unknown[] = [];
    const client = {
      openStream: async <T>(endpoint: string) =>
        (endpoint === "$events" ? events.iterable : control.iterable) as unknown as AsyncIterable<T>,
    } as unknown as DshClient;
    const store = { applyControlFrame: () => {} } as unknown as SessionStore;
    const approvals = { ingest: () => {} } as unknown as ApprovalCenter;

    const streams = new GlobalStreams(client, store, approvals, { onUnexpectedError: (e) => errors.push(e) });
    streams.startAll();
    await new Promise((r) => setTimeout(r, 10));

    // 构造一个「压后」的载体错误：name 是字面量（压不掉），但 constructor.name 被压成 "e"。
    const carrier = new Error("api gateway: Remote stream WebSocket closed before opening");
    carrier.name = "RemoteStreamCarrierError";
    Object.defineProperty(carrier, "constructor", { value: { name: "e" } });
    expect(carrier.constructor.name).toBe("e"); // 前提：确实模拟出了压后形态
    expect(carrier.name).toBe("RemoteStreamCarrierError");

    // 把它从流里抛出来，模拟正常断线
    const failing = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(carrier) }),
    };
    const failingClient = {
      openStream: async <T>(endpoint: string) =>
        (endpoint === "$events" ? events.iterable : failing) as unknown as AsyncIterable<T>,
    } as unknown as DshClient;
    const streams2 = new GlobalStreams(failingClient, store, approvals, { onUnexpectedError: (e) => errors.push(e) });
    streams2.startAll();
    await new Promise((r) => setTimeout(r, 20));

    expect(errors).toHaveLength(0); // 正常断线不得上报
    streams.stop();
    streams2.stop();
  });
});
