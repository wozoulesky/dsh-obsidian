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

// ---------------------------------------------------------------------------
// 内置中英双语 + 跟随 Obsidian 语言（TASK：i18n 内置双语）
// 以上既有用例必须保持原样通过；以下为新增覆盖。
// ---------------------------------------------------------------------------

import { EN_STRINGS, resolveLanguage, resolveObsidianLanguage } from "../src/i18n";

const CJK = /[\u4e00-\u9fff]/;
const placeholdersOf = (text: string): string[] =>
  Array.from(text.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort();

describe("内置英文文案表 EN_STRINGS", () => {
  it("与 DEFAULT_STRINGS 键集完全一致（防漏翻/防多余键）", () => {
    expect(Object.keys(EN_STRINGS).sort()).toEqual(Object.keys(DEFAULT_STRINGS).sort());
  });

  it("每条都是非空字符串，没有留空/TODO 占位", () => {
    for (const [key, value] of Object.entries(EN_STRINGS)) {
      expect(typeof value, `${key} 必须是字符串`).toBe("string");
      expect(value.trim().length, `${key} 不能为空`).toBeGreaterThan(0);
      expect(value, `${key} 不能是 TODO`).not.toMatch(/TODO|FIXME|待翻译/i);
    }
  });

  it("英文表里没有中文残留（允许 {param} 占位符与纯符号）", () => {
    const offenders = Object.entries(EN_STRINGS)
      .filter(([, value]) => CJK.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it("英文表包含中文表对应条目的全部 {param} 占位符（防运行时露出 {message}）", () => {
    const missing: string[] = [];
    for (const [key, zh] of Object.entries(DEFAULT_STRINGS)) {
      const en = EN_STRINGS[key];
      if (en === undefined) {
        missing.push(`${key}: 英文表缺失该键`);
        continue;
      }
      const zhParams = placeholdersOf(zh);
      const enParams = placeholdersOf(en);
      const lost = zhParams.filter((p) => !enParams.includes(p));
      if (lost.length > 0) missing.push(`${key}: 丢失 {${lost.join("}, {")}}`);
    }
    expect(missing).toEqual([]);
  });
});

describe("resolveLanguage（纯函数，由 main.ts 传入 getLanguage() 的结果）", () => {
  it.each([
    ["en", "en"],
    ["en-US", "en"],
    ["EN", "en"],
    ["ja", "en"],
    ["de-DE", "en"],
    ["zh", "zh"],
    ["zh-cn", "zh"],
    ["zh-CN", "zh"],
    ["zh-TW", "zh"],
    ["zh-hans", "zh"],
    ["zh-hant", "zh"],
    ["zh_CN", "zh"],
    [" zh-cn ", "zh"],
  ] as const)("%s → %s", (raw, expected) => {
    expect(resolveLanguage(raw)).toBe(expected);
  });

  it("拿不到语言（undefined/null/空串/纯空白）时回落中文，保持旧行为不倒退", () => {
    expect(resolveLanguage(undefined)).toBe("zh");
    expect(resolveLanguage(null as unknown as undefined)).toBe("zh");
    expect(resolveLanguage("")).toBe("zh");
    expect(resolveLanguage("   ")).toBe("zh");
  });

  it("getLanguage 抛错/缺失时 resolveObsidianLanguage 回落中文而不是崩插件", () => {
    expect(resolveObsidianLanguage(() => "en")).toBe("en");
    expect(resolveObsidianLanguage(() => "zh-TW")).toBe("zh");
    expect(resolveObsidianLanguage(() => { throw new Error("no api"); })).toBe("zh");
    expect(resolveObsidianLanguage(undefined)).toBe("zh");
  });

  /**
   * `getLanguage()` 是 Obsidian 1.8.7 才有的 API，而本插件 minAppVersion 是 1.7.2。
   * main.ts 用 `requireApiVersion("1.8.7") ? getLanguage() : undefined` 守卫；
   * 这里模拟老宿主（守卫为 false、读取器返回 undefined）必须回落中文，
   * 且当守卫为 true 时正常取到英文——防止有人日后把守卫改坏。
   */
  it("requireApiVersion 守卫：老宿主回落中文，新宿主正常识别英文", () => {
    const readWithGuard = (apiVersion: string, lang: string) => {
      const supported = requireApiVersionAt("1.8.7", apiVersion);
      return resolveObsidianLanguage(() => (supported ? lang : undefined));
    };
    expect(readWithGuard("1.7.2", "en")).toBe("zh"); // 老宿主：没有 getLanguage，回落中文
    expect(readWithGuard("1.13.7", "en")).toBe("en"); // 新宿主：跟随英文
    expect(readWithGuard("1.13.7", "zh-cn")).toBe("zh");
  });
});

/** 与 main.ts 里 requireApiVersion 相同的语义（数值段逐段比较），便于在纯函数测试里复现守卫。 */
function requireApiVersionAt(want: string, have: string): boolean {
  const parse = (v: string): number[] => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const w = parse(want);
  const h = parse(have);
  for (let i = 0; i < Math.max(w.length, h.length); i++) {
    const wv = w[i] ?? 0;
    const hv = h[i] ?? 0;
    if (hv > wv) return true;
    if (hv < wv) return false;
  }
  return true;
}

describe("I18n 按语言取文案", () => {
  it("new I18n() 默认仍是中文（向后兼容）", () => {
    expect(new I18n().t("chat.older")).toBe("加载更早");
  });

  it("new I18n({}, \"en\") 返回英文；new I18n({}, \"zh\") 返回中文", () => {
    expect(new I18n({}, "en").t("chat.older")).toBe("Load earlier");
    expect(new I18n({}, "zh").t("chat.older")).toBe("加载更早");
  });

  it("构造函数也接受原始 ISO 码（如 \"zh-CN\" / \"en-US\"），内部归一化", () => {
    expect(new I18n({}, "zh-CN").t("chat.new")).toBe("新建");
    expect(new I18n({}, "en-US").t("chat.new")).toBe("New");
  });

  it("overrides 在两种语言下都优先于内置表", () => {
    const overrides = { "chat.older": "Custom earlier" };
    expect(new I18n(overrides, "en").t("chat.older")).toBe("Custom earlier");
    expect(new I18n(overrides, "zh").t("chat.older")).toBe("Custom earlier");
  });

  it("英文模式下仍支持 {param} 占位符替换", () => {
    expect(new I18n({}, "en").t("chat.sendFailed", { message: "boom" })).toBe("Send failed: boom");
  });

  it("英文模式下未知 key 仍回落 key 本身", () => {
    expect(new I18n({}, "en").t("missing.key")).toBe("missing.key");
  });
});

describe("loadI18n 增加 lang 参数", () => {
  it("传 zh 时读覆盖、缺省回落中文", async () => {
    const i18n = await loadI18n(["a.json"], async () => JSON.stringify({ "chat.new": "New" }), "zh");
    expect(i18n.t("chat.new")).toBe("New");
    expect(i18n.t("chat.older")).toBe("加载更早");
  });

  it("传 en 时缺省回落英文", async () => {
    const i18n = await loadI18n(["a.json"], async () => { throw new Error("ENOENT"); }, "en");
    expect(i18n.t("chat.older")).toBe("Load earlier");
    expect(i18n.t("chat.new")).toBe("New");
  });

  it("不传 lang 时默认中文（向后兼容）", async () => {
    const i18n = await loadI18n(["a.json"], async () => { throw new Error("ENOENT"); });
    expect(i18n.t("chat.older")).toBe("加载更早");
  });
});

describe("过期文案修正（0.2.1 桌面端改为随机端口，不再固定 19387）", () => {
  it.each(["zh", "en"] as const)("%s 的 settings.dshUrlDesc 不再宣称桌面端固定 19387，并说明自动探测", (lang) => {
    const desc = new I18n({}, lang).t("settings.dshUrlDesc");
    expect(desc).not.toContain("19387");
    expect(desc).not.toMatch(/固定|fixed/i);
    // 核心语义：一般不用手填 / 自动探测 / 桌面版随机端口
    expect(desc).toMatch(lang === "zh" ? /自动探测/ : /detect/i);
    expect(desc).toMatch(lang === "zh" ? /随机端口/ : /random port/i);
    expect(desc).toMatch(lang === "zh" ? /手动指定/ : /manually/i);
  });

  it.each(["zh", "en"] as const)("%s 的 diag.notRunning 不再引导用户去改 19387", (lang) => {
    const text = new I18n({}, lang).t("diag.notRunning");
    expect(text).not.toContain("19387");
    expect(text).toMatch(lang === "zh" ? /确认 DSH 已启动/ : /Confirm DSH is started/i);
    expect(text).toMatch(lang === "zh" ? /重新探测/ : /probe again/i);
  });

  it.each(["zh", "en"] as const)("%s 的 diag.unreachable 不再引导用户去改 19387", (lang) => {
    const text = new I18n({}, lang).t("diag.unreachable");
    expect(text).not.toContain("19387");
    expect(text).toMatch(lang === "zh" ? /确认 DSH 已启动/ : /Confirm DSH is started/i);
    expect(text).toMatch(lang === "zh" ? /重新探测/ : /probe again/i);
  });
});

describe("i18n.template.json 作为中文基准与内置双语表保持同步", () => {
  it("模板键与 EN_STRINGS 完全一致", () => {
    const template = JSON.parse(readFileSync("i18n.template.json", "utf8"));
    expect(Object.keys(template).sort()).toEqual(Object.keys(EN_STRINGS).sort());
  });

  it("模板是中文基准（值等于 DEFAULT_STRINGS 的中文文案）", () => {
    const template = JSON.parse(readFileSync("i18n.template.json", "utf8")) as Record<string, string>;
    for (const [key, zh] of Object.entries(DEFAULT_STRINGS)) {
      expect(template[key], `模板 ${key} 与中文内置表不同步`).toBe(zh);
    }
  });
});
