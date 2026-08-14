import { existsSync, readFileSync } from "fs";
import { describe, expect, it } from "vitest";

describe("build sanity", () => {
  it("main.js 产物不含 ws 浏览器 stub；一旦打包 ws 必须是 Node 实现", () => {
    // 构建产物由 npm run build 生成；未构建时跳过（避免与单元测试的执行顺序耦合）。
    if (!existsSync("main.js")) return;
    const bundle = readFileSync("main.js", "utf8");
    expect(bundle).not.toContain("ws does not work in the browser");
    // 仅当 ws 已被打包进产物时，进一步断言它是 Node 实现（依赖 net/tls）。
    if (bundle.includes("receiverOnMessage")) {
      expect(bundle).toContain('require("tls")');
    }
  });
});
