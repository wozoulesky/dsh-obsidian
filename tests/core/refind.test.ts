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

  it("连续失败到上限才放弃，避免无界重跑 discovery", () => {
    const s = createRefindState();
    for (let i = 0; i < REFIND_MAX_MISSES - 1; i++) {
      expect(onDiscoveryResult(s, false)).toBe(false);
      expect(s.givenUp).toBe(false);
    }
    onDiscoveryResult(s, false);
    expect(s.givenUp).toBe(true);
    // 放弃后不再尝试
    for (let i = 0; i < REFIND_FAILURES; i++) onReconnectFailure(s);
    expect(shouldRefind(s)).toBe(false);
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
