/**
 * TASK-030 项 2：命令域（`src/core/commands.ts`）单测。
 *
 * 词法契约与 host 端 `parseCommand` 同源（真机反例实测："/x" 被视为命令名 "x"，
 * 未注册时 host 返回 undefined 且不写任何 session 日志）。
 * 清单收窄契约：非数组 → 空数组；逐项剔除畸形项；input.hint 为空视为无 input。
 */
import { describe, expect, it } from "vitest";
import { classifyCommandResult, commandNameOf, isCommandLine, narrowCommandDescriptors } from "../../src/core/commands";
import type { CommandExecution } from "../../src/transport/types";

describe("commandNameOf / isCommandLine", () => {
  it("识别标准命令行（含带参数与行尾）", () => {
    expect(commandNameOf("/compact")).toBe("compact");
    expect(commandNameOf("/goal create 完成 X")).toBe("goal");
    expect(commandNameOf("/plan\toff")).toBe("plan");
    expect(commandNameOf("/permission\n")).toBe("permission");
  });

  it("命令名后必须空白或行尾（与 host 同源）：路径不当命令", () => {
    expect(isCommandLine("/tmp/foo 看看")).toBe(false);
    expect(isCommandLine("/compact-x")).toBe(true); // 合法命令名字符，是否注册由服务端裁决
    expect(isCommandLine("/compact2")).toBe(true);
  });

  it("非命令行：大写/数字开头/无斜杠/中文", () => {
    for (const text of ["/Clear", "/1abc", "compact", "你好", "", "  ", "@/x"]) {
      expect(isCommandLine(text)).toBe(false);
      expect(commandNameOf(text)).toBeUndefined();
    }
  });

  it("前导空白不算命令行（host 用 ^ 锚定）", () => {
    expect(isCommandLine(" /compact")).toBe(false);
  });
});

describe("narrowCommandDescriptors", () => {
  it("消费真机样本（compact/goal 等，含 input 声明）", () => {
    const real = [
      { name: "compact", description: "Compact older conversation history" },
      { name: "goal", description: "set or view the goal for a long-running task", input: { hint: "[<objective>|clear|edit <objective>|pause|resume]", attachments: true } },
      { name: "feedback", description: "record feedback about this session", input: { hint: "<text>" } },
    ];
    expect(narrowCommandDescriptors(real)).toEqual(real);
  });

  it("attachments 只有为 true 才保留（false/缺省都不写入该键）", () => {
    const narrowed = narrowCommandDescriptors([
      { name: "a", description: "d", input: { hint: "h", attachments: false } },
      { name: "b", description: "d", input: { hint: "h" } },
    ]);
    expect(narrowed[0].input).toEqual({ hint: "h" });
    expect(narrowed[1].input).toEqual({ hint: "h" });
  });

  it("畸形项被逐个剔除，合法项保留", () => {
    const narrowed = narrowCommandDescriptors([
      { name: "ok", description: "keep" },
      { name: "", description: "空名字" },
      { name: "no-desc" },
      { description: "无名字" },
      "compact",
      null,
      42,
      { name: "bad-input", description: "d", input: { hint: "" } },
    ]);
    expect(narrowed.map((c) => c.name)).toEqual(["ok", "bad-input"]);
    expect(narrowed[1].input).toBeUndefined(); // hint 为空 → 视为未声明 input
  });

  it("非数组（undefined/null/对象/字符串）→ 空数组（UI 退回内置兜底清单）", () => {
    for (const bad of [undefined, null, {}, "commands", 7]) {
      expect(narrowCommandDescriptors(bad)).toEqual([]);
    }
  });

  it("不修改入参（纯函数）", () => {
    const real = [{ name: "compact", description: "d", input: { hint: "h", attachments: true } }];
    narrowCommandDescriptors(real);
    expect(real[0].input).toEqual({ hint: "h", attachments: true });
  });
});

describe("classifyCommandResult（路由决策）", () => {
  const success: CommandExecution = { commandId: "cmd-1", result: { kind: "success", text: "已压缩" } };
  const failure: CommandExecution = { commandId: "cmd-2", result: { kind: "error", text: "/goal 需要参数" } };

  it("undefined → fallback（服务端不认识这行，回退为普通 prompt）", () => {
    expect(classifyCommandResult({ ok: true, value: undefined })).toBe("fallback");
  });

  it("成功 → handled；命令存在但执行失败 → failed（不得当正文重发）", () => {
    expect(classifyCommandResult({ ok: true, value: success })).toBe("handled");
    expect(classifyCommandResult({ ok: true, value: failure })).toBe("failed");
  });

  it("调用层错误（网关/超时）→ failed", () => {
    expect(classifyCommandResult({ ok: false, error: { code: "gateway/arguments-invalid", message: "x" } })).toBe("failed");
  });

  it("result 字段畸形（线上漂移）→ failed 而非崩溃", () => {
    const malformed = { commandId: "c", result: { kind: "unknown" } } as unknown as CommandExecution;
    expect(classifyCommandResult({ ok: true, value: malformed })).toBe("failed");
  });
});
