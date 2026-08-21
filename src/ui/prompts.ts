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

const MENTION_RE = /@(?:file|folder):([^\s@]+)/g;

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
