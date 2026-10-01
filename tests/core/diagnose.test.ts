import { describe, expect, it, vi } from "vitest";
import {
  DSH_CLI_URL,
  DSH_DESKTOP_URL,
  candidateDshUrls,
  classifyDshFailure,
  failureHintKeyFor,
  firstReachableDshUrl,
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

describe("candidateDshUrls", () => {
  it("配置成 CLI 默认端口时，候选只剩桌面端口（去重 + 桌面优先）", () => {
    expect(candidateDshUrls("http://127.0.0.1:3080")).toEqual([DSH_DESKTOP_URL]);
    // 带尾斜杠/路径是同一个地址，仍应被去重
    expect(candidateDshUrls("http://127.0.0.1:3080/")).toEqual([DSH_DESKTOP_URL]);
  });

  it("配置成桌面端口时，候选是 CLI 端口", () => {
    expect(candidateDshUrls("http://127.0.0.1:19387")).toEqual([DSH_CLI_URL]);
  });

  it("自定义 loopback 端口：两个候选都在，且桌面端口排第一（两个都活时选桌面）", () => {
    expect(candidateDshUrls("http://127.0.0.1:8080")).toEqual([DSH_DESKTOP_URL, DSH_CLI_URL]);
  });

  it("localhost 也算 loopback：候选用 127.0.0.1，顺带修掉「localhost 先解析到 ::1」的连不上", () => {
    expect(candidateDshUrls("http://localhost:3080")).toEqual([DSH_DESKTOP_URL, DSH_CLI_URL]);
  });

  it("非 loopback 地址不给候选：远端地址不该被本地端口顶掉", () => {
    expect(candidateDshUrls("http://192.168.1.5:3080")).toEqual([]);
    expect(candidateDshUrls("https://dsh.example.com")).toEqual([]);
  });

  it("非法地址返回空数组（不猜）", () => {
    expect(candidateDshUrls("not a url")).toEqual([]);
    expect(candidateDshUrls("")).toEqual([]);
  });
});

describe("firstReachableDshUrl", () => {
  it("返回优先级最高的可用地址，而不是最快返回的那个", async () => {
    const probe = vi.fn(async (url: string) => {
      if (url === DSH_CLI_URL) return true; // CLI 先返回，但桌面端口优先级更高
      await new Promise((r) => setTimeout(r, 5));
      return url === DSH_DESKTOP_URL;
    });
    await expect(firstReachableDshUrl([DSH_DESKTOP_URL, DSH_CLI_URL], probe)).resolves.toBe(DSH_DESKTOP_URL);
  });

  it("都不可用 → null", async () => {
    await expect(firstReachableDshUrl([DSH_DESKTOP_URL, DSH_CLI_URL], async () => false)).resolves.toBeNull();
  });

  it("probe 抛错视为不可用，且不外溢", async () => {
    const probe = async (url: string) => {
      if (url === DSH_DESKTOP_URL) throw new Error("boom");
      return true;
    };
    await expect(firstReachableDshUrl([DSH_DESKTOP_URL, DSH_CLI_URL], probe)).resolves.toBe(DSH_CLI_URL);
  });

  it("并发探测（最坏耗时 = 1 × 超时，而不是 N × 超时）", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const probe = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return false;
    };
    await firstReachableDshUrl([DSH_DESKTOP_URL, DSH_CLI_URL], probe);
    expect(maxInFlight).toBe(2);
  });

  it("空候选直接返回 null，不调用 probe", async () => {
    const probe = vi.fn(async () => true);
    await expect(firstReachableDshUrl([], probe)).resolves.toBeNull();
    expect(probe).not.toHaveBeenCalled();
  });
});
