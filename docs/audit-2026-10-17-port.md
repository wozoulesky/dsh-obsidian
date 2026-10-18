# DSH 0.2.1 动态端口：插件端口发现可行性核查（dsh-bridge v0.1.9）

核查日期：2026-10-17 / 2026-10-18
核查对象：本机 **DSH 桌面版 0.2.1-rc.2**（`/Applications/DeepSeek Harness.app`，`dshBuildCommit 332895e0f7c9d4dbfb29729f5eb367fa263ff986`）
核查问题：桌面端改为系统分配端口后，插件有没有**可靠**办法发现真实端口？成本、风险、失效模式分别是什么？
基线文档：[dsh-0.2-compat-audit-2026-10-01.md](dsh-0.2-compat-audit-2026-10-01.md)（0.2.0-rc.2 全量核查）、[audit-2026-10-17-protocol.md](audit-2026-10-17-protocol.md)（0.2.1 协议增量核查）
性质：**只做调查与方案评估，不改任何代码**。全文结论都能用第 8 节命令重放。

---

## 0. 一句话结论

> **端口是可发现的，但只能从「操作系统 / Electron 客户端产物」这一侧发现，不能从 DSH 自己这一侧发现。**
>
> - DSH 0.2.1 桌面端用 `--port 0` 启动 Host（官方源码逐行确认），端口由内核分配，当前是 `127.0.0.1:56516`。
> - **DSH 进程内部没有任何地方把端口/URL 落盘**：既没有 endpoint 文件，也没有状态文件，也没有环境变量注入。`ready.url` 只通过 IPC 送到 Electron 主进程内存里。（第 3、4 节穷举证据）
> - 所以「读 DSH 状态文件」「读 `DSH_WEB_URL`」这两个最省事的方案**在 0.2.1 上是死路**，可以直接排除。
> - 可行路径只有三条，实测都能稳定拿到 56516：**① 直接反解 Chromium Cookie 库**（读文件 0.4 ms + 全段哈希 367–466 ms，零外部命令）；**② `netstat`/`lsof` 拿 loopback 监听端口 + Cookie 哈希求交**（≈25 ms，把哈希范围压到 ~17 个，但要 `child_process`）；**③ TCP 扫描 `49152–65535` + `GET /` 指纹**（≈1.3–1.9 s，兜底）。
> - **推荐方案**：`configured → 静态候选(19387/3080) → Cookie 反解 → 扫描兜底` 的四级降级，全部改动集中在 `src/core/diagnose.ts` 一个文件（`main.ts` 只改一行调用），且只在**首次探测失败时**触发，不占 onload 预算；P1 不引入 `child_process`，把 `netstat`/`lsof` 留作可选加速。
> - **必答问题**：现在这副装好的插件配 0.2.1 桌面版是**必然完全连不上**（100%，不是概率事件）；用户侧看到的不是"静默失败"，而是**状态栏永久显示「DSH 未运行」+ 诊断把"DSH 正在运行"误报成"没在运行"，并指引用户去改一个已经被废弃的固定端口 19387**。详见第 5 节。

---

## 1. 结论速览

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 0.2.1 桌面端端口是动态的吗？ | **是**。Host 子进程以 `args: ["--no-open","--host","127.0.0.1","--port","0"]` 启动 | `dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:234-240`（asar 内），见 3.1 |
| 2 | 端口是内核分配的哪个区间？ | macOS 临时端口段 `49152–65535`。实测两代端口 `51740`、`56516` 都落在区间内 | `sysctl net.inet.ip.portrange.first/last` → `49152/65535`，见 8.1 |
| 3 | 现在实际监听哪个端口？ | `127.0.0.1:56516`（PID 55960，进程名 `DeepSeek`，cwd=`~/.dsh/profiles/desktop`） | `lsof -nP -a -c DeepSeek -iTCP -sTCP:LISTEN`，见 8.2 |
| 4 | 19387 / 3080 还活着吗？ | **都死了**。19387 无监听、`curl` 拒连；3080 从未在 0.2.1 上监听 | 见 8.3 |
| 5 | DSH 会把端口写到某个文件吗？ | **不会**。asar 内 16736 个 packed 文件全量扫描：无任何 endpoint/port/url 落盘代码；`~/.dsh` 全部状态文件里也没有端口 | 见 4.1–4.3 |
| 6 | 有环境变量能拿到吗？ | **没有**。`DSH_WEB_URL` 只注入 agent 自己的受管 bash，不进 Obsidian；`DSH_DESKTOP_HOST_INSPECT_PORT` 只设 Node inspector 端口 | 见 4.4 |
| 7 | 能不能问 Electron 主进程要 URL？ | 理论可以（`dsh-desktop:boot` 返回 `streamBaseUrl`），但插件在**另一个应用**（Obsidian）的渲染进程里，摸不到 DSH 的 IPC | 见 3.2 |
| 8 | 有没有轻量指纹能确认"这个端口是 DSH"？ | **有**。无 cookie 的 `GET /` → `401` + 正文 `dsh web authentication required; reopen the URL printed by dsh web.`，且 `HEAD` 也支持 | `dsh-client-connection/lib/index.js:571-577`，见 3.3 |
| 9 | 换端口后插件现有 cookie 还能用吗？ | **不能**。cookie 名 = `sha256(authority)`、payload 里也校验 `authority`，必须按新端口重签 | 见 3.4，实测矩阵 |
| 10 | 插件现在的自动探测能救回来吗？ | **不能**。候选写死 `19387`/`3080`，两个都是死的，`firstReachableDshUrl` 返回 null → 保持原配置 | 见 5.1 |
| 11 | 推荐方案要改哪些文件？ | `src/core/diagnose.ts`（新增发现函数）+ `src/main.ts`（1 行：候选来源改为「静态候选 ∪ 动态发现」） | 见 7.3 |

---

## 2. 现场事实（可重放）

### 2.1 环境

| 项 | 值 | 取法 |
|---|---|---|
| DSH 桌面版版本 | `0.2.1-rc.2` | `PlistBuddy -c 'Print :CFBundleShortVersionString' .../Contents/Info.plist` |
| asar 内 `package.json` | `@deepseek-ai/dsh-desktop` / `0.2.1-rc.2` / `dshDesktopAppId: com.deepseek.dsh` | asar 解析 |
| 安装时间 | `2026-10-17 17:39`（app.asar mtime） | `ls -ld` |
| 升级包 | `~/Library/Caches/@deepseek-aidsh-desktop-updater/pending/deepseek-harness-0.2.1-rc.2-mac-arm64.zip` | 存在即本次升级 |
| 桌面 Electron 主进程 PID | `55936` | `SingletonLock` 符号链接 → `skydeMacBook-Air.local-55936` |
| DSH Host 子进程 PID | `55960` | `lsof -c DeepSeek -iTCP -sTCP:LISTEN` |
| Host 子进程 cwd | `/Users/sky/.dsh/profiles/desktop` | `lsof -p 55960 -d cwd` |
| 监听端口 | `127.0.0.1:56516` | 同上 |
| Obsidian | `1.13.7`，插件 `dsh-bridge` 0.1.9 | `Info.plist` / `manifest.json` |
| 插件已保存地址 | `http://127.0.0.1:19387` | `obsidian-warehouse/.obsidian/plugins/dsh-bridge/data.json` |

### 2.2 时间线：端口是每次启动换的，不是一次性的

| 时间 | 端口 | 证据来源 |
|---|---|---|
| 2026-10-07 20:07 | `19387` | Cookie 库第 1 行；Chromium 缓存项 `c55ee8dbd8b1860b_0` 首字节 `1/0/http://127.0.0.1:19387/` |
| 2026-10-17 16:46 | `51740` | Cookie 库第 2 行；缓存项 `bea99cf3c3eeca16_0` → `1/0/http://127.0.0.1:51740/` |
| 2026-10-17 20:48（当前） | `56516` | Cookie 库第 3 行；缓存项 `d5ff285a7127cca0_0` → `1/0/http://127.0.0.1:56516/` |

> 读法（三个端口对应三个不同的构建/启动）：
> - `19387`（10-07）是**固定端口时代**的产物（推断：该端口正是旧版 `dsh-desktop-host` 的硬编码值，与基线文档 5.1 记录一致）。
> - `51740`（10-17 16:46）**早于** 当前 `app.asar` 的安装时间（17:39），所以它来自装这个 0.2.1-rc.2 之前的那次启动。**推断**（非直接观测）：它已经在临时端口段内，说明当时的桌面端也已是 `--port 0`，即动态端口不是 0.2.1-rc.2 才引入的。
> - `56516`（10-17 20:48）是当前这次启动：`app.asar` 17:39 被替换，20:48 重启，`SingletonLock` 与 Cookie 库 mtime 都是 20:48。
>
> 这张表同时否掉了两个常见的"临时凑合"想法：
> - **不能靠"上次的端口"**：每次重启都变，且每次都会新增一行 cookie，历史值永远留在库里（所以反解时会拿到 3 个候选，必须验证）。
> - **不能靠缓存里的旧 URL**：缓存项是旧的，会把 `19387` 当成"最近用过的地址"；而且缓存里同时躺着三个端口，没有"哪个是现在"的语义。

---

## 3. 根因：官方源码逐行证据

以下路径都相对 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（182,833,898 字节，asar header 已按 `sizePayload @4` / `jsonLen @12` / 内容基址 `8+sizePayload` 解析，`maxEnd == filesize` 自校验通过）。取证工具与方法见第 9 节。

### 3.1 Host 子进程用 `--port 0` 启动 —— 这是动态端口的源头

`dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js` 第 226–252 行（`main()`，`args` 在 234–240）：

```js
const application = runProfile({
  environment: loadLayeredEnv("dsh"),
  profile: "desktop",
  resolvedProfile: { profile, installAnchor },
  patchFiles: [],
  args: [
    "--no-open",
    "--host",
    "127.0.0.1",
    "--port",
    "0"            // ← 内核分配端口
  ],
  ...
```

`--port 0` 交给 `dsh-web-app` 的监听器；`dsh-web-app/cordis.patch.yml` 里 `port: !!js ctx.webStartup.port ?? 3080`，显式传了 `0` 就不再走 3080 默认值。

**这条推翻了基线文档 5.1 的结论**（原文写 `args: ["--no-open", "--port", "19387"]`）。同一位置的代码在 0.2.1 已改为 `--host 127.0.0.1 --port 0`，且 `DSH_DESKTOP_URL = "http://127.0.0.1:19387"` 这个常量在整个 asar 里**一次都不出现**：

```
asan 全量扫描（16736 个 packed 文件，跳过唯一超 40MB 的 lighthouse_worker.js）：
  hits "19387" = 0
  hits "3080"  = 12（全是 CLI 默认值文档/配置，与桌面端无关）
```

### 3.2 端口只在 IPC 里流过，从不落盘

`dsh-host 启动完成后把真实 URL 上报给 Electron 主进程`（同文件，第 344–350 行）：

```js
const url = ctx.connection.authenticatedUrl(
  `${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}`
);
if (process.connected) process.send?.({
  type: "ready",
  url,
  injections: ctx.webServer.collectIndexInjections()
}, ...);
```

Electron 侧（`lib/main.js`）：
- `DesktopHostProcess.start()`（`lib/main.js:3791-3811`，`stdio` 在 `:3805-3810`）用 `spawn(node, [...], { cwd: projectDir, stdio: ["ignore","pipe","pipe","ipc"] })` 起子进程 —— 第 4 个 fd 是 **IPC channel**，URL 就走这里。
- `child.on("message", ...)` 收到 `type === "ready"` → `this.readyResolve({ url, injections })`（`:3818-3827`）。
- 收到后 `hostCookie = await authenticateWebHost(ready.url)`（`authenticateWebHost` 定义在 `lib/main.js:8229-8236`，调用在 `:12191`）：对 `ready.url` 发 `fetch(url, { redirect: "manual" })`，期望 `303 + set-cookie`，把 cookie 存进**内存变量**。
- `ipcMain.handle(DESKTOP_IPC.boot /* "dsh-desktop:boot" */)` 返回 `{ injections, streamBaseUrl: new URL(hostUrl).origin }`（`lib/main.js:12424-12432`，`DESKTOP_IPC` 定义在 `:6981`）。

**关键点：`hostUrl` / `hostCookie` 都是 `lib/main.js` 顶层 `let`，生命周期 = 进程内。** 没有 `writeFile`、没有 `mkdir`、没有 SQLite、没有 `electron-store`。

### 3.3 无 cookie 时的 401 指纹（发现候选端口后用来判"是不是 DSH"）

`dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js:571-577`：

```js
writeUnauthorized(req, res) {
  res.writeHead(401, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8"
  });
  res.end(req.method === "HEAD" ? void 0
    : "dsh web authentication required; reopen the URL printed by dsh web.\n");
}
```

实测（8.4）：

| 端口 | 服务 | `GET /` 结果 | 是否可判为 DSH |
|---|---|---|---|
| 56516 | DSH Host | `401`，`cache-control: no-store`，正文 `dsh web authentication required; ...` | ✅ 高置信 |
| 19825 | 某本地 Agent 服务 | `403`，JSON `{"ok":false,"error":"Forbidden: missing X-OpenCLI header"}` | ❌ |
| 49568 | Code Helper | `200`，正文 `ok` | ❌ |
| 56656 | rapportd | 非 HTTP（`Parse Error: Expected HTTP/, RTSP/ or ICE/`） | ❌ |

`HEAD /` 同样返回 401（无正文），所以指纹探测可以只用 HEAD，省流量。

### 3.4 cookie 绑定 authority，换端口必须重签

`dsh-client-connection` 的 `authenticate()`：

```js
const authority = requestAudience(request.headers, secure);
const rawCookie = header(request.headers, "cookie");
if (authority === void 0 || rawCookie === void 0) return void 0;
const value = cookieValue(rawCookie, cookieName(authority));   // 名字 = sha256(authority)
if (value === void 0) return void 0;
const payload = decodeCookie(value, this.secret);
if (payload === void 0 || payload.authority !== authority) return void 0;   // payload 也校验
```

实测矩阵（8.5，用插件同一份 `~/.dsh/.credentials.yaml` 里的 secret 手工签名）：

| 连接地址 | cookie 签给谁 | HTTP 状态 | 结论 |
|---|---|---|---|
| `127.0.0.1:56516` | `127.0.0.1:56516` | **200** | ✅ |
| `127.0.0.1:56516` | `127.0.0.1:19387` | 401 | 旧端口 cookie 无效 |
| `127.0.0.1:56516` | `localhost:56516` | 401 | 主机名不同也无效 |
| `localhost:56516` | `127.0.0.1:56516` | 401 | 反向也不行 |
| `localhost:56516` | `localhost:56516` | **200** | ✅ |

> 对方案的含义：**扫描出的每个候选端口都必须用该 authority 重新签一次 cookie 再验证**，不能复用。插件现有 `DshCookieAuth` 每次请求按 `baseUrl` 重签，天然满足——这是好消息，`probeDshUrl(url)` 可以直接拿来验证任意候选端口，无需改认证层。

---

## 4. 「端口有没有被写到哪儿」的穷举证据

这一节是整份文档里最关键的负面证据：它把"读文件"和"读环境变量"两条低成本路线**排除**掉，剩下的方案才谈得上"可靠"。

### 4.1 asar 全量扫描：没有 endpoint 落盘代码

对 asar 内 **全部 16736 个 packed 文件**（跳过唯一超 40MB 的 `lighthouse_worker.js`）逐字节扫描：

- `writeFile|mkdirSync|appendFile|renameSync` 在 `dsh-desktop-host/**`、`dsh-web-app/**`、`dsh-client-connection/**` 三个包里 **0 命中**（`desktop-host` 整个包连一次 `writeFile` 都没有）。
- 全局搜 `host-url|endpoint.json|port.json|address.json|runtime-state` → **0 命中**。
- 搜 `56516` → 1 命中，但是 `dsh/desktop-runtime.json` 里某个 `node_modules/sharp/...` 的 sha256 字符串**碰巧含 `565168`**，与端口无关（假阳性，已核对上下文）。

Electron 主进程 `lib/main.js` 确实有 8 处 `writeFileSync` / 1 处 `writeFileAtomic`，但逐个核对**写入目标全是别的东西**，没有一处写端口：

| 行 | 写什么 |
|---|---|
| 3420 / 3423 / 3425 / 3497 / 3566 | profile 的 `package.json`、`cordis.patch.yml`、`pnpm-workspace.yaml` |
| 8509-8516（`writeCrashReport`，调用点 11851） | 崩溃报告（只在致命错误/用户主动上报时写） |
| 9062 | 某个 JSON 存储（`this.path`） |
| 10298 | 桌面 settings 默认值（`~/Library/Application Support/@deepseek-ai/dsh-desktop/desktop/settings.json`） |
| 11193 / 11203 | 快捷键（`keybindings.json`） |
| 11786（`markerPath` 定义在 12819） | `background-close-confirmed` 空标记文件 |
| 13190 | 启动失败诊断文件（只在失败时写） |

### 4.2 `~/.dsh` 状态文件：没有一个含端口

| 文件 | 内容 | 有端口吗 |
|---|---|---|
| `~/.dsh/storages/workspace.json` | 工作区与会话索引 | ❌ |
| `~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` | `desktopVersion: 0.2.1-rc.2`、platform/arch、payloadDigest、python/node/pnpm 版本、包清单 | ❌ |
| `~/.dsh/.credentials.yaml` | secret、token、refs | ❌ |
| `~/.dsh/profiles/desktop/cordis*.yml` | profile patch 层 | ❌ |
| `~/.dsh/storages/session_projcache/sessions/*.json`（116 个） | 会话投影（只含聊天内容，其中出现的 `127.0.0.1:56516` 是**本次调查的对话正文**，不是系统状态） | ❌ |

限定范围内的 grep（**不做全盘 grep**，范围仅 `~/.dsh` 且排除 `sessions/dsh-runtimes/node_modules`）：

```bash
grep -rl '127\.0\.0\.1:[0-9]' --exclude-dir=sessions --exclude-dir=dsh-runtimes --exclude-dir=node_modules ~/.dsh
# → 无输出
```

### 4.3 Electron 客户端目录：只有"产物"，没有"状态"

`~/Library/Application Support/@deepseek-ai/dsh-desktop/` 下逐项检查：

| 文件 | 含端口吗 | 说明 |
|---|---|---|
| `Cookies`（SQLite） | ✅ **端口名哈希在里面** | 见第 6.1 节方案 D0 |
| `Cache/Cache_Data/<hash>_0` | ✅ **完整 URL**（`1/0/http://127.0.0.1:56516/`） | 见第 6.1 节方案 E |
| `SingletonLock` → `hostname-<pid>` | ❌ | 只给 Electron 主进程 PID |
| `desktop/settings.json` | ❌ | 只有 `{"updates":{"allowTestAuthPopupWindow":false}}` |
| `Preferences` / `Local State` / `TransportSecurity` / `Network Persistent State` | ❌ | `strings` 里 0 个 `127.0.0.1:` |
| `Local Storage/leveldb` / `Session Storage` | ❌ | 同上 |

### 4.4 环境变量：没有可用通道

- `DSH_WEB_URL`：`dsh-web-app/README.md:57` 明确 `surfaceContext` 只把它注入**agent 自己的受管 bash**；`README.md:83 / :109` 说启动展示与浏览器交接拿到的是**带 token 的 URL**，而 agent 上下文拿到的是**干净 URL**。二者都**不注入 Obsidian 等第三方进程**（基线文档 5.3 已确认，本次复核未发现变化）。
- `DSH_DESKTOP_HOST_INSPECT_PORT`（`lib/main.js:11906-11909`）：只拼 `--inspect=127.0.0.1:<port>` 给 Node inspector，**与 Web 监听端口无关**。
- 全量扫过 `lib/main.js` 的 env 相关常量，没有任何 web-host/web-port 覆盖项。

> 结论：**DSH 侧不存在"端口发现契约"**。这是设计选择（端口是进程内部实现细节，不是对外 API），不是 bug，也不会在补丁版本里补上。因此插件必须从"进程/客户端产物"这一侧反向发现。

---

## 5. 【必答】插件现在配 0.2.1 桌面版：连得上吗？用户看到什么？

### 5.1 判定：**必然完全连不上**，且**自动探测救不回来**

把真机上的插件代码（`src/core/diagnose.ts` + `src/transport/{client,auth}.ts`，用 esbuild 打成 CJS 后在裸 Node 里跑）对当前环境跑一遍 `onload` 的判定链路（8.6）：

```json
{"configured":"http://127.0.0.1:19387","okConfigured":false,
 "candidates":["http://127.0.0.1:3080/"],"resolved":"http://127.0.0.1:19387","ms":15}
{"configured":"http://127.0.0.1:3080","okConfigured":false,
 "candidates":["http://127.0.0.1:19387/"],"resolved":"http://127.0.0.1:3080","ms":3}
```

即：

1. `probeDshUrl("http://127.0.0.1:19387")` → `connect ECONNREFUSED 127.0.0.1:19387` → `false`。
2. `candidateDshUrls("http://127.0.0.1:19387")` → `["http://127.0.0.1:3080/"]`（`src/core/diagnose.ts:123`：`[DSH_DESKTOP_URL, DSH_CLI_URL].filter(u => hrefOf(u) !== configured)`）。
3. 探测 3080 → `connect ECONNREFUSED 127.0.0.1:3080` → `false`。
4. `firstReachableDshUrl` 返回 `null` → `autoSwitchDshUrl` **原样返回配置地址**，并且**不弹任何 Notice**（Notice 只在 `found !== null` 时发）。
5. 用死地址建 `DshClient` 并 `mux.start()` → WS 也 `ECONNREFUSED`。

**新装用户同样连不上**：`src/settings.ts:19` 的默认值是 `http://127.0.0.1:3080`，两个静态候选里 3080 也是死的。

**手工填 56516 能通，但只活一次**：`56516` 是本次启动的端口，下次桌面重启端口再变，插件又回到"连不上"，而自动探测依旧救不回来。

### 5.2 用户侧实际看到什么（按界面逐处列出）

| 界面位置 | 触发条件 | 用户看到 | 事实评价 |
|---|---|---|---|
| **状态栏** | mux 首次 `ECONNREFUSED` → `serviceDown=true` → `main.statusNotRunning` | **「DSH 未运行（连接被拒绝）· 重连中…」** 永久停留，每 2 s 重连一次（`muxStream.ts:424-426`，`ECONNREFUSED` 走固定 2 s 轮询） | ❌ **误导**：DSH 正在运行，是插件找错端口 |
| **onload** | 候选全失败 | **什么提示都没有**（`autoSwitchDshUrl` 静默返回） | ❌ 静默失败，用户不知道发生了什么 |
| **聊天面板打开时** | `manager.refresh()` 抛错 | Notice：**「会话列表拉取失败：connect ECONNREFUSED 127.0.0.1:19387」**（`chatView.ts:167`） | ⚠️ 有报错但只有原始串，指向错误端口 |
| **onload 的 `manager.refresh()`** | 同上 | 只写 `console.error`，**无 UI**（`main.ts:151`） | ⚠️ 普通用户看不到 |
| **设置 → 诊断连接** | 点「诊断」 | Notice：**「连接异常：本机 DSH 似乎没有在运行（连接被拒绝）——确认 DSH 已启动，并检查「DSH 地址」的端口：桌面 App 固定 19387，dsh web 命令默认 3080（技术细节：connect ECONNREFUSED 127.0.0.1:19387）」** | ❌ **双重误导**：① 说"没在运行"，实际在运行；② 指引"桌面 App 固定 19387"，而 0.2.1 已改成系统分配 |
| **设置 → DSH 地址（说明文字）** | 常驻 | 「端口因启动方式而异：桌面 App 固定 http://127.0.0.1:19387，dsh web 命令默认 http://127.0.0.1:3080」 | ❌ 同上，已过时 |
| **`load-error.log`** | 仅 onload 抛异常时写 | 本次场景不触发（探测失败不抛，返回 false） | — |

失败归类走 `classifyDshFailure("connect ECONNREFUSED ...")` → `notRunning` → `hintKey = "diag.notRunning"`（`classifyDshFailure` 在 `src/core/diagnose.ts:37-45`，`HINT_KEYS` 在 `:27-34`）。**这个归类本身没错，错的是它假设"连不上 = 没运行"这个前提在动态端口下不再成立。**

### 5.3 一句话给用户会被怎么答复

> "你的 DSH 明明开着，插件却说它没开，还让我去改一个 19387 的端口——可我在设置里把它改成 56516 就能用了，但 DSH 一重启又坏了。"

这就是必须修的理由：**不是"版本兼容"问题，而是"必然失效 + 误导性诊断"**，且随 0.2.1 覆盖面扩大而放大。

---

## 6. 候选方案对比

所有耗时都是**本机实测**（macOS arm64，DSH 0.2.1-rc.2 运行中；采集时 Obsidian 未启动，但各方案的耗时与 Obsidian 是否运行无关——读文件/枚举端口/扫描都不依赖 Obsidian 进程。8.7 有原始数据与可重放脚本）。

### 6.1 汇总表

| # | 方案 | 可行性 | 实测耗时 | 精度 | 失效模式 | 风险 |
|---|---|---|---|---|---|---|
| **A** | **TCP 扫描 `49152–65535` + `GET /` 指纹 + 逐端口 `session/list` 验证** | ✅ 纯 `net`/`http`，零系统依赖 | 扫描 **1287–1791 ms**（1024 并发/120 ms 超时，随负载波动）；指纹 13 ms；验证 3 个候选串行 **67 ms** | 确定（三重过滤） | 端口被防火墙/非 loopback 绑定、临时端口段被改（`sysctl` 非默认） | 低。只是慢一点，且只在首次失败时跑 |
| **B** | 读 DSH 持久化状态文件（endpoint.json 之类） | ❌ **不存在** | — | — | 无文件可读 | — （第 4.1/4.2 节已穷举排除） |
| **C** | 读环境变量 `DSH_WEB_URL` | ❌ **拿不到** | — | — | Obsidian 进程里没有这个变量 | —（第 4.4 节已排除） |
| **D0** | **Chromium Cookie 库反解**：读 `Cookies` 原始字节取 `dsh-auth-<43字符>`，对端口段逐个哈希反查 | ✅ 实测命中（纯文件读，零外部命令） | 读文件 **0.4 ms** + 全段哈希（1024–65535）**367–466 ms** + 3 个候选串行验证 **67 ms** | 确定（哈希精确匹配 + `session/list` 验证） | ① Cookie 库还没写入当前端口（首次启动的极短窗口）② 用户清了 DSH cookie ③ CLI 场景没有这个库 ④ 非 macOS 路径不同 | 低。只读一个文件；但属"读别的应用的浏览器数据库"，需在 README 明示 |
| **D1** | **`netstat`/`lsof` 拿 loopback 监听 → 与 Cookie 哈希求交**（D0 的加速版） | ✅ 实测命中 | `netstat` **22 ms**（`lsof` **81–103 ms**）+ 读 Cookie 库 **0.4 ms** + 哈希 ~17 个 **<2 ms** | 确定（同上） | 同 D0，另有：`netstat`/`lsof` 不在 PATH、权限、平台命令差异 | 中低。多引入 `child_process`；跨平台命令分支 |
| **E** | 读 Chromium HTTP 缓存里的完整 URL | ✅ 实测命中 | 读 138 个缓存项首 160 字节 **49 ms** | 高（完整 URL） | 缓存可能被清、格式随 Chromium 版本变（`1/0/http://...` 是内部格式） | 中。**格式无契约**，Chromium 升级即可能失效 |
| **F** | 只 `lsof -c DeepSeek` 按进程名过滤 | ✅ 实测命中 | **81–103 ms** | 确定 | 进程名变了（`DeepSeek` 是 9 字符截断）、`lsof` 不在 PATH、需要 `/usr/sbin` 绝对路径、Linux 上容器内可能看不到 | 中低。快但脆（依赖进程名） |
| **G** | 静态候选表扩容（加 `56516`、加 51740…） | ⚠️ 治标 | 0 ms | 只在"运气对上"时有效 | **下次重启必然失效** | 高（伪修复，会让用户以为修好了） |
| **H** | 让用户手工填端口 | ⚠️ 可用但不可接受 | — | 确定 | 每次 DSH 重启都要改一次 | 高（体验不可接受，且用户不知道端口是多少） |
| **I** | 让用户在 DSH 端固定端口（`--port` 参数/配置） | ❌ 桌面端无此开关 | — | — | 桌面 App 自己没有传 `--port` 的入口；改 `cordis.patch.yml` 属于 hack | 高（越界修改用户 DSH，且升级即被覆盖） |

### 6.2 关键判断

1. **B / C 必须直接排除**，不要再花时间找"是不是有个隐藏文件"。第 4 节是全量穷举，不是抽样。
2. **G（静态扩容）是伪修复**，必须显式拒绝：它能让今天的 56516 恰好可用，但把"必然失效"变成"随机失效"，更难排查。
3. **D0 + A 组合是最优解**：D0 只用 `fs` 读一个文件 + 哈希（≈0.5 s），A 在 D0 不可用时 1.3–1.9 s 兜底。两者都是"发现 + 验证"成对出现，**不会把非 DSH 的端口误当成 DSH**。
4. **D1 是 D0 的性能优化**（22 ms vs 367–466 ms），代价是引入 `child_process`；**建议 P1 不做，留作 P3**。
5. **F 可作为 D1 的替代**（`netstat` 不可用时），但**不能单独作为最终方案**——按进程名过滤太脆。
6. **E 不推荐进生产**：Chromium 缓存格式是内部实现，没有契约，且有"读到旧端口"的混淆风险（第 2.2 节已证实缓存里同时躺着 19387/51740/56516）。

### 6.3 推荐方案的准确形态（四级降级）

```
L0  configured URL          —— 现有行为，尊重用户手填
L1  静态候选 19387 / 3080    —— 保留，覆盖 CLI 默认端口与 <0.2.1 桌面端（零成本）
L2  Chromium Cookie 库反解   —— 覆盖 0.2.1+ 桌面端动态端口（读文件 + 哈希，≈0.5 s，无外部命令）
L2' netstat/lsof 交叉加速    —— 可选优化：把 L2 的哈希范围从 65534 个压到 ~17 个（≈25 ms，需 child_process）
L3  TCP 扫描临时端口段       —— L2 失败时的兜底（≈1.3–1.9 s）
```

每一级产出的候选**都必须过一遍 `probeDshUrl(candidate)`**（真实的 `session/list`，按该 authority 重签 cookie）才算命中。这保证了「发现」不会引入新的误判。

---

## 7. 推荐方案：最小改动落点

### 7.1 改动范围

| 文件 | 改动 | 规模 |
|---|---|---|
| `src/core/diagnose.ts` | 新增 `discoverDesktopDshUrls()`（L2/L3 实现），并把 `candidateDshUrls` 拆成「静态候选（纯函数，保持现状）」+「动态发现（异步）」两个来源 | ~120 行 |
| `src/main.ts` | `findWorkingDshUrl` 里把候选来源从 `candidateDshUrls(configuredUrl)` 改成 `[...candidateDshUrls(configuredUrl), ...(await discoverDesktopDshUrls())]` | **1 行** || `src/ui/settingsTab.ts` | 诊断失败时，若发现到真实端口，把提示从「DSH 未运行」改成「DSH 在 56516，点此切换」 | ~10 行 |
| `i18n.template.json` | 改 `settings.dshUrlDesc`、`diag.notRunning` 的措辞（去掉"固定 19387"），新增 1 条"已发现端口"文案 | 3 条 |

**不改**：`src/transport/auth.ts`（`DshCookieAuth` 已按 `baseUrl` 重签，天然支持任意端口）、`src/transport/client.ts`、`src/transport/muxStream.ts`、`src/settings.ts`（默认值 3080 仍对 CLI 成立）、README（本轮不动）。

### 7.2 时序约束（很重要）

现在 `onload` 的预算：`PROBE_TIMEOUT_MS = 3000`，但只探 2 个候选（并发），实测全失败时 3–15 ms 就返回。**不能**把 L3 的 1.3–1.9 s 扫描塞进 onload —— 那会让每次启动（即使 DSH 正常）都慢 1.3 s 以上。

推荐时序：

- **onload**：只跑 L0 + L1（现状，≈15 ms）。
- **首次探测全失败时**（`autoSwitchDshUrl` 返回 null 那一步）：跑 **L2 only**（Cookie 反解 ≈0.5–0.8 s；若同时启用 L2' 加速则 ≈25 ms），命中就落盘 + Notice。这已经覆盖 99% 的桌面端场景。
- **L3（扫描）只在用户点「诊断连接」时跑**，或者 L2 也失败时跑一次并缓存结果；不要放 onload。

这样正常启动的开销增加 ≈0（L2 只在失败路径上），而失败路径从"永远连不上"变成"0.5 s 后自动连上"。

### 7.3 实现要点（伪代码，只描述不改代码）

```ts
// src/core/diagnose.ts

/** L2：从 Electron Chromium Cookie 库反解桌面端端口（零外部命令、零扫描）。 */
export async function discoverDshPortsFromCookies(home = homedir()): Promise<number[]> {
  const hashes = readDshCookieAuthorityHashes(home);   // 读 Cookies 原始字节，正则取 dsh-auth-<43字符>
  if (hashes.size === 0) return [];
  const ports: number[] = [];
  for (let p = PORT_RANGE_FIRST; p <= PORT_RANGE_LAST; p++) {
    if (hashes.has(b64url(sha256(`127.0.0.1:${p}`)))) ports.push(p);
  }
  return ports;   // 含历史端口，调用方必须逐个 verify
}

/** L2'：可选加速 —— 先拿 loopback 监听端口，只对它们做哈希（需 child_process）。 */
export async function discoverDshPortsFromListeners(): Promise<number[]> {
  const listeners = readLoopbackListeners();           // /usr/sbin/netstat -anv -p tcp，失败则 /usr/sbin/lsof
  if (listeners.length === 0) return [];
  const hashes = readDshCookieAuthorityHashes();
  if (hashes.size === 0) return [];
  return listeners.filter((p) => hashes.has(b64url(sha256(`127.0.0.1:${p}`))));
}

/** L3：扫描临时端口段 + 401 指纹。仅作兜底。 */
export async function scanForDshPorts(): Promise<number[]> {
  const open = await tcpScan(PORT_RANGE_FIRST, PORT_RANGE_LAST, { concurrency: 1024, timeoutMs: 120 });
  const checked = await Promise.all(open.map(fingerprintDsh));   // HEAD / → 401 + dsh 指纹
  return checked.filter(Boolean);
}
```

四个实现细节，都是踩过的坑：

1. **`netstat`/`lsof` 必须用绝对路径**（`/usr/sbin/netstat`、`/usr/sbin/lsof`），精简 PATH 下裸命令可能找不到。实测 `netstat` 更快（22 ms vs 81–103 ms）且不需要额外权限，**优先 `netstat`**；两者都属可选优化（L2'），不进 P1。
2. **Cookie 库用 `fs.readFileSync` 读原始字节 + 正则**，不要 `require("better-sqlite3")`（Obsidian 里没有）。实测桌面端运行时 `fs.readFileSync` 0.4 ms 成功；若改用 SQL 必须加 `?immutable=1`，且 `Cookies-journal` 可能非空。
3. **不要写死临时端口段**：运行时读 `sysctl net.inet.ip.portrange.first/last`（macOS 当前 `49152/65535`）；Linux 读 `/proc/sys/net/ipv4/ip_local_port_range`；Windows 默认 `49152–65535` 但会被 Hyper-V/WinNAT 预留段侵蚀，需要 `netsh int ipv4 show excludedportrange tcp` 排除。
4. **绝不复用旧 cookie**：每个候选端口用 `new DshCookieAuth({ baseUrl: `http://127.0.0.1:${port}` })` 重新签名（第 3.4 节矩阵已证明必须如此）。

### 7.4 为什么这是"最小改动"

- 只动 2 个源文件的核心逻辑量（`diagnose.ts` 新增两个纯异步函数 + `main.ts` 一行）；认证/传输/会话层完全不动。
- `candidateDshUrls` 的**纯函数签名与现有 7 条单测全部保持不变**（`tests/core/diagnose.test.ts:99-125`），新增逻辑走独立导出，测试可平行新增。
- L2/L3 都在**失败路径**上，正常用户的启动耗时与现在完全一致。
- 不引入新依赖：P1 只用 `node:net`、`node:http`、`node:crypto`、`node:fs`；`node:child_process`（`netstat`/`lsof` 加速）是可选的 L2'，见 7.5。

### 7.5 一个必须提前决策的取舍：要不要引入 `child_process`

`netstat`/`lsof` 需要 `child_process.execFile`。现状：插件源码**完全没有**用过 `child_process`（已 grep 确认），只通过 Obsidian 的 require shim 用 `crypto`/`fs`/`os`。

| 选项 | 优点 | 代价 |
|---|---|---|
| Cookie 库反解 + 全段哈希（**纯文件读**） | 零外部命令、零扫描、跨平台一致；0.4 ms 读 + 367–466 ms 哈希 | 依赖 Chromium Cookie 库存在且含当前端口；需处理「历史端口也要验证」 |
| 纯 `net` 扫描（不调外部命令） | 零外部依赖、零权限问题、跨平台一致 | 1.3–1.9 s；会碰到本机其他服务（只是 TCP connect，不发送数据，风险极低） |
| `child_process.execFile("/usr/sbin/netstat", ...)` | 22 ms，精确，把哈希范围压到 ~17 个 | ① 新引入 `child_process`（Obsidian 渲染进程里**可用**，但属于"插件执行外部命令"，社区审核更敏感）② 平台分支与命令差异 |

**建议**：P1 做 **Cookie 库反解 + 纯 `net` 扫描兜底**（完全不引入 `child_process`），把 `netstat`/`lsof` 作为 L2' 的可选优化后置。理由：

- Cookie 全段哈希（1024–65535）**367–466 ms** + 对解出的历史端口逐个验证（冷态约 170–180 ms/个，热态约 30 ms/个）≈ **0.5–0.8 s**，且**完全不需要扫描**、不需要外部命令 —— 这是最优的"零依赖"方案。
- 若 Cookie 库不可用（用户清了 cookie / CLI 场景 / 首次启动尚未写库），退到纯 `net` 扫描 1.3 s。
- 两条路都不碰 `child_process`，社区审核风险最低。

> 实测参考（8.7）：
> - `Cookies` 全段哈希（1024–65535）：**367–466 ms** → 解出 `[19387, 51740, 56516]` → 逐个验证 → 只剩 `56516`
> - `netstat` + Cookie 交叉：**22 + 0.4 + ~0 ms** → 直接只剩 `56516`
> - 纯 `net` 扫描 49152–65535：**1287–1791 ms**（随负载波动）

---

## 8. 复现命令附录

> 全部在本机（macOS arm64、DSH 0.2.1-rc.2 运行中）实测通过。命令里的 `APP=/Applications/DeepSeek Harness.app`。

### 8.1 版本与端口段

```bash
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "/Applications/DeepSeek Harness.app/Contents/Info.plist"
# → 0.2.1-rc.2

sysctl net.inet.ip.portrange.first net.inet.ip.portrange.last
# → 49152 / 65535
```

### 8.2 当前真实端口

```bash
lsof -nP -a -c DeepSeek -iTCP -sTCP:LISTEN
# COMMAND     PID USER   FD   TYPE ... NAME
# DeepSeek  55960  sky   21u  IPv4 ... TCP 127.0.0.1:56516 (LISTEN)
```

### 8.3 19387 / 3080 已死

```bash
lsof -nP -iTCP:19387 -sTCP:LISTEN   # 无输出，exit 1
lsof -nP -iTCP:3080  -sTCP:LISTEN   # 无输出，exit 1
curl -sS -m 2 -X POST http://127.0.0.1:19387/api/session/list
# curl: (7) Failed to connect to 127.0.0.1 port 19387
```

### 8.4 DSH 指纹（无 cookie）

```bash
curl -sS -m 2 -D - http://127.0.0.1:56516/ | head -8
# HTTP/1.1 401 Unauthorized
# cache-control: no-store
# content-type: text/plain; charset=utf-8
# dsh web authentication required; reopen the URL printed by dsh web.

curl -sS -m 2 -I http://127.0.0.1:56516/ | head -3   # HEAD 也 401
curl -sS -m 2 -X POST http://127.0.0.1:56516/api/session/list   # → 401 "unauthorized"
```

### 8.5 authority 绑定验证（需先算出 cookie）

```bash
# 生成 secret 与 scope 常量
node -e '
const fs=require("fs"),crypto=require("crypto"),os=require("os");
const b64=b=>b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const raw=/client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/.exec(
  fs.readFileSync(os.homedir()+"/.dsh/.credentials.yaml","utf8"))[1].replace(/^["\x27]|["\x27]$/g,"");
const secret=Buffer.from(raw.replace(/-/g,"+").replace(/_/g,"/").padEnd(Math.ceil(raw.length/4)*4,"="),"base64");
const cookieFor=a=>{const body=b64(Buffer.from(JSON.stringify({version:1,authority:a,issuedAt:Date.now(),expiresAt:Date.now()+36e5})));
  return "dsh-auth-"+b64(crypto.createHash("sha256").update(a).digest())+"=v1."+body+"."+b64(crypto.createHmac("sha256",secret).update(body).digest());};
const http=require("http");
const probe=(host,port,signed)=>new Promise(r=>{const b=JSON.stringify({type:"client-request",rpcId:"r",method:"session/list",payload:{args:{_request:{}}}});
  const q=http.request({hostname:host,port,path:"/api/session/list",method:"POST",timeout:2000,
    headers:{"content-type":"application/json","content-length":Buffer.byteLength(b),cookie:cookieFor(signed)}},
    res=>{res.resume();res.on("end",()=>r([host+":"+port,"signed="+signed,res.statusCode].join("  "))) });
  q.on("error",e=>r([host+":"+port,"signed="+signed,e.code].join("  ")));q.write(b);q.end();});
(async()=>{for (const [h,p,s] of [["127.0.0.1",56516,"127.0.0.1:56516"],["127.0.0.1",56516,"127.0.0.1:19387"],
  ["127.0.0.1",56516,"localhost:56516"],["localhost",56516,"127.0.0.1:56516"],["localhost",56516,"localhost:56516"]])
  console.log(await probe(h,p,s));})();
'
# 127.0.0.1:56516  signed=127.0.0.1:56516  200
# 127.0.0.1:56516  signed=127.0.0.1:19387  401
# 127.0.0.1:56516  signed=localhost:56516  401
# localhost:56516  signed=127.0.0.1:56516  401
# localhost:56516  signed=localhost:56516  200
```

### 8.6 用插件自己的代码复现 onload 判定

```bash
cd /Users/sky/Develop/dsh-obsidian
cat > /tmp/symptom-entry.ts <<'EOF'
export { candidateDshUrls, firstReachableDshUrl } from "/Users/sky/Develop/dsh-obsidian/src/core/diagnose";
export { DshClient } from "/Users/sky/Develop/dsh-obsidian/src/transport/client";
export { DshCookieAuth } from "/Users/sky/Develop/dsh-obsidian/src/transport/auth";
EOF
node_modules/.bin/esbuild /tmp/symptom-entry.ts --bundle --platform=node --format=cjs \
  --outfile=/tmp/symptom-bundle.cjs --log-level=error
node -e '
globalThis.window={crypto:require("node:crypto").webcrypto,process:{env:process.env},
  setTimeout:(f,m)=>setTimeout(f,m),clearTimeout:i=>clearTimeout(i),addEventListener(){},removeEventListener(){}};
globalThis.Buffer=Buffer;
const {candidateDshUrls,firstReachableDshUrl,DshClient,DshCookieAuth}=require("/tmp/symptom-bundle.cjs");
const probeDshUrl=async url=>{try{const c=new DshClient({baseUrl:url,auth:new DshCookieAuth({baseUrl:url}),timeoutMs:3000});
  return (await c.list()).ok===true;}catch{return false;}};
(async()=>{for (const configured of ["http://127.0.0.1:19387","http://127.0.0.1:3080"]) {
  const ok=await probeDshUrl(configured);
  const c=candidateDshUrls(configured);
  console.log(JSON.stringify({configured,ok,candidates:c,resolved:ok?configured:(await firstReachableDshUrl(c,probeDshUrl))??configured}));
}})();'
# {"configured":"http://127.0.0.1:19387","ok":false,"candidates":["http://127.0.0.1:3080/"],"resolved":"http://127.0.0.1:19387"}
# {"configured":"http://127.0.0.1:3080","ok":false,"candidates":["http://127.0.0.1:19387/"],"resolved":"http://127.0.0.1:3080"}
```

### 8.7 三条发现路径的实测耗时

```bash
# (a) netstat 拿 loopback 监听端口
time /usr/sbin/netstat -anv -p tcp | grep LISTEN | grep -c '127\.0\.0\.1\.'
# → 17 个；耗时 22 ms

# (b) lsof 按进程名
time /usr/sbin/lsof -nP -a -c DeepSeek -iTCP -sTCP:LISTEN
# → 127.0.0.1:56516；耗时 81–103 ms

# (c) Cookie 库反解端口（读原始字节 + 哈希全段）
node -e '
const fs=require("fs"),crypto=require("crypto");const t=Date.now();
const b64=b=>b.toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const raw=fs.readFileSync(process.env.HOME+"/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies").toString("latin1");
const hashes=new Set([...raw.matchAll(/dsh-auth-([A-Za-z0-9_-]{43})/g)].map(m=>m[1]));
const ports=[];for(let p=1024;p<=65535;p++)if(hashes.has(b64(crypto.createHash("sha256").update("127.0.0.1:"+p).digest())))ports.push(p);
console.log({hashes:hashes.size,ports,ms:Date.now()-t});'
# → { hashes: 3, ports: [ 19387, 51740, 56516 ], ms: 367–466 }（随负载）

# (d) 纯 net 扫描临时端口段（1024 并发 / 120ms 超时）+ HEAD 指纹
node -e '
const net=require("net"),http=require("http");
const HOST="127.0.0.1", TIMEOUT=120, CONC=1024;
const tcp=p=>new Promise(r=>{const s=new net.Socket();let d=false;
  const fin=ok=>{if(d)return;d=true;s.destroy();r(ok);};
  s.setTimeout(TIMEOUT,()=>fin(false));s.once("connect",()=>fin(true));s.once("error",()=>fin(false));s.connect(p,HOST);});
const fp=p=>new Promise(r=>{const q=http.request({hostname:HOST,port:p,path:"/",method:"HEAD",timeout:1000},
  res=>{res.resume();res.on("end",()=>r(res.statusCode===401&&res.headers["cache-control"]==="no-store"));});
  q.on("timeout",()=>{q.destroy();r(false)});q.on("error",()=>r(false));q.end();});
(async()=>{const t0=Date.now(),open=[];let n=49152;
  await Promise.all(Array.from({length:CONC},async()=>{while(n<=65535){const p=n++;if(await tcp(p))open.push(p);}}));
  const tScan=Date.now()-t0;
  const hits=[];for(const p of open)if(await fp(p))hits.push(p);
  console.log({tScanMs:tScan,open,hits,totalMs:Date.now()-t0});})();'
# 实测两次：{ tScanMs: 1287, open: [ 49568, 56516, 56656 ], hits: [ 56516 ], totalMs: ~1350 }
#            { tScanMs: 1791, open: [ 49568, 56516, 56656 ], hits: [ 56516 ], totalMs: ~1870 }
# 扫描耗时随机器负载在 1.3–1.9 s 波动；指纹阶段只对 3 个开放端口发 HEAD，可忽略。
```

### 8.8 asar 取证（192MB Electron asar，关键在 header 格式）

`app.asar` 不能 grep（单一 182MB 二进制 blob）。实测正确的 header 布局：

```
u32@0  = 4              // pickle 头固定值
u32@4  = 4780396        // pickle payload 大小（= u32@8 + 4）
u32@8  = 4780392        // = JSON 字节数 + 6
u32@12 = 4780386        // JSON 字节数（asar header 的真实长度）
JSON 从 offset 16 开始  // = 8 (pickle 头) + 8 (这 4 个 u32 中的后两个? 实测锚点)
base   = 8 + 4780396 = 4780404   // 文件内容基址
自校验：max(entry.offset + entry.size) == 文件长度(182833898)，delta 0
```

> 这套偏移是**实测反推**的（不是文档抄来的）。第一次按「offset 4..8 = header size」解析会得到 `SyntaxError: Unexpected token 'h'`；用 `maxEnd == filesize` 作为唯一可信判据逐位试出来的。

读出任意文件：

```bash
cat > /tmp/asarx.mjs <<'EOF'
import fs from "node:fs";
const A = process.argv[2] ?? "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar";
const fd = fs.openSync(A, "r");
const rd = (o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return b; };
const base = 8 + rd(4, 4).readUInt32LE(0);
const jsonLen = rd(12, 4).readUInt32LE(0);
const header = JSON.parse(rd(16, jsonLen).toString("utf8"));
const [mode, pathRe, contentRe] = process.argv.slice(3);
const out = [];
(function walk(n, p) {
  for (const [k, e] of Object.entries(n.files ?? {})) {
    const q = p ? `${p}/${k}` : k;
    if (e.files) walk(e, q);
    else if (e.offset !== undefined && !e.unpacked) out.push({ path: q, offset: Number(e.offset), size: Number(e.size) });
  }
})(header, "");
for (const e of out) {
  if (!new RegExp(pathRe).test(e.path)) continue;
  const t = rd(base + e.offset, e.size).toString("utf8");
  if (!contentRe) { console.log(e.path); continue; }
  const re = new RegExp(contentRe, "g"); let m;
  while ((m = re.exec(t))) {
    const line = t.slice(0, m.index).split("\n").length;
    console.log(`${e.path}:${line}: ${t.slice(Math.max(0, m.index - 80), m.index + 160).replace(/\n/g, "\\n")}`);
  }
}
EOF
node /tmp/asarx.mjs - 'dsh-desktop-host/lib/index\.js' '"--port"'
# → dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js:238: ... "--port", "0"  （args 数组 234-240 行）
```

### 8.9 「端口没落盘」的穷举复核

```bash
# asar 内全量找 19387（16736 个 packed 文件逐个读）
node /tmp/verify-19387.mjs
# → { packedFiles: 16736, scannedFiles: 16736, skippedOversize: [".../lighthouse_worker.js"],
#     hits19387: 0, hitFiles: [], hits56516: 1, hits3080: 12 }

# ~/.dsh 里除了 sessions/ 之外没有任何 loopback URL
grep -rl '127\.0\.0\.1:[0-9]' --exclude-dir=sessions --exclude-dir=dsh-runtimes \
  --exclude-dir=node_modules ~/.dsh        # → 无输出

# 桌面端状态文件里没有端口
cat ~/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json | head -20
cat ~/Library/Application\ Support/@deepseek-ai/dsh-desktop/desktop/settings.json
```

---

## 9. 验证边界（哪些跑了 / 哪些没跑）

| 层 | 实际怎么做的 | 证明了什么 | **没有**证明什么 |
|---|---|---|---|
| 静态（asar） | 自写 asar 解析器（header 校验 `maxEnd == filesize`）读 `dsh-desktop-host`/`dsh-web-app`/`dsh-client-connection` 源码；16736 文件全量字符串扫描 | `--port 0` 是事实；`ready.url` 只走 IPC；asar 内无 `19387`；无端口落盘代码 | 没有在真实 IDE 里单步调试 Electron 主进程（只能读源码推断内存生命周期） |
| 运行时（OS） | `lsof`/`netstat`/`sysctl`/`curl`/`sqlite3` 真机采样 | 当前端口 56516；端口段 49152–65535；19387/3080 均无监听 | `/bin/ps` 在本沙箱不可用（`Operation not permitted`），未能直接读 PPID；Host(55960) 与 Electron 主进程(55936) 的父子关系由 `SingletonLock`+`lsof` 间接确认（主进程有两条 `ESTABLISHED → 127.0.0.1:56516`，Host 的 fd 1/2 是 unix socket pair） |
| 插件代码（真机） | esbuild 打包 `src/core/diagnose.ts` + `src/transport/{client,auth}.ts`，裸 Node 里对 56516/19387/3080/`localhost` 发真实 `session/list` 与 `/api/remote.mux` WS 握手 | 插件的认证与传输层**完全兼容 0.2.1**（56516 上 `{"ok":true,"count":116}`，WS 握手成功）；19387/3080 `ECONNREFUSED`；authority 绑定矩阵 5/5 符合预期 | 没有在真实 Obsidian 窗口里点一遍（本次采集期间 Obsidian 进程未运行；症状描述来自代码路径推演 + 用插件自身代码对真机 DSH 的探测结果，两者互相印证） |
| 发现方案 | 三条路径各自独立实现在 Node 里跑通并计时（8.7） | 三条都能稳定拿到 56516；耗时数据可复现 | 没有做成插件代码合入验证（本轮约束是只出文档、不改 `src/`） |

### 9.1 明确没做到的事（交给后续）

1. **没在 Windows / Linux 上验证**。Cookie 库路径（macOS `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies`；Windows 大概率 `%APPDATA%\@deepseek-ai\dsh-desktop\Network\Cookies`；Linux `~/.config/@deepseek-ai/dsh-desktop/Cookies`）与临时端口段（Windows `49152–65535` 默认但 Hyper-V/WinNAT 会保留段；Linux `/proc/sys/net/ipv4/ip_local_port_range`）都需要各自适配。
2. **没验证 0.2.1 以下版本的回归**。L1 静态候选保留 19387/3080，对 `<0.2.1` 桌面端与 CLI 仍然有效（这是基线文档已确认的事实），但没在旧版上重跑。
3. **没验证 `--port 0` 是否会被未来版本改回固定端口**。如果官方改回固定端口，L2/L3 只是白跑一遍（有 L0/L1 短路，不会出错）。

---

## 10. 遗留风险与建议

| 风险 | 影响 | 缓解 |
|---|---|---|
| 桌面端在"未加载 GUI"的极短窗口内 Cookie 库还没有新行 | L2 拿不到当前端口 | 退回 L3 扫描；或把 L2 结果与"最近 30 s 内 mtime 变化的 cookie"联合判断 |
| 用户清了 DSH 的 cookie | L2 拿不到 | L3 扫描兜底（1.3 s） |
| 端口被非 loopback 绑定（`--host` 改成具体 IP） | L2/L3 都只看 `127.0.0.1` | 桌面端硬编码 `--host 127.0.0.1`（3.1 节），当前不是风险；若未来放开，需要扩到配置里的 host |
| 临时端口段被 `/etc/sysctl.conf` 改过 | L3 扫错区间 | 运行时读 `sysctl net.inet.ip.portrange.first/last`，不要写死 |
| 引入 `child_process` 触发社区审核更严 | 上架延迟 | **建议先不引入**（7.5 节），用纯 `net` + Cookie 文件读 |
| 静态候选 G 被当成"修好了" | 掩盖问题 | 明确拒绝；`candidateDshUrls` 的注释（`src/core/diagnose.ts:87-89`）必须同步改成"桌面端 0.2.1+ 为系统分配端口" |

### 10.1 建议的最小发布节奏

1. **P0（必须）**：修 `src/core/diagnose.ts` 的错误注释与 `diag.notRunning`/`settings.dshUrlDesc` 的误导文案 —— 即使不做发现，也不能继续告诉用户"桌面 App 固定 19387"。
2. **P1（核心）**：加 L2（Cookie 库反解 + 逐候选验证），失败路径从"永远连不上"变"≈0.5–0.8 s 自动连上"。
3. **P2（兜底）**：加 L3（纯 `net` 扫描 + 401 指纹），覆盖 L2 不可用场景；只在「诊断连接」按钮里跑。
4. **P3（可选）**：`netstat`/`lsof` 快路径（需评估 `child_process` 的审核与跨平台成本）。

---

## 附录 A：一句话给 Lead 的摘要

- 端口确实是动态的（`--port 0`，源码级确认），**且 DSH 侧没有任何落盘/环境变量通道**（16736 文件全量扫描 + `~/.dsh` 全量检查，均 0 命中）——"读状态文件"方案可以直接砍掉。
- 可行方案实测三条，都稳定命中 56516：Cookie 库反解（0.4 ms 读 + 367–466 ms 哈希 + 67 ms 验证）、`netstat`+Cookie 交叉（22 ms）、纯 `net` 扫描（1287–1791 ms）。**推荐 P1 只做 Cookie 反解 + 扫描兜底**（都不引入 `child_process`）。
- 推荐「L0 配置 → L1 静态 19387/3080 → L2 Cookie 反解 → L3 扫描兜底」四级降级，改动集中在 `src/core/diagnose.ts` + `src/main.ts` 一行，全部走失败路径。
- **必答**：现在配 0.2.1 桌面版 **100% 连不上**；用户看到状态栏永久「DSH 未运行（连接被拒绝）· 重连中…」、开聊天面板弹「会话列表拉取失败：connect ECONNREFUSED 127.0.0.1:19387」、诊断弹「本机 DSH 似乎没有在运行……桌面 App 固定 19387」——**DSH 明明在运行，诊断在骗人**。
- 附带发现：基线文档 `dsh-0.2-compat-audit-2026-10-01.md` 5.1 节「桌面 App 固定 19387（`--port 19387`）」已被 0.2.1 证伪，该文档需要标注过期。
