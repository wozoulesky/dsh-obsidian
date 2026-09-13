/**
 * `@` 提及候选索引（性能批 1）。
 *
 * 原实现每次按键都对 vault 全量 `getFiles()` 过滤 + 逐路径 `toLowerCase()`，
 * 只为取前 20 条（万级数组重建）。本模块把文件/文件夹路径预计算为
 * 「小写路径 → 原始候选串」数组并缓存，查询只走内存数组，不再触碰 vault API。
 *
 * 失效由调用方驱动：vault 文件集合变化时调用 `invalidate()`（见 DshInputBox 的订阅）。
 */

/** 路径来源：只取本模块所需的两个方法，便于单测注入假实现（obsidian Vault 结构兼容）。 */
export interface MentionPathSource {
  getFiles(): { path: string }[];
  getAllFolders(): { path: string }[];
}

interface MentionEntry {
  /** 预计算的小写路径（过滤用，避免每次查询重复大小写转换）。 */
  lower: string;
  /** 原始候选串：`@file:<原路径>` / `@folder:<原路径>`。 */
  value: string;
}

/** 候选上限（与既有 `slice(0, 20)` 行为一致）。 */
export const MENTION_CANDIDATE_LIMIT = 20;

export class MentionIndex {
  private entries: MentionEntry[] | null = null;

  constructor(
    private source: MentionPathSource,
    private limit: number = MENTION_CANDIDATE_LIMIT
  ) {}

  /** 清空缓存：vault 文件集合变化或视图销毁时调用（任意时刻可安全调用）。 */
  invalidate(): void {
    this.entries = null;
  }

  /**
   * 匹配 query 的候选串：文件在前、文件夹在后，总量不超过 limit。
   * 与既有 `[...files, ...folders].slice(0, 20)` 等价——命中上限即提前结束，不再扫剩余项。
   */
  candidates(query: string): string[] {
    const lower = query.toLowerCase();
    if (this.entries === null) this.entries = this.build();
    const out: string[] = [];
    for (const entry of this.entries) {
      if (entry.lower.includes(lower)) {
        out.push(entry.value);
        if (out.length >= this.limit) break;
      }
    }
    return out;
  }

  /** 重建缓存：先文件后文件夹（保持既有拼接顺序），并过滤文件夹根。 */
  private build(): MentionEntry[] {
    const entries: MentionEntry[] = [];
    for (const file of this.source.getFiles()) {
      entries.push({ lower: file.path.toLowerCase(), value: `@file:${file.path}` });
    }
    for (const folder of this.source.getAllFolders()) {
      if (folder.path === "/") continue; // 既有行为：过滤文件夹根
      entries.push({ lower: folder.path.toLowerCase(), value: `@folder:${folder.path}` });
    }
    return entries;
  }
}
