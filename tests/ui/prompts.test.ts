import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, collectMentionPaths, filterBuiltinCommands, isClearCommand, matchSuggestToken, resolveMentions, truncate } from "../../src/ui/prompts";

describe("BUILTIN_COMMANDS", () => {
  it("包含 /plan 且所有命令以 / 开头", () => {
    expect(BUILTIN_COMMANDS.some((c) => c.name === "/plan")).toBe(true);
    for (const c of BUILTIN_COMMANDS) expect(c.name.startsWith("/")).toBe(true);
  });

  it("包含前端命令 /clear（本地拦截，不发给服务端）", () => {
    expect(BUILTIN_COMMANDS.some((c) => c.name === "/clear")).toBe(true);
  });
});

describe("isClearCommand", () => {
  it("精确匹配 /clear（忽略首尾空白）", () => {
    expect(isClearCommand("/clear")).toBe(true);
    expect(isClearCommand("  /clear  ")).toBe(true);
  });

  it("带参数/其他文本不拦截（/clear foo 仍按普通消息发给 DSH）", () => {
    expect(isClearCommand("/clear foo")).toBe(false);
    expect(isClearCommand("/compact")).toBe(false);
    expect(isClearCommand("normal message")).toBe(false);
  });
});

describe("collectMentionPaths", () => {
  it("提取 @file: 标记中的路径", () => {
    expect(collectMentionPaths("改一下 @file:notes/a.md 和 @file:todo/b.md 的风格")).toEqual(["notes/a.md", "todo/b.md"]);
  });
  it("无标记返回空数组", () => {
    expect(collectMentionPaths("普通文本")).toEqual([]);
  });
});

describe("resolveMentions", () => {
  it("把 @file: 标记替换为引用块并截断长内容", async () => {
    const read = async (path: string) => (path === "a.md" ? { kind: "file" as const, text: "AAAA" } : null);
    const out = await resolveMentions("看下 @file:a.md", read, 3);
    expect(out).toBe("看下 文件 a.md：\n> AAA…");
  });

  it("文件不存在时替换为错误说明", async () => {
    const out = await resolveMentions("看下 @file:missing.md", async () => null, 100);
    expect(out).toContain("找不到");
  });

  it("@folder: 注入目录树并标注为目录", async () => {
    const read = async (path: string) => (path === "notes" ? { kind: "folder" as const, text: "a.md\nb/" } : null);
    const out = await resolveMentions("整理 @folder:notes", read, 100);
    expect(out).toBe("整理 目录 notes：\n> a.md\n> b/");
  });

  it("同一路径提及多次时全部替换（String.replace 字符串模式只替换首处的回归）", async () => {
    const read = async (path: string) => ({ kind: "file" as const, text: "AAAA" });
    const out = await resolveMentions("对比 @file:a.md 与 @file:a.md", read, 100);
    expect(out.match(/文件 a\.md：/g)).toHaveLength(2);
    expect(out).not.toContain("@file:");
  });

  it("collectMentionPaths 同时捕获 file 与 folder 标记", () => {
    expect(collectMentionPaths("@file:a.md @folder:notes")).toEqual(["a.md", "notes"]);
  });
});

describe("filterBuiltinCommands", () => {
  it("按命令名过滤（忽略前导 /，不区分大小写）", () => {
    expect(filterBuiltinCommands("com").map((c) => c.name)).toEqual(["/compact"]);
    expect(filterBuiltinCommands("pl").map((c) => c.name)).toContain("/plan");
    expect(filterBuiltinCommands("").map((c) => c.name)).toEqual(BUILTIN_COMMANDS.map((c) => c.name));
    expect(filterBuiltinCommands("xyz")).toEqual([]);
  });
});

describe("matchSuggestToken", () => {
  it("输入框光标前 @ 触发提及联想（含空查询）", () => {
    expect(matchSuggestToken("@")).toEqual({ kind: "mention", query: "" });
    expect(matchSuggestToken("和 @")).toEqual({ kind: "mention", query: "" });
    expect(matchSuggestToken("@测")).toEqual({ kind: "mention", query: "测" });
    expect(matchSuggestToken("@file:a.md")).toEqual({ kind: "mention", query: "a.md" });
  });

  it("/ 触发命令联想", () => {
    expect(matchSuggestToken("/")).toEqual({ kind: "slash", query: "" });
    expect(matchSuggestToken("/pl")).toEqual({ kind: "slash", query: "pl" });
  });

  it("无 token（正文/结尾空格）返回 null", () => {
    expect(matchSuggestToken("你好")).toBeNull();
    expect(matchSuggestToken("对比 @file:a.md 和 ")).toBeNull();
    expect(matchSuggestToken("")).toBeNull();
  });
});

describe("truncate", () => {
  it("超过上限时截断并加省略号", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
  it("不超上限原样返回", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });
});
