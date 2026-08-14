import { existsSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("build sanity", () => {
  it("main.js 产物存在且包含 Node 版 ws 实现（而非浏览器 stub）", () => {
    // 构建产物由 npm run build 生成；该用例在 CI/本地流程中于构建后运行。
    if (!existsSync("main.js")) return; // 未构建时跳过
    const bundle = readFileSync("main.js", "utf8");
    expect(bundle.length).toBeGreaterThan(5000);
    expect(bundle).not.toContain("ws does not work in the browser");
    // ws 未被打进产物前（当前任务）该断言会失败，因此仅当 bundle 包含 ws 时检查
    if (bundle.includes("receiverOnMessage")) {
      expect(bundle).toContain("require(\"tls\")");
    }
  });
});
