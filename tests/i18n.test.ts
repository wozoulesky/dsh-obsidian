import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_STRINGS, I18n, loadI18n } from "../src/i18n";

describe("I18n.t", () => {
  it("返回默认中文文案", () => {
    expect(new I18n().t("chat.older")).toBe("加载更早");
  });

  it("外部覆盖优先于默认", () => {
    const i18n = new I18n({ "chat.older": "Load earlier" });
    expect(i18n.t("chat.older")).toBe("Load earlier");
  });

  it("未知 key 回落为 key 本身", () => {
    expect(new I18n().t("missing.key")).toBe("missing.key");
  });

  it("支持 {param} 占位符替换", () => {
    const i18n = new I18n({ "chat.sendFailed": "Send failed: {message}" });
    expect(i18n.t("chat.sendFailed", { message: "boom" })).toBe("Send failed: boom");
    expect(new I18n().t("chat.sendFailed", { message: "boom" })).toContain("boom");
  });
});

describe("loadI18n", () => {
  it("读取合法 JSON 并只保留字符串覆盖", async () => {
    const i18n = await loadI18n(".obsidian/plugins/dsh-bridge", async (path) => {
      expect(path).toBe(".obsidian/plugins/dsh-bridge/i18n.json");
      return JSON.stringify({ "chat.older": "Older", "chat.new": 123 });
    });
    expect(i18n.t("chat.older")).toBe("Older");
    expect(i18n.t("chat.new")).toBe("新建"); // 非字符串值被忽略，回落默认
  });

  it("文件缺失时回落默认且不抛错", async () => {
    const i18n = await loadI18n("dir", async () => {
      throw new Error("ENOENT");
    });
    expect(i18n.t("chat.older")).toBe("加载更早");
  });

  it("非法 JSON 时回落默认且不抛错", async () => {
    const i18n = await loadI18n("dir", async () => "{ not json");
    expect(i18n.t("chat.older")).toBe("加载更早");
  });

  it("非对象 JSON 时回落默认", async () => {
    const i18n = await loadI18n("dir", async () => "[]");
    expect(i18n.t("chat.older")).toBe("加载更早");
  });
});

describe("i18n.template.json", () => {
  it("模板键与 DEFAULT_STRINGS 完全一致，避免文档与实现漂移", () => {
    const template = JSON.parse(readFileSync("i18n.template.json", "utf8"));
    expect(Object.keys(template).sort()).toEqual(Object.keys(DEFAULT_STRINGS).sort());
  });
});
