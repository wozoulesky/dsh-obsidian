/**
 * 与 Obsidian 社区审核同源的本地 lint（2026-09-13 接入）。
 *
 * 为什么要有它：社区审核只是在**发布之后**告诉你哪里不合规，而它报告的消息文案有时
 * 与真实触发条件不符（例：`prefer-create-el` 的文案写「document.createElement」，
 * 实际触发是 `createEl("span")` 应改 `createSpan`）。本地跑同一套规则 = 发布前拦住，
 * 不用等一轮审核往返。
 *
 * 来源：eslint-plugin-obsidianmd（社区审核使用的规则包）+ 官方 recommended 配置。
 * 已验证：把历史告警还原后，本配置能精确复现审核报告的同一条告警。
 *
 * 不检查 tests/：测试替身需要放宽类型，规则在此处噪声大于收益。
 */
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";

export default tseslint.config(
  { ignores: ["main.js", "node_modules/**", "tmp/**", "docs/**", "tests/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  ...obsidianmd.configs.recommended,
);
