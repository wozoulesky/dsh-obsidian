import { describe, expect, it } from "vitest";
import { isServerResponse, mintId } from "../../src/transport/types";

describe("mintId", () => {
  it("生成符合 UUID v4 格式的唯一字符串", () => {
    const a = mintId();
    const b = mintId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("isServerResponse", () => {
  it("接受合法响应信封", () => {
    expect(isServerResponse({ type: "server-response", rpcId: "x", result: { ok: true, value: 1 } })).toBe(true);
  });
  it("拒绝缺少字段或类型错误的值", () => {
    expect(isServerResponse(null)).toBe(false);
    expect(isServerResponse({})).toBe(false);
    expect(isServerResponse({ type: "client-request", rpcId: "x", method: "m", payload: {} })).toBe(false);
    expect(isServerResponse({ type: "server-response", rpcId: "x", result: {} })).toBe(false);
    expect(isServerResponse({ type: "server-response", rpcId: 123, result: { ok: true, value: 1 } })).toBe(false);
  });
});
