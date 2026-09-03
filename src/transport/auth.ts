/**
 * DSH 0.1.2-rc.1 browser-session cookie 认证（批 1）。
 *
 * 契约事实（对照本机 0.1.2-rc.1 官方 dsh-client-connection 源码核实）：
 * - cookie 名：`dsh-auth-` + base64url(sha256(authority))（authority 必须与请求 Host header 严格一致）
 * - cookie 值：`v1.<body>.<sig>`，body = base64url(utf8(JSON.stringify({version,authority,issuedAt,expiresAt})))，
 *   sig = base64url(hmac-sha256(secret, utf8(body))) —— HMAC 的输入是 base64url 编码后的 body 字符串本身。
 * - secret：`%USERPROFILE%/.dsh/.credentials.yaml` → `records["client-connection/browser-session"].payload.secret`
 *   （32 字节 base64url 字符串，签名前 decode 成 Buffer）。
 *
 * 运行环境：本文件在 Obsidian 渲染进程（nodeIntegration=false，Obsidian 提供 require shim）与
 * Node 单测环境同时运行。沿用 nodeShims.ts 的模式：`declare function require(...)` + `require("crypto")` /
 * `require("fs")`，esbuild 已把 Node builtins 全部 external。YAML 为简易逐行解析，无第三方依赖。
 *
 * cookie 不落盘、不持久化（每进程内存签名）；credentials 文件变化（mtime）或此前读取失败时自动重读，
 * 覆盖「DSH 重启换 secret」场景。
 */

declare function require(module: string): unknown;

interface CryptoLike {
  createHash(algorithm: string): HashLike;
  createHmac(algorithm: string, key: Buffer): HmacLike;
}
interface HashLike {
  update(data: string | Buffer): HashLike;
  digest(): Buffer;
}
interface HmacLike {
  update(data: string | Buffer): HmacLike;
  digest(): Buffer;
}

interface StatsLike {
  mtimeMs: number;
  isFile(): boolean;
}
interface FsLike {
  readFile(path: string, encoding: "utf8", cb: (err: unknown, data?: string) => void): void;
  stat(path: string, cb: (err: unknown, stats?: StatsLike) => void): void;
}

function loadCrypto(): CryptoLike {
  return require("crypto") as CryptoLike;
}
function loadFs(): FsLike {
  return require("fs") as FsLike;
}

/** DSH 凭据读取 / cookie 签名失败（供上层 UI 提示「DSH 凭据不可读」）。 */
export class DshAuthError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "DshAuthError";
  }
}

/** base64url：base64 后 `+`→`-`、`/`→`_`、去掉 `=`。 */
export function encodeBase64Url(data: Buffer): string {
  return data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

/** 对 base64url 字符串解码（签名 secret 使用；非法输入抛错）。 */
export function decodeBase64Url(text: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(text) || text.length % 4 === 1) {
    throw new DshAuthError("DSH 凭据 secret 不是合法的 base64url 字符串");
  }
  const padding = "=".repeat((4 - (text.length % 4)) % 4);
  const decoded = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/") + padding, "base64");
  // 官方 decodeBase64Url 会校验 canonical 往返，这里同样防带 padding 位垃圾的输入
  if (encodeBase64Url(decoded) !== text) {
    throw new DshAuthError("DSH 凭据 secret 不是合法的 base64url 字符串");
  }
  return decoded;
}

/** authority = `new URL("http://" + baseUrl).host` 归一（hostname 小写；显式端口保留，默认端口剥离）。 */
export function authorityOf(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DshAuthError(`baseUrl 无法解析：${JSON.stringify(baseUrl)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DshAuthError(`baseUrl 必须是 http/https 地址：${JSON.stringify(baseUrl)}`);
  }
  return url.host;
}

/** cookie 名：`dsh-auth-` + base64url(sha256(authority))。 */
export function cookieName(authority: string): string {
  return "dsh-auth-" + encodeBase64Url(loadCrypto().createHash("sha256").update(authority).digest());
}

export interface CookiePayload {
  version: 1;
  authority: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * 自签 cookie 值 `v1.<body>.<sig>`（纯函数，供单测与 tmp/probe-auth.mjs 对拍）。
 * @param payload   载荷（issuedAt/expiresAt 为 epoch 毫秒）
 * @param secretKey 已解码的 32 字节 secret Buffer（来自 credentials 文件）
 */
export function signCookie(payload: CookiePayload, secretKey: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = encodeBase64Url(loadCrypto().createHmac("sha256", secretKey).update(body).digest());
  return `v1.${body}.${sig}`;
}

/** cookie 有效时长：7 天（≤ 服务端 cookieMaxAgeDays 默认 30 的上限，留足余量）。 */
export const COOKIE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

export interface DshCookieAuthOptions {
  /** DSH web 根地址（如 http://127.0.0.1:3080）。authority 取其 host:port。 */
  baseUrl: string;
  /** 读取 credentials YAML 文本；默认读真实 %USERPROFILE%/.dsh/.credentials.yaml。单测注入假文本。 */
  readCredentialsFile?: () => Promise<string>;
  /** 当前时间（毫秒）；默认 Date.now。单测注入固定时间以对齐签名向量。 */
  nowMs?: () => number;
}

const CREDENTIALS_RECORD_KEY = "client-connection/browser-session";
const SECRET_BYTES = 32;

/** 简易 YAML 逐行解析：提取 `records.<key>.payload.secret`（2 空格缩进层级；无第三方依赖）。 */
export function extractSecretFromYaml(yamlText: string, recordKey: string = CREDENTIALS_RECORD_KEY): Buffer {
  const lines = yamlText.split(/\r?\n/u);
  // 记录头可能是缩进的（`records:` 下的 2 空格子键），按去尾空白后相等匹配
  const recordIndex = lines.findIndex((line) => line.trim() === `${recordKey}:`);
  if (recordIndex === -1) {
    throw new DshAuthError(`DSH 凭据文件中没有 ${recordKey} 记录（DSH 未初始化浏览器会话凭据）`);
  }
  const recordIndent = lines[recordIndex].length - lines[recordIndex].trimStart().length;
  // 记录块结束：下一个缩进 ≤ 记录头缩进的非空行（同级记录/上层键）
  const stopAt = lines.findIndex(
    (line, i) => i > recordIndex && line.trim() !== "" && line.length - line.trimStart().length <= recordIndent
  );
  const end = stopAt === -1 ? lines.length : stopAt;
  let keyFound = false;
  let secret: string | undefined;
  for (let i = recordIndex + 1; i < end; i++) {
    const line = lines[i];
    if (/^\s+secret:\s*/u.test(line)) {
      secret = line.trim().replace(/^secret:\s*/u, "").trim();
      keyFound = true;
      break;
    }
  }
  if (!keyFound || secret === undefined || secret === "") {
    throw new DshAuthError(`DSH 凭据文件中 ${recordKey} 记录缺少 payload.secret`);
  }
  if (/^["']/u.test(secret)) {
    const unquoted = secret.replace(/^(["'])(.*)\1$/u, "$2");
    if (unquoted !== secret) secret = unquoted;
  }
  const key = decodeBase64Url(secret);
  if (key.length !== SECRET_BYTES) {
    throw new DshAuthError(`DSH 凭据 secret 长度非法（期望 ${SECRET_BYTES} 字节，实际 ${key.length} 字节）`);
  }
  return key;
}

/** 默认凭据文件路径：`%USERPROFILE%/.dsh/.credentials.yaml`（Electron 渲染进程可读的环境变量）。 */
export function defaultCredentialsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? "";
  return `${home}/.dsh/.credentials.yaml`;
}

/**
 * DSH browser-session cookie 认证器。
 *
 * 惰性读取 + 失败自动重读：首次取 cookie 时读 credentials 文件并缓存 secret；
 * 之后每次签名前检查文件 mtime，若变化（DSH 重启换 secret）或此前读取失败则重读。
 * cookieHeader() 返回完整 `Cookie` 请求头值：`dsh-auth-...=v1.<body>.<sig>`。
 */
export class DshCookieAuth {
  private readonly authority: string;
  private readonly readFile: () => Promise<string>;
  private readonly readMtime: () => Promise<number>;
  private readonly now: () => number;

  private secret: Buffer | undefined;
  private fileMtimeMs: number | undefined;
  private lastReadFailed = false;
  private lastError: DshAuthError | undefined;
  private refreshInFlight: Promise<void> | undefined;

  constructor(opts: DshCookieAuthOptions) {
    this.authority = authorityOf(opts.baseUrl);
    this.now = opts.nowMs ?? (() => Date.now());
    const fs = loadFs();
    if (opts.readCredentialsFile) {
      // 注入读取函数：跳过真实文件（mtime 检查退化为「读取失败才重读」）
      this.readFile = opts.readCredentialsFile;
      this.readMtime = () => Promise.resolve(0);
    } else {
      const path = defaultCredentialsPath();
      this.readFile = () =>
        new Promise<string>((resolve, reject) => {
          fs.readFile(path, "utf8", (err, data) => {
            if (err) {
              reject(
                new DshAuthError(`无法读取 DSH 凭据文件 ${path}：${err instanceof Error ? err.message : String(err)}`, err)
              );
            } else {
              resolve(data ?? "");
            }
          });
        });
      this.readMtime = () =>
        new Promise<number>((resolve, reject) => {
          fs.stat(path, (err, stats) => {
            if (err || stats === undefined) {
              reject(
                new DshAuthError(`无法读取 DSH 凭据文件 ${path} 的状态：${err instanceof Error ? err.message : String(err)}`, err)
              );
            } else if (!stats.isFile()) {
              reject(new DshAuthError(`DSH 凭据路径 ${path} 不是文件`));
            } else {
              resolve(stats.mtimeMs);
            }
          });
        });
    }
  }

  /** 强制重读 credentials（下一次 cookieHeader 立即用新 secret）。 */
  async refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.doRefresh();
    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = undefined;
    }
  }

  private async doRefresh(): Promise<void> {
    try {
      let mtime: number;
      try {
        mtime = await this.readMtime();
      } catch {
        mtime = 0; // mtime 不可读时仍尝试读内容（内容读取的错误信息更具体）
      }
      const text = await this.readFile();
      this.secret = extractSecretFromYaml(text);
      this.fileMtimeMs = mtime;
      this.lastReadFailed = false;
      this.lastError = undefined;
    } catch (err) {
      this.secret = undefined;
      this.lastReadFailed = true;
      this.lastError = err instanceof DshAuthError ? err : new DshAuthError(err instanceof Error ? err.message : String(err), err);
      throw this.lastError; // 归一为 DshAuthError 供上层 UI 提示「DSH 凭据不可读」
    }
  }

  private async ensureSecret(): Promise<Buffer> {
    const firstLoad = this.secret === undefined;
    if (firstLoad || this.lastReadFailed) {
      await this.refresh();
      return this.secret as Buffer;
    }
    try {
      const mtime = await this.readMtime();
      if (mtime !== this.fileMtimeMs) await this.refresh();
    } catch {
      // mtime 检查失败：文件可能被删除/换名，重读以获得明确错误
      await this.refresh();
    }
    return this.secret as Buffer;
  }

  /** 检查当前 secret 是否仍然新鲜（mtime 未变且无失败记录）；不新鲜则自动重读。 */
  async refreshIfStale(): Promise<void> {
    if (this.secret === undefined || this.lastReadFailed) {
      await this.refresh();
      return;
    }
    try {
      const mtime = await this.readMtime();
      if (mtime !== this.fileMtimeMs) await this.refresh();
    } catch {
      await this.refresh();
    }
  }

  /**
   * 返回完整的 `Cookie` 请求头值：`dsh-auth-...=v1.<body>.<sig>`
   * （含 `Cookie:` 前缀与否由调用方决定；此处不含前缀）。
   */
  async cookieHeader(): Promise<string> {
    const secret = await this.ensureSecret();
    const issuedAt = this.now();
    const expiresAt = issuedAt + COOKIE_LIFETIME_MS;
    const value = signCookie({ version: 1, authority: this.authority, issuedAt, expiresAt }, secret);
    return `${cookieName(this.authority)}=${value}`;
  }

  /** 上一次刷新失败的错误（未失败过为 undefined），供上层 UI 提示「DSH 凭据不可读」。 */
  get lastFailure(): DshAuthError | undefined {
    return this.lastError;
  }
}
