import { createHash as refCreateHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DSH_CLI_URL,
  DSH_DESKTOP_URL,
  candidateDshUrls,
  classifyDshFailure,
  cookieNameForPort,
  discoverDshUrls,
  failureHintKeyFor,
  firstReachableDshUrl,
  portsFromCookieBuffer,
  probeDshConnection,
} from "../../src/core/diagnose";
import { cookieName as authCookieName } from "../../src/transport/auth";

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

  /**
   * code-first 归类：底层错误已带稳定错误码（`auth/*`、`transport/*`），
   * 分类器应优先认码，而不是去猜英文/中文文案里的关键词。
   *
   * 为什么重要：文案会随 i18n 改动（我们刚把所有底层中文兜底改成英文），
   * 靠 message 关键词判类随时可能悄悄降级成 unknown，让「认证失败」变成「未知错误」。
   * 码是契约，文案不是。
   */
  it("带 auth/* 错误码时无需依赖文案即可判定认证失败", () => {
    // 文案里刻意不含 credentials/凭据 等关键词，验证真的走了码
    expect(classifyDshFailure("auth/secret-invalid: The secret is bad")).toBe("authFailed");
    expect(classifyDshFailure("auth/home-unresolved: no home")).toBe("authFailed");
    expect(classifyDshFailure("auth/credentials-record-missing: missing")).toBe("authFailed");
    // 旧中文文案仍要能判（向后兼容：日志里可能还有历史文案）
    expect(classifyDshFailure("凭据读取失败")).toBe("authFailed");
  });

  it("带 transport/* 错误码时按码归类", () => {
    expect(classifyDshFailure("transport/timeout: no response")).toBe("notResponding");
    expect(classifyDshFailure("transport/connection-failed: refused")).toBe("unknown");
    // http-status 码后面跟着真实 HTTP 状态，仍由状态码决定细分
    expect(classifyDshFailure("transport/http-status: HTTP 401")).toBe("authFailed");
    expect(classifyDshFailure("transport/http-status: HTTP 404")).toBe("versionMismatch");
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

/* ================= 端口自动发现（DSH 0.2.1+ 系统分配端口） ================= */

/** 参考实现：与 auth.ts 的 cookieName 无关的独立重算（node:crypto）。 */
function refCookieNameForPort(port: number): string {
  const authority = `127.0.0.1:${port}`;
  return (
    "dsh-auth-" +
    refCreateHash("sha256")
      .update(authority)
      .digest("base64")
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "")
  );
}

describe("cookieNameForPort", () => {
  it("与 auth.ts 的 cookieName 对同一 authority 完全一致（防漂移）", () => {
    for (const port of [1024, 3080, 19387, 51740, 56516, 65535]) {
      expect(cookieNameForPort(port)).toBe(authCookieName(`127.0.0.1:${port}`));
    }
  });

  it("与独立 node:crypto 重算一致，且形如 dsh-auth-<43 字符 base64url>", () => {
    expect(cookieNameForPort(56516)).toBe(refCookieNameForPort(56516));
    expect(cookieNameForPort(56516)).toMatch(/^dsh-auth-[A-Za-z0-9_-]{43}$/u);
  });

  it("端口区间边界 1024 / 65535 都能算，且互不相同（无 off-by-one）", () => {
    expect(cookieNameForPort(1024)).toBe(refCookieNameForPort(1024));
    expect(cookieNameForPort(65535)).toBe(refCookieNameForPort(65535));
    expect(cookieNameForPort(1024)).not.toBe(cookieNameForPort(65535));
    expect(cookieNameForPort(65534)).not.toBe(cookieNameForPort(65535));
  });
});

describe("portsFromCookieBuffer", () => {
  it("从原始字节里解出 2-3 个端口（SQLite 文件直接子串匹配，无需 SQLite 库）", () => {
    const ports = [19387, 51740, 56516];
    // 模拟 Chromium Cookies（SQLite）：cookie 名散在二进制记录里，前后有不可打印字节
    const parts: Buffer[] = [Buffer.from("SQLite format 3\u0000", "latin1")];
    for (const port of ports) {
      parts.push(Buffer.from([0x00, 0x0f, 0x01]));
      parts.push(Buffer.from(`${cookieNameForPort(port)}`, "latin1"));
      parts.push(Buffer.from([0x00, 0x00, 0x03, 0x02]));
    }
    const buf = Buffer.concat(parts);
    expect(portsFromCookieBuffer(buf).sort((a, b) => a - b)).toEqual(ports);
  });

  it("只出现部分端口时只返回这些", () => {
    const buf = Buffer.from(`xx${cookieNameForPort(56516)}yy`, "latin1");
    expect(portsFromCookieBuffer(buf)).toEqual([56516]);
  });

  it("没有任何 dsh-auth cookie → 返回 []", () => {
    expect(portsFromCookieBuffer(Buffer.from("SQLite format 3 no cookies here", "latin1"))).toEqual([]);
    expect(portsFromCookieBuffer(Buffer.alloc(0))).toEqual([]);
  });

  it("结果稳定（同样输入两次结果一致，且不含重复）", () => {
    const name = cookieNameForPort(56516);
    const buf = Buffer.from(`${name}${name}`, "latin1");
    const a = portsFromCookieBuffer(buf);
    const b = portsFromCookieBuffer(buf);
    expect(a).toEqual(b);
    expect(a).toEqual([56516]);
  });

  it("自定义端口列表时只在该范围内匹配", () => {
    const buf = Buffer.from(`${cookieNameForPort(56516)}${cookieNameForPort(19387)}`, "latin1");
    expect(portsFromCookieBuffer(buf, [19387]).sort((a, b) => a - b)).toEqual([19387]);
  });
});

describe("discoverDshUrls", () => {
  const fakeCookieFile = "fake/Cookies";

  function bufferWith(ports: number[]): Buffer {
    return Buffer.concat([
      Buffer.from("SQLite format 3\u0000", "latin1"),
      ...ports.map((p) => Buffer.from(cookieNameForPort(p), "latin1")),
    ]);
  }

  it("Cookie 库解密出端口 → 返回候选 URL（含真实端口 56516），且不发网络请求", async () => {
    const readFile = vi.fn(async () => bufferWith([19387, 51740, 56516]));
    const urls = await discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: false, readFile });
    expect(urls).toContain("http://127.0.0.1:56516");
    // 只调用了注入的 readFile，没有任何网络探测（验证交给 probeDshUrl）
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("多个历史端口都返回，且当前端口排最前/靠前（调用方逐个验证）", async () => {
    const readFile = async () => bufferWith([19387, 51740, 56516]);
    const urls = await discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: false, readFile });
    expect(urls).toEqual([
      "http://127.0.0.1:56516",
      "http://127.0.0.1:51740",
      "http://127.0.0.1:19387",
    ]);
  });

  it("readFile 抛错（文件不存在 / CLI 场景）→ 返回 [] 不抛", async () => {
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    });
    await expect(discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: false, readFile })).resolves.toEqual([]);
  });

  it("所有路径都读失败也不抛，返回 []", async () => {
    const readFile = async () => {
      throw new Error("EACCES");
    };
    await expect(
      discoverDshUrls({ cookieFilePaths: ["a", "b"], scan: false, readFile })
    ).resolves.toEqual([]);
  });

  it("第一个文件失败后仍尝试下一个文件（多平台路径列表）", async () => {
    const readFile = vi.fn(async (path: string) => {
      if (path === "missing") throw new Error("ENOENT");
      return bufferWith([56516]);
    });
    const urls = await discoverDshUrls({ cookieFilePaths: ["missing", "present"], scan: false, readFile });
    expect(urls).toEqual(["http://127.0.0.1:56516"]);
    expect(readFile.mock.calls.map((c) => c[0])).toEqual(["missing", "present"]);
  });

  it("Cookie 库存在但没有 dsh-auth → 返回 []（不猜）", async () => {
    const readFile = async () => Buffer.from("SQLite format 3 no cookies", "latin1");
    await expect(discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: false, readFile })).resolves.toEqual([]);
  });

  it("扫描兜底：Cookie 解不出时用注入的 scan 找到端口", async () => {
    const readFile = async () => Buffer.from("no cookies", "latin1");
    const scan = vi.fn(async () => [56516]);
    const urls = await discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: true, readFile, scanPorts: scan });
    expect(urls).toEqual(["http://127.0.0.1:56516"]);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it("Cookie 已解出端口时不再扫描（省掉 1.3-1.9 s）", async () => {
    const readFile = async () => bufferWith([56516]);
    const scan = vi.fn(async () => [56516]);
    await discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: true, readFile, scanPorts: scan });
    expect(scan).not.toHaveBeenCalled();
  });

  it("scan: false（onload 默认路径）时绝不扫描", async () => {
    const readFile = async () => Buffer.from("no cookies", "latin1");
    const scan = vi.fn(async () => [56516]);
    await expect(
      discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: false, readFile, scanPorts: scan })
    ).resolves.toEqual([]);
    expect(scan).not.toHaveBeenCalled();
  });

  it("扫描结果去重并按端口降序（新端口靠前）", async () => {
    const readFile = async () => Buffer.from("no cookies", "latin1");
    const scan = vi.fn(async () => [60000, 56516, 56516, 56516]);
    const urls = await discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: true, readFile, scanPorts: scan });
    expect(urls).toEqual(["http://127.0.0.1:60000", "http://127.0.0.1:56516"]);
  });

  it("扫描结果里的越界端口被丢弃（<1024 / >65535）", async () => {
    const readFile = async () => Buffer.from("no cookies", "latin1");
    const scan = vi.fn(async () => [80, 56516, 70000]);
    const urls = await discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: true, readFile, scanPorts: scan });
    expect(urls).toEqual(["http://127.0.0.1:56516"]);
  });

  it("扫描挂死时按 maxScanMs 超时返回（不抛、不永久挂起）", async () => {
    const readFile = async () => {
      throw new Error("ENOENT");
    };
    const scan = vi.fn(() => new Promise<number[]>(() => {}));
    const startedAt = Date.now();
    const urls = await discoverDshUrls({
      cookieFilePaths: [fakeCookieFile],
      scan: true,
      readFile,
      scanPorts: scan,
      maxScanMs: 60,
    });
    expect(urls).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  }, 10000);

  it("扫描抛错时吞掉异常，返回 []", async () => {
    const readFile = async () => {
      throw new Error("ENOENT");
    };
    const scan = vi.fn(async () => {
      throw new Error("scan boom");
    });
    await expect(
      discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: true, readFile, scanPorts: scan })
    ).resolves.toEqual([]);
  });

  it("扫描返回空也不抛，返回 []", async () => {
    const readFile = async () => Buffer.from("no cookies", "latin1");
    const scan = vi.fn(async () => []);
    await expect(
      discoverDshUrls({ cookieFilePaths: [fakeCookieFile], scan: true, readFile, scanPorts: scan })
    ).resolves.toEqual([]);
  });

  it("全空输入（无路径列表、不扫描）→ [] 且不抛", async () => {
    await expect(discoverDshUrls({ cookieFilePaths: [], scan: false })).resolves.toEqual([]);
  });

  it("Cookie 反解耗时会从扫描预算里扣掉（总预算封顶，不叠加）", async () => {
    // 注入时钟：读 Cookie 花掉 100 ms，总预算 150 ms → 扫描只剩 50 ms
    let clock = 0;
    const readFile = async (): Promise<Buffer> => {
      clock += 100;
      throw new Error("ENOENT");
    };
    const scan = vi.fn(() => new Promise<number[]>(() => {}));
    const startedAt = Date.now();
    const urls = await discoverDshUrls({
      cookieFilePaths: [fakeCookieFile],
      scan: true,
      readFile,
      scanPorts: scan,
      maxScanMs: 150,
      now: () => clock,
    });
    expect(urls).toEqual([]);
    expect(scan).toHaveBeenCalledTimes(1);
    // 扫描必须在剩余预算（50 ms）内被放弃，而不是再等完整的 150 ms
    expect(Date.now() - startedAt).toBeLessThan(140);
  });

  it("Cookie 反解已耗尽总预算时直接跳过扫描", async () => {
    let clock = 0;
    const readFile = async (): Promise<Buffer> => {
      clock += 500;
      throw new Error("ENOENT");
    };
    const scan = vi.fn(async () => [56516]);
    const urls = await discoverDshUrls({
      cookieFilePaths: [fakeCookieFile],
      scan: true,
      readFile,
      scanPorts: scan,
      maxScanMs: 200,
      now: () => clock,
    });
    expect(scan).not.toHaveBeenCalled();
    expect(urls).toEqual([]);
  });
});
