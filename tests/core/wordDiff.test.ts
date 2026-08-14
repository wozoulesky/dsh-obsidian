import { describe, expect, it } from "vitest";
import { wordDiff } from "../../src/core/wordDiff";

describe("wordDiff", () => {
  it("相同文本输出单个 equal", () => {
    expect(wordDiff("hello world", "hello world")).toEqual([{ type: "equal", text: "hello world" }]);
  });

  it("纯插入", () => {
    expect(wordDiff("a c", "a b c")).toEqual([
      { type: "equal", text: "a " },
      { type: "add", text: "b " },
      { type: "equal", text: "c" },
    ]);
  });

  it("纯删除", () => {
    expect(wordDiff("a b c", "a c")).toEqual([
      { type: "equal", text: "a " },
      { type: "del", text: "b " },
      { type: "equal", text: "c" },
    ]);
  });

  it("相邻同类型操作合并", () => {
    expect(wordDiff("x", "y z")).toEqual([
      { type: "add", text: "y z" },
      { type: "del", text: "x" },
    ]);
  });

  it("中文按词切分", () => {
    const ops = wordDiff("今天 天气", "今天 天气 很好");
    expect(ops).toEqual([
      { type: "equal", text: "今天 天气" },
      { type: "add", text: " 很好" },
    ]);
  });
});
