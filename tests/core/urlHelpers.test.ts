/**
 * `sameUrl` / `isLoopbackUrl`：换端口自愈与候选探测共用的两个判定。
 *
 * 它们原先写在 `main.ts` 里且未导出，因此从未被测试覆盖 —— 而这两条判定直接决定：
 * - `sameUrl`：发现到的地址是否「就是当前这个连不上的地址」（跳过它，否则自愈空转）
 * - `isLoopbackUrl`：是否允许做本机端口发现（远端 DSH 绝不能被本机端口顶掉）
 *
 * 把 `isLoopbackUrl` 收进 diagnose 后，`candidateDshUrls` 里那份内联判定也改用它，
 * 杜绝「同一规则两处实现、改一处漏一处」。
 */
import { describe, expect, it } from "vitest";
import { isLoopbackUrl, sameUrl } from "../../src/core/diagnose";

describe("sameUrl", () => {
  it("结尾斜杠差异视为同一入口（落盘值与发现值的常见差异）", () => {
    expect(sameUrl("http://127.0.0.1:56516", "http://127.0.0.1:56516/")).toBe(true);
  });

  it("端口不同视为不同入口（换端口的核心判定）", () => {
    expect(sameUrl("http://127.0.0.1:56516", "http://127.0.0.1:49651")).toBe(false);
  });

  it("host 不同视为不同入口", () => {
    expect(sameUrl("http://127.0.0.1:3080", "http://localhost:3080")).toBe(false);
  });

  it("相同字符串为 true", () => {
    expect(sameUrl("http://127.0.0.1:3080", "http://127.0.0.1:3080")).toBe(true);
  });

  it("非法地址退化为字符串比较，不抛错", () => {
    expect(() => sameUrl("not-a-url", "not-a-url")).not.toThrow();
    expect(sameUrl("not-a-url", "not-a-url")).toBe(true);
    expect(sameUrl("not-a-url", "http://127.0.0.1:1")).toBe(false);
  });
});

describe("isLoopbackUrl", () => {
  it("127.0.0.1 是本机", () => {
    expect(isLoopbackUrl("http://127.0.0.1:56516")).toBe(true);
  });

  it("localhost 也算本机（macOS 上可能先解析到 ::1）", () => {
    expect(isLoopbackUrl("http://localhost:3080")).toBe(true);
  });

  it("IPv6 回环 [::1] 算本机", () => {
    expect(isLoopbackUrl("http://[::1]:3080")).toBe(true);
  });

  it("远端地址不是本机 —— 否则远端 DSH 会被本机端口顶掉", () => {
    expect(isLoopbackUrl("http://192.168.1.10:3080")).toBe(false);
    expect(isLoopbackUrl("https://dsh.example.com")).toBe(false);
  });

  it("看起来像本机的字符串不算 —— 必须整串等于，不能用前缀/后缀匹配", () => {
    expect(isLoopbackUrl("http://0.0.0.0:3080")).toBe(false);
    expect(isLoopbackUrl("http://127.0.0.1.evil.com")).toBe(false);
    // 这两条专门防「用 includes/startsWith 实现」的退化写错法
    expect(isLoopbackUrl("http://127.0.0.1127.0.0.1:3080")).toBe(false);
    expect(isLoopbackUrl("http://evil-localhost.com")).toBe(false);
  });

  it("非法地址返回 false 而不是抛错", () => {
    expect(() => isLoopbackUrl("not-a-url")).not.toThrow();
    expect(isLoopbackUrl("not-a-url")).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
  });
});
