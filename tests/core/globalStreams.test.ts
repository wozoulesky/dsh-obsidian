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

  it("stop 后不再重开（插件卸载）", async () => {
    const { streams, rounds } = make();
    streams.startAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(rounds()).toEqual({ eventsRound: 1, controlRound: 1 });
    streams.stop();
    streams.startAll();
    await new Promise((r) => setTimeout(r, 10));
    expect(rounds()).toEqual({ eventsRound: 1, controlRound: 1 });
  });
});
