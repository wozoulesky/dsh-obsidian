/**
 * 批 1 认证层单测：签名向量（官方 encodeCookie 算法对拍）、YAML 解析、错误路径、重读语义。
 * 测试内用 node:crypto 独立重算作为参考实现（与被测代码的 require("crypto") 通道互不干扰）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  authorityOf,
  COOKIE_LIFETIME_MS,
  cookieName,
  decodeBase64Url,
  defaultCredentialsPath,
  DshAuthError,
  DshCookieAuth,
  encodeBase64Url,
  extractSecretFromYaml,
  signCookie,
} from "../../src/transport/auth";

const SECRET_A = Buffer.from("0123456789abcdef0123456789abcdef"); // 32 字节
const AUTHORITY = "127.0.0.1:3080";

// ---- 参考实现（node:crypto 独立重算，与被测 require("crypto") 通道对拍） ----

function refB64url(b: Buffer): string {
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function refCookieName(authority: string): string {
  return "dsh-auth-" + refB64url(createHash("sha256").update(authority).digest());
}
function refSign(payload: { version: number; authority: string; issuedAt: number; expiresAt: number }, secret: Buffer): string {
  const body = refB64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `v1.${body}.${refB64url(createHmac("sha256", secret).update(body).digest())}`;
}

function parseCookie(header: string): { name: string; version: string; body: string; sig: string; payload: { version: number; authority: string; issuedAt: number; expiresAt: number } } {
  const at = header.indexOf("=");
  expect(at).toBeGreaterThan(0);
  const name = header.slice(0, at);
  const value = header.slice(at + 1);
  const parts = value.split(".");
  expect(parts).toHaveLength(3);
  expect(parts[0]).toBe("v1");
  const body = parts[1];
  const sig = parts[2];
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { version: number; authority: string; issuedAt: number; expiresAt: number };
  expect(payload.version).toBe(1);
  return { name, version: parts[0], body, sig, payload };
}

function expectSignedWith(header: string, secret: Buffer): void {
  const { name, body, sig, payload } = parseCookie(header);
  expect(name).toBe(refCookieName(payload.authority));
  expect(refB64url(createHmac("sha256", secret).update(body).digest())).toBe(sig);
}

function credsYaml(secretB64url: string): string {
  return [
    "version: 1",
    "refs: {}",
    "records:",
    "  client-connection/browser-session:",
    "    kind: grant",
    "    payload:",
    "      version: 1",
    `      secret: ${secretB64url}`,
    "",
  ].join("\n");
}

describe("签名向量（官方 encodeCookie 算法对拍）", () => {
  it("golden 向量与官方算法完全一致（固定 secret/authority/时间戳，expiresAt=issuedAt+12h）", () => {
    const secret = Buffer.from("0123456789abcdef0123456789abcdef");
    const authority = "127.0.0.1:3080";
    const payload = { version: 1 as const, authority, issuedAt: 1700000000000, expiresAt: 1700043200000 };
    // 向量由 tmp/golden-vector.mjs（node:crypto 独立实现）生成
    expect(cookieName(authority)).toBe("dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7CnfxKhLE00pKIDWxt1sw");
    expect(signCookie(payload, secret)).toBe(
      "v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6MzA4MCIsImlzc3VlZEF0IjoxNzAwMDAwMDAwMDAwLCJleHBpcmVzQXQiOjE3MDAwNDMyMDAwMDB9._6d1f4VDD6a6489SoqE0R2BqxdGTnd4TOqj_jHUvTBc"
    );
  });

  it("随机向量：signCookie/cookieName 与 node:crypto 独立重算一致", () => {
    for (let i = 0; i < 5; i++) {
      const secret = randomBytes(32);
      const authority = i % 2 === 0 ? "127.0.0.1:3080" : "localhost:9999";
      const issuedAt = 1700000000000 + i * 1000;
      const expiresAt = issuedAt + COOKIE_LIFETIME_MS;
      const payload = { version: 1 as const, authority, issuedAt, expiresAt };
      expect(signCookie(payload, secret)).toBe(refSign(payload, secret));
      expect(cookieName(authority)).toBe(refCookieName(authority));
    }
  });

  it("base64url：无 +/= 字符，编解码往返一致，非法输入拒绝", () => {
    const raw = randomBytes(40);
    const enc = encodeBase64Url(raw);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeBase64Url(enc).equals(raw)).toBe(true);
    // 带 padding 的普通 base64 与非法字符都应被拒绝
    expect(() => decodeBase64Url(raw.toString("base64"))).toThrow(DshAuthError);
    expect(() => decodeBase64Url("not valid!")).toThrow(DshAuthError);
    expect(() => decodeBase64Url("a")).toThrow(DshAuthError); // 长度 % 4 === 1
  });

  it("authority 归一：hostname 小写、显式端口保留、默认端口剥离、非法地址拒绝", () => {
    expect(authorityOf("http://127.0.0.1:3080")).toBe("127.0.0.1:3080");
    expect(authorityOf("http://127.0.0.1:3080/")).toBe("127.0.0.1:3080");
    expect(authorityOf("http://LOCALHOST:3080/x")).toBe("localhost:3080");
    expect(authorityOf("http://127.0.0.1")).toBe("127.0.0.1");
    expect(() => authorityOf("not-a-url")).toThrow(DshAuthError);
    expect(() => authorityOf("ftp://x")).toThrow(DshAuthError);
  });
});

describe("YAML 凭据解析", () => {
  it("正常提取 client-connection/browser-session 的 32 字节 secret", () => {
    const key = extractSecretFromYaml(credsYaml(encodeBase64Url(SECRET_A)));
    expect(key.equals(SECRET_A)).toBe(true);
  });

  it("带引号的 secret 同样可提取", () => {
    const key = extractSecretFromYaml(credsYaml(`"${encodeBase64Url(SECRET_A)}"`));
    expect(key.equals(SECRET_A)).toBe(true);
  });

  it("无 browser-session 记录 → 抛带记录名的明确错误", () => {
    const yaml = ["records:", "  other/record:", "    kind: grant", "    payload:", "      version: 1", "      secret: xyz", ""].join("\n");
    expect(() => extractSecretFromYaml(yaml)).toThrow(/client-connection\/browser-session/);
  });

  it("记录缺少 payload.secret → 抛明确错误", () => {
    const yaml = ["records:", "  client-connection/browser-session:", "    kind: grant", "    payload:", "      version: 1", ""].join("\n");
    expect(() => extractSecretFromYaml(yaml)).toThrow(/payload\.secret/);
  });

  it("secret 非法（非 base64url / 长度不是 32 字节）→ 抛明确错误", () => {
    const bad1 = ["records:", "  client-connection/browser-session:", "    kind: grant", "    payload:", "      version: 1", "      secret: a+b/c==", ""].join("\n");
    expect(() => extractSecretFromYaml(bad1)).toThrow(/base64url/);
    const short = encodeBase64Url(randomBytes(16));
    expect(() => extractSecretFromYaml(credsYaml(short))).toThrow(/长度非法/);
  });
});

describe("defaultCredentialsPath（os.homedir 实现）", () => {
  it("拼接 <homedir>/.dsh/.credentials.yaml；尾斜杠归一", () => {
    expect(defaultCredentialsPath(() => "C:\\Users\\tester")).toBe("C:\\Users\\tester/.dsh/.credentials.yaml");
    expect(defaultCredentialsPath(() => "/home/tester")).toBe("/home/tester/.dsh/.credentials.yaml");
    expect(defaultCredentialsPath(() => "C:\\Users\\tester\\")).toBe("C:\\Users\\tester/.dsh/.credentials.yaml");
    expect(defaultCredentialsPath(() => "/home/tester/")).toBe("/home/tester/.dsh/.credentials.yaml");
  });

  it("homedir 为空 / 抛异常 → 抛 DshAuthError（渲染进程无 process 全局，不得裸抛）", () => {
    expect(() => defaultCredentialsPath(() => "")).toThrow(DshAuthError);
    expect(() => defaultCredentialsPath(() => { throw new Error("homedir 不可用"); })).toThrow(DshAuthError);
  });

  it("缺省走 require(\"os\").homedir()，等于 node:os.homedir()", () => {
    expect(defaultCredentialsPath()).toBe(`${homedir()}/.dsh/.credentials.yaml`);
  });
});

describe("DshCookieAuth（注入读取函数）", () => {
  it("cookieHeader 返回完整 Cookie 头值：名称按 authority 哈希、时间窗 = now..now+12h", async () => {
    const now = 1700000000000;
    const auth = new DshCookieAuth({
      baseUrl: "http://127.0.0.1:3080",
      readCredentialsFile: async () => credsYaml(encodeBase64Url(SECRET_A)),
      nowMs: () => now,
    });
    const header = await auth.cookieHeader();
    const { name, payload } = parseCookie(header);
    expect(name).toBe(refCookieName(AUTHORITY));
    expect(payload.authority).toBe(AUTHORITY);
    expect(payload.issuedAt).toBe(now);
    expect(payload.expiresAt - payload.issuedAt).toBe(COOKIE_LIFETIME_MS);
    expect(COOKIE_LIFETIME_MS).toBe(12 * 60 * 60 * 1000);
    expectSignedWith(header, SECRET_A);
  });

  it("每次 cookieHeader 都重新签发（issuedAt 随当前时间变化）", async () => {
    let now = 1000;
    const auth = new DshCookieAuth({
      baseUrl: "http://127.0.0.1:3080",
      readCredentialsFile: async () => credsYaml(encodeBase64Url(SECRET_A)),
      nowMs: () => now,
    });
    const h1 = await auth.cookieHeader();
    now = 2000;
    const h2 = await auth.cookieHeader();
    expect(parseCookie(h1).payload.issuedAt).toBe(1000);
    expect(parseCookie(h2).payload.issuedAt).toBe(2000);
    expect(h1).not.toBe(h2);
  });

  it("读取失败 → 抛 DshAuthError（上层可提示「DSH 凭据不可读」）", async () => {
    const auth = new DshCookieAuth({
      baseUrl: "http://127.0.0.1:3080",
      readCredentialsFile: async () => {
        throw new Error("ENOENT: 文件不存在");
      },
    });
    await expect(auth.cookieHeader()).rejects.toBeInstanceOf(DshAuthError);
    await expect(auth.cookieHeader()).rejects.toThrow(/ENOENT/);
  });

  it("失败后自动重读：凭据恢复后下一次 cookieHeader 成功", async () => {
    let fail = true;
    const auth = new DshCookieAuth({
      baseUrl: "http://127.0.0.1:3080",
      readCredentialsFile: async () => {
        if (fail) throw new Error("ENOENT: 文件不存在");
        return credsYaml(encodeBase64Url(SECRET_A));
      },
    });
    await expect(auth.cookieHeader()).rejects.toBeInstanceOf(DshAuthError);
    fail = false;
    const header = await auth.cookieHeader();
    expectSignedWith(header, SECRET_A);
  });

  it("refresh() 强制重读：secret 内容变化后立即用新 secret 签名", async () => {
    const secretB = randomBytes(32);
    let current = encodeBase64Url(SECRET_A);
    const auth = new DshCookieAuth({
      baseUrl: "http://127.0.0.1:3080",
      readCredentialsFile: async () => credsYaml(current),
    });
    const h1 = await auth.cookieHeader();
    expectSignedWith(h1, SECRET_A);
    current = encodeBase64Url(secretB);
    await auth.refresh();
    const h2 = await auth.cookieHeader();
    expectSignedWith(h2, secretB);
    expect(h2).not.toBe(h1);
  });
});

describe("DshCookieAuth（真实文件路径：<homedir>/.dsh/.credentials.yaml，注入 homedir）", () => {
  let dir: string;
  let credsPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dsh-auth-test-"));
    mkdirSync(join(dir, ".dsh"), { recursive: true });
    credsPath = join(dir, ".dsh", ".credentials.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("读真实凭据路径并自签；文件 mtime 变化后自动用新 secret 重签（DSH 重启换 secret）", async () => {
    const secretB = randomBytes(32);
    writeFileSync(credsPath, credsYaml(encodeBase64Url(SECRET_A)));
    const auth = new DshCookieAuth({ baseUrl: "http://127.0.0.1:3080", homedir: () => dir });
    const h1 = await auth.cookieHeader();
    expectSignedWith(h1, SECRET_A);

    // 模拟 DSH 重启换 secret：重写文件并强制推进 mtime
    writeFileSync(credsPath, credsYaml(encodeBase64Url(secretB)));
    const later = new Date(Date.now() + 5000);
    utimesSync(credsPath, later, later);

    const h2 = await auth.cookieHeader();
    expectSignedWith(h2, secretB);
    expect(h2).not.toBe(h1);
  });

  it("凭据文件缺失 → 抛含路径的明确错误；文件重建后自动恢复", async () => {
    const auth = new DshCookieAuth({ baseUrl: "http://127.0.0.1:3080", homedir: () => dir });
    await expect(auth.cookieHeader()).rejects.toThrow(/无法读取 DSH 凭据文件/);
    writeFileSync(credsPath, credsYaml(encodeBase64Url(SECRET_A)));
    const header = await auth.cookieHeader();
    expectSignedWith(header, SECRET_A);
  });

  it("并发取 cookie 只读一次凭据文件（refresh 去抖）", async () => {
    let reads = 0;
    writeFileSync(credsPath, credsYaml(encodeBase64Url(SECRET_A)));
    const fixedNow = 1700000000000;
    const auth = new DshCookieAuth({
      baseUrl: "http://127.0.0.1:3080",
      readCredentialsFile: async () => {
        reads++;
        return credsYaml(encodeBase64Url(SECRET_A));
      },
      nowMs: () => fixedNow, // 固定时钟：两个并发的 issuedAt 一致，h1===h2 断言不受毫秒差影响（flaky 根因）
    });
    const [h1, h2] = await Promise.all([auth.cookieHeader(), auth.cookieHeader()]);
    expect(reads).toBe(1);
    expect(h1).toBe(h2);
  });
});
