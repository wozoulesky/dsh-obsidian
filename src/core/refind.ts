/**
 * 「DSH 换端口后自愈」的判定逻辑（纯函数，便于单测；main.ts 只负责接线）。
 *
 * 背景：DSH 0.2.1 桌面端每次启动都用 `--port 0` 拿新的随机端口，
 * 而 mux 的重连是无限退避重试**构造期固定**的 baseUrl。没有这层兜底，
 * 用户重启 DSH 后插件永远连旧端口，只能重载 Obsidian —— "装完就用"只在首次启动成立。
 */

/** 连续重连失败多少次后尝试重新发现。取 3：ECONNREFUSED 时固定 2s 轮询，≈6s，越过 DSH 启动窗口。 */
export const REFIND_FAILURES = 3;

/** 连续多少轮发现都找不到可用地址后暂停，避免每 2s 白跑一次 discovery。 */
export const REFIND_MAX_MISSES = 5;

/**
 * 暂停后经过多少次重连失败再解除暂停（冷却期）。
 *
 * 实测一次「发现 + 探测全部候选」只需 37–100ms（DSH 未运行时也没有慢路径），
 * 所以冷却期不必很长 —— 取 3（ECONNREFUSED 下 2s 轮询 ≈6 秒一次发现），
 * 与首次触发阈值对称：用户先开 Obsidian、DSH 几分钟后才起来时，
 * 最坏等待是「DSH 就绪 + 6 秒」，而不是「DSH 就绪 + 60 秒」。
 *
 * 无脑每 2s 都跑发现也没问题（<5% 占空比），但保留冷却期能让
 * 「发现这条路对当前环境确实无效」（例如非桌面端拿不到 Cookie 库）时
 * 不至于持续打日志/耗电。
 */
export const REFIND_COOLDOWN_FAILURES = 3;

/** 自愈状态机（全部为显式字段，便于断言与调试）。 */
export interface RefindState {
  /** 自上次连上以来累计的重连失败次数。 */
  failures: number;
  /** 连续几轮发现都没找到可用地址。 */
  misses: number;
  /**
   * 本轮是否已「暂停」发现（连续多轮找不到可用地址，正在冷却）。
   *
   * **不是终态**：DSH 可能在很久之后才启动（实测有用户先开 Obsidian、25 分钟后才开 DSH）。
   * 若把它当终态，插件就永远连不上了 —— 而它只有 onConnected 才能清零，
   * 既然放弃了就永远连不上，形成死锁。故超过冷却期后必须自动放开重试。
   */
  givenUp: boolean;
  /** 自「暂停」起又累计了多少次重连失败；用于冷却期计数。 */
  failsSinceGiveUp: number;
  /** 发现流程是否正在跑（互斥）。 */
  refinding: boolean;
}

export function createRefindState(): RefindState {
  return { failures: 0, misses: 0, givenUp: false, refinding: false, failsSinceGiveUp: 0 };
}

/** 连上了：全部计数清零，包括 givenUp（下次断线要能重新发现）。 */
export function onConnected(state: RefindState): void {
  state.failures = 0;
  state.misses = 0;
  state.givenUp = false;
  state.failsSinceGiveUp = 0;
}

/**
 * 记录一次重连失败。
 *
 * 若当前处于「暂停」状态，则累计冷却计数；满 `REFIND_COOLDOWN_FAILURES` 后
 * 解除暂停、重新开始发现 —— 这是「DSH 后启动」能恢复的关键：
 * 用户可能先开 Obsidian 很久才开 DSH，插件不能在那之前就永久放弃。
 */
export function onReconnectFailure(state: RefindState): void {
  state.failures += 1;
  if (state.givenUp) {
    state.failsSinceGiveUp += 1;
    if (state.failsSinceGiveUp >= REFIND_COOLDOWN_FAILURES) {
      state.givenUp = false;
      state.failsSinceGiveUp = 0;
      state.misses = 0;
    }
  }
}

/** 是否应当发起一次「重新发现入口」：达到失败阈值、没在跑、也没放弃。 */
export function shouldRefind(state: RefindState): boolean {
  return !state.refinding && !state.givenUp && state.failures >= REFIND_FAILURES;
}

/**
 * 记录一轮发现的结果。
 *
 * @param reachable 是否找到了可用地址
 * @returns 找到 → true（调用方据此执行 rebind）
 *
 * 注意：**失败不置 givenUp**，只累计 misses；连续 REFIND_MAX_MISSES 轮都失败才放弃。
 * 反过来，成功也**不清零 misses 之外的语义**——成功不置 givenUp，
 * 否则用户第二次重启 DSH 就再也不会自愈了（这是最容易写错的一处）。
 */
export function onDiscoveryResult(state: RefindState, reachable: boolean): boolean {
  if (reachable) {
    state.misses = 0;
    return true;
  }
  state.misses += 1;
  if (state.misses >= REFIND_MAX_MISSES) state.givenUp = true;
  return false;
}
