/**
 * 0.1.5 真实线上帧回归夹具。
 *
 * 帧样本逐字取自 2026-09-12 对本机 DSH 0.1.5-rc.1 的真机探测
 * （`tmp/probe-assistant-stream-fixed.notes.md`，22s 窗口收到 268 个 frame=chunk）。
 * 目的：把"官方面向真实服务器"的形状钉进测试——日后 DSH 再改协议时，
 * 这里会先红，而不是等用户在真机上发现流式又没了。
 */
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/store";
import type { SessionFollowFrame } from "../../src/transport/types";

/** 真实 captured：开场快照（0.1.5 header 形状） */
const REAL_SNAPSHOT: Extract<SessionFollowFrame, { type: "snapshot" }> = {
  type: "snapshot",
  header: {
    version: 1,
    id: "session-1e783170-3c9f-4363-b422-14f73e25a2eb",
    createdAt: 1789149600000,
    cwd: "E:\\obsidian-plugin",
    isSeeded: true,
    agentPreset: "default",
  },
  cursor: 33640,
  records: [
    { type: "event", event: { type: "user/message", seq: 330, time: 1789149600000, data: { id: "u1", role: "user", content: [{ type: "text", text: "看看目前项目" }], source: { kind: "user" } } } },
  ],
  hasMore: true,
  projections: { asOfSeq: 33640, values: { title: "看看目前项目有没有需要性能" } },
};

/** 真实 captured：一条 reasoning 增量帧（原样，含 attemptId/revision/index/time） */
function realChunkFrame(index: number, chunk: unknown): Extract<SessionFollowFrame, { type: "assistant-stream" }> {
  return {
    type: "assistant-stream",
    frame: {
      type: "chunk",
      attemptId: "session-1e783170-3c9f-4363-b422-14f73e25a2eb:61",
      revision: 33641 + index,
      index,
      time: 1789149725826 + index,
      chunk: chunk as never,
    },
  };
}

describe("0.1.5 真实线上帧夹具", () => {
  it("用真机捕获的 assistant-stream 帧序列还原出流式文本", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot("s1", REAL_SNAPSHOT);

    // 真机观测到的帧顺序：start → block-start(reasoning) → reasoning-delta…（这里取代表性子集）
    store.applyFollowAssistantStream("s1", {
      type: "start",
      attemptId: "session-1e783170-3c9f-4363-b422-14f73e25a2eb:61",
      revision: 33640,
      startedAfterSeq: 33640,
      turn: 1,
      step: 61,
    });
    store.applyFollowAssistantStream("s1", realChunkFrame(0, { type: "block-start", index: 0, blockType: "reasoning" }).frame);
    store.applyFollowAssistantStream("s1", realChunkFrame(1, { type: "reasoning-delta", index: 0, text: "While" }).frame);
    store.applyFollowAssistantStream("s1", realChunkFrame(2, { type: "reasoning-delta", index: 0, text: " that" }).frame);

    const view = store.getView("s1");
    const node = view?.nodes.at(-1);
    expect(node).toMatchObject({ kind: "assistant", streaming: true });
    expect(node?.kind === "assistant" ? node.reasoning : null).toBe("While that");
  });

  it("真机块序：block-end(tool-call) 建卡 + tool/result 结算，仍只有一条 assistant 节点", () => {
    const store = new SessionStore();
    store.applyFollowSnapshot("s1", REAL_SNAPSHOT);

    store.applyFollowAssistantStream("s1", { type: "start", attemptId: "a:61", revision: 1, startedAfterSeq: 33640, turn: 1, step: 61 });
    store.applyFollowAssistantStream("s1", realChunkFrame(0, { type: "text-delta", index: 0, text: "我先看一下" }).frame);
    store.applyFollowAssistantStream("s1", {
      type: "chunk",
      attemptId: "a:61",
      revision: 2,
      index: 1,
      time: 1789149725900,
      chunk: { type: "block-end", index: 1, block: { type: "tool-call", id: "call_00_jtCxr5VAWpxeRdrOXQGp0838", name: "pwsh", arguments: '{"command":"ls"}' } },
    });

    // durable 事件（真机样本形状）
    store.applyFollowEvent("s1", {
      type: "event",
      event: {
        type: "tool/result",
        seq: 340,
        time: 1789149606964,
        data: {
          message: {
            source: { kind: "tool", callId: "call_00_jtCxr5VAWpxeRdrOXQGp0838" },
            content: [{ type: "tool-result", toolCallId: "call_00_jtCxr5VAWpxeRdrOXQGp0838", content: [{ type: "text", text: "moved to tmp/\n" }], isError: false }],
            role: "user",
            id: "dc0bd249-69f3-413c-becd-3ce652069645",
          },
        },
      },
    });

    const view = store.getView("s1");
    const assistants = (view?.nodes ?? []).filter((n) => n.kind === "assistant");
    expect(assistants).toHaveLength(1);
    const node = assistants[0];
    expect(node.kind === "assistant" ? node.text : null).toBe("我先看一下");
    expect(node.kind === "assistant" ? node.toolCards[0] : null).toMatchObject({
      id: "call_00_jtCxr5VAWpxeRdrOXQGp0838",
      name: "pwsh",
      status: "done",
      resultText: "moved to tmp/\n",
    });
  });

  it("真机快照 projections 键不被识别时不影响播种（未知投影静默忽略）", () => {
    const store = new SessionStore();
    const frame: Extract<SessionFollowFrame, { type: "snapshot" }> = {
      ...REAL_SNAPSHOT,
      projections: {
        asOfSeq: 33640,
        // 真机实际下发的键集合的代表性子集（插件当前只消费 title/plan）
        values: { title: "标题", tokenUsage: { outputTokens: 1 }, todos: null, goal: null, inbox: {}, sessionStats: {} },
      },
    };
    expect(() => store.applyFollowSnapshot("s1", frame)).not.toThrow();
    expect(store.getView("s1")?.title).toBe("标题");
  });
});
