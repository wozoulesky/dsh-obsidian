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
import { cookieName } from "../transport/auth";
import { describeUnknown } from "../utils/describe";
import { clearTimer, setTimer } from "../utils/timers";

/** 渲染进程无 `process` 全局（见 transport/auth.ts 头注释）：Node builtins 一律走 require shim。 */
declare function require(module: string): unknown;

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

/**
 * 把底层错误串归类为可诊断的失败种类。
 *
 * **code-first**：底层错误现在带稳定错误码（`auth/*`、`transport/*`），优先按码判类。
 * 以前只靠 message 关键词（`/凭据|credentials/i`），而文案会随 i18n 改动（中文兜底已改英文），
 * 靠猜词随时可能悄悄降级成 unknown —— 码是契约，文案不是。
 * 关键词匹配保留为兜底：历史日志、服务端原文、第三方错误仍没有码。
 */
export function classifyDshFailure(message: string): DshFailureKind {
  // 1) errno / HTTP 状态最具体，先判（`transport/http-status: HTTP 401` 要靠这里细分）
  if (/ECONNREFUSED/.test(message)) return "notRunning";
  if (/\bENOTFOUND\b|EAI_AGAIN|getaddrinfo/i.test(message)) return "unreachable";
  if (/ETIMEDOUT|timeout after|timed out|Timeout/i.test(message)) return "notResponding";
  if (/HTTP\s*404/.test(message)) return "versionMismatch";
  if (/HTTP\s*(401|403)/.test(message)) return "authFailed";

  // 2) 稳定错误码（不依赖任何文案措辞）
  if (/\bauth\//.test(message)) return "authFailed";

  // 3) 文案兜底（历史中文文案仍可能出现在日志里）
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
 * DSH 的两个**静态**入口端口（只覆盖旧版桌面端与 CLI 默认值）：
 * - `DSH_DESKTOP_URL`：< 0.2.1 的桌面 App 固定 19387（`--port 19387`）。
 *   **0.2.1+ 已改为 `--port 0`（系统随机分配，实测 56516）**，所以这个地址在新版上必然连不上，
 *   只作为零成本的静态候选保留；真实端口靠 `discoverDshUrls()` 发现。
 * - `DSH_CLI_URL`：`dsh --profile web` 默认 3080（`dsh-web-app` 的 `port ?? 3080`），CLI 仍然适用。
 *
 * 事实来源与核查记录：docs/audit-2026-10-17-port.md（0.2.1 动态端口）第 3、6、7 节；
 * 旧结论（「桌面 App 固定 19387」）来自 docs/dsh-0.2-compat-audit-2026-10-01.md 第 5 节，已被证伪。
 * 顺序即优先级——两个都活着时选桌面端口。
 */
export const DSH_DESKTOP_URL = "http://127.0.0.1:19387";
export const DSH_CLI_URL = "http://127.0.0.1:3080";

/** 端口反解区间（含两端；无 off-by-one，1024 与 65535 都参与）。 */
export const DSH_PORT_RANGE_FIRST = 1024;
export const DSH_PORT_RANGE_LAST = 65535;
/** 系统分配（临时）端口段的保守默认值；macOS 当前 `49152–65535`，Linux/Windows 大体相同。 */
const EPHEMERAL_RANGE_FIRST = 49152;
const DEFAULT_MAX_SCAN_MS = 2000;
const SCAN_CONCURRENCY = 1024;
const SCAN_TIMEOUT_MS = 120;

/** Chromium Cookie 库里的 cookie 名前缀（`dsh-auth-` + base64url(sha256(authority))）。 */
const AUTH_COOKIE_PREFIX = "dsh-auth-";
/** 43 字符 = base64url(32 字节 sha256) 的固定长度。 */
const AUTH_COOKIE_HASH_LEN = 43;

/**
 * 端口 → cookie 名（`127.0.0.1:<port>` 的 authority）。
 *
 * 刻意**复用** `transport/auth.ts` 的 `cookieName`，而不是在这里复刻哈希：
 * 两处一旦漂移，反解就会永远 0 命中且极难发现。测试里另有一条「与 auth.ts 一致」的防漂移用例。
 */
export function cookieNameForPort(port: number): string {
  return cookieName(`127.0.0.1:${port}`);
}

/** 端口是否在合法反解区间内。 */
function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= DSH_PORT_RANGE_FIRST && port <= DSH_PORT_RANGE_LAST;
}

/** 从原始字节里抽出所有形如 `dsh-auth-<43 字符>` 的 cookie 名（纯字节扫描，不需要 SQLite）。 */
function authCookieTokensIn(buffer: Buffer): Set<string> {
  const tokens = new Set<string>();
  if (buffer.length === 0) return tokens;
  // latin1 是字节一一映射，ASCII cookie 名无损；避免 utf8 解码把二进制段落丢弃。
  const text = buffer.toString("latin1");
  let index = text.indexOf(AUTH_COOKIE_PREFIX);
  while (index !== -1) {
    const start = index + AUTH_COOKIE_PREFIX.length;
    const token = text.slice(start, start + AUTH_COOKIE_HASH_LEN);
    if (token.length === AUTH_COOKIE_HASH_LEN && /^[A-Za-z0-9_-]+$/u.test(token)) tokens.add(token);
    index = text.indexOf(AUTH_COOKIE_PREFIX, index + 1);
  }
  return tokens;
}

/**
 * 在 Cookie 库原始字节里反解出端口（升序、去重、稳定）。
 *
 * 原理：cookie 名只依赖 authority，所以对端口段每个端口算一次 cookie 名再查表即可。
 * 无需 SQLite 依赖——直接读文件原始字节做子串匹配（审计 §7.3 实测可行）。
 * `ports` 可限定反解范围（单测/加速用），默认全段 1024–65535。
 * 结果含**历史端口**（每重启一次就多一行 cookie，旧行不会被删），调用方必须逐个真实验证。
 */
export function portsFromCookieBuffer(buffer: Buffer, ports?: number[]): number[] {
  const tokens = authCookieTokensIn(buffer);
  if (tokens.size === 0) return [];
  const candidates = ports ?? null;
  if (candidates) {
    const present = candidates.filter((port) => isValidPort(port) && tokens.has(cookieNameForPort(port).slice(AUTH_COOKIE_PREFIX.length)));
    return Array.from(new Set(present)).sort((a, b) => a - b);
  }
  // 全段反解：命中全部 token 就提前收敛（常见 1–3 个 token，可少算一半哈希）。
  const found: number[] = [];
  for (let port = DSH_PORT_RANGE_FIRST; port <= DSH_PORT_RANGE_LAST; port++) {
    if (tokens.has(cookieNameForPort(port).slice(AUTH_COOKIE_PREFIX.length))) {
      found.push(port);
      if (found.length === tokens.size) break;
    }
  }
  return found;
}

/* ---- 运行环境垫片（渲染进程 / 裸 Node 都必须可用；全部延迟加载并吞异常） ---- */

interface FsLike {
  readFile(path: string, cb: (err: unknown, data?: Buffer) => void): void;
}
interface OsLike {
  homedir(): string;
  platform(): string;
}
interface NetSocketLike {
  setTimeout(ms: number, cb: () => void): void;
  on(event: string, cb: () => void): void;
  destroy(): void;
}
interface NetLike {
  connect(options: { host: string; port: number }): NetSocketLike;
}

function loadModule<T>(name: string): T | null {
  try {
    return require(name) as T;
  } catch {
    return null;
  }
}

/** 默认 readFile：回调式 `fs.readFile`（与 auth.ts 同一套 require 约定，不引入新依赖）。 */
function defaultReadFile(path: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const fs = loadModule<FsLike>("fs");
    if (!fs) {
      reject(new Error("fs unavailable"));
      return;
    }
    fs.readFile(path, (err, data) => {
      if (err) reject(err instanceof Error ? err : new Error(describeUnknown(err)));
      else resolve(data ?? Buffer.alloc(0));
    });
  });
}

/**
 * 各平台 Chromium Cookie 库路径（按命中概率排序）。
 *
 * Electron 新版把 cookie 存在 `Network/Cookies` 子目录，旧版在根目录，两处都试。
 * 不用 `process.env`：渲染进程没有 `process` 全局（见 auth.ts 头注释），
 * Windows 走 `os.homedir()` + `AppData/Roaming` 推断。
 */
export function defaultCookieFilePaths(): string[] {
  const os = loadModule<OsLike>("os");
  if (!os) return [];
  let home: string;
  let platform: string;
  try {
    home = os.homedir();
    platform = os.platform();
  } catch {
    return [];
  }
  if (!home) return [];
  const app = "@deepseek-ai/dsh-desktop";
  if (platform === "darwin") {
    const base = `${home}/Library/Application Support/${app}`;
    return [`${base}/Cookies`, `${base}/Network/Cookies`];
  }
  if (platform === "win32") {
    const base = `${home}/AppData/Roaming/${app}`;
    return [`${base}/Network/Cookies`, `${base}/Cookies`];
  }
  const base = `${home}/.config/${app}`;
  return [`${base}/Cookies`, `${base}/Network/Cookies`];
}

/**
 * 单个端口的 TCP 连通性探测（只 connect，不发任何数据）。
 * @returns true = 有人监听；false/抛错 = 没人监听。
 */
function probePort(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const net = loadModule<NetLike>("net");
    if (!net) {
      resolve(false);
      return;
    }
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* 尽力而为 */
      }
      resolve(ok);
    };
    let socket: NetSocketLike;
    try {
      socket = net.connect({ host: "127.0.0.1", port });
    } catch {
      resolve(false);
      return;
    }
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.setTimeout(SCAN_TIMEOUT_MS, () => done(false));
  });
}

/**
 * 扫描临时端口段，返回**有人监听**的端口（降序）。
 * 只做 TCP connect，不发 HTTP、不判「是不是 DSH」——指纹与鉴权验证统一交给 `probeDshUrl`。
 */
async function defaultScanPorts(first: number, last: number): Promise<number[]> {
  const all: number[] = [];
  for (let port = first; port <= last; port++) all.push(port);
  const listening: number[] = [];
  for (let index = 0; index < all.length; index += SCAN_CONCURRENCY) {
    const slice = all.slice(index, index + SCAN_CONCURRENCY);
    const results = await Promise.all(slice.map((port) => probePort(port)));
    results.forEach((ok, offset) => {
      if (ok) listening.push(slice[offset]);
    });
  }
  return listening.sort((a, b) => b - a);
}

export interface DiscoverDshUrlsOptions {
  /** Cookie 库路径（默认各平台标准路径）；传 `[]` 表示不读文件。 */
  cookieFilePaths?: string[];
  /** 是否允许 TCP 扫描兜底（默认 false：扫描 ≈1.3–1.9 s，只该在失败路径/诊断按钮里开）。 */
  scan?: boolean;
  /** 注入的读文件实现（单测用）；默认 `fs.readFile`。 */
  readFile?: (path: string) => Promise<Buffer>;
  /** 注入的时钟（单测用）；用于把 Cookie 反解耗时计入总预算。 */
  now?: () => number;
  /**
   * 整个发现流程（Cookie 反解 + 扫描）的总时长上限，默认 2000 ms。
   * Cookie 已花掉的时间会从扫描预算里扣掉；超时即放弃扫描并返回已有结果，绝不拖挂插件。
   */
  maxScanMs?: number;
  /** 注入的扫描实现（单测用）；默认纯 `net` 连接扫描。 */
  scanPorts?: () => Promise<number[]>;
  /** 扫描端口区间（默认临时端口段 49152–65535）。 */
  scanRange?: { first: number; last: number };
}

/**
 * 发现桌面端 DSH 的真实端口（DSH 0.2.1+ 用 `--port 0`，端口每次启动都变）。
 *
 * 分级（见 docs/audit-2026-10-17-port.md §6/§7）：
 * - **L2（默认路径）**：反解 Chromium Cookie 库 → 端口。纯文件读 + 哈希，≈0.2–0.5 s，零外部命令。
 * - **L3（兜底，需 `scan: true`）**：TCP 扫描临时端口段，≈1.3–1.9 s，受 `maxScanMs` 封顶。
 *   Cookie 已经解出端口时**不扫描**（省掉 1.3 s+）。
 *
 * 不做任何 HTTP 请求、不验证端口是否真是 DSH：调用方应把结果交给 `probeDshUrl` 逐个验证
 * （该函数按 authority 重签 cookie，天然支持任意端口）。任何 IO/平台异常都吞掉，绝不抛。
 *
 * @returns 按优先级排序的候选 URL（Cookie 新端口在前，同源降序），失败返回 `[]`。
 *          不含静态 19387/3080——那两个由 `candidateDshUrls` 提供，调用方合并后需去重。
 */
export async function discoverDshUrls(opts: DiscoverDshUrlsOptions = {}): Promise<string[]> {
  try {
    const ports = await discoverDshPorts(opts);
    return ports.map((port) => `http://127.0.0.1:${port}`);
  } catch {
    // 诊断是尽力而为：任何意外都退化成「没发现」，绝不把插件加载拖挂。
    return [];
  }
}

/** 端口发现主体（与 URL 拼装分离，便于单测与复用）。 */
async function discoverDshPorts(opts: DiscoverDshUrlsOptions): Promise<number[]> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const found = new Set<number>();
  const readFile = opts.readFile ?? defaultReadFile;
  const paths = opts.cookieFilePaths ?? defaultCookieFilePaths();
  for (const path of paths) {
    try {
      const buffer = await readFile(path);
      for (const port of portsFromCookieBuffer(buffer)) found.add(port);
      if (found.size > 0) break; // 命中即停：多平台路径只是备选，不必全读
    } catch {
      // 文件不存在（CLI 场景 / 用户清了 cookie / 平台不同）→ 换下一条路径，不抛
    }
  }
  const cookiePorts = Array.from(found).sort((a, b) => b - a);
  if (cookiePorts.length > 0) return cookiePorts; // 已有精确结果，不浪费 1.3 s 扫描
  if (opts.scan !== true) return [];

  // 总预算含 Cookie 反解耗时：反解已经花掉多少，就只把剩下的留给扫描。
  const limit = Math.max(0, (opts.maxScanMs ?? DEFAULT_MAX_SCAN_MS) - (now() - startedAt));
  const scanned = await scanWithBudget(opts, limit);
  const merged = new Set<number>(cookiePorts);
  for (const port of scanned) if (isValidPort(port)) merged.add(port);
  return Array.from(merged).sort((a, b) => b - a);
}

/** 在 `limit` 毫秒预算内跑扫描；超时/抛错一律降级为空结果。 */
async function scanWithBudget(opts: DiscoverDshUrlsOptions, limit: number): Promise<number[]> {
  if (limit <= 0) return [];
  const range = opts.scanRange ?? { first: EPHEMERAL_RANGE_FIRST, last: DSH_PORT_RANGE_LAST };
  const runner = opts.scanPorts ?? (() => defaultScanPorts(range.first, range.last));
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<number[]>((resolve) => {
    timer = setTimer(() => resolve([]), limit);
  });
  try {
    const scanned = await Promise.race([Promise.resolve().then(runner), timeout]);
    return Array.isArray(scanned) ? scanned : [];
  } catch {
    return [];
  } finally {
    clearTimer(timer);
  }
}

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
/**
 * 两个 DSH 地址是否指向同一入口（按 `URL.href` 归一化，容忍结尾斜杠差异）。
 *
 * 换端口自愈里用它跳过「就是当前这个连不上的地址」——否则发现结果会把当前地址
 * 又选一遍，自愈空转。非法地址退化为字符串比较（不抛错：地址来自用户设置/落盘文件）。
 */
export function sameUrl(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
}

/**
 * 地址是否指向本机。`localhost` 也算（macOS 上可能先解析到 ::1，但插件探测的是 127.0.0.1）。
 *
 * 用途：**本机端口发现只对 loopback 成立**。用户若刻意配了远端 DSH，
 * 绝不能用本机随机端口把它顶掉。
 */
export function isLoopbackUrl(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

export function candidateDshUrls(configuredUrl: string): string[] {
  // 复用 isLoopbackUrl：同一规则只留一处实现，避免改一边漏一边
  if (!isLoopbackUrl(configuredUrl)) return [];
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
