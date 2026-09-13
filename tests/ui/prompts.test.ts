import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  FRONTEND_COMMANDS,
  collectMentionPaths,
  filterCommandSuggestions,
  isClearCommand,
  matchSuggestToken,
  mergeCommandSuggestions,
  resolveMentions,
  routeInput,
  truncate,
  truncateTail,
} from "../../src/ui/prompts";
import type { CommandDescriptor } from "../../src/transport/types";

const t = (key: string) => `[${key}]`;

describe("BUILTIN_COMMANDS", () => {
  it("包含 /plan 且所有命令以 / 开头", () => {
    expect(BUILTIN_COMMANDS.some((c) => c.name === "/plan")).toBe(true);
    for (const c of BUILTIN_COMMANDS) expect(c.name.startsWith("/")).toBe(true);
  });

  it("包含前端命令 /clear（本地拦截，不发给服务端）", () => {
    expect(BUILTIN_COMMANDS.some((c) => c.name === "/clear")).toBe(true);
    expect(FRONTEND_COMMANDS.map((c) => c.name)).toEqual(["/clear"]);
  });

  it("离线兜底清单覆盖真机实测的 6 条服务端命令 + /clear", () => {
    // 真机 commands/list 返回 compact/export/feedback/goal/permission/plan（tmp/probe-task030.notes.md）
    expect(BUILTIN_COMMANDS.map((c) => c.name).sort()).toEqual([
      "/clear",
      "/compact",
      "/export",
      "/feedback",
      "/goal",
      "/permission",
      "/plan",
    ]);
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

describe("routeInput（TASK-030 项 2 输入路由）", () => {
  it("/clear → 前端命令", () => {
    expect(routeInput("/clear")).toEqual({ kind: "clear" });
    expect(routeInput("  /clear ")).toEqual({ kind: "clear" });
  });

  it("斜杠命令词法 → command（不依赖本地清单，由服务端裁决是否注册）", () => {
    expect(routeInput("/compact")).toEqual({ kind: "command" });
    expect(routeInput("/goal create 完成 X")).toEqual({ kind: "command" });
    expect(routeInput("/permission")).toEqual({ kind: "command" });
  });

  it("非命令词法的输入 → prompt（含以 / 开头但不是命令名的路径）", () => {
    expect(routeInput("你好")).toEqual({ kind: "prompt" });
    expect(routeInput("/tmp/foo 看看")).toEqual({ kind: "prompt" }); // 命令名后必须空白/行尾
    expect(routeInput("/Clear")).toEqual({ kind: "prompt" }); // 大写不是合法命令名
    expect(routeInput("@file:a.md 总结")).toEqual({ kind: "prompt" });
  });

  it("/clear 带参数仍走 command 路线（服务端不认识时回退 prompt）", () => {
    expect(routeInput("/clear foo")).toEqual({ kind: "command" });
  });
});

describe("mergeCommandSuggestions / filterCommandSuggestions", () => {
  const server: CommandDescriptor[] = [
    { name: "compact", description: "Compact older conversation history" },
    { name: "goal", description: "set or view the goal", input: { hint: "[<objective>]", attachments: true } },
  ];

  it("在线清单：前端命令恒在首位，服务端描述原样使用", () => {
    const items = mergeCommandSuggestions(server, t);
    expect(items.map((c) => c.name)).toEqual(["/clear", "/compact", "/goal"]);
    expect(items[1].description).toBe("Compact older conversation history");
    expect(items[0].description).toBe("[command.clear.desc]");
  });

  it("离线（null）：退回内置兜底清单 + i18n 描述", () => {
    const items = mergeCommandSuggestions(null, t);
    expect(items.map((c) => c.name)).toEqual(BUILTIN_COMMANDS.map((c) => c.name));
    expect(items.every((c) => c.description.startsWith("["))).toBe(true);
  });

  it("服务端若也返回 clear，不与前端 /clear 重复", () => {
    const items = mergeCommandSuggestions([{ name: "clear", description: "server clear" }, ...server], t);
    expect(items.filter((c) => c.name === "/clear")).toHaveLength(1);
    expect(items[0].description).toBe("[command.clear.desc]");
  });

  it("按查询过滤（忽略前导 /，不区分大小写）", () => {
    const items = mergeCommandSuggestions(server, t);
    expect(filterCommandSuggestions(items, "com").map((c) => c.name)).toEqual(["/compact"]);
    expect(filterCommandSuggestions(items, "GO").map((c) => c.name)).toEqual(["/goal"]);
    expect(filterCommandSuggestions(items, "")).toHaveLength(items.length);
    expect(filterCommandSuggestions(items, "zzz")).toEqual([]);
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

describe("truncateTail（流式推理取尾部）", () => {
  it("超过上限时保留末尾并前置省略号", () => {
    expect(truncateTail("abcdef", 3)).toBe("…def");
  });

  it("不超上限原样返回（与 truncate 一致）", () => {
    expect(truncateTail("abc", 3)).toBe("abc");
    expect(truncateTail("", 3)).toBe("");
  });

  it("与 truncate 互补：一个保头一个保尾，长度都不超过 max+1", () => {
    const long = "x".repeat(50) + "TAIL";
    expect(truncate(long, 10).endsWith("…")).toBe(true);
    expect(truncateTail(long, 10).endsWith("TAIL")).toBe(true);
    expect(truncateTail(long, 10).length).toBe(11);
  });
});
