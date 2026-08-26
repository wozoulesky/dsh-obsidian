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
    const i18n = await loadI18n(["dir/i18n.json"], async (path) => {
      expect(path).toBe("dir/i18n.json");
      return JSON.stringify({ "chat.older": "Older", "chat.new": 123 });
    });
    expect(i18n.t("chat.older")).toBe("Older");
    expect(i18n.t("chat.new")).toBe("新建"); // 非字符串值被忽略，回落默认
  });

  it("文件缺失时回落默认且不抛错", async () => {
    const i18n = await loadI18n(["dir/i18n.json"], async () => {
      throw new Error("ENOENT");
    });
    expect(i18n.t("chat.older")).toBe("加载更早");
  });

  it("非法 JSON 时回落默认且不抛错", async () => {
    const i18n = await loadI18n(["dir/i18n.json"], async () => "{ not json");
    expect(i18n.t("chat.older")).toBe("加载更早");
  });

  it("非对象 JSON 时回落默认", async () => {
    const i18n = await loadI18n(["dir/i18n.json"], async () => "[]");
    expect(i18n.t("chat.older")).toBe("加载更早");
  });

  it("候选路径按序尝试：第一个合法对象生效（vault 根优先于插件目录）", async () => {
    const i18n = await loadI18n(
      ["dsh-bridge.i18n.json", "plugins/i18n.json"],
      async (path) => (path === "dsh-bridge.i18n.json" ? JSON.stringify({ "chat.older": "From vault root" }) : JSON.stringify({ "chat.older": "From plugin dir" }))
    );
    expect(i18n.t("chat.older")).toBe("From vault root");
  });

  it("第一个候选缺失/非法时尝试下一个候选", async () => {
    const i18n = await loadI18n(
      ["broken.json", "plugins/i18n.json"],
      async (path) => {
        if (path === "broken.json") throw new Error("ENOENT");
        return JSON.stringify({ "chat.older": "From plugin dir" });
      }
    );
    expect(i18n.t("chat.older")).toBe("From plugin dir");
  });

  it("vault 根文件为非法 JSON 时不阻塞插件目录候选", async () => {
    const i18n = await loadI18n(
      ["vault.json", "plugins/i18n.json"],
      async (path) => (path === "vault.json" ? "{ bad" : JSON.stringify({ "chat.older": "From plugin dir" }))
    );
    expect(i18n.t("chat.older")).toBe("From plugin dir");
  });
});

describe("i18n.template.json", () => {
  it("模板键与 DEFAULT_STRINGS 完全一致，避免文档与实现漂移", () => {
    const template = JSON.parse(readFileSync("i18n.template.json", "utf8"));
    expect(Object.keys(template).sort()).toEqual(Object.keys(DEFAULT_STRINGS).sort());
  });
});
