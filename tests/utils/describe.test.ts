import { describe, expect, it } from "vitest";
import { describeUnknown } from "../../src/utils/describe";

describe("describeUnknown（社区审核 no-base-to-string 的替代实现）", () => {
  it("Error 取 message（诊断信息不丢）", () => {
    expect(describeUnknown(new Error("boom"))).toBe("boom");
    expect(describeUnknown(new TypeError("bad type"))).toBe("bad type");
  });

  it("原始值按原义转换", () => {
    expect(describeUnknown("s")).toBe("s");
    expect(describeUnknown(42)).toBe("42");
    expect(describeUnknown(true)).toBe("true");
    // 目标为 ES2018，不能用 BigInt 字面量（10n）
    expect(describeUnknown(BigInt(10))).toBe("10");
    expect(describeUnknown(undefined)).toBe("undefined");
    expect(describeUnknown(null)).toBe("null");
  });

  it("对象走 JSON —— 绝不返回 '[object Object]'", () => {
    const out = describeUnknown({ code: "x", nested: { a: 1 } });
    expect(out).toBe('{"code":"x","nested":{"a":1}}');
    expect(out).not.toContain("[object Object]");
  });

  it("数组同样走 JSON", () => {
    expect(describeUnknown([1, "a"])).toBe('[1,"a"]');
  });

  it("循环引用不抛错（退回 Object.prototype.toString，仍不是 '[object Object]' 语义丢失）", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = describeUnknown(cyclic);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("函数给出可辨认的名字而不是源码串", () => {
    function named(): void {
      /* noop */
    }
    expect(describeUnknown(named)).toBe("[function named]");
    expect(describeUnknown(() => undefined)).toBe("[function]");
  });

  it("回归：任何输入都不得产出 '[object Object]'", () => {
    const inputs: unknown[] = [{}, { a: 1 }, [], new Error("e"), "s", 1, null, undefined, Symbol("x"), () => undefined];
    for (const input of inputs) {
      expect(describeUnknown(input)).not.toBe("[object Object]");
    }
  });
});
