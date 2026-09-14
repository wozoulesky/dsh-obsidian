import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // obsidian npm 包只有类型（main 为空），测试统一指向最小 stub。
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-window.ts"],
    passWithNoTests: true,
    // 传输层用例各自起真实 TCP/WebSocket 服务，且自带 waitFor 轮询预算：
    // 单次 2000ms（退避重连用例 4000ms），单个用例内串行调用两次 → 最坏 ~4.2s 以上。
    // vitest 默认 5000ms 在高负载（36 个文件并行、多文件抢端口）时会先于内层守卫触发，
    // 报出无信息量的 "Test timed out in 5000ms"，把真正的诊断
    // "timeout waiting for <label>" 掩盖掉。上调到明显高于最坏内层预算，
    // 让内层轮询器继续充当有效的失败守卫。
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
