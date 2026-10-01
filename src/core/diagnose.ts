/**
 * 连接失败的归类与处置提示（纯函数 + 一次探测，无 DOM / 无 obsidian 依赖）。
 *
 * 存在理由：`HTTP 401 for http://127.0.0.1:3080/api/session/list`、`connect ECONNREFUSED` 这类
 * 原始错误串对用户没有任何可操作性——而竞品调研显示「DSH 版本兼容」是这一族的共性痛点
 * （头部插件专门把版本兼容表写进 README 首页）。这里把底层错误串收敛到有限的几种成因，
 * 每种成因对应一句可执行提示；UI（设置面板「诊断连接」按钮、状态栏）只负责取词与展示。
 *
 * 归类顺序刻意从「连接层」到「应用层」：先看socket/DNS/超时，再看 HTTP 状态码，最后看凭据错误。
 */
import type { RpcResult } from "../transport/types";

export type DshFailureKind =
  /** 端口拒绝连接：DSH 没在跑（最常见）。 */
  | "notRunning"
  /** 域名/主机解析不了：地址填错。 */
  | "unreachable"
  /** 连上了但无响应：进程卡住或端口被别的服务占用。 */
  | "notResponding"
  /** HTTP 404：本机 DSH 过旧，没有该 API（版本兼容问题）。 */
  | "versionMismatch"
  /** HTTP 401/403 或凭据文件不可读：认证不可用。 */
  | "authFailed"
  /** 归类不了：保留原始错误串，不编造结论。 */
  | "unknown";

const HINT_KEYS: Record<DshFailureKind, string | null> = {
  notRunning: "diag.notRunning",
  unreachable: "diag.unreachable",
  notResponding: "diag.notResponding",
  versionMismatch: "diag.versionMismatch",
  authFailed: "diag.authFailed",
  unknown: null,
};

/** 把底层错误串归类为可诊断的失败种类。 */
export function classifyDshFailure(message: string): DshFailureKind {
  if (/ECONNREFUSED/.test(message)) return "notRunning";
  if (/\bENOTFOUND\b|EAI_AGAIN|getaddrinfo/i.test(message)) return "unreachable";
  if (/ETIMEDOUT|timeout after|timed out|Timeout/i.test(message)) return "notResponding";
  if (/HTTP\s*404/.test(message)) return "versionMismatch";
  if (/HTTP\s*(401|403)/.test(message)) return "authFailed";
  if (/凭据|credentials/i.test(message)) return "authFailed";
  return "unknown";
}

/** 归类 → i18n 提示键；`unknown` 返回 null（调用方保留原始错误，不显示编造的结论）。 */
export function failureHintKey(kind: DshFailureKind): string | null {
  return HINT_KEYS[kind];
}

/** 一步到位：错误串 → i18n 提示键。 */
export function failureHintKeyFor(message: string): string | null {
  return failureHintKey(classifyDshFailure(message));
}

/** 探测结果：成功，或失败（原始详情 + 可选的归类提示键）。 */
export type DshProbeOutcome =
  | { ok: true }
  | { ok: false; detail: string; kind: DshFailureKind; hintKey: string | null };

/**
 * 用一次 `session.list` 探测三件事：**可达 / 认证可用 / 版本契约匹配**。
 *
 * 为什么用 list 而不是更轻的探针：它同时穿过认证（自签 cookie）与 RPC 信封两层，
 * 是插件每次启动都会走的真实路径——探测通过即代表核心链路可用。
 * 两种失败形态都要接：`RpcResult.ok === false`（服务端明确拒绝，如 404 路由缺失 → 归类为版本问题）
 * 与抛错（连接层失败 / 凭据不可读）。
 */
export async function probeDshConnection(list: () => Promise<RpcResult<unknown>>): Promise<DshProbeOutcome> {
  try {
    const result = await list();
    if (result.ok) return { ok: true };
    const detail = `${result.error.code}: ${result.error.message}`;
    const kind = classifyDshFailure(detail);
    return { ok: false, detail, kind, hintKey: failureHintKey(kind) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const kind = classifyDshFailure(detail);
    return { ok: false, detail, kind, hintKey: failureHintKey(kind) };
  }
}

/* ---- 端口自动探测 ---- */

/**
 * DSH 的两个入口端口（都不是动态端口，只是启动方式不同）：
 * - `DSH_DESKTOP_URL`：桌面 App 固定 19387（`dsh-desktop-host` 硬编码 `--port 19387`）
 * - `DSH_CLI_URL`：`dsh --profile web` 默认 3080（`dsh-web-app` 的 `port ?? 3080`）
 *
 * 事实来源与核查记录：docs/dsh-0.2-compat-audit-2026-10-01.md 第 5 节。
 * 顺序即优先级——两个都活着时选桌面端口。
 */
export const DSH_DESKTOP_URL = "http://127.0.0.1:19387";
export const DSH_CLI_URL = "http://127.0.0.1:3080";

/** 归一化为 `URL.href`（`http://127.0.0.1:3080` → `http://127.0.0.1:3080/`）；非法地址返回 null。 */
function hrefOf(url: string): string | null {
  try {
    return new URL(url).href;
  } catch {
    return null;
  }
}

/**
 * 给出「配置地址之外」的候选探测地址，按优先级排列（桌面优先）。
 *
 * 只在配置地址指向 loopback 时才给候选——19387/3080 只对 loopback 成立，远端地址不该被本地端口顶掉。
 * 非法地址或非 loopback 一律返回空数组（不猜）。
 * `localhost` 也算 loopback：DSH 只绑 127.0.0.1，而 macOS 上 `localhost` 可能先解析到 ::1，
 * 此时探测 `127.0.0.1:3080` 正好把这种「地址写法导致的连不上」一起修掉。
 */
export function candidateDshUrls(configuredUrl: string): string[] {
  let hostname: string;
  try {
    hostname = new URL(configuredUrl).hostname;
  } catch {
    return [];
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") return [];
  const configured = hrefOf(configuredUrl);
  return [DSH_DESKTOP_URL, DSH_CLI_URL].filter((url) => hrefOf(url) !== configured);
}

/**
 * 并发探测全部候选，返回**优先级最高**的可用地址；都不行返回 null。
 *
 * 并发（而不是逐个串行）是为了给 onload 路径的最坏耗时封顶：串行 N 个候选最坏 N × 超时，
 * 并发只等于 1 × 超时。代价是「第一个就通」时多探一次——本地回环上可忽略。
 * `probe` 抛错一律视为不可用：探测是尽力而为，绝不能把插件加载拖挂。
 */
export async function firstReachableDshUrl(
  candidates: string[],
  probe: (url: string) => Promise<boolean>
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const results = await Promise.all(
    candidates.map((url) =>
      probe(url).then(
        (ok) => ok === true,
        () => false
      )
    )
  );
  const index = results.findIndex(Boolean);
  return index === -1 ? null : candidates[index];
}
