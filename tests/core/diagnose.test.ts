import { describe, expect, it, vi } from "vitest";
import {
  classifyDshFailure,
  failureHintKeyFor,
  probeDshConnection,
} from "../../src/core/diagnose";

describe("classifyDshFailure", () => {
  it("端口拒绝 → DSH 未运行", () => {
    expect(classifyDshFailure("connect ECONNREFUSED 127.0.0.1:3080")).toBe("notRunning");
    expect(failureHintKeyFor("connect ECONNREFUSED 127.0.0.1:3080")).toBe("diag.notRunning");
  });

  it("HTTP 404 → 版本不兼容（旧 DSH 没有该 API）", () => {
    expect(classifyDshFailure("HTTP 404 for http://127.0.0.1:3080/api/session/list")).toBe("versionMismatch");
    expect(failureHintKeyFor("HTTP 404 for http://x/api")).toBe("diag.versionMismatch");
  });

  it("HTTP 401/403 → 认证不可用", () => {
    expect(classifyDshFailure("HTTP 401 for http://127.0.0.1:3080/api/session/list")).toBe("authFailed");
    expect(classifyDshFailure("HTTP 403 for http://127.0.0.1:3080/api/respond")).toBe("authFailed");
  });

  it("凭据文件错误串（无 HTTP 码）同样归到认证", () => {
    expect(classifyDshFailure("无法读取 DSH 凭据文件 C:/Users/x/.dsh/.credentials.yaml：ENOENT")).toBe("authFailed");
    expect(classifyDshFailure("DSH 凭据文件中没有 client-connection/browser-session 记录")).toBe("authFailed");
  });

  it("DNS 解析失败 → 地址错误", () => {
    expect(classifyDshFailure("getaddrinfo ENOTFOUND dsb.local")).toBe("unreachable");
  });

  it("超时 → 无响应", () => {
    expect(classifyDshFailure("timeout after 15000ms")).toBe("notResponding");
    expect(classifyDshFailure("connect ETIMEDOUT 10.0.0.5:3080")).toBe("notResponding");
  });

  it("归类不了就诚实返回 unknown，且不编造提示键", () => {
    expect(classifyDshFailure("some unexpected failure")).toBe("unknown");
    expect(failureHintKeyFor("some unexpected failure")).toBeNull();
  });

  it("优先级：连接层先于 HTTP 码判定", () => {
    // 同时含 ECONNREFUSED 与 404 字样时，以连接层为准
    expect(classifyDshFailure("ECONNREFUSED while fetching HTTP 404 page")).toBe("notRunning");
  });
});

describe("probeDshConnection", () => {
  it("list 成功 → ok", async () => {
    const outcome = await probeDshConnection(async () => ({ ok: true, value: {} }));
    expect(outcome).toEqual({ ok: true });
  });

  it("RpcResult.ok === false → 带上 code/message 与归类", async () => {
    const outcome = await probeDshConnection(async () => ({
      ok: false,
      error: { code: "gateway/not-found", message: "HTTP 404 for /api/session/list" },
    }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.kind).toBe("versionMismatch");
    expect(outcome.hintKey).toBe("diag.versionMismatch");
    expect(outcome.detail).toContain("gateway/not-found");
  });

  it("抛错（连接层）→ 归类为未运行", async () => {
    const outcome = await probeDshConnection(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3080");
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.kind).toBe("notRunning");
    expect(outcome.hintKey).toBe("diag.notRunning");
  });

  it("非 Error 抛出物也被转成字符串，不抛给调用方", async () => {
    const outcome = await probeDshConnection(async () => {
      throw "boom";
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.detail).toBe("boom");
    expect(outcome.kind).toBe("unknown");
    expect(outcome.hintKey).toBeNull();
  });

  it("只调用一次（探测不得有副作用重试）", async () => {
    const list = vi.fn(async () => ({ ok: true, value: {} }) as const);
    await probeDshConnection(list);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
