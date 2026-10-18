/**
 * 「DSH 换端口后自愈」的状态机（`src/core/refind.ts`）。
 *
 * 真机场景：DSH 0.2.1 桌面端每次启动换随机端口；mux 只会重连固定的 baseUrl。
 * 没有这层兜底，用户重启 DSH 后必须重载 Obsidian。
 *
 * 这里钉住几条容易写错的规则：
 * - 阈值前不发现（避免 DSH 正常重启的抖动也触发）
 * - 发现成功**不得**置 givenUp（否则第二次重启就再也不自愈了）
 * - 连续失败到上限才放弃（避免无界重跑 discovery 烧 CPU）
 * - 连上后全部清零（下次断线能重新自愈）
 */
import { describe, expect, it } from "vitest";
import {
  createRefindState,
  onConnected,
  onDiscoveryResult,
  onReconnectFailure,
  REFIND_COOLDOWN_FAILURES,
  REFIND_FAILURES,
  REFIND_MAX_MISSES,
  shouldRefind,
} from "../../src/core/refind";

describe("refind 状态机", () => {
  it("新状态不自愈：还没失败过", () => {
    expect(shouldRefind(createRefindState())).toBe(false);
  });

  it("失败次数未到阈值不自愈（DSH 正常重启的短暂断开不该触发发现）", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_FAILURES - 1; i++) {
      onReconnectFailure(s);
      expect(shouldRefind(s)).toBe(false);
    }
    onReconnectFailure(s);
    expect(shouldRefind(s)).toBe(true);
  });

  it("refinding 期间即使到阈值也不重复发起（互斥）", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_FAILURES; i++) onReconnectFailure(s);
    s.refinding = true;
    expect(shouldRefind(s)).toBe(false);
  });

  it("发现成功 → 返回 true，且**不置 givenUp**（第二次重启仍能自愈）", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_FAILURES; i++) onReconnectFailure(s);
    expect(onDiscoveryResult(s, true)).toBe(true);
    expect(s.givenUp).toBe(false);
    expect(s.misses).toBe(0);
    // 模拟"第二次换端口"：再次断线到阈值，仍要能发现
    for (let i = 0; i < REFIND_FAILURES; i++) onReconnectFailure(s);
    expect(shouldRefind(s)).toBe(true);
  });

  it("连续失败到上限进入暂停，冷却期内不重跑 discovery", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_MAX_MISSES - 1; i++) {
      expect(onDiscoveryResult(s, false)).toBe(false);
      expect(s.givenUp).toBe(false);
    }
    onDiscoveryResult(s, false);
    expect(s.givenUp).toBe(true);
    // 暂停后的冷却期内不再尝试（避免每秒白跑 discovery）
    for (let i = 0; i < REFIND_COOLDOWN_FAILURES - 1; i++) {
      onReconnectFailure(s);
      expect(shouldRefind(s)).toBe(false);
    }
    // 冷却期满后自动放开 —— 绝不能是终态，否则「DSH 后启动」会永久连不上
    onReconnectFailure(s);
    expect(shouldRefind(s)).toBe(true);
  });

  it("中途成功一次会清零 misses（偶发抖动不该累积成放弃）", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_MAX_MISSES - 1; i++) onDiscoveryResult(s, false);
    onDiscoveryResult(s, true);
    expect(s.misses).toBe(0);
    for (let i = 0; i < REFIND_MAX_MISSES - 1; i++) onDiscoveryResult(s, false);
    expect(s.givenUp).toBe(false);
  });

  it("连上后清零：givenUp / failures / misses 全部复位", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_FAILURES; i++) onReconnectFailure(s);
    for (let i = 0; i < REFIND_MAX_MISSES; i++) onDiscoveryResult(s, false);
    expect(s.givenUp).toBe(true);
    onConnected(s);
    expect(s).toMatchObject({ failures: 0, misses: 0, givenUp: false });
    expect(shouldRefind(s)).toBe(false);
  });
});

/**
 * 真机回归：「Obsidian 先启动、DSH 后启动」时插件永久不连。
 *
 * 场景（用户实测复现）：Obsidian 20:55 启动，DSH 21:20 才起来。
 * 启动时 onload 探测不到任何 DSH → 自愈开始按轮发现 → 连续 5 轮都找不到 →
 * `givenUp = true` **永久放弃**。等 DSH 真的起来时，插件已经不再尝试，
 * 而 `givenUp` 只有 `onConnected` 能清零 —— 但既然放弃了就永远连不上，
 * 形成死锁：状态栏一直停在「DSH 未运行（连接被拒绝）·重连中…」。
 *
 * 正确的语义：`givenUp` 只应"本轮暂停"，不该是终态。
 * 每轮发现失败都说明 DSH 可能还没起来，而 DSH 随时可能起来 ——
 * 所以放弃之后必须还能被重新唤醒（退避后重试），而不是永不回头。
 */
describe("refind：DSH 后启动时不能永久放弃", () => {
  it("发现连续失败到放弃后，仍能在后续失败中重新获得尝试机会", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_FAILURES; i++) onReconnectFailure(s);
    expect(shouldRefind(s)).toBe(true);

    // 连续 REFIND_MAX_MISSES 轮都找不到 → 本轮放弃
    for (let i = 0; i < REFIND_MAX_MISSES; i++) onDiscoveryResult(s, false);
    expect(s.givenUp).toBe(true);
    expect(shouldRefind(s)).toBe(false);

    // DSH 过了很久才起来：冷却期（REFIND_COOLDOWN_FAILURES 次失败）后必须自动放开重试
    for (let i = 0; i < REFIND_COOLDOWN_FAILURES; i++) onReconnectFailure(s);
    expect(s.givenUp).toBe(false);
    expect(shouldRefind(s)).toBe(true);
  });
});

/**
 * 补充：冷却期内不应反复发现（避免 discovery 开销失控）。
 * 与上一条配对：既要「能恢复」，又不能「每 2s 都跑一遍发现」。
 */
describe("refind 冷却期", () => {
  it("暂停后的前 COOLDOWN-1 次失败不重新发现，满期才放开", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_FAILURES; i++) onReconnectFailure(s);
    for (let i = 0; i < REFIND_MAX_MISSES; i++) onDiscoveryResult(s, false);
    expect(s.givenUp).toBe(true);

    for (let i = 0; i < REFIND_COOLDOWN_FAILURES - 1; i++) {
      onReconnectFailure(s);
      expect(shouldRefind(s)).toBe(false);
    }
    onReconnectFailure(s);
    expect(s.givenUp).toBe(false);
    expect(shouldRefind(s)).toBe(true);
  });
});
