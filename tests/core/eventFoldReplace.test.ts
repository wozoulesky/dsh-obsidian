/**
 * TASK-028 项 3：压缩替换（`surfaceOp = { op: "replace", startSeq, endSeq }`）的折叠语义。
 *
 * 官方契约（@deepseek-ai/dsh-session types，已核实）：
 * 「replaces surface nodes from `startSeq` (inclusive) through `endSeq` (inclusive) with this node.
 *   `startSeq === endSeq` replaces a single node.」
 *
 * 折叠规则：先按节点自身的 `seq` 移除落在 `[startSeq, endSeq]` 的可见节点，再按既有分支应用该事件
 * （顺序不能颠倒：替换事件自身若落在区间内，必须随后被加回来）。
 *
 * 语义目标：compaction 替换旧内容后旧节点不再堆积 → 长会话的节点数/渲染成本有上界。
 */
import { describe, expect, it } from "vitest";
import { createSessionView, foldEvent, type SessionView } from "../../src/core/eventFold";
import type { SessionEvent } from "../../src/transport/types";

type SurfaceOp = SessionEvent["surfaceOp"];

function ev(type: string, seq: number, data: Record<string, unknown>, surfaceOp?: SurfaceOp): SessionEvent {
  const event: SessionEvent = { type, seq, time: seq * 1000, data };
  if (surfaceOp !== undefined) event.surfaceOp = surfaceOp;
  return event;
}

const replace = (startSeq: number, endSeq: number): SurfaceOp => ({ op: "replace", startSeq, endSeq });

/** 在给定 seq 上放一个用户节点。 */
function pushUser(view: SessionView, seq: number, text: string): void {
  foldEvent(view, ev("user/message", seq, { id: `m${seq}`, role: "user", content: [{ type: "text", text }], source: { kind: "user" } }));
}

/** 在给定 seq 上放一个已收尾的 assistant 节点。 */
function pushAssistant(view: SessionView, seq: number, text: string): void {
  foldEvent(
    view,
    ev("assistant/message", seq, { turn: 1, step: 1, message: { id: `a${seq}`, content: [{ type: "text", text }], source: { kind: "model", provider: "p", model: "m" } } })
  );
}

/** 视图里可见节点的 seq。 */
function seqs(view: SessionView): number[] {
  return view.nodes.map((n) => n.seq);
}

/** 压缩替换事件：真实线上形态是 source.kind=plugin/plugin=compact 的 user/message（官方 client 判据一致）。 */
const compactionEvent = (seq: number, startSeq: number, endSeq: number, summary: string): SessionEvent =>
  ev(
    "user/message",
    seq,
    {
      id: `compact-${seq}`,
      role: "user",
      content: [{ type: "text", text: summary }],
      source: { kind: "plugin", plugin: "compact", compactionId: "c1" },
    },
    replace(startSeq, endSeq)
  );

describe("foldEvent：surfaceOp=replace 的区间移除", () => {
  it("移除区间内的旧节点，随后应用替换事件（新摘要节点出现）", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "第一问");
    pushAssistant(view, 2, "第一答");
    pushUser(view, 3, "第二问");
    pushUser(view, 5, "第三问");
    expect(seqs(view)).toEqual([1, 2, 3, 5]);

    foldEvent(view, compactionEvent(6, 1, 3, "【压缩摘要】前两轮对话…"));

    expect(seqs(view)).toEqual([5, 6]); // [1,3] 被移除，摘要节点入列
    expect(view.nodes[1]).toMatchObject({ kind: "user", text: "【压缩摘要】前两轮对话…", seq: 6 });
    // 摘要来自插件而非用户：sourceKind 保留原始来源（UI 据此渲染为上下文气泡而非用户气泡）
    expect(view.nodes[1]).toMatchObject({ sourceKind: "plugin" });
  });

  it("边界：区间外的节点一个都不动（含紧邻的 seq）", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "0");
    pushUser(view, 2, "1");
    pushUser(view, 3, "2");
    pushUser(view, 4, "3");
    pushUser(view, 5, "4");

    foldEvent(view, compactionEvent(6, 2, 4, "摘要"));
    expect(seqs(view)).toEqual([1, 5, 6]); // 只掉 2/3/4
  });

  it("边界：seq 恰好等于 startSeq / endSeq 都被移除（区间两端均为闭区间）", () => {
    const view = createSessionView("s1");
    pushUser(view, 7, "start");
    pushUser(view, 8, "middle");
    pushUser(view, 9, "end");
    foldEvent(view, compactionEvent(10, 7, 9, "摘要"));
    expect(seqs(view)).toEqual([10]);

    // startSeq === endSeq 替换单个节点
    const single = createSessionView("s2");
    pushUser(single, 1, "a");
    pushUser(single, 2, "b");
    pushUser(single, 3, "c");
    foldEvent(single, compactionEvent(4, 2, 2, "单点替换"));
    expect(seqs(single)).toEqual([1, 3, 4]);
  });

  it("边界：区间内没有任何节点（空区间）→ 只做常规追加", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    foldEvent(view, compactionEvent(2, 100, 200, "摘要"));
    expect(seqs(view)).toEqual([1, 2]);
  });

  it("防御：startSeq > endSeq 的异常载荷不删除任何节点（不做 min/max 交换）", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    pushUser(view, 2, "b");
    pushUser(view, 3, "c");
    foldEvent(view, compactionEvent(4, 3, 1, "摘要"));
    expect(seqs(view)).toEqual([1, 2, 3, 4]); // 宁可不删，也不能删错
  });

  it("surfaceOp='append' / 未带 surfaceOp 的事件不触发任何移除", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    pushUser(view, 2, "b");
    foldEvent(view, ev("user/message", 3, { id: "m3", content: [{ type: "text", text: "c" }], source: { kind: "user" } }, "append"));
    foldEvent(view, ev("user/message", 4, { id: "m4", content: [{ type: "text", text: "d" }], source: { kind: "user" } }));
    expect(seqs(view)).toEqual([1, 2, 3, 4]);
  });

  it("替换事件自身落在区间内时仍然存活（先移除、后应用）", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    pushUser(view, 2, "b");
    foldEvent(view, compactionEvent(2, 1, 2, "就地替换"));
    expect(seqs(view)).toEqual([2]);
    expect(view.nodes[0]).toMatchObject({ text: "就地替换" });
  });

  it("原位修改 view.nodes（保持数组引用不变）：store/UI 可能持有该引用", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    pushUser(view, 2, "b");
    const nodesRef = view.nodes;
    foldEvent(view, compactionEvent(3, 1, 2, "摘要"));
    expect(view.nodes).toBe(nodesRef);
  });

  it("lastSeq / firstSeq 语义不被替换破坏（翻页边界仍以已折叠事件为准）", () => {
    const view = createSessionView("s1");
    pushUser(view, 10, "a");
    pushUser(view, 11, "b");
    foldEvent(view, compactionEvent(12, 10, 11, "摘要"));
    expect(view.lastSeq).toBe(12);
    expect(view.firstSeq).toBe(10); // 已折叠事件的最小 seq，不因节点被移除而后退
  });

  it("替换事件落在仍在流式的节点上时不污染流式节点：替换内容另建节点", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/chunk", 1, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "历史正文" } }));
    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "（还在流式）" } }));

    // 压缩替换的 durable 事件在流式期间落地：必须自成节点
    foldEvent(
      view,
      ev(
        "assistant/message",
        3,
        { turn: 1, step: 1, message: { id: "a3", content: [{ type: "text", text: "【压缩摘要】" }], source: { kind: "model", provider: "p", model: "m" } } },
        replace(1, 2)
      )
    );

    expect(seqs(view)).toEqual([3]); // 被替换的流式节点移除后不再复活（没有重复消息）
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", text: "【压缩摘要】", streaming: false });

    // 流式结束后仍然只有这一个节点
    foldEvent(view, ev("turn/end", 4, { turn: 1, reason: { kind: "completed" } }));
    expect(view.nodes).toHaveLength(1);
  });

  it("长会话上界：多轮对话被一次压缩替换后节点数收敛到摘要 + 区间外内容", () => {
    const view = createSessionView("s1");
    let seq = 1;
    for (let turn = 0; turn < 8; turn++) {
      pushUser(view, seq++, `问题 ${turn}`);
      pushAssistant(view, seq++, `回答 ${turn}`);
    }
    expect(view.nodes).toHaveLength(16);

    // 压缩前 7 轮（seq 1..14），保留最后一轮（seq 15/16）
    foldEvent(view, compactionEvent(17, 1, 14, "【压缩摘要】前 7 轮…"));
    expect(seqs(view)).toEqual([15, 16, 17]);
  });
});

describe("foldEvent：压缩替换下的 rev 语义（TASK-027 契约）", () => {
  it("存活节点的 rev 不被替换操作改动（没有内容变更就不该失效缓存）", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    pushAssistant(view, 2, "b");
    pushUser(view, 3, "c");
    const survivor = view.nodes[2];
    const revBefore = survivor.rev;

    foldEvent(view, compactionEvent(4, 1, 2, "摘要"));
    expect(view.nodes[0]).toBe(survivor);
    expect(survivor.rev).toBe(revBefore);
  });

  it("被移除后再次到达的重复事件按新节点重建（rev 从 0 起，不会复用旧 rev）", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    foldEvent(view, compactionEvent(2, 1, 1, "摘要"));
    expect(view.nodes).toHaveLength(1);

    pushUser(view, 3, "b");
    const node = view.nodes[1];
    expect(node.rev).toBe(0);
  });

  it("替换事件自身的节点 rev 为 0（全新节点，缓存不会误复用同 id 的旧 DOM）", () => {
    const view = createSessionView("s1");
    pushUser(view, 1, "a");
    foldEvent(view, compactionEvent(2, 1, 1, "摘要"));
    expect(view.nodes[0]).toMatchObject({ seq: 2, rev: 0 });
  });
});
