/**
 * TASK-029 项 1：推理内容的更新策略（TASK-027 遗留硬约束的正面解）。
 *
 * 背景（真机证据 `tmp/probe-assistant-stream-fixed.notes.md`）：22s 窗口收到 268 个
 * `assistant-stream` 增量帧，绝大多数是 `reasoning-delta`（约 11 帧/秒）。
 *
 * 两条必须同时成立、互相拉扯的契约：
 * 1. **推理内容必须会刷新**——一旦 UI 渲染 reasoning，不 bump 就等于永不更新；
 * 2. **不得逐帧重绘**——每个 delta 都 bump 会让节点签名缓存逐帧失效、每帧重建节点 DOM
 *    并重解析 Markdown，正是 TASK-013 修掉的卡顿。
 *
 * 本文件的断言就是这两条的机器可读形式：
 * - 同一节流窗内 N 个 delta → `rev` 只涨 1（第 2 条）；
 * - 同时 `node.reasoning` 完整累积 N 段文本（第 1 条的**数据**侧）；
 * - 跨窗的 delta 逐个重新触发 bump（第 1 条的**渲染**侧：文本变化最终一定到达 DOM）；
 * - 流式收尾（end / turn-end / assistant-message）必定产生一次正式 bump，
 *   保证定格渲染拿到完整文本（否则最后不足一个窗口的增量会永远停在旧 DOM 上）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REASONING_BUMP_INTERVAL_MS, createSessionView, foldAssistantStreamFrame, foldEvent, type AssistantNode } from "../../src/core/eventFold";
import { SessionStore } from "../../src/core/store";

/** 建一个带流式 assistant 节点的视图（复用 follow 快照的空形状）。 */
function streamingView() {
  const view = createSessionView("s1");
  foldAssistantStreamFrame(view, { type: "start", attemptId: "a:1", revision: 1, startedAfterSeq: 0, turn: 1, step: 1 });
  const node = view.nodes.at(-1);
  if (node?.kind !== "assistant") throw new Error("未建出 assistant 节点");
  return { view, node };
}

function reasoningFrame(index: number, text: string) {
  return { type: "chunk" as const, attemptId: "a:1", revision: index + 2, index, time: index, chunk: { type: "reasoning-delta" as const, index: 0, text } };
}

describe("reasoning 更新策略：按时间窗节流 bump", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("节流窗内 50 个 reasoning-delta 只 bump 一次（不逐帧重建节点 DOM）", () => {
    const { view, node } = streamingView();
    const revAfterStart = node.rev;

    for (let i = 0; i < 50; i++) {
      // 真机节奏：相邻增量约 88ms（22s/250 帧），全部落在同一个 250ms 窗内
      vi.advanceTimersByTime(1);
      foldAssistantStreamFrame(view, reasoningFrame(i, `片段${i}`));
    }

    // 渲染侧：只有首个增量触发了一次重绘
    expect(node.rev).toBe(revAfterStart + 1);
    // 数据侧：文本一字不少（节流只限制重绘频率，不丢内容）
    expect(node.reasoning).toBe(Array.from({ length: 50 }, (_, i) => `片段${i}`).join(""));
  });

  it("跨窗的增量会再次 bump：推理内容在流式期间持续可见（≤4 次/秒）", () => {
    const { view, node } = streamingView();
    const rev0 = node.rev;
    const total = 40;
    const step = 100; // 帧间隔（ms）
    // 一次 bump 后，下一个够格 bump 的帧 = 时间首次 ≥ 上窗 + 窗口的帧
    const framesPerWindow = Math.ceil(REASONING_BUMP_INTERVAL_MS / step); // 3

    for (let i = 0; i < total; i++) {
      foldAssistantStreamFrame(view, reasoningFrame(i, "x"));
      vi.advanceTimersByTime(step);
    }

    const bumps = node.rev - rev0;
    // 每满一个窗口恰好多一次 bump：不是 1（永不更新），也远不是 40（逐帧重绘）
    expect(bumps).toBe(Math.ceil(total / framesPerWindow));
    expect(node.reasoning).toHaveLength(total);
  });

  it("首个 reasoning-delta 立即 bump（不必等满一个窗口才出现「思考过程」）", () => {
    const { view, node } = streamingView();
    const rev0 = node.rev;
    foldAssistantStreamFrame(view, reasoningFrame(0, "第一段"));
    expect(node.rev).toBe(rev0 + 1);
  });

  it("text-delta 不受 reasoning 节流影响（正文始终逐帧更新）", () => {
    const { view, node } = streamingView();
    const rev0 = node.rev;
    for (let i = 0; i < 10; i++) {
      foldAssistantStreamFrame(view, { type: "chunk", attemptId: "a:1", revision: i, index: i, time: i, chunk: { type: "text-delta", index: 1, text: "字" } });
    }
    expect(node.rev).toBe(rev0 + 10);
  });

  it("流式收尾（assistant-stream end，abandoned）必定再 bump 一次：定格渲染拿到完整推理", () => {
    const { view, node } = streamingView();
    // 尾部落在一个窗内：这些增量本身不触发 bump（模拟"最后一批 reasoning 卡在窗口内"）
    for (let i = 0; i < 20; i++) foldAssistantStreamFrame(view, reasoningFrame(i, "尾巴"));
    const revBeforeEnd = node.rev;

    foldAssistantStreamFrame(view, { type: "end", attemptId: "a:1", revision: 99, index: 20, outcome: { kind: "abandoned" } });

    expect(node.streaming).toBe(false);
    expect(node.rev).toBe(revBeforeEnd + 1); // 收尾 bump → 完整 reasoning 进入定格渲染
    expect(node.reasoning).toBe("尾巴".repeat(20));
  });

  it("turn/end 收尾同样 bump（0.1.2 durable 路径的 reasoning 也定格）", () => {
    const view = createSessionView("s1");
    foldEvent(view, { type: "turn/start", seq: 1, time: 1, data: {} });
    foldEvent(view, { type: "assistant/chunk", seq: 2, time: 2, data: { chunk: { type: "reasoning-delta", index: 0, text: "想了想" } } });
    foldEvent(view, { type: "assistant/chunk", seq: 3, time: 3, data: { chunk: { type: "text-delta", index: 1, text: "答案" } } });
    const node = view.nodes.at(-1) as AssistantNode;
    const revBefore = node.rev;

    foldEvent(view, { type: "turn/end", seq: 4, time: 4, data: { reason: { kind: "completed" } } });

    expect(node.streaming).toBe(false);
    expect(node.rev).toBe(revBefore + 1); // 收尾这一次 bump 即把完整 reasoning 送进定格渲染
    expect(node.reasoning).toBe("想了想");
    expect(node.text).toBe("答案");
  });

  it("turn/end 的「thinking 就是答案」兜底也会 bump（少一次就会显示旧正文）", () => {
    const view = createSessionView("s1");
    foldEvent(view, { type: "turn/start", seq: 1, time: 1, data: {} });
    foldEvent(view, { type: "assistant/chunk", seq: 2, time: 2, data: { chunk: { type: "reasoning-delta", index: 0, text: "只有推理" } } });
    const node = view.nodes.at(-1) as AssistantNode;
    const revBefore = node.rev;

    foldEvent(view, { type: "turn/end", seq: 3, time: 3, data: { reason: { kind: "completed" } } });

    // 两次可见变更（streaming=false、reasoning 提升为正文）各自 bump，故 ≥ +1
    expect(node.rev).toBeGreaterThanOrEqual(revBefore + 1);
    expect(node.text).toBe("只有推理");
  });

  it("durable assistant/message 补写流里没送到的 reasoning 时 bump（否则 UI 永远看不到它）", () => {
    const view = createSessionView("s1");
    // 先来一条流式文本，节点已存在但 reasoning 为空
    foldEvent(view, { type: "assistant/chunk", seq: 1, time: 1, data: { chunk: { type: "text-delta", index: 0, text: "正文" } } });
    const node = view.nodes.at(-1) as AssistantNode;
    expect(node.reasoning).toBe("");

    foldEvent(view, {
      type: "assistant/message",
      seq: 2,
      time: 2,
      data: { message: { id: "m1", content: [{ type: "text", text: "正文" }, { type: "reasoning", text: "message 里的推理" }] } },
    });

    expect(node.reasoning).toBe("message 里的推理");
    // 节点已结算：该窗内确实涨了 rev（对比"完全不 bump"的旧实现会停在原值）
    expect(node.rev).toBeGreaterThan(0);
  });

  it("真机节奏回归：268 帧/22s 的 reasoning 流不会退化成逐帧重绘", () => {
    const store = new SessionStore();
    store.ensureView("s1");
    store.applyFollowAssistantStream("s1", { type: "start", attemptId: "a:61", revision: 1, startedAfterSeq: 0, turn: 1, step: 61 });
    const node = store.ensureView("s1").nodes.at(-1) as AssistantNode;
    const rev0 = node.rev;

    // 22s、268 帧（≈82ms/帧），全部为 reasoning-delta——真机实测的形状
    const total = 268;
    const step = 82;
    const framesPerWindow = Math.ceil(REASONING_BUMP_INTERVAL_MS / step); // 4
    for (let i = 0; i < total; i++) {
      vi.advanceTimersByTime(step);
      store.applyFollowAssistantStream("s1", reasoningFrame(i, "思考"));
    }

    const bumps = node.rev - rev0;
    // 真机复现：268 次重绘请求被压到 67 次（≈3 次/秒），且内容零丢失
    expect(bumps).toBe(Math.ceil(total / framesPerWindow));
    expect(bumps).toBeLessThan(total / 3);
    expect(node.reasoning.length).toBe(total * 2);
  });
});
