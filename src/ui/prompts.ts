export interface BuiltinCommand {
  name: string;
  description: string;
}

/** v1 内置命令清单（与 DSH 内置命令对齐；服务端执行，插件只负责联想与发送）。 */
export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "/plan", description: "进入计划模式（/plan off 退出）" },
  { name: "/compact", description: "压缩会话历史" },
  { name: "/feedback", description: "给最近的回复打分反馈" },
  { name: "/goal", description: "管理长期目标（/goal create <目标>）" },
];

const MENTION_RE = /@file:([^\s@]+)/g;

export function collectMentionPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) out.push(m[1]);
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** 把 @file:路径 标记替换为文件内容引用（长内容截断；缺失文件给出说明）。 */
export async function resolveMentions(
  text: string,
  read: (path: string) => Promise<string | null>,
  maxChars: number
): Promise<string> {
  let out = text;
  for (const path of collectMentionPaths(text)) {
    const content = await read(path);
    const replacement = content === null
      ? `（找不到文件 ${path}，请检查路径）`
      : `文件 ${path}：\n> ${truncate(content, maxChars).replace(/\n/g, "\n> ")}`;
    out = out.replace(`@file:${path}`, replacement);
  }
  return out;
}
