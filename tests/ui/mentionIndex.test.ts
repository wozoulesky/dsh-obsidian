import { describe, expect, it, vi } from "vitest";
import { MENTION_CANDIDATE_LIMIT, MentionIndex, type MentionPathSource } from "../../src/ui/mentionIndex";

function makeSource(files: string[], folders: string[] = []) {
  return {
    getFiles: vi.fn(() => files.map((path) => ({ path }))),
    getAllFolders: vi.fn(() => folders.map((path) => ({ path }))),
  };
}

/** 旧实现（TASK-027 前）的候选算法，用作等价性基准。 */
function legacyCandidates(files: string[], folders: string[], query: string): string[] {
  const lower = query.toLowerCase();
  const f = files.filter((p) => p.toLowerCase().includes(lower)).map((p) => `@file:${p}`);
  const d = folders.filter((p) => p !== "/" && p.toLowerCase().includes(lower)).map((p) => `@folder:${p}`);
  return [...f, ...d].slice(0, 20);
}

describe("MentionIndex 缓存", () => {
  it("首次查询构建缓存（读一次 vault），后续查询命中缓存不再读 vault", () => {
    const source = makeSource(["Notes/A.md", "Notes/B.md"], ["Notes", "Archive"]);
    const index = new MentionIndex(source);

    expect(index.candidates("no")).toEqual(["@file:Notes/A.md", "@file:Notes/B.md", "@folder:Notes"]);
    expect(source.getFiles).toHaveBeenCalledTimes(1);
    expect(source.getAllFolders).toHaveBeenCalledTimes(1);

    // 多次不同查询：全部走缓存
    index.candidates("a");
    index.candidates("archive");
    index.candidates("");
    expect(source.getFiles).toHaveBeenCalledTimes(1);
    expect(source.getAllFolders).toHaveBeenCalledTimes(1);
  });

  it("invalidate() 后下一次查询重建缓存", () => {
    const source = makeSource(["Notes/A.md"]);
    const index = new MentionIndex(source);
    index.candidates("no");
    expect(source.getFiles).toHaveBeenCalledTimes(1);

    index.invalidate();
    index.candidates("no");
    expect(source.getFiles).toHaveBeenCalledTimes(2);
  });

  it("重建后反映新增文件（vault 变更语义）", () => {
    const files = ["Notes/A.md"];
    const source: MentionPathSource = {
      getFiles: () => files.map((path) => ({ path })),
      getAllFolders: () => [],
    };
    const index = new MentionIndex(source);
    expect(index.candidates("new")).toEqual([]);

    files.push("Notes/New.md");
    index.invalidate();
    expect(index.candidates("new")).toEqual(["@file:Notes/New.md"]);
  });
});

describe("MentionIndex 查询语义", () => {
  it("过滤大小写不敏感，且候选串保留原始大小写", () => {
    const index = new MentionIndex(makeSource(["Notes/MyNote.md"]));
    expect(index.candidates("mynote")).toEqual(["@file:Notes/MyNote.md"]);
    expect(index.candidates("MYNOTE")).toEqual(["@file:Notes/MyNote.md"]);
  });

  it("文件在前、文件夹在后，并过滤文件夹根", () => {
    const index = new MentionIndex(makeSource(["a/Note.md"], ["/", "a", "a/Note"]));
    expect(index.candidates("note")).toEqual(["@file:a/Note.md", "@folder:a/Note"]);
  });

  it("上限为 20，超出部分截断", () => {
    const files = Array.from({ length: 30 }, (_, i) => `N${i}.md`);
    const index = new MentionIndex(makeSource(files));
    expect(index.candidates("")).toHaveLength(MENTION_CANDIDATE_LIMIT);
  });

  it("文件占满上限时文件夹不再进入结果（与旧实现 slice(0,20) 一致）", () => {
    const files = Array.from({ length: 25 }, (_, i) => `N${i}.md`);
    const index = new MentionIndex(makeSource(files, ["Notes"]));
    expect(index.candidates("")).toHaveLength(MENTION_CANDIDATE_LIMIT);
    expect(index.candidates("")).not.toContain("@folder:Notes");
  });

  it("与旧算法逐项等价（多组查询）", () => {
    const files = ["Notes/A.md", "Notes/B.md", "Archive/C.md", "notes/deep/D.md", "Top.md"];
    const folders = ["/", "Notes", "Archive", "notes/deep", "Empty"];
    const index = new MentionIndex(makeSource(files, folders));
    for (const query of ["", "no", "a", "notes", "deep", "zzz", "TO", "archive"]) {
      expect(index.candidates(query), `query=${query}`).toEqual(legacyCandidates(files, folders, query));
    }
  });

  it("可配置上限", () => {
    const index = new MentionIndex(makeSource(["a.md", "b.md", "c.md"]), 2);
    expect(index.candidates("")).toEqual(["@file:a.md", "@file:b.md"]);
  });
});
