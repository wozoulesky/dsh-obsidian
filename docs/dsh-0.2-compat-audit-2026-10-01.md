# DSH 0.2 兼容性核查（dsh-bridge / dsh-obsidian）

核查日期：2026-10-01
核查对象：本机安装的 **DSH 0.2.0-rc.2**（nightly channel，`hostProtocolVersion: 4`）
核查结论：**0.2 没有破坏本插件的连接链路**。认证、RPC 信封、端点清单、WS 帧协议全部逐条对上，并已对本机运行中的 0.2 服务做真机端到端验证。
唯一会导致"连不上"的现实原因是**端口**（桌面 App 与 CLI 用的是两个不同端口），与 0.2 无关，但值得在插件侧做引导。

---

## 1. 结论速览

| 问题 | 结论 |
|---|---|
| 0.2 有没有改认证（cookie / 密钥位置 / 签名算法）？ | **没有**。0.1.7-rc.2 → 0.2.0-rc.2，承载认证与 WS 的 `@deepseek-ai/dsh-client-connection` 除版本号外**字节完全一致** |
| 0.2 有没有改 WS / RPC 协议？ | **没有**。`/api/remote.mux`、`open/item/end/error/cancel` 帧、`{type:'client-request'\|'server-response'}` 信封、ready 首帧全部未变；无 protocol v2、无版本协商握手 |
| 0.2 有没有删掉我们在用的端点？ | **没有**。0.2 共 140 个 RPC 端点，本插件用到的 18 个全部存在，且**参数 wire 名逐个一致** |
| 现在能连上吗？ | **能**。已用插件自身代码（`DshCookieAuth` + `DshClient` + `RemoteMuxTransport`）直连本机 0.2.0-rc.2 实测通过 |
| 那"连不上"的真实原因是什么？ | **端口**：桌面 App 固定 `127.0.0.1:19387`，`dsh --profile web` CLI 默认 `3080`。插件默认值是 3080，桌面 App 用户必须改 |

---

## 2. 核查方法（三层证据，互相独立）

1. **静态层**：从 `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar` 解包 0.2.0-rc.2 全量实现（12973 个文件），直接读源码常量与生成的调用描述符（`typert.host.js`）。
2. **协议层**：提取 0.2 的 140 条 `InvocationDescriptor`，与本插件使用的端点 / 参数名做比对。
3. **真机层**：对本机**正在运行**的 0.2 服务（PID 34432，`127.0.0.1:19387`）发真实 HTTP + WebSocket 请求，并直接跑插件自己的代码与集成测试。

### 2.1 验证边界（重要：哪一层跑了、哪一层没跑）

| 层 | 实际怎么跑的 | 证明了什么 | **没有**证明什么 |
|---|---|---|---|
| DSH 服务端 | 本机运行中的 0.2.0-rc.2（`127.0.0.1:19387`），真实 HTTP POST + 真实 WebSocket 握手 | 服务端契约：认证、端点、参数、帧协议 | — |
| 插件的传输/探测模块 | esbuild 把 `src/transport/*`、`src/core/diagnose.ts` 打成 CJS，在**裸 Node** 里跑（补了 `window` 别名） | **插件真实代码**能连上真实 DSH；端口探测的真实行为与耗时 | 这些模块在 Obsidian 宿主（渲染进程）里的行为 |
| 单元测试 | vitest + `tests/mocks/obsidian.ts`（手写桩） | 逻辑正确性，含 `Notice` / `Setting` 的**路由**分支 | `Notice` / `Setting` 的**真实渲染** |
| **Obsidian 应用** | **已补测**（2026-10-01 下午，见 2.2）：装 Obsidian 1.13.7 + 空 vault，手动装入插件目录、写 `community-plugins.json` 启用、重启宿主观测 | **onload 真实执行、端口探测写回、状态栏、面板、@提及、流式输出、审批写文件、内联编辑** | 断线重连与探测的少数变体（见第 9 节未勾选项） |

**结论**：以上证据足以判定「**0.2 没有破坏本插件的连接契约**」，以及「**插件在真实 Obsidian 中对真实 DSH 可用**」。

### 2.2 Obsidian 内验收（2026-10-01 补测，覆盖 2.1 原先的空白）

环境：Obsidian 1.13.7（`/Applications/Obsidian.app`），空 vault `~/Develop/obsidian-warehouse`，DSH 桌面端 0.2.0-rc.2 运行于 `127.0.0.1:19387`。

安装方式：`main.js` / `manifest.json` / `styles.css` 复制进 `<vault>/.obsidian/plugins/dsh-bridge/`，写 `community-plugins.json` 启用，重启 Obsidian。

| # | 验收项 | 证据（客观、可复现） | 结果 |
|---|---|---|---|
| 1 | 插件加载不报错 | 插件目录无 `load-error.log` | ✅ |
| 2 | **端口自动探测（本次新增）** | 故意把 `data.json` 预置为错误端口 `http://127.0.0.1:3080`；打开 Obsidian 后 **16:48:07 自动改写为 `http://127.0.0.1:19387`**，并弹出「DSH 地址已自动切换」通知（用户目视确认） | ✅ |
| 3 | mux 长连接 | `Obsidian(渲染进程) ⇄ 127.0.0.1:19387 ESTABLISHED`，同一 socket 稳定 20s+（DSH 每 2s Ping，不回 Pong 会被断开） | ✅ |
| 4 | 状态栏 / ribbon / 面板 | 用户目视确认：状态栏「DSH 已连接」、ribbon bot 图标、面板可打开并列出会话 | ✅ |
| 5 | `@提及` + 流式输出 | DSH 侧 `session/list`：会话 `5be46326` 由 `blank=true` 变 `blank=false`，自动标题「示例笔记文件测试与总结」 | ✅ |
| 6 | 审批 + 写文件 | vault 内 `产物/总结.md` 于 16:53:27 生成，内容准确复述 `示例笔记.md` 的分节结构（证明 DSH 真读到了文件，且写操作经审批放行） | ✅ |
| 7 | 内联编辑 diff | `示例笔记.md` 于 17:06:12 被改写；且插件 `data.json` 落盘 `inlineEditSessionId: session-a3f42a90-…`（DSH 侧该会话标题「Obsidian 文本改写为更有冲击力」）——走的是插件自身流程而非手改 | ✅ |
| 8 | `session/create` 用 vault 路径 | 该 vault **不在** DSH 已登记工作区列表内，实测 `session/create {cwd: vault}` 仍返回 `ok=true`——DSH 不要求 cwd 预先登记 | ✅ |
| 9 | 断线重连（杀 DSH → 重启） | **未测**：DSH 同时承载本次会话，杀掉会中断 | ⏸ |
| 10 | 探测的少数变体（两个入口都开 / 远端地址不被顶掉） | **未测**：单元测试已覆盖逻辑，真机只跑了主路径 | ⏸ |

> 说明：第 2、5、6、7 项的证据是文件时间戳与 DSH 侧会话状态，不依赖主观描述。


---

## 3. 真机验证结果（关键证据）

环境：DSH 0.2.0-rc.2 桌面版运行中，监听 `127.0.0.1:19387`。

### 3.1 认证：插件自签 cookie 被 0.2 接受

```
cookie header: dsh-auth-…=v1.eyJ2ZXJzaW9uIjoxLCJ… (len 226)
```

- 无 cookie 请求 → `HTTP 401`（0.2 的 `BrowserAuth` 生效）
- 插件按 `~/.dsh/.credentials.yaml` → `records["client-connection/browser-session"].payload.secret` 自签 → **HTTP 200**

### 3.2 一元 RPC：全部通过，信封与 rpcId 回显正确

| 端点 | 插件发出的 args | 结果 |
|---|---|---|
| `session/list` | `{_request:{}}` | `ok=true`，`value={items:[…]}`（8 个会话） |
| `session/modelCatalog` | `{}` | `ok=true`，`value={default,routableProviders,groups,failures}` |
| `commands/list` | `{agentId}` | `ok=true`，`value=array(6)` |
| `goals/get` | `{agentId}` | `ok=true`，`value=undefined`（当前无目标） |
| `session/page` | `{request:{address,throughSeq:-1,maxMessages:3}}` | `ok=true`，`value={records,hasMore}` |

对照实验（证明服务端校验依旧严格、与插件注释一致）：

- `session/modelCatalog` 传 `{request:{}}` → `gateway/arguments-invalid`（"unexpected \"request\""）——与插件源码注释记录的行为完全一致
- 不存在的端点 → `HTTP 404 not found`——正是 `diagnose.ts` 把 404 归类为 `versionMismatch` 的依据

### 3.3 WebSocket 多路复用：三条流全部正常

| 流 | 实测结果 |
|---|---|
| `$events` | 首帧 `{"type":"ready","clientId":"…","host":{"home":"/Users/sky"}}`——`clientId` 可正常取到，审批应答（`$events/result`）的前提成立 |
| `session/control` | 首帧 `type=baseline`，随后 `type=projection` 帧 |
| `session/follow` | 首帧 keys = `type,header,cursor,records,hasMore,projections`——与 `types.ts` 的 `SessionFollowFrame` snapshot 形状逐字段一致 |

另：服务端每 2s 发一次 WS Ping，必须是活连接；插件的 `ws` 依赖会在协议层自动回 Pong，无需改动。

### 3.4 插件自身测试

- `DSH_URL=http://127.0.0.1:19387 npx vitest run tests/integration/liveServer.test.ts` → **2 passed**（默认不设 `DSH_URL` 时该文件整体 skip）
- 全量单测基线：`npm test` → **38 files / 554 passed / 2 skipped**，全绿

---

## 4. 逐条核对的契约（均未变更）

| 契约项 | 0.2.0-rc.2 实测/源码事实 | 本插件实现 | 判定 |
|---|---|---|---|
| 密钥位置 | `AUTH_RECORD_KEY = credentialKey("client-connection","browser-session")`，`kind: grant`，`payload.version: 1`，32 字节 | `auth.ts` 的 YAML 行解析取 `payload.secret` | ✅ 一致（本机凭据文件实测就是这个结构） |
| cookie 名 | `"dsh-auth-" + base64url(sha256(authority))`，`authority = new URL("http://"+host).host` | 同 | ✅ |
| cookie 值 | `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, body))>`，body 为 base64url 字符串本身 | 同 | ✅ |
| cookie 校验 | `issuedAt <= now < expiresAt` 且 `expiresAt-issuedAt <= cookieMaxAgeDays`（默认 30 天），`payload.authority === authority` | 12 小时寿命（严格小于任何合法配置的 1 天下限） | ✅ 结构安全 |
| RPC 信封 | `{type:'client-request',rpcId,method,payload:{args}}` → `{type:'server-response',rpcId,result}` | 同，且校验 rpcId 回显 | ✅ |
| 端点命名 | `<namespace>/<method>`，HTTP `POST /api/<endpoint>` | 同 | ✅ |
| 一元参数包装 | 描述符 `wire` 名（`request` / `_request` / `agentId` / 无参） | 同 | ✅ |
| WS 路径 | `REMOTE_STREAM_MUX_PATH = '/api/remote.mux'` | 同 | ✅ |
| 客户端帧 | `{type:'open',streamId,endpoint,payload}`、`{type:'cancel',streamId}` | 同 | ✅ |
| 服务端帧 | `{type:'item',streamId,value?}`、`{type:'end',streamId}`、`{type:'error',streamId,error:{code,message,details}}` | 同 | ✅ |
| `$events` 首帧 | `{type:'ready',clientId,host:{home}}` | 读 `clientId` | ✅（`host` 为新增字段，additive） |
| `$events/result` 三态 | `{kind:'next'} \| {kind:'result',value?} \| {kind:'rejected',error}` | `RemoteEventOutcome` 同 | ✅ |

**本插件使用的 18 个端点（0.2 全部存在，参数 wire 名一致）**：
`session/list`、`session/create`、`session/prompt`、`session/page`、`session/cancel`、`session/modelCatalog`、`session/selectModel`、`session/attachment`、`session/follow`(stream)、`session/control`(stream)、`commands/list`、`commands/execute`、`goals/{get,create,edit,pause,resume,complete,clear}`、`$events`、`$events/result`。

> 注意：`commands/list`、`goals/*` 的描述符里 `name` 是 `agent`（TS 参数名），但 **`wire` 仍是 `agentId`**——插件发 `{agentId}` 是正确的，不要被 TS 侧名字误导。

---

## 5. 唯一现实风险：端口（与 0.2 破坏性变更无关，但最常导致"连不上"）

### 5.1 事实（源码级确认）

| 启动方式 | 端口 | 证据 |
|---|---|---|
| **桌面 App**（本机即此路径） | **固定 `127.0.0.1:19387`** | `@deepseek-ai/dsh-desktop-host/lib/index.js`：`args: ["--no-open", "--port", "19387"]`，**无 env 覆盖** |
| `dsh --profile web` CLI（不带 `--port`） | **默认 `3080`** | `@deepseek-ai/dsh-web-app/cordis.patch.yml`：`port: !!js ctx.webStartup.port ?? 3080` |
| `dsh --profile web --port 0` | 由 OS 随机分配 | `dsh-web-app/lib/startup.js` 帮助文本 |

> ⚠️ 曾有一版调研结论称"0.2 代码里不存在 3080、端口一律动态"——**该结论有误**，已按上面源码事实更正。真实情况是：**桌面 19387 / CLI 默认 3080**，两者都不是随机端口（除非显式传 `--port 0`）。

### 5.2 为什么这会造成"连不上"

- 插件默认 `http://127.0.0.1:3080`（`src/settings.ts`），**桌面 App 用户不改设置就必然 `ECONNREFUSED`**，诊断会显示"DSH 似乎没有在运行"，而其实 DSH 正在运行。
- cookie 的名字与签名都绑定 `authority = host:port`，**换端口必须换 URL**；好在插件每次请求都按当前 `baseUrl` 重签 cookie，所以只要 URL 改对就自动可用，无需清缓存。

### 5.3 `DSH_WEB_URL` 不能用作自动发现（重要）

`dsh-web-app` 的 `surfaceContext` 只把 `DSH_WEB_URL` 注入**agent 自己的受管 bash 环境**（"expose `DSH_WEB_URL` to its shell commands"），**不注入 Obsidian 等第三方进程**。因此插件无法靠环境变量自动发现端口，必须由用户填 URL（或做端口探测/让用户一键切换）。

---

## 6. 0.2 的破坏性变更清单（对本插件的影响评估）

0.2.0-rc.1 / rc.2 的官方 Release Notes 中，**没有任何一条涉及本地 HTTP 端口、绑定地址、认证方式、cookie、WebSocket/RPC 协议或 `client-connection`**。

| # | 变更 | 对 dsh-bridge 的影响 |
|---|---|---|
| BC-1 | `time-context` / `schedule` / `ui-schedule` 三行从核心组合**整行移除**，改由可选包 `@deepseek-ai/dsh-experimental-schedule-bundle` 提供 | **无**。本插件不是 Cordis 插件、不 `inject` 这些服务 |
| BC-2 | desktop profile 的插件管理被放开（新增 `manageDesktopProfile`） | **无**。仅影响 DSH 插件生态，不影响外部 HTTP 客户端 |
| BC-3 | pi-ai 升级 0.87.1，**部分旧模型 ID 被移除**，已保存的模型选择可能需重选 | **轻微**。本插件的模型目录是运行时从 `session/modelCatalog` 拉的，不会硬编码失效；但用户在 DSH 侧保存的模型选择可能需要重选一次 |
| BC-4 | 插件市场的 13/99 个插件 peer 范围显式排除 0.2（如 `<0.2.0-0`） | **无**。本插件不是 DSH 插件市场里的 Cordis 包 |
| BC-5 | 桌面新增 OTLP 遥测行（仅 desktop profile 生效） | **无**（隐私提示层面可留意） |

**结论：没有一条破坏性变更会导致本插件连不上。**

---

## 7. 后续动作与执行状态

| # | 动作 | 状态 |
|---|---|---|
| 1 | **【高】README 兼容性矩阵补 0.2 行**（中英双份），并把"比已验证版本更新的 DSH"改为"比 0.2 更新（0.3+）" | ✅ 已执行（含前置条件/安装步骤的端口说明） |
| 2 | **【高】端口引导**：设置项描述与 `diag.*` 文案明确区分桌面 App `19387` / `dsh web` `3080` | ✅ 已执行（`src/i18n.ts` + `i18n.template.json`，5 条文案；键名未变，i18n 一致性用例保持通过） |
| 3 | **【中】诊断文案版本号**：`diag.versionMismatch` 从"支持 0.1.2 线与 0.1.5 线"改为含 0.2 线 | ✅ 已执行 |
| 4 | **【中】端口自动探测**：桌面 App 固定 19387、`dsh web` 默认 3080，用户不该为了端口手改设置 | ✅ 已执行（见下） |
| 5 | **【低】`hostProtocolVersion: 4`**：桌面运行时自描述字段，**不是 HTTP 协议协商** | ✅ 无需适配（已确认） |

**第 1–4 项的执行验证（2026-10-01）**：`npm test`（38 files / 565 passed / 2 skipped）＋ `npm run lint`（0 问题）＋ `npm run build`（tsc + esbuild production）全部通过；`main.js` 已随构建更新（仓库跟踪的发布产物，CI 有漂移哨兵）。

### 7.1 端口自动探测的实现（第 4 项）

规则（`src/core/diagnose.ts` + `src/main.ts`）：

1. **配置地址能连上就尊重它**——用户手填的地址可能是刻意的（例如同时开着桌面 App，但就是要连 CLI 的 3080）。
2. 连不上才按 **桌面优先** 探测候选（`candidateDshUrls`：19387 → 3080，并去掉与配置重复的那个），命中即**落盘 + 提示**。
3. **只在配置地址是 loopback 时给候选**（19387/3080 只对 loopback 成立，远端地址不该被本地端口顶掉）；非法地址不猜。
4. `localhost` 也算 loopback——DSH 只绑 127.0.0.1，而 macOS 上 `localhost` 可能先解析到 ::1，候选用 `127.0.0.1` 正好把这种「地址写法导致的连不上」一起修掉。
5. 判据是**一次真实 `session/list`**（同时穿过认证与 RPC 两层），不是 TCP 连通性——端口上蹲着别的程序不会被误判。
6. **候选并发探测**：最坏耗时 = 1 × 超时（3s），而不是 N × 超时；探测抛错一律吞掉，绝不拖挂插件加载。
7. 设置面板的「诊断」按钮失败后也会走同一条探测：覆盖 **Obsidian 先起、DSH 后起** 的盲区（那时 onload 什么也探不到）。命中后提示「重启 Obsidian 或重新启用插件后生效」——正式客户端是用旧地址构造的，无法就地热换。

**真机验证**（对本机运行中的 0.2.0-rc.2，用插件自身模块跑）：

| 设置里的地址 | 探测结果 | 耗时 |
|---|---|---|
| `http://127.0.0.1:3080`（默认值，桌面 App 在跑） | 3080 `ECONNREFUSED` → **自动切到 `http://127.0.0.1:19387`** | 4ms |
| `http://127.0.0.1:19387`（正确） | 配置地址即可用，**不再探测候选** | 3ms |
| `http://127.0.0.1:8080`（自定义 loopback） | 两个候选都试 → **选中 19387（桌面优先）** | 1ms |

**已知残余缺口**：探测只在「配置地址连不上」时发生。若 Obsidian 先启动、DSH 后启动，onload 那次探不到任何东西，需要用户在设置里点一次「诊断」自动修复（或重启 Obsidian）。要彻底消除得支持就地重建客户端，涉及 runtime 全量重建与视图引用，收益不抵复杂度，暂不做。



---

## 8. 置信度与未核实项

**已核实（一手，可采信）**：第 3、4、5.1 节全部结论，均来自 0.2.0-rc.2 解包源码 + 本机运行中的服务实测 + 插件自身代码运行结果。

**未核实（不编造）**：

- 0.1.x 桌面版是否也用 19387（CDN 上 0.1.x 安装包已下线，本机无旧版本缓存，无法字节比对）。因此"19387 是 0.2 新引入的"**不能断言**；但"桌面 App 用 19387"这一**当前事实**已由源码 + 运行进程双重确认。
- 截至 2026-10-01，**没有 0.2.0 正式版**，只有 `0.2.0-rc.1`（09-28）与 `0.2.0-rc.2`（09-29）；`npm dist-tags.latest = 0.2.0-rc.2`。0.1.x 最后一版为 `0.1.7-rc.2`。
- 官方仓库**没有独立 `CHANGELOG.md`**（raw 404），变更记录只在 GitHub Releases。
- 未找到任何"0.2 导致第三方插件连不上"的官方或社区具体报告。

**联网检索受限说明**：本次 `web_search` 工具因缺 `DEEPSEEK_API_KEY` 不可用，社区深挖靠 `web_fetch` / `curl` 直取官方更新源、npm registry 与 GitHub Releases atom feed 完成；`gh` CLI 未登录、GitHub API 匿名限额耗尽，X/Reddit/V2EX 未覆盖。

### 一手来源

- 官方更新源：<https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml>
- 官方 Release：[v0.2.0-rc.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.1)、[v0.2.0-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2)、[releases.atom](https://github.com/deepseek-ai/deepseek-harness/releases.atom)
- npm：[`@deepseek-ai/dsh`](https://registry.npmjs.org/@deepseek-ai/dsh)、[`@deepseek-ai/dsh-client-connection`](https://registry.npmjs.org/@deepseek-ai/dsh-client-connection)
- 随包官方文档：`node_modules/@deepseek-ai/dsh-client-connection/README.zh.md`（浏览器认证与信任边界）、`dsh-api-gateway/README.zh.md`（Remote 与 mux 协议）、`dsh-web-app/README.zh.md`（`DSH_WEB_URL` 语义）

### 复现命令

```bash
# 1) 确认本机 DSH 版本与端口
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "/Applications/DeepSeek Harness.app/Contents/Info.plist"
lsof -nP -iTCP -sTCP:LISTEN | grep -i deepseek

# 2) 跑插件自带的真机集成测试（指向运行中的 DSH）
DSH_URL=http://127.0.0.1:19387 npx vitest run --config vitest.config.mjs tests/integration/liveServer.test.ts

# 3) 全量单测基线
npm test
```

---

## 9. 手工验收清单（2026-10-01 已执行）

**执行结果**：已在 Obsidian 1.13.7 + 空 vault `~/Develop/obsidian-warehouse` 上跑过一遍，逐项证据见 **2.2**。
勾选状态：✅ 已过 / ⏸ 未测（附原因）。**未勾选项都不影响「0.2 兼容」这个结论**，只是覆盖度缺口。

### 准备

1. 装 Obsidian ≥ 1.7.2（桌面端），建/开一个 vault。
2. `npm install && npm run build`，把 `main.js`、`manifest.json`、`styles.css` 复制进 `<vault>/.obsidian/plugins/dsh-bridge/`。
3. 启动 DSH **桌面 App**（或 `dsh --profile web`），记下实际端口。

### 协议与连接（对应第 3、4 节）

4. ✅ 启用插件 → 状态栏「DSH 已连接」（目视确认）。
5. ✅ 打开面板 → 会话列表正常；发消息 → 流式输出正常（DSH 侧会话由 `blank=true` 转 `blank=false` 并自动命名）。
6. ✅ 让 DSH 写文件 → 审批卡片出现 → 批准后 DSH 写出 `产物/总结.md`（内容证明它真读到了源文件）。
7. ✅ 选中文字走内联编辑 → 词级 diff 预览 → 应用后正文被替换；插件 `data.json` 落盘了 `inlineEditSessionId`。
8. ✅ **断线重连已验**（2026-10-01 17:26–17:31，用本地 TCP 代理造可控入口，避免杀掉承载本次会话的 DSH）：
   - 杀掉入口 → 状态栏变「DSH 重连中…」；**重启入口 → 0.13 秒恢复**，状态栏回到「DSH 已连接」。
   - ❌ **同时发现一个状态栏 Bug**：断联 35 秒后仍显示「DSH 重连中…」，**从未**显示设计中的「DSH 未运行（连接被拒绝）」。详见 9.1。

### 端口自动探测（对应第 7.1 节，本次新增）

9. ✅ **主路径已验**：故意预置错误端口 3080 → 打开 Obsidian → 16:48:07 自动改写为 19387，并弹出切换通知（目视确认）。
10. ✅ **真机已验**：配置地址可用时保持不动——插件连的是配置里的 3080，未被切到 19387。
11. ✅ **真机已验**（17:29:37）：19387 与 3080 **两个入口都活着**（3080 走真实认证 RPC 2/2 通过），配置地址设成死端口 8080 → 选中 **19387（桌面优先）**；截图抓到切换通知原文。
12. ✅ **真机已验**：配置成远端 `http://192.168.1.5:9999` → `data.json` 未被改写（mtime 停在我写入的时刻），状态栏「DSH 重连中…」——远端地址没被本地端口顶掉。
13. ⏸ 「Obsidian 先起、DSH 后起」→ 点「诊断连接」自动修复——单测覆盖，真机未复跑（本机 19387 始终活着，无法构造该场景）。

### 9.1 状态栏 Bug：已修 + 已真机复验（2026-10-01 17:35）

**现象**：DSH 断联后状态栏停在「DSH 重连中…」，`main.statusNotRunning`（「DSH 未运行（连接被拒绝）· 重连中…」）**永远不会显示**——而这正是 `main.ts` 注释里写的"最高频的『为什么连不上』"。

**根因**（时序竞态，`src/transport/muxStream.ts`）：
1. socket 断开 → `onLost()` → `emitState("reconnecting")`：此刻 `refusedSinceOpen` 仍为 `false`，`main.ts` 的 `onState` 把状态栏算成「重连中…」。
2. 随后重试失败得到 `ECONNREFUSED` → 置 `refusedSinceOpen = true`——但**状态值没有变化**。
3. 下一次 `connect()` 再调 `emitState("reconnecting")` → 被去重（`lastState === state`）→ **回调不再触发**，状态栏不再重算。

**修复**（`src/transport/muxStream.ts`，+12/-1）：
- `refusedSinceOpen` 由 `false → true` 翻转时记下 `firstRefusalSinceOpen`，并调用新增的 `notifyState()`——绕开 `emitState` 的去重，把「状态值没变、但 UI 取词依据变了」这件事通知出去。
- `notifyState()` 传当前状态（`lastState ?? "reconnecting"`）。消费方按状态字符串分支，只有 `connected` 有副作用，重复收到同一个值是安全的（已在方法注释里写明）。

**验证（三层）**：
1. **单元测试**：新增「ECONNREFUSED 后必须重新通知状态，否则状态栏读不到 serviceDown」——断言"必须有一次回调时 `serviceDown` 已为 true"。**临时撤掉修复后该用例确实变红**（`timeout waiting for 带 serviceDown=true 的状态通知`），修复后绿。
2. **全量门禁**：`npm test` 567 passed / 2 skipped（较修复前 +1）、`npm run lint` 0 问题、`npm run build` 通过。
3. **真机复验**（同一套 TCP 代理脚手架）：把修好的产物装进 vault → 连上代理出口 3080 → 杀代理 → **约 5 秒内**状态栏变为 `DSH 未运行（连接被拒绝）· 重连中...`（截图确认）。修复前同样操作 35 秒仍是「DSH 重连中…」。


### 回归（确认这次改动没碰坏别的）

14. ✅ 设置面板其余项读写正常（`data.json` 被正确合并 / 回写，见 2.2 第 2 项）。
15. ✅ 全程无 `load-error.log`。

