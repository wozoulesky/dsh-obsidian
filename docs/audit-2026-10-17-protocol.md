# DSH 0.2.1-rc.2 协议兼容增量核查（dsh-bridge v0.1.9）

核查日期：2026-10-17 / 2026-10-18
核查对象：本机 **DSH 0.2.1-rc.2**（桌面版，PID 55960，监听 `127.0.0.1:56516`）
基线文档：[dsh-0.2-compat-audit-2026-10-01.md](dsh-0.2-compat-audit-2026-10-01.md)（针对 0.2.0-rc.2 的全量核查）
本次性质：**增量核查** —— 只判定 0.2.0-rc.2 → 0.2.1-rc.2 之间的差异，已由基线文档确认过的结论不重复论证。

---

## 0. 一句话结论

> **协议级可用，但不是「只差端口」。**
>
> - 认证、RPC 信封、`/api/remote.mux` 帧协议、插件所用 **21 个线上端点**（18 个一元 RPC + 3 条 WS 流）的存在性与 **wire 参数名全部不变**，`dsh-api-gateway` 的 `stream-protocol` 两个版本**字节完全一致**。已用插件自身代码（`DshCookieAuth` + `DshClient` + `RemoteMuxTransport`）对运行中的 0.2.1-rc.2 打通全部一元 RPC 与三条 WS 流。
> - **但**桌面端 0.2.1 起改为 `--port 0`（系统分配端口），插件的端口自动探测写死了 `19387/3080` 两个候选，**两个候选在 0.2.1 上都必然是死的** → 用户升级后插件会连不上、且自动探测救不回来，「只差端口」这个说法低估了严重性：**端口从固定值变成了不可预测值**。
> - 另有一处**早已存在、与 0.2.1 无关**的真实数据契约缺口：`session/control` 的 baseline 自 **0.1.7-rc.1** 起就没有 `queues`/`jobs` 字段了，而插件 `store.applyControlFrame` 仍无条件 `Object.entries(frame.value.queues)` → **每次收到 baseline 必抛 TypeError**。这个异常被 `globalStreams` 的 `try/catch` 静默吞掉，导致 `session/control` 流**首帧即终止、永不重开**（详见第 5 节）。

---

## 1. 结论速览（每条都有源码路径或实测证据）

| # | 问题 | 结论 | 证据 |
|---|---|---|---|
| 1 | 0.2.1 有没有改认证（cookie 名/签名/payload 版本）？ | **没有**。`COOKIE_PREFIX`/`COOKIE_PAYLOAD_VERSION`/`STORED_SECRET_VERSION`/`AUTH_RECORD_KEY`/`cookieName`/`signature` 逐行一致 | 见 3.1 逐行 diff |
| 2 | cookie 值格式变了吗？ | **没变**。仍是 `v<version>.<body>.<sig>`，version=1；0.2.1 只是**新增接受** `v2`（服务端解码放宽），旧 `v1` 仍被接受 | `dsh-client-connection-0.2.1-rc.2/lib/index.js:decodeCookie`（`version !== "v1" && version !== "v2"`） |
| 3 | 请求 audience / authority 规则变了吗？ | **实质没变**。`requestAudience` 在 0.2.1 被抽成独立函数（0.2.0 内联），HTTP 下仍返回 `url.host`（host:port）；**新增**的只是 HTTPS 下返回 `url.origin` + cookie 带 `Secure` | 见 3.2 |
| 4 | Host/Origin 防火墙变严了吗？ | **新增了 bindHost 通道**，但 loopback 请求仍放行。插件连 `127.0.0.1`，落在 `isLoopbackHostname` → 不受影响 | `isTrustedApiRequest(request, trustedHosts, bindHost?, protocol?)` |
| 5 | `/api/remote.mux` 路径变了吗？ | **没变**，且 `stream-protocol.js` 两版 **byte-identical** | 见 3.3 `cmp` 输出 |
| 6 | WS 帧 `open/item/end/error/cancel` 变了吗？ | **完全没变** | `stream-protocol.d.ts` diff 为空 |
| 7 | `{type:'client-request'/'server-response'}` 信封变了吗？ | **没变**。实测信封校验仍按 rpcId 严格比对 | 见 3.4 真机 |
| 8 | `$events` 首帧 ready 形状变了吗？ | **没变**：`{type:"ready", clientId, host:{home}}` | 见 3.5 真机 |
| 9 | 插件用的端点在 0.2.1 还在吗？ | **全部在**。21 个（18 一元 + 3 流）全部命中 0.2.1 的 144 端点表 | 见 4.1 |
| 10 | 这些端点的 wire 参数名变了吗？ | **全部没变**。对 `dsh-api-session-controller`/`dsh-commands`/`dsh-goal` 三个包做描述符级 diff，**paramDiffs = 0** | 见 4.2 |
| 11 | 0.2.1 新增了哪些端点？ | 新增 14 个（`session/rename`、`session/search`、`session/projections`、`session/fork`、`session/updateQueue`、`session/openWorkspacePath`、`session/workspacePathApplications`、`session/canOpenWorkspacePath`、`session/initializeDefaultModel`、`skills/list`、`permissionPresets/catalog`、`agentPresets/list`、`remoteAccess/follow`、`workspace/follow` 等） | 见 4.3 |
| 12 | 桌面端端口还固定吗？ | **不再固定**。0.2.1 起 `dsh-desktop-host` 传 `--port 0`，由 OS 分配 | `dsh-desktop-host-0.2.1/lib/index.js:235-240`（`args` 含 `"--port", "0"`）；`dsh-host-webserver` README.zh.md:39 定义 `port: 0` 语义 |
| 13 | 插件能自动发现新端口吗？ | **不能**。写死 `19387`/`3080` 两个候选，都是固定端口假设 | `src/core/diagnose.ts:94-95` |
| 14 | 「网关授权与连接机制」会挡住第三方 HTTP 客户端吗？ | **不会**。新机制只约束**非 owner Peer**；用 launch token 换来的 operator 拿到 `principal:{kind:'owner'}`，owner 跳过全部 `decide()` 检查 | 见 6.1 |
| 15 | `session/control` baseline 形状变了吗？ | **早于 0.2.1 就变了**（0.1.7-rc.1 起只剩 `projections`），但插件仍按 `{queues,jobs,projections}` 读 → **必崩** | 见 5.1 / 5.2 |
| 16 | 插件代码实跑通过吗？ | **一元 RPC 与 3 条流全通**；唯独 `session/control` 首帧崩（问题 15） | 见 3.4 / 5.2 |
| 17 | 集成测试通过吗？ | `DSH_URL=http://127.0.0.1:56516 vitest run tests/integration/liveServer.test.ts` → **2 passed** | 见 3.6 |
| 18 | 全量门禁 | 集成测试 **2 passed**；全量套件 567 passed / 2 skipped。但注意 `muxStream` 那 1 failed **不是抖动**，是确定性并发 bug（与 0.2.1 无关，见 3.6 与第 12 节） | 见 3.6 / 第 12 节 |

**回答验收问题「协议级可用、还是只差端口」**：
**协议级可用** —— 除第 15 条的既存缺陷外，0.2.0→0.2.1 没有发生任何破坏性协议变更。
**但「只差端口」是错的** —— 端口从「两个已知固定值」变成「OS 随机分配、无落盘、无 stdout」，插件现有探测策略在 0.2.1 上是**结构性失效**，不是一个配置项能修的。详见第 7 节。

---

## 2. 核查方法与验证边界

### 2.1 四层证据

| 层 | 做法 | 证明什么 |
|---|---|---|
| 静态层 A | 手写 asar 解析器读 `app.asar`（182 MB，18 312 个文件），建索引到 `/tmp/dsh021/asar-index.json`，按需提取 | 0.2.1-rc.2 的实现真身 |
| 静态层 B | 从 npm registry 下载 0.2.0-rc.2 与 0.2.1-rc.2 两版 tarball，**逐包 diff** | 精确到行的增量差异（比读 release notes 可靠） |
| 协议层 | 解析两版 `typert.host.js` 的 `InvocationDescriptor`（键名、`wire:` 名、`mode:'stream'`、`uplink`），做集合与参数级 diff | 端点/wire 契约是否漂移 |
| 真机层 | 用 esbuild 打包插件真实源码（`src/transport/{auth,client,muxStream}.ts` + `src/core/store.ts`）成 CJS，在裸 Node 里对运行中的 56516 发真实请求 | 插件自身代码对真实 0.2.1 的行为 |

> asar 解析注意：头是 **pickle 嵌套**，`offset 0..8` 是 `[4, headerSize]`，`offset 8` 起才是内层 pickle（`uint32 payloadSize` + `uint32 strLen` + JSON）。文件内容 base = `8 + headerSize`。不能用普通 grep/cat 读。

### 2.2 没有证明的部分

- **Obsidian 宿主内**的行为未复测（本次只测协议与数据契约；宿主行为见基线文档 2.2）。
- 未测 Windows/Linux 桌面行为（`--port 0` 是跨平台改动，macOS 已确认）。
- 未做 `session/prompt` 端到端（会真的消耗模型调用并污染会话），只做了端点存在性 + 参数名 + 负例校验。

---

## 3. 认证与传输：逐项增量复核

### 3.1 cookie 认证：签名逻辑未变（关键证据）

对 `dsh-client-connection` 的 0.2.0-rc.2 与 0.2.1-rc.2 做具名符号逐行比对：

| 符号 | 结果 |
|---|---|
| `AUTH_RECORD_KEY` | **same** |
| `COOKIE_PREFIX`（`"dsh-auth-"`） | **same** |
| `COOKIE_PAYLOAD_VERSION`（1） | **same** |
| `STORED_SECRET_VERSION`（1） | **same** |
| `TOKEN_QUERY`（`"token"`） | **same** |
| `SECRET_BYTES`（32） | **same** |
| `DAY_MILLISECONDS` | **same** |
| `cookieName()` | **same**（`"dsh-auth-" + base64url(sha256(authority))`） |
| `encodeBase64Url` / `decodeBase64Url` | **same** |
| `signature()` | **same**（`hmac-sha256(secret, body)`） |
| `encodeCookie()` | **DIFFERS**（`v1.` → `v${payload.version}.`，payload.version 仍为 1 → 线上输出 `v1.` 不变） |
| `decodeCookie()` | **DIFFERS**（新增接受 `v2`，`v1` 仍接受） |
| `sessionCookie()` | **DIFFERS**（新增 `secure` 参数，仅 HTTPS 加 `; Secure`） |
| `requestAudience()` | **DIFFERS**（由内联抽为函数；HTTP 分支仍 `url.host`） |
| `CONNECT_PATH` | **新增** `"/connect"`（launch-token → operator 换发路由） |

**结论**：插件的 `src/transport/auth.ts` 自签 `v1.<body>.<sig>` cookie，在 0.2.1 上**依然被接受**。真机验证：

```
COOKIE_NAME dsh-auth-KRFlZ38q2n6BEaK... len 226
session/list   ok=true
```

cookie 名长度 52 = `"dsh-auth-"`(9) + base64url(sha256) 43 字符，与插件 `cookieName()` 计算一致。

### 3.2 Host/Origin 防火墙：新增 bindHost，但 loopback 不受影响

0.2.1 把签名改成：

```
isTrustedApiRequest(request, trustedHosts, bindHost?, protocol?)
```

新增 `bindHost`（监听地址字面量，任意端口放行）与 `isRemoteAuthority()` 导出。判定顺序仍是：

1. hostname 是 loopback（`localhost` / `[::1]` / `127/8`）→ 放行
2. hostname === bindHost 字面量 → 放行
3. hostname ∈ trustedHosts → 放行
4. 否则 403

插件连 `http://127.0.0.1:<port>`，走第 1 条。**不受影响**。

### 3.3 WS mux 路径与帧协议：字节级完全一致

```
$ cmp dsh-api-gateway-0.2.0-rc.2/lib/types/stream-protocol.js \
      dsh-api-gateway-0.2.1-rc.2/lib/types/stream-protocol.js
IDENTICAL
```

常量全部一致：

```
REMOTE_STREAM_MUX_PATH      = '/api/remote.mux'
REMOTE_EVENT_STREAM_ENDPOINT = '$events'
REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'
REMOTE_EVENT_STREAM_PAYLOAD  = { args: {} }
REMOTE_EVENT_STREAM_READY    = { type: 'ready' }
```

`stream-protocol.d.ts` diff 为空 → `open/item/end/error/cancel` 帧形状与信封未变。

### 3.4 真机：一元 RPC 全通（含负例）

用插件打包产物对 56516 实跑：

```
session/list                        OK  ok=true obj{items}
session/modelCatalog                OK  ok=true obj{default,routableProviders,groups,failures}
session/page                        OK  ok=true obj{records,hasMore}
commands/list {agentId}             OK  ok=true array(6)
goals/get {agentId}                 OK  ok=true undefined
```

**参数名严格性负例**（证明 wire 校验仍按 descriptor 精确匹配，插件注释里的契约仍然成立）：

```
session/modelCatalog {request:{}}   → gateway/arguments-invalid: unexpected "request"
session/list {request:{}}           → gateway/arguments-invalid: missing "_request"; unexpected "request"
commands/list {request:{agentId}}   → gateway/arguments-invalid: missing "agentId"
goals/get {agent}                   → gateway/arguments-invalid: missing "agentId"
session/doesNotExist                → HTTP 404
```

goals 全生命周期（create → edit → pause → resume → complete → clear）在真机上逐步骤全部 `ok`，
`goalGet` 返回形状 `{id, revision, objective, phase, maxGoalRounds, roundsStarted, createdAt, updatedAt, activation}`
与插件 `GoalView extends GoalProjection + activation` 完全吻合（测试后已 `goals/clear` 清理）。

### 3.5 真机：三条 WS 流全通

```
$events 首帧      {"type":"ready","clientId":"e194e5a9-...","host":{"home":"/Users/sky"}}
session/control   baseline, projection 两帧
session/follow    first type=snapshot keys=type,header,cursor,records,hasMore,projections
                  （records=33，projections=obj{asOfSeq,values}）
session/follow + assistantStream:true  → 首帧多一个 assistantStream 字段（能力位仍在）
```

`session/follow` 的 args 必须是 `{request:{...}}`（与插件 `sessionManager.ts:194` 一致）；传平铺会得到
`args fields do not match the descriptor: missing "request"`。

### 3.6 真机门禁

```
$ DSH_URL=http://127.0.0.1:56516 ./node_modules/.bin/vitest run tests/integration/liveServer.test.ts
✓ tests/integration/liveServer.test.ts (2 tests) 391ms
Test Files 1 passed | Tests 2 passed
```

全量套件会稳定/间歇出现 1 failed，失败固定是
`tests/transport/muxStream.test.ts > open 发 open 帧（endpoint/payload），收 item 帧产出 value`，
耗时 `15009ms`——**正好撞上 `vitest.config.mjs` 的 `testTimeout: 15000`**。

> **这不是「测试抖动」，是传输层的确定性并发 bug（已由 Lead 定位根因并验证修法，详见第 12 节）。**
> 表现为「时红时绿」只是因为它依赖一个**握手时序窗口**：命中窗口必失败，未命中则侥幸通过。
> 因此**不要**用 `singleFork` / 分片 / 抬高超时去「治」它——那只会掩盖一个真实的生产缺陷。

> 另注：不加 `DSH_URL` 时，集成测试因默认 `3080` 不可达而 **2 skipped**（不失败）。这本身就是第 7 节问题的旁证。

---

## 4. 端点与 wire 参数：按包的描述符级 diff

### 4.1 插件使用的 21 个线上端点，0.2.1 全部存在

从 0.2.1-rc.2 的 144 个 `InvocationDescriptor` 中，插件实际用到的 **21 个**全部命中（18 个一元 RPC 经 `DshClient.call`，3 条流经 `DshClient.openStream`）：

| 类别 | 端点 | 0.2.1 存在 |
|---|---|---|
| session | `list` `create` `prompt` `page` `cancel` `modelCatalog` `selectModel` `attachment` | ✅ |
| session 流 | `follow`（stream） `control`（stream） | ✅ |
| commands | `list` `execute` | ✅ |
| goals | `get` `create` `edit` `pause` `resume` `complete` `clear` | ✅ |
| 事件 | `$events`（stream） `$events/result`（unary） | ✅ |

`$events/result` 存在性负例（伪 clientId）：`gateway/internal: Remote event result identifies no active event stream`
→ 端点存在且校验生效。

### 4.2 wire 参数名：零差异

对承载这些端点的三个包做 0.2.0-rc.2 vs 0.2.1-rc.2 描述符 diff（统一解析 `'ns/method': {…}` 与
`id: '@deepseek-ai/…#ns/method'` 两种代码生成格式，抽取每个 parameter 的 `wire:` 名）：

| 包 | 端点数（两版） | 参数差异 |
|---|---|---|
| `dsh-api-session-controller` | 21 / 21 | **0** |
| `dsh-commands` | 2 / 2 | **0** |
| `dsh-goal` | 7 / 7 | **0** |

具体形状（0.2.1 描述符 + 真机双重确认）：

```
session/list              { _request: {} }
session/create            { request: {...} }
session/prompt            { request: {...} }
session/page              { request: {...} }
session/cancel            { request: {...} }
session/modelCatalog      {}                    // 无参数
session/selectModel       { request: {...} }
session/attachment        { request: {...} }
session/follow (stream)   { request: {...} }
session/control (stream)  {}
commands/list             { agentId }           // 平铺 lookup wire
commands/execute          { agentId, line, submittedAttachments }
goals/*                   { agentId, ... }      // 平铺
$events (stream)          {}
$events/result            { clientId, eventId, outcome }
```

### 4.3 0.2.1 新增端点（144 vs 0.2.0 的 140）

```
新增 session 域：rename / search / projections / fork / updateQueue /
                openWorkspacePath / workspacePathApplications /
                canOpenWorkspacePath / initializeDefaultModel
新增其它域：    skills/list、permissionPresets/catalog、agentPresets/list、
                remoteAccess/follow（stream）、workspace/follow（stream）、job/*
```

**插件所用端点中，0.2.1 删改的**：无（21 个全在，且参数名零差异）。

---

## 5. ⚠️ 既存真实缺陷：`session/control` baseline 缺 `queues`/`jobs`

这一条**不是 0.2.1 引入的**，但它是本次核查发现的唯一「真会让功能坏掉」的问题，必须单列。

### 5.1 事实：baseline 只剩 projections，且可追溯到 0.1.7-rc.1

用 npm registry 逐版本二分 `SessionControlBaseline`：

| 版本 | baseline 字段 |
|---|---|
| 0.1.2-alpha.2 | `queues` + `jobs` + `projections` |
| 0.1.5-rc.1 | `queues` + `jobs` + `projections` |
| 0.1.6-alpha.2 | `jobs` + `projections`（queues 已删） |
| **0.1.7-rc.1** | **只有 `projections`** |
| 0.2.0-rc.2 | 只有 `projections` |
| **0.2.1-rc.2** | **只有 `projections`** |

0.2.1-rc.2 真机 baseline 实测：

```
baseline.value keys: projections          ← 没有 queues，没有 jobs
projections entries: 8
```

### 5.2 后果：插件 `applyControlFrame` 每次必抛

`src/core/store.ts:181`：

```ts
for (const [sessionId, items] of Object.entries(frame.value.queues)) {
```

`frame.value.queues` 是 `undefined` → `Object.entries(undefined)` 抛
`TypeError: Cannot convert undefined or null to object`。

用插件真实 `SessionStore` 对真机 baseline 实跑：

```
applyControlFrame THREW on frame 1 type baseline : Cannot convert undefined or null to object
WITH VIEW: THREW on baseline : Cannot convert undefined or null to object
```

而 `src/core/globalStreams.ts:64-71` 的消费循环是：

```ts
try {
  const stream = await this.client.openStream("session/control", {}, signal);
  for await (const frame of stream) { this.store.applyControlFrame(frame); }
} catch { /* 静默结束；重连由 onState("connected") 触发重开 */ }
```

→ 异常被吞，循环退出，**`session/control` 流在第一帧后永久死亡**。后果：

- 队列（发送中/排队消息）永远不更新；
- 后续 `projection` 增量帧全部收不到 → 依赖 control 流播种的投影（含未打开会话的 title 等）不再刷新；
- 只有重连（`onState("connected")`）会重开，但开完第一帧又死 → 每次重连后最多活一帧。

> 注：`session/follow` 的 snapshot 里也带 `projections`，所以「打开中的会话」的 title/plan/todos 仍能靠 follow 播到；
> 崩的是 **control 流的全局播种与增量通道**。这也解释了为什么该缺陷能长期潜伏而不被用户立刻发现。

### 5.3 修复方向（不在本次改动范围，仅记录）

最小改动：把 `store.ts:181` 改为对可选字段做防御：

```ts
const queues = frame.value.queues ?? {};
for (const [sessionId, items] of Object.entries(queues)) { ... }
```

并把 `SessionControlFrame` 类型（`src/transport/types.ts:405-414`）改成 `queues?`/`jobs?`。
另可顺带用 0.2.1 的 `session/updateQueue`（第 8 节）替代已经消失的服务端队列流。

---

## 6. 「网关授权与连接机制」到底改了什么（0.2.1-rc.1 重点条目）

这条 release note 最容易被误读成「第三方客户端要被授权挡住了」。实际核查：

### 6.1 新增的是**非 owner 的访问控制**，owner 完全不受影响

- 新包 `@deepseek-ai/dsh-api-remote-access` **在 0.2.1 才首发**（npm 版本历史：`0.2.1-alpha.3` 起；0.2.0 无此包）。
- `dsh-api-gateway` 新增 `lib/types/access.js`（`callResources` / `eventResources`），`TypertGatewayService` 的 `dispatchRpc` / `openStream` 里：

```js
if (request.peer.principal.kind !== "owner") { /* ... remoteAccess.decide(...) ... */ }
```

**owner 直接跳过整个 `decide()`**。
- `Peer` 的 `principal` 在 `publishPeer()` 里恒为 `{ kind: "owner" }`；
  `remoteAccess/follow` 对 owner 返回 `{ type: 'baseline', owner: true }`（真机实测确认）。

### 6.2 新增的 `/connect` launch-token 换发（可选路径，不是强制）

`dsh-client-connection` 0.2.1 新增：

```
CONNECT_PATH = "/connect"
authorizeConnect(req, res, secure, publish)
  GET /connect?token=<launchToken>&interactions=answer|none
  → 303 到 ./api/remote.mux，并 Set-Cookie 一个 v2 operator 凭据
```

`interactions`：
- `"answer"` → 该 Peer 参与 forwarded waterfall（这是 `$events` + `$events/result` 的前置条件）
- `"none"`（缺省）→ 只读，不能应答 waterfall

**对插件的意义**：插件走的是**既有路径**——直接用 `~/.dsh/.credentials.yaml` 里的 `browser-session` secret
自签 `v1` cookie。这条路径 0.2.1 **仍然有效且仍是 owner 身份**（真机 `session/list` ok、`$events` ready、
`$events/result` 可应答已验证）。

> 换句话说：`/connect` 是给「没有 credentials 文件读权限」的第三方进程（比如浏览器里的非 Electron 客户端）
> 准备的新入口，**不是插件必须迁移的东西**。但它是一个值得记录的备选认证路径。

### 6.3 TLS / trustedHosts 相关（不影响本插件）

0.2.1 新增 `--tls-cert/--tls-key` 与 `--public-url`，并在 HTTPS 下：

- cookie 加 `; Secure`
- `requestAudience` 返回 `url.origin`（含 scheme）而非 `url.host`

插件只支持 `http`/`https` 的 `baseUrl`，若用户配 HTTPS 远端地址，`authorityOf()` 返回 `url.host`（不含 scheme）
→ 与服务端 HTTPS 分支的 `url.origin` **不匹配**，cookie 名会对不上。
**但**：这是远端/TLS 场景，插件当前定位是本机 loopback。列为已知限制，非当下 blocker。

---

## 7. 端口：从「固定双值」变成「系统随机」（本次最需要行动的变更）

### 7.1 事实链

1. 0.2.1 release note：「桌面端默认使用系统分配的端口，避免 Windows 保留端口范围导致应用无法启动」。
2. 源码：`@deepseek-ai/dsh-desktop-host` 的 `main()` 里

```js
// dsh-desktop-host-0.2.1/lib/index.js:235-240
args: [
  "--no-open",
  "--host", "127.0.0.1",
  "--port", "0",      // ← 0 = 请求 OS 分配；0.2.0 此处为硬编码 19387
]
```

   `port: 0` 语义由 `dsh-host-webserver` 定义：「`port` 为 0 时请求 OS 分配端口；之后用
   `ctx.webServer.port` 读取正在监听的端口」（其 README.zh.md 第 39 行）。0.2.0 时这里是硬编码
   `--port 19387`（基线文档第 5 节记录）。
3. 真机：`lsof` 显示 `DeepSeek 55960 127.0.0.1:56516 (LISTEN)`；`19387` 与 `3080` 均 `connection refused`。

### 7.2 插件现状为何必然失效

`src/core/diagnose.ts:94-95`：

```ts
export const DSH_DESKTOP_URL = "http://127.0.0.1:19387";
export const DSH_CLI_URL = "http://127.0.0.1:3080";
```

`candidateDshUrls()` 只产出这两个候选。0.2.1 桌面端的实际端口既不是 19387 也不是 3080，
且**每次启动都可能不同** → `autoSwitchDshUrl()` 必然返回 `null` → 插件保持配置里的死地址 →
状态栏「DSH 未运行」，用户在设置面板手改也**无法持久**（下次启动又变）。

> 顺带：`DSH_WEB_URL` 环境变量（本机为 `http://127.0.0.1:56516`）是 DSH 注入给**工具子进程**的，
> Obsidian 进程里没有它，不能直接利用。

### 7.3 可行的端口发现方案（已实测可行性）

**方案 A：loopback 全端口扫描 + DSH 指纹**

- macOS 动态端口范围 `49152..65535`（`sysctl net.inet.ip.portrange.first/last` 实测）。
- 实测：1024 并发、120ms 超时，**16 384 个端口 1.5 秒扫完**，命中 3 个开放端口。
- 指纹：DSH 对未认证请求返回

```
HTTP/1.1 401 Unauthorized
cache-control: no-store
content-type: text/plain; charset=utf-8
body: "dsh web authentication required; reopen the URL printed by dsh web."
```

  该字符串在 0.2.0-rc.2 与 0.2.1-rc.2 中**都存在且一致**
  （`dsh-client-connection/lib/index.js` 的 `writeUnauthorized`），可作稳定指纹。

  实测三个开放端口的区分度：

```
49568 → 200 "ok"                                  （VS Code helper，被指纹排除）
56516 → 401 "dsh web authentication required…"    （DSH ✅）
56656 → 无 HTTP 响应                              （rapportd，被指纹排除）
```

- 再叠加一次 `session/list`（插件已有 `probeDshUrl`）即可确认「是 DSH 且认证可用」。

**方案 B：从正在运行的 DSH 进程反查端口** —— 需要 `lsof`/`ps`，但 Obsidian 渲染进程的 `child_process`
可用性受限，且本机 `/bin/ps` 不可用（任务说明），可靠性差。

**方案 C：读 Electron 端缓存**（实测存在
`~/Library/Application Support/@deepseek-ai/dsh-desktop/Cache/Cache_Data/<hash>` 内含
`http://127.0.0.1:56516/`）—— 但这是 Chromium HTTP cache，格式无保证、随版本变化，**不建议**作为主路径。

**推荐**：A 为主（首次连不上时兜底扫描一次，上限约 1.5 秒），命中后按 401+body 指纹 +
`session/list` 双重确认；保留 19387/3080 作为最快路径（CLI 仍是固定 3080）。同时把扫描结果写回
`data.json`，并在失败时给出「请从 DSH 窗口标题/菜单复制地址」的引导。

> 注意：方案 A 属于**端口发现**，不属于本次「协议核查」范围；此处只记录可行性证据（已实测），
> 实现留给后续任务。

---

## 8. 0.2.1 新能力中值得本插件接入的（含接口形态与优先级）

只列对 **Obsidian 侧边栏体验**真正有感的。接口形态均取自 0.2.1-rc.2 的 typert 描述符，
标注为「实测」的均已对 56516 真机验证。

### P0 —— 修 bug 必需

| 能力 | 接口形态 | 说明 |
|---|---|---|
| **修正 control baseline 解析** | 无新接口，改本地 | 见第 5 节。**这是唯一必须改的既有逻辑**，否则 control 流恒死 |

### P1 —— 直接补上现在缺失的可见能力

| # | 能力 | 接口形态 | 真机 | 价值 |
|---|---|---|---|---|
| 1 | **上下文压力可视化** | 已随 `session/control` 的 `projection` 帧免费下发：`contextPressure {pressureTokens, projectedTokens, contextWindow}`、`contextBreakdown {systemTokens, toolsTokens, messageTokens}` | ✅ 实测 `pressureTokens:96799, contextWindow:262144` | 侧边栏显示「上下文 xx%」进度条，长对话时提示压缩。**零新增请求**——只要修好 P0，数据本来就到了 |
| 2 | **`/compact` 手动压缩** | `commands/execute {agentId, line:"/compact", submittedAttachments:[]}`；命令清单里已出现 | ✅ 命令清单实测含 `/compact /export /feedback /goal /permission /plan` | 输入框加「压缩上下文」按钮，直接复用已实现的 `executeCommand` |
| 3 | **权限模式展示/切换** | 投影 `permissions {currentValue:"workspace-write"}`；`permissionPresets/catalog {}` → `{options, defaultOptions, defaultPreset}` | ✅ 均实测 | 状态栏显示当前权限档位；`/permission` 命令可切 |
| 4 | **工作目录显示** | 投影 `workingDirectory`（string \| null） | ✅ 实测 `/Users/sky/Develop/dsh-obsidian` | 面板标题旁显示当前 cwd，避免「DSH 在别的目录干活」的困惑 |
| 5 | **待办清单** | 投影 `todos: [{content, status}]` | ✅ 投影键存在 | 插件 `narrowTodos` 已在消费（`store.ts`），修好 P0 后即可实时刷新 |

### P2 —— 体验增强

| # | 能力 | 接口形态 | 真机 | 价值 |
|---|---|---|---|---|
| 6 | **会话重命名** | `session/rename {request:{sessionId, title}}` → `{title, seq}` | ✅ 实测 ok | 会话列表右键重命名；也便于内联编辑会话起有意义的名字 |
| 7 | **单会话投影按需拉取** | `session/projections {request:{sessionId}}` → `{asOfSeq, values}` | ✅ 实测 21 个投影键 | 打开某会话时精确补数据，不必等 control 流播种（也是 P0 的兜底替代） |
| 8 | **会话 fork** | `session/fork {request:{sessionId, atSeq?, allowMigration?}}` → `{sessionId}` | 描述符确认（未实跑，避免造垃圾会话） | 「从此处分支」——Obsidian 里做「另开一个方向」很自然 |
| 9 | **工作区文件打开** | `session/openWorkspacePath {request:{path}}` → `{opened:true}`；`session/workspacePathApplications {request:{path}}` → 应用清单（含 icon） | ✅ 实测打开 README 成功 | 聊天里点到文件路径可直接用系统应用打开，而不是只能 `workspaceFiles/read` |
| 10 | **配额/用量** | 投影 `tokenUsage {uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`、`sessionStats` | ✅ 实测 | 面板底部显示本会话用量 |
| 11 | **技能清单** | `skills/list {request:{sessionId}}` → `{skills}` | ✅ 实测 | 输入框 `/` 菜单补全（现在只补 `commands/list` 的 6 条） |
| 12 | **文件引用补全** | `fileReferences/list {agentId, query}` → `[{path, kind:"file"\|"directory"}]`（最多 20 条） | ✅ 实测 | `@提及` 换成服务端补全，替代插件本地索引（`src/ui/mentionIndex.ts`），能覆盖工作区外路径 |
| 13 | **用户提问（异步问答）** | 投影 `userQuestions {active:[{callId, questions:[{id,question,detail,header,options,multiSelect,intent}]}], settled:[...]}`；应答 `userQuestions/answer`；流 `userQuestions/attachWait` | 投影键存在 | 侧边栏弹出选择题 UI（`ask_user_question` 这类工具的可视化），比在聊天流里读文本强 |
| 14 | **agent preset 切换** | `agentPresets/list {}` → `{presets}`；`agentPresets/select {agent, agentPreset}` | ✅ list 实测 | 新会话选预设 |

### P3 —— 可选 / 暂不接

| 能力 | 为什么暂不接 |
|---|---|
| `session/search`（全文检索） | 本部署 `session-query-sqlite` 配的是 `openAt: never` → 实测直接报 `session search is disabled`。桌面端默认关闭 |
| `workspace/follow`、`remoteAccess/follow` 流 | 侧重多客户端/多用户共享场景，Obsidian 单机单用户用不到 |
| `session/updateQueue` | 0.2.1 新增的队列变更接口，但插件要显示队列**先得修 P0**；修好后可作为「编辑/删除排队消息」的能力 |
| `/connect` launch-token 认证 | 插件能读 credentials 文件，走既有路径更简单；除非将来要在无磁盘权限环境跑 |
| TLS / `--public-url` | 远端部署场景，插件当前定位本机 |

---

## 9. 明确的回答

### Q1：0.1.9 插件连 0.2.1-rc.2 是「协议级可用」，还是「只差端口」？

**协议级可用。** 依据：

- 认证签名逻辑未变（3.1）；`/api/remote.mux` 与帧协议**字节一致**（3.3）；
- 插件所用的 21 个线上端点在 0.2.1 全在，且三个承载包的 **wire 参数名零差异**（4.1/4.2）；
- 用插件真实代码对运行中的 0.2.1-rc.2 打通了全部一元 RPC（含负例）与三条 WS 流（3.4/3.5）；
- 集成测试 2 passed，全量 567 passed（3.6）。

**但「只差端口」不准确，而且会误导排期。** 准确说法是：

> 协议没坏；**端口发现机制坏了**。0.2.1 桌面端改为 `--port 0`，端口变成每次启动都可能不同的随机值，
> 而插件的探测只覆盖两个固定值，**结构性失效**。这不是改一个默认值能解决的，需要新增「端口发现」能力
> （第 7.3 节，已实测可行：1.5 秒扫完 49152-65535 + 401 指纹识别）。

此外，**另有一个与 0.2.1 无关的既存缺陷**（`session/control` baseline 缺 `queues`，第 5 节）会让
control 流首帧即死——它比端口问题更隐蔽，因为它**不报错**，只是静默少数据。

### Q2：0.2.1 的「网关授权」会不会挡住第三方 HTTP 客户端？

**不会。** 新机制（`dsh-api-remote-access`，0.2.1 首发）只对 `principal.kind !== "owner"` 的 Peer 生效；
插件用 `~/.dsh/.credentials.yaml` 的 secret 自签 cookie，服务端识别为 owner，**跳过全部访问控制判定**（6.1）。
真机 `session/list` / `$events` / `$events/result` 全部成功即为证据。

---

## 10. 附录：证据可复现命令

```bash
# 版本与端口
/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "/Applications/DeepSeek Harness.app/Contents/Info.plist"
lsof -nP -iTCP -sTCP:LISTEN | grep DeepSeek

# 401 指纹
curl -s -i http://127.0.0.1:56516/ | head -8

# 全量测试 / 集成测试
DSH_URL=http://127.0.0.1:56516 ./node_modules/.bin/vitest run tests/integration/liveServer.test.ts
./node_modules/.bin/vitest run

# asar 解析（pickle 嵌套，见 2.1）
# offset 4 = headerSize; base = 8 + headerSize;
# header 内层 = uint32 payloadSize + uint32 strLen + JSON

# 两版包 diff：从 npm registry 取 dist.tarball 后 tar xzf 并 diff
```

---

## 11. 本次核查发现的、超出 0.2.1 增量范围的问题（供排期参考）

| 级别 | 问题 | 位置 | 影响 |
|---|---|---|---|
| **P0** | `session/control` baseline 无 `queues` → `Object.entries(undefined)` 抛错 → control 流首帧即死且被静默吞掉 | `src/core/store.ts:181`、`src/transport/types.ts:405-414`、`src/core/globalStreams.ts:64-71` | 队列不更新、全局投影播种与增量全失效；不报错，极难察觉 |
| **P0** | `start()` 未登记 `pendingConnect` → 与 `open()` 各连一次 → 服务端 accept 2 条 WS、首帧丢失、流永挂 | `src/transport/muxStream.ts:216-217`（修法见第 12 节） | 握手窗口（<3ms）内命中即首帧丢失 + 迭代器 15s 超时；`onload()` 先 `start()` 后 `open()` 的时序最容易命中 |
| **P1** | 端口探测只覆盖 19387/3080，0.2.1 桌面端改为随机端口 | `src/core/diagnose.ts:94-95`、`src/main.ts:189-203` | 0.2.1 桌面用户升级后**必然**连不上，自动探测救不回 |
| **P2** | `authorityOf()` 在 HTTPS 下用 `url.host`，而 0.2.1 服务端 HTTPS 分支用 `url.origin` | `src/transport/auth.ts:authorityOf` | HTTPS 远端部署时 cookie 名不匹配 → 401（当前定位本机 loopback，非 blocker） |
| P3 | `session/follow` 的 `assistantStream` 能力位探测逻辑可保留（0.2.1 仍接受该字段） | `src/core/sessionManager.ts:174-205` | 无问题，仅记录契约仍成立 |

---

## 12. 更正与补充：muxStream 那条不是「测试抖动」，是确定性并发 bug

> 本节由 Lead 复核后补写，取代 3.6 节原有的「间歇抖动 / 建议 singleFork」推断。原推断方向错误：
> 把一个**真实的生产缺陷**误判成了测试基础设施问题。

### 12.1 现象

`tests/transport/muxStream.test.ts > open 发 open 帧…` 超时 15s。Lead 连跑 4 次全红（4/4），
隔离跑该文件亦红；仅在特定时机下侥幸通过。**依赖时序窗口，不是随机抖动。**

### 12.2 根因（`src/transport/muxStream.ts`）

```
start()        → void this.connect()          // ← 没有登记 pendingConnect
open() → streamIter() → waitForSocket()
               → if (!this.pendingConnect) this.pendingConnect = this.connect()
                 // pendingConnect 仍是 null → 又发一次 connect()
```

于是**同时建立两条物理 WebSocket**（服务端 accept 2 条）：

1. `item` 帧回到 socket A；
2. `this.socket` 指向 socket B（后完成握手的那条）；
3. `receive()` 开头 `if (this.socket !== socket) return` → **帧被静默丢弃**；
4. 迭代器永远等不到 `item` → 15s 超时。

隔离验证：写临时用例「`start()` 后等**服务端** accept、但不等客户端 `open` 事件，再调 `open()`」，
断言服务端连接数为 1 → 实测 **2**，断言失败。证明是窗口期双连，与测试桩无关。

**本次核查方（protocol-checker）独立复验**（不依赖 Lead 的结论，自建用例参数化窗口）：
把「`start()` 后到 `open()` 之间」的延迟从 0 扫到 50ms，实测服务端 accept 次数：

| `start()`→`open()` 延迟 | 服务端 accept | 是否命中双连 |
|---|---|---|
| 0 ms | **2** | 命中 |
| 1 ms | **2** | 命中 |
| 3 ms | 1 | 未命中 |
| 10 ms | 1 | 未命中 |
| 50 ms | 1 | 未命中 |

这组数据正好解释了「为什么看起来像抖动」：命中区间落在 1–3ms 之间（即窗口 **< 3ms**），
能否命中取决于 `connect()` 起步到 `open()` 之间的实际耗时——本机全量并行时 4 次采样命中 2 次、
Lead 机器 4 次全中、隔离单跑常不中。**这是时序窗口的命中率差异，不是随机抖动。**
同一临时用例套用 12.4 的一行修法后，全部 5 个延迟点 accept 均变为 **1**，
`muxStream.test.ts` 18/18、全量 568 passed（含该临时用例）/ 2 skipped，连跑 3 次全绿；验证后已还原源码。

### 12.3 生产影响

`main.ts:150` 在 `onload()` 里先 `client.mux.start()`，用户之后打开面板才 `open()`。
只要在握手窗口内，就会双连 + 首帧丢失。这也解释了 **CI（Ubuntu）长期绿、本地 macOS 常红**——
平台时序差异，属于既有红灯被忽略。

**附带发现（本次核查中新观察到，与 muxStream 双连无关）**：`connect()` 的 `finish()` 闭包引用了
`const promise = new Promise(...)`，而 `failWithoutSocket()` 在该 executor 内**同步**执行路径上会触发
`ReferenceError: Cannot access 'promise' before initialization`（TDZ）。只有当 WebSocket 构造**同步抛错**
时才会走到——本机 bundle 里 `ws` 互操作异常时被触发。生产环境 `new WebSocket()` 很少同步抛错，
所以一直没暴露，但这条路径本身是个潜在崩溃点，建议一并加固（把 `promise` 的判等改为
`this.pendingConnect === null` 或提到闭包外）。**优先级低于双连，仅记录。**

### 12.4 修法与验证（Lead 已实测，源码已还原，未留改动）

```diff
   start(): void {
     if (this.stopped) this.stopped = false;
     if (!this.focusCleanup) this.installFocusReconnect();
     if (this.socket?.readyState === WS_OPEN || this.pendingConnect) return;
-    void this.connect().catch(() => { /* … */ });
+    void this.waitForSocket().catch(() => { /* … */ });
   }
```

让连接尝试经 `pendingConnect` 登记、与 `open()` 共享同一次尝试。

- 修后 `tests/transport/muxStream.test.ts`：**18/18 passed**
- 全量：**38 files / 567 passed / 2 skipped**（全绿）
- 建议补一条回归用例：断言「`start()` 与 `open()` 并发时，服务端只 accept 1 条连接」——
  现有 18 个用例都没覆盖这个不变量，这正是它能长期潜伏的原因。
