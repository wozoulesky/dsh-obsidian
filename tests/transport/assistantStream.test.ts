import { describe, expect, it } from "vitest";
import { expandAssistantStream } from "../../src/transport/assistantStream";

describe("expandAssistantStream（0.1.5 压缩记录展开）", () => {
  it("展开 text-chunks / reasoning-chunks 为逐条 delta（顺序保持、index 透传）", () => {
    const out = expandAssistantStream([
      { type: "text-chunks", time0: 100, index: 0, dt: [1, 2], texts: ["A", "B", "C"] },
      { type: "reasoning-chunks", time0: 200, index: 1, dt: [3], texts: ["想", "法"] },
    ]);
    expect(out).toEqual([
      { type: "text-delta", index: 0, text: "A" },
      { type: "text-delta", index: 0, text: "B" },
      { type: "text-delta", index: 0, text: "C" },
      { type: "reasoning-delta", index: 1, text: "想" },
      { type: "reasoning-delta", index: 1, text: "法" },
    ]);
  });

  it("展开 tool-call-chunks（携带 id/name）", () => {
    const out = expandAssistantStream([{ type: "tool-call-chunks", time0: 1, index: 0, dt: [1], id: "c1", name: "read", args: ['{"p"', ':1}'] }]);
    expect(out).toEqual([
      { type: "tool-call-delta", index: 0, id: "c1", name: "read", argumentsDelta: '{"p"' },
      { type: "tool-call-delta", index: 0, id: "c1", name: "read", argumentsDelta: ":1}" },
    ]);
  });

  it("tool-call-chunks 缺 id 时跳过（不产出畸形 delta）", () => {
    expect(expandAssistantStream([{ type: "tool-call-chunks", time0: 1, index: 0, dt: [], args: ["x"] }])).toEqual([]);
  });

  it("展开未压缩的 chunk 记录（含 block-start / block-end）", () => {
    const out = expandAssistantStream([
      { type: "chunk", time: 1, chunk: { type: "block-start", index: 0, blockType: "reasoning" } },
      { type: "chunk", time: 2, chunk: { type: "reasoning-delta", index: 0, text: "While" } },
      { type: "chunk", time: 3, chunk: { type: "block-end", index: 0, block: { type: "text", text: "done" } } },
    ]);
    expect(out).toEqual([
      { type: "block-start", index: 0, blockType: "reasoning" },
      { type: "reasoning-delta", index: 0, text: "While" },
      { type: "block-end", index: 0, block: { type: "text", text: "done" } },
    ]);
  });

  it("未知记录 / 畸形成员被跳过而非抛错（瞬态数据丢弃优于崩溃）", () => {
    const out = expandAssistantStream([
      { type: "future-record", whatever: 1 },
      null,
      "not-an-object",
      [1, 2],
      { type: "text-chunks", time0: 1, index: 0, dt: [1], texts: ["ok", 42] },
      { type: "text-chunks", time0: 1, texts: ["no-index"] },
      { type: "chunk", time: 1, chunk: { type: "text-delta", text: "无 index" } },
    ]);
    expect(out).toEqual([{ type: "text-delta", index: 0, text: "ok" }]);
  });

  it("空流返回空数组", () => {
    expect(expandAssistantStream([])).toEqual([]);
  });
});
