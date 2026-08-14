import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, collectMentionPaths, resolveMentions, truncate } from "../../src/ui/prompts";

describe("BUILTIN_COMMANDS", () => {
  it("包含 /plan 且所有命令以 / 开头", () => {
    expect(BUILTIN_COMMANDS.some((c) => c.name === "/plan")).toBe(true);
    for (const c of BUILTIN_COMMANDS) expect(c.name.startsWith("/")).toBe(true);
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

  it("collectMentionPaths 同时捕获 file 与 folder 标记", () => {
    expect(collectMentionPaths("@file:a.md @folder:notes")).toEqual(["a.md", "notes"]);
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
