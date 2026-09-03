/**
 * chunkrow 解包层单测（批 3）：三种 run 解包、seq/time/dt 前缀和、dt 负数、
 * event 透传、非法记录防呆、折叠器形状对齐。
 */
import { describe, expect, it } from "vitest";
import {
  expandChunkRow,
  expandChunkRowEvent,
  expandHistoryRecords,
} from "../../src/transport/chunkRows";
import type { ChunkRowEvent, SessionHistoryRecord } from "../../src/transport/types";

const rowText: ChunkRowEvent = {
  type: "chunkrow/text-chunks",
  seq: 10,
  time: 1000,
  data: { turn: 1, step: 2, index: 0, dt: [5, -2], texts: ["hello", " ", "world"] },
};

const rowReasoning: ChunkRowEvent = {
  type: "chunkrow/reasoning-chunks",
  seq: 20,
  time: 2000,
  data: { turn: 2, step: 3, index: 1, dt: [10], texts: ["想", "考"] },
};

const rowTool: ChunkRowEvent = {
  type: "chunkrow/tool-call-chunks",
  seq: 30,
  time: 3000,
  data: { turn: 3, step: 4, index: 2, dt: [0, 7], id: "call-1", name: "read", args: ["{\"", "a\":", "1}"] },
};

describe("expandChunkRowEvent", () => {
  it("text-chunks：展开为逐条 assistant/chunk（seq+k / time+Σdt / text-delta 形状）", () => {
    const events = expandChunkRowEvent(rowText);
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "assistant/chunk",
      seq: 10,
      time: 1000,
      data: { turn: 1, step: 2, chunk: { type: "text-delta", index: 0, text: "hello" } },
    });
    expect(events[1]).toEqual({
      type: "assistant/chunk",
      seq: 11,
      time: 1005,
      data: { turn: 1, step: 2, chunk: { type: "text-delta", index: 0, text: " " } },
    });
    expect(events[2]).toEqual({
      type: "assistant/chunk",
      seq: 12,
      time: 1003, // 1000 + 5 + (-2)：dt 允许负数（时钟回拨）
      data: { turn: 1, step: 2, chunk: { type: "text-delta", index: 0, text: "world" } },
    });
  });

  it("reasoning-chunks：reasoning-delta 形状", () => {
    const events = expandChunkRowEvent(rowReasoning);
    expect(events).toHaveLength(2);
    expect(events[0].data.chunk).toEqual({ type: "reasoning-delta", index: 1, text: "想" });
    expect(events[1]).toMatchObject({ seq: 21, time: 2010 });
  });

  it("tool-call-chunks：tool-call-delta 形状（id/name/argumentsDelta）", () => {
    const events = expandChunkRowEvent(rowTool);
    expect(events).toHaveLength(3);
    expect(events[0].data.chunk).toEqual({ type: "tool-call-delta", index: 2, id: "call-1", name: "read", argumentsDelta: "{\"" });
    expect(events[1]).toMatchObject({ seq: 31, time: 3000 });
    expect(events[2].data.chunk).toEqual({ type: "tool-call-delta", index: 2, id: "call-1", name: "read", argumentsDelta: "1}" });
  });

  it("tool-call name 可缺省（省略时展开不含 name 键）", () => {
    const row: ChunkRowEvent = {
      type: "chunkrow/tool-call-chunks",
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, index: 0, dt: [], id: "call-2", args: ["x"] },
    };
    const [event] = expandChunkRowEvent(row);
    expect(event.data.chunk).toEqual({ type: "tool-call-delta", index: 0, id: "call-2", argumentsDelta: "x" });
    expect(Object.prototype.hasOwnProperty.call(event.data.chunk, "name")).toBe(false);
  });

  it("展开形状与 eventFold.applyChunk 消费形状一致（chunk 字段可被直接折叠）", () => {
    for (const event of expandChunkRowEvent(rowText)) {
      expect(event.type).toBe("assistant/chunk");
      expect(typeof event.seq).toBe("number");
      expect(typeof event.time).toBe("number");
      expect(typeof event.data.turn).toBe("number");
      expect(typeof event.data.step).toBe("number");
      const chunk = event.data.chunk;
      expect(typeof chunk.index).toBe("number");
      expect(chunk.type === "text-delta" && typeof chunk.text === "string").toBe(true);
    }
  });
});

describe("expandChunkRowEvent 防呆", () => {
  it("dt 长度与成员数不匹配时抛错", () => {
    const row: ChunkRowEvent = {
      type: "chunkrow/text-chunks",
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, index: 0, dt: [1], texts: ["a", "b", "c"] },
    };
    expect(() => expandChunkRowEvent(row)).toThrow(/dt length/);
  });

  it("成员非字符串数组时抛错", () => {
    const row = {
      type: "chunkrow/text-chunks",
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, index: 0, dt: [], texts: [1] },
    } as unknown as ChunkRowEvent;
    expect(() => expandChunkRowEvent(row)).toThrow(/non-empty string array/);
  });

  it("seq/time 非数字时抛错", () => {
    const row = { ...rowText, seq: "x" as unknown as number };
    expect(() => expandChunkRowEvent(row)).toThrow(/seq must be a number/);
    const row2 = { ...rowText, time: null as unknown as number };
    expect(() => expandChunkRowEvent(row2)).toThrow(/time must be a number/);
  });

  it("tool-call id 非字符串时抛错", () => {
    const row: ChunkRowEvent = {
      type: "chunkrow/tool-call-chunks",
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, index: 0, dt: [], id: 123 as unknown as string, args: ["x"] },
    };
    expect(() => expandChunkRowEvent(row)).toThrow(/id must be a string/);
  });

  it("turn/step/index 非数字时抛错", () => {
    const row = {
      type: "chunkrow/text-chunks",
      seq: 1,
      time: 1,
      data: { turn: "t", step: 1, index: 0, dt: [], texts: ["a"] },
    } as unknown as ChunkRowEvent;
    expect(() => expandChunkRowEvent(row)).toThrow(/turn\/step\/index/);
  });
});

describe("expandChunkRow（SessionHistoryRecord 入口）", () => {
  it("event 型原样透传为 [event]", () => {
    const event = { type: "user/message", seq: 5, time: 5, data: { id: "m1" } };
    const record: SessionHistoryRecord = { type: "event", event };
    const out = expandChunkRow(record);
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(event);
  });

  it("chunks 型展开", () => {
    const record: SessionHistoryRecord = { type: "chunks", event: rowText };
    const out = expandChunkRow(record);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.seq)).toEqual([10, 11, 12]);
  });

  it("未知 record.type 原样透传（防呆不吞数据）", () => {
    const weird = { type: "future-kind", whatever: 1 } as unknown as SessionHistoryRecord;
    expect(expandChunkRow(weird)).toEqual([weird]);
  });
});

describe("expandHistoryRecords", () => {
  it("混合 records 顺序展开（event 与 chunks 交错保持 log 顺序）", () => {
    const records: SessionHistoryRecord[] = [
      { type: "event", event: { type: "turn/start", seq: 0, time: 0, data: { turn: 1 } } },
      { type: "chunks", event: rowText },
      { type: "chunks", event: rowTool },
      { type: "event", event: { type: "turn/end", seq: 33, time: 3007, data: { turn: 3, reason: { kind: "done" } } } },
    ];
    const out = expandHistoryRecords(records);
    expect(out.map((e) => e.seq)).toEqual([0, 10, 11, 12, 30, 31, 32, 33]);
    expect(out.every((e) => typeof e.seq === "number" && typeof e.time === "number")).toBe(true);
  });
});
