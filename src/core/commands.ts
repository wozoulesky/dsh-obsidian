/**
 * 命令域（TASK-030 项 2）：`commands/list` 负载收窄 + 斜杠命令行词法判定。
 *
 * 词法规则与 host 端 `parseCommand`（`@deepseek-ai/dsh-commands`）**同源**：
 * 斜杠 + 小写字母开头的命令名（`a-z0-9_-`），且命令名后必须是行尾或空白
 * （见下方 `COMMAND_LINE_RE`）——因此 "/tmp/foo 看看" 里的 `/tmp` 虽被解析为命令名，
 * 但未注册 → host 返回 `undefined`，插件据此回退为普通 prompt
 * （不猜、不本地维护白名单）。
 */
import type { CommandDescriptor, CommandExecution, CommandInputHint, RpcResult } from "../transport/types";
import { isObject, nonEmptyStringField, readField } from "./narrow";

/** 命令行词法（与 host 端同源）。 */
const COMMAND_LINE_RE = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u;

/** 取命令名（不含前导 `/`）；不是命令行 → undefined。 */
export function commandNameOf(text: string): string | undefined {
  const match = COMMAND_LINE_RE.exec(text);
  return match?.[1];
}

/** 是否为 hosts 可解析的斜杠命令行（是否**注册**由服务端裁决，此处只判词法）。 */
export function isCommandLine(text: string): boolean {
  return commandNameOf(text) !== undefined;
}

/** 收窄输入声明：`hint` 非空字符串才保留；`attachments` 仅在为 true 时保留。 */
function narrowInputHint(value: unknown): CommandInputHint | undefined {
  if (!isObject(value)) return undefined;
  const hint = nonEmptyStringField(value, "hint");
  if (hint === undefined) return undefined;
  return readField(value, "attachments") === true ? { hint, attachments: true } : { hint };
}

/**
 * 收窄 `commands/list` 的返回数组：
 * 逐项剔除畸形项（缺 name/description），非数组 → 空数组（UI 退回离线内置清单）。
 */
export function narrowCommandDescriptors(value: unknown): CommandDescriptor[] {
  if (!Array.isArray(value)) return [];
  const out: CommandDescriptor[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const name = nonEmptyStringField(item, "name");
    const description = nonEmptyStringField(item, "description");
    if (name === undefined || description === undefined) continue;
    const input = narrowInputHint(readField(item, "input"));
    out.push(input === undefined ? { name, description } : { name, description, input });
  }
  return out;
}

/**
 * `commands/execute` 的结果该怎么处理（TASK-030 项 2 的路由决策，独立成纯函数以便单测）：
 *
 * - `handled`：命令确实执行了（成功）；
 * - `failed`：命令**存在**但执行失败，或调用层错误 —— 不能再当正文发给模型
 *   （否则 "/compact" 会原样进上下文，用户看到的是一次莫名其妙的模型调用）；
 * - `fallback`：服务端不认识这一行（`value === undefined`，host 不写任何 session 日志）
 *   —— 调用方回退为普通 prompt，保证 "/tmp/foo 看看" 这类正文照常发送。
 */
export type CommandOutcome = "handled" | "failed" | "fallback";

export function classifyCommandResult(result: RpcResult<CommandExecution | undefined>): CommandOutcome {
  if (!result.ok) return "failed";
  if (result.value === undefined) return "fallback";
  // 只有明确的 success 才算执行成功：未知 kind（线上契约漂移）按失败处理——
  // 宁可提示"命令失败"，也不能把它当成功静默掉。
  return result.value.result.kind === "success" ? "handled" : "failed";
}
