import { isCommandLine } from "../core/commands";
import type { CommandDescriptor } from "../transport/types";

export interface BuiltinCommand {
  name: string;
}

/**
 * 前端命令（插件本地实现，服务端没有）：恒出现在联想列表里，且发送时被本地拦截。
 * `/clear` = 新建干净会话（TASK-016）。
 */
export const FRONTEND_COMMANDS: BuiltinCommand[] = [{ name: "/clear" }];

/**
 * 离线兜底命令清单：`commands/list` 不可用（旧版 DSH / 断线 / 拉取失败）时的联想来源。
 * 名称取自真机实测（0.1.5-rc.1 `commands/list` 的真实返回，见 tmp/probe-task030.notes.md）：
 * compact / export / feedback / goal / permission / plan。
 * 在线时这份清单**不参与**联想——服务端返回什么就显示什么（描述也用服务端的）。
 */
export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  ...FRONTEND_COMMANDS,
  { name: "/compact" },
  { name: "/export" },
  { name: "/feedback" },
  { name: "/goal" },
  { name: "/permission" },
  { name: "/plan" },
];

/** /clear 精确匹配（前端拦截，不发给服务端）。 */
export function isClearCommand(text: string): boolean {
  return text.trim() === "/clear";
}

/**
 * 输入路由（TASK-030 项 2）判定结果：
 * - `clear`：前端命令，本地处理；
 * - `command`：词法上是斜杠命令 → 先走 `commands/execute`（服务端裁决是否注册），
 *   返回 `undefined` 时调用方再回退为普通 prompt；
 * - `prompt`：普通消息。
 */
export type InputRoute = { kind: "clear" } | { kind: "command" } | { kind: "prompt" };

/**
 * 判定一条输入该怎么发。
 *
 * 刻意**不**依赖 `commands/list` 是否已加载：服务端才是"这条命令是否存在"的唯一权威，
 * 本地白名单只会带来"清单还没拉到就把 /compact 当正文发给模型"这类偏差。
 * 代价是未注册的斜杠行多花一次 RPC（返回 undefined，host 不写任何日志）。
 */
export function routeInput(text: string): InputRoute {
  if (isClearCommand(text)) return { kind: "clear" };
  if (isCommandLine(text.trim())) return { kind: "command" };
  return { kind: "prompt" };
}

/** 联想项（name 含前导 `/`）。 */
export interface CommandSuggestion {
  name: string;
  description: string;
}

/**
 * 合并「服务端命令清单」与「前端命令」得到联想项：
 * - `commands === null`（未加载/不可用）→ 退回 `BUILTIN_COMMANDS` + i18n 描述；
 * - 在线 → 服务端描述优先，前端命令（`/clear`）恒在首位，同名去重（前端优先）。
 */
export function mergeCommandSuggestions(
  commands: readonly CommandDescriptor[] | null,
  t: (key: string, params?: Record<string, string | number>) => string
): CommandSuggestion[] {
  const frontend: CommandSuggestion[] = FRONTEND_COMMANDS.map((c) => ({
    name: c.name,
    description: t(`command.${c.name.slice(1)}.desc`),
  }));
  if (commands === null) {
    return [
      ...frontend,
      ...BUILTIN_COMMANDS.filter((c) => !FRONTEND_COMMANDS.some((f) => f.name === c.name)).map((c) => ({
        name: c.name,
        description: t(`command.${c.name.slice(1)}.desc`),
      })),
    ];
  }
  const server: CommandSuggestion[] = commands
    .filter((c) => !FRONTEND_COMMANDS.some((f) => f.name === `/${c.name}`))
    .map((c) => ({ name: `/${c.name}`, description: c.description }));
  return [...frontend, ...server];
}

/** 按查询过滤联想项（query 不带 "/"，如 "com" 匹配 /compact）。 */
export function filterCommandSuggestions(suggestions: readonly CommandSuggestion[], query: string): CommandSuggestion[] {
  const lower = query.toLowerCase();
  return suggestions.filter((c) => c.name.slice(1).toLowerCase().startsWith(lower));
}

export const MENTION_RE = /@(?:file|folder):([^\s@]+)/g;

/** 提及来源的解析结果：file 为文件内容，folder 为目录树文本。 */
export interface MentionSource {
  kind: "file" | "folder";
  text: string;
}

export function collectMentionPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) out.push(m[1]);
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/**
 * 取末尾 max 个字符（超长时前置省略号）。
 *
 * 用于**流式期间**的推理内容展示：思考文本要从头读，但正在生成时用户关心的是"现在想到哪"，
 * 只截头部会让长推理看起来卡住不动（正文不再变化）。定格后改回 truncate（从头读）。
 */
export function truncateTail(text: string, max: number): string {
  if (text.length <= max) return text;
  return "…" + text.slice(text.length - max);
}

/** 依据光标前文本解析联想 token（@ 提及 / / 命令）；返回 null 表示无联想。 */
export function matchSuggestToken(before: string): { kind: "mention" | "slash"; query: string } | null {
  const m = before.match(/(?:^|\s)(@(?:file|folder):([^\s@]*)|@([^\s@/]*)|(\/)([^\s@/]*))$/);
  if (!m) return null;
  const kind: "mention" | "slash" = m[1].startsWith("@") ? "mention" : "slash";
  const query = (kind === "mention" ? (m[2] ?? m[3]) : m[5] ?? "").toLowerCase();
  return { kind, query };
}

/** 替换文本中所有出现的标记（String.replace 遇字符串模式只替换首次，同一路径提及多次必须全量替换）。 */
function replaceAll(text: string, search: string, replacement: string): string {
  return text.split(search).join(replacement);
}

/** 把 @file:路径 / @folder:路径 标记替换为内容引用（长内容截断；缺失给出说明）。 */
export async function resolveMentions(
  text: string,
  read: (path: string) => Promise<MentionSource | null>,
  maxChars: number
): Promise<string> {
  let out = text;
  for (const path of collectMentionPaths(text)) {
    const source = await read(path);
    const replacement = source === null
      ? `（找不到 ${path}，请检查路径）`
      : `${source.kind === "file" ? "文件" : "目录"} ${path}：\n> ${truncate(source.text, maxChars).replace(/\n/g, "\n> ")}`;
    out = replaceAll(out, `@file:${path}`, replacement);
    out = replaceAll(out, `@folder:${path}`, replacement);
  }
  return out;
}
