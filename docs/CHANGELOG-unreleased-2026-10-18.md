# 未发布变更（2026-10-18）

> 本轮把上一轮审计（`audit-2026-10-17-*.md`）里标记的问题**真正修掉了**，并落地了用户要求的两件事：
> 社区插件库装完即可用（端口自动发现）、界面语言自动跟随 Obsidian。
> 基线 `master@0d8d837`（v0.1.9）→ 工作树 29 文件 / +1974 −116。

## 一、修掉的缺陷

### P0-1 端口自动发现（DSH 0.2.1 随机端口导致必然连不上）

**现象**：DSH 0.2.1 桌面端改为 `--port 0`，每次启动由系统随机分配端口（实测 `19387` → `51740` → `56516`），
而插件只探测写死的 `19387`/`3080`，升级 DSH 后**必然连不上**。

**修复**：`src/core/diagnose.ts` 新增 `discoverDshUrls()`，按成本分级：
1. 静态候选 `19387`/`3080`（零成本，覆盖旧版桌面端与 CLI）
2. **反解 Chromium Cookie 库**（主路径，实测 **189–244 ms**）：DSH 桌面端把
   `dsh-auth-<base64url(sha256("127.0.0.1:<port>"))>` 写进
   `~/Library/Application Support/@deepseek-ai/dsh-desktop/Cookies`，对端口区间逐个算 cookie 名做字节级子串匹配即可
3. TCP 扫描临时端口段（兜底，实测 ~1.1–1.7 s，**需显式 `scan: true`**）

设计纪律：
- 发现层**不发 HTTP**、不做指纹判定（实测扫描会捞到非 DSH 服务：`49568` 回 `200 ok`、`56656` 非 HTTP）
- 扫描**绝不进 `onload`**，只挂在用户主动点的「诊断」按钮上
- 发现只对 loopback 生效——用户刻意配了远端 DSH 时不得被本机随机端口顶掉
- `cookieNameForPort` **复用** `transport/auth.ts` 的 `cookieName`，不复制哈希算法（有交叉单测锁漂移）

**真机验证**：`discoverDshUrls()` → `["...:56516", "...:51740", "...:19387"]`（237 ms）→ 命中 `56516` → `session/list` OK。
模拟「设置里残留失效的 19387」场景 → 自动恢复连上 `56516`。

### P0-2 `session/control` baseline 缺 `queues` 导致崩溃

**现象**：DSH 0.1.7-rc.1 起 baseline 只下发 `projections`，旧代码 `Object.entries(frame.value.queues)` 抛
`TypeError: Cannot convert undefined or null to object`。危害不止于报错：projections 已在前面应用成功
（数据进库），但异常让本帧剩余逻辑与 `notify()` 全部跳过（**UI 不重绘**），控制流首帧即死。

**修复**：`src/core/store.ts` 改 `?? {}` 容错；`src/transport/types.ts` 把 `queues`/`jobs`/`projections`
改为**可选**——原先把已消失的字段标成必填，让编译器失去了报警能力，正是该 bug 潜伏的原因。
回归测试用真机抓到的原始帧形状（`value` 只有 `projections`）。

### P0-3 `muxStream` 双连接竞态（流永远收不到数据）

**现象**：`start()` 直接调 `connect()` 却没登记进 `pendingConnect`，紧随其后的 `open()` → `waitForSocket()`
看到为空又发起第二次连接。服务端 accept 两条 WS，`item` 帧回到 socket A 而 `this.socket` 指向 B，
被 `receive()` 的 `this.socket !== socket` 守卫静默丢弃 → 迭代器 15s 超时。

**修复**：`start()` 改走 `waitForSocket()`（会登记连接尝试）。

### P0-3b `connect()` 内 TDZ `ReferenceError`（新发现）

`finish()` 闭包引用 `const promise`，但 `finish` 可能在 `promise` 初始化前被**同步**调用
（`new WebSocket()` 抛同步异常时）。后果：`ReferenceError: Cannot access 'promise' before initialization`
掩盖真实原因，且 `pendingConnect` 被永久占位 → **插件从此再也无法重连**。
修复：改用本次尝试独有的 `pendingToken` 做比较，无 TDZ 风险。
回归测试用 `Promise.race` 断言「不得永久挂住」，并已反向验证（还原 bug 时确定变红）。

### P0-4 全局流空 `catch` 静默吞异常（让 P0-2 一直没被发现）

`globalStreams.ts` 两条流都用裸 `catch {}`，异常对象被直接丢弃：无日志、不重连、不通知 UI，
表现只是「侧栏停在打开那一刻」。修复：新增 `onUnexpectedError` 钩子，区分预期断线（静默）与
真正的 bug（上报），`main.ts` 接成 `console.error` + `stream-error.log`（带时间戳、截断 32KB）。

**⚠️ 生产构建陷阱（worker 发现，已修复并加测试）**：判定「预期断线」最初用 `err.constructor.name`，
但生产构建 `minify: true` 会把 class 名压成短名（实测 `RemoteStreamCarrierError` → `"e"`），
判定永远 false → 每次正常断线重连都误报为「非预期异常」并写日志，正好把这个钩子想解决的问题反过来。
改用 `err.name`（`muxStream.ts` 以字符串字面量赋值，压不掉）。单测跑未压缩 TS 发现不了，
故新增一条**显式模拟压后短名**的回归测试，并已反向验证。

### P1-2 IME 组合输入被当成发送

中文/日文用户按 Enter 是「确认候选词」，但 `inputBox.ts` 的 Enter 分支没有 `isComposing` 守卫：
会把**未上屏的拼音**当正文发出去，且 textarea 已被清空——用户既发错内容又丢了正在打的字。
修复：`onKeydown` 最前加守卫，同时检查事件自带 `isComposing` 与 `compositionstart/end` 跟踪态
（部分平台 commit 那一拍 `isComposing` 已回落）。

### P1-3 底层硬编码中文错误串

11 处中文错误串（`auth.ts`/`client.ts`/`sessionManager.ts`/`eventFold.ts`）改为
**稳定错误码 + 英文兜底 message**（`AUTH_ERROR_CODES`/`TRANSPORT_ERROR_CODES`/`SESSION_ERROR_CODES`），
transport/core 层不 import i18n（避免核心层反向依赖 UI 文案）。所有英文兜底保留了原有诊断信息
（path / recordKey / 期望-实际字节数 / rpcId / HTTP status），没为「纯英文」丢信息。

同时把 `classifyDshFailure` 改成 **code-first**：原先靠 `/凭据|credentials/i` 猜文案判类，
文案一改就可能悄悄降级成 unknown，让「认证失败」变「未知错误」。

### P1-4 回合被服务端拒绝时消息「凭空消失」（真机发现）

**现象**：给一个已归档/不可执行的旧会话发消息，消息发出去就没了，界面不留任何痕迹。
用户无法判断是没发出去、卡住了、还是被拒了。

**根因**：DSH 的 `turn/end` 有六种 reason
（`completed | blocked | aborted | interrupted | error | max-tokens`，
见 `dsh-agent/lib/types/consumed-work.js` 的 `accountsForClaim`），而插件只处理了 `error`，
其余全部静默。其中 `blocked` 最要命：`pre-step` 被策略 gate 拒绝
（典型是 `archived-session-gate`），服务端**连请求都不发**、消息被丢弃、工作永远不会执行，
**但 `session/prompt` 仍返回 `accepted: true`** —— 从客户端看完全成功。

**修复**：`eventFold` 对非 `completed` 的收尾追加 `notice` 节点（新节点类型，携带 `reason`），
`chatView` 按 reason 渲染提示文案；`blocked` 明确告知「没有被执行」并给出「新建会话后重试」的动作。
reason 本身不携带原因文本（`reject` 只有 `{kind:'reject'}`），故文案按 kind 固定，未知 kind 走
带 `{reason}` 的兜底——**保证 DSH 将来新增收尾类型时不会退化成静默**。

顺带收益：新增节点类型后 tsc 立刻报出 `chatView` 里未覆盖的分支（原先假定末尾节点必为 assistant），
这正是引入穷尽性检查的价值。

## 二、用户要求的两件事

### 一键安装（社区插件库装完即可用）
即上面的 P0-1 + onload 探测并发化。地址一般无需手填，找到即落盘并提示。
README 中英文已同步，删掉「桌面 App 固定 19387」的过时引导。

### 界面语言跟随 Obsidian
`src/i18n.ts` 新增 `EN_STRINGS`（**140 条**，键集与中文表逐键一致）+
`resolveLanguage()`（`zh*` → 中文，其它 → 英文，拿不到/异常**回落中文**不倒退）+
`I18n(overrides, lang)` / `loadI18n(paths, read, lang)` 双参数向后兼容。

`main.ts` 接线用 `requireApiVersion("1.8.7") ? getLanguage() : undefined` 守卫——
`getLanguage()` 是 Obsidian **1.8.7** 才有的 API，而本插件 `minAppVersion` 是 **1.7.2**，
不守卫会在 1.7.x 上因缺函数拖垮 `onload`（该问题由 lint 规则 `obsidianmd/no-unsupported-api` 抓出）。
测试锁住：两表键集一致、英文表无中文残留、**占位符完整性**（防英文丢 `{message}`）、
模板键集一致、版本守卫在新旧宿主上的两种行为。

顺带修正过期文案（`settings.dshUrlDesc` / `diag.notRunning` / `diag.unreachable`）中英同步。

## 三、文档
- `README.md` / `README.zh.md`：端口事实修正 + 一键安装说明 + 语言跟随说明
- `docs/dsh-0.2-compat-audit-2026-10-01.md`：加**过期说明**（端口结论已被证伪，其余结论仍有效），保留为历史记录

## 四、验证

| 项 | 结果 |
|---|---|
| `eslint src` | exit 0，**零告警** |
| `tsc --noEmit -skipLibCheck` | exit 0 |
| `vitest run` | **38 files / 659 passed / 2 skipped / 0 failed**（基线 566 passed + 1 failed） |
| `main.js` 字节可复现 | 两次构建 `cmp` 一致 |
| 产物内容 | 含 `1.8.7` 守卫、`dsh-auth-` 反解、英文串；**无 `constructor.name` 残留** |
| 真机端到端 | 端口发现 237ms → 命中 56516 → mux connected → 3 帧 control 入库未抛错 → 中英 UI 正确 |

### P1-5 DSH 重启换端口后插件永久失联（须重载 Obsidian）— 真机发现并修复

**现象**：Obsidian 一直开着，用户重启 DSH（桌面端每次启动拿新的随机端口），
插件状态栏从此停在「DSH 未运行（连接被拒绝）·重连中…」，即使 DSH 明明已在新端口跑起来。
唯一出路是手动重载 Obsidian —— 这直接削弱了「一键安装、装完就用」的承诺。

**根因**（三层，逐层挖出来的）：
1. `baseUrl` 在 `onload` 里用 `const` 算一次就作为构造参数传给 `DshClient`，
   `RemoteMuxTransport.baseUrl` 没有 setter；而 `scheduleReconnect()` 只调 `connect()`，
   于是无限退避重试**同一个已失效的地址**。没有任何代码路径会重新发现新端口。
2. `main.ts` 的 `onState` 只做重连，不做重新发现。
3. **最隐蔽的一层**：即使加了「连续失败 N 次就重新发现」，也永远不会触发 ——
   `emitState` 对同值去重，`"reconnecting"` 只在状态**翻转**时通知一次。
   真机实测：杀掉旧端口后状态栏正确显示「未运行」，但自愈逻辑只收到 1 次通知，
   阈值 3 永远达不到。这条是**真机验证才暴露**的，单元测试和代码阅读都看不出来。

**修复**：
- `RemoteMuxTransport.rebindBaseUrl(url, cookieHeader?)`：原地换入口。
  保持实例身份不变（`manager`/`approvals`/`globalStreams` 都持有它）；
  `generation++` + 关旧 socket（否则旧地址在途帧会串进新连接）；
  复位 `attempt`/`lastRefused`/`refusedSinceOpen`；活动状态下自动续连。
- **必须同时换凭据来源**：cookie 名 = `dsh-auth-<sha256(authority)>`，authority 含端口。
  构造期 `() => auth.cookieHeader()` 闭包捕获的是旧 auth 对象，只换地址会继续用旧 authority
  签的 cookie → 新地址一律 401。现场症状是「端口明明换对了还是连不上」，极易误判成服务端问题。
- `DshClient.rebindBaseUrl(url, auth)`：换 `opts.baseUrl` + 换 auth + 让 mux 用动态闭包解析凭据。
- 新增 `onRefused` 回调：**不去重**，每次被拒都回调（`onState` 保留给状态栏）。
- `src/core/refind.ts`：自愈状态机抽成纯函数（`shouldRefind`/`onDiscoveryResult`/`onConnected`），
  7 条单测钉住每条规则，其中「发现成功**不得**置 givenUp」是最容易写错的一条
  （写错会导致用户第二次重启 DSH 就再也不会自愈）。
- `main.ts.tryRefindDshUrl`：连续失败 3 次（`ECONNREFUSED` 时 2s 轮询 ≈6s）→ 重新发现并热切换 →
  落盘 + `Notice` 告知 + 刷新会话列表。连续 5 轮找不到才放弃，连上即全部清零。
  只对 loopback 生效：用户刻意配的远端 DSH 不能被本机端口顶掉。

**真机验证**（用端口代理制造「真换端口」场景，比改配置更接近真实）：
插件经代理 `27123 → 56516` 连上并显示「DSH 已连接」→ `kill -9` 代理模拟旧端口消失 →
**4 秒后**配置自动切到 `56516`，状态栏恢复「DSH 已连接」，随后发送真实消息
`SELFHEAL-OK` 并收到 DSH 回复 —— 整条 RPC + 事件流链路真的通了，全程用户无操作。

### P1-6 「Obsidian 先启动、DSH 后启动」时插件永久不连（用户真机复现）

**现象**：用户先开 Obsidian（20:55），25 分钟后才启动 DSH（21:20）。
此后插件状态栏一直停在「DSH 未运行（连接被拒绝）·重连中…」，即使 DSH 已在新端口跑起来，
重载 Obsidian 也不会自动恢复（重载后 onload 能发现，但**不重载就一直不连**）。

**根因**（是 P1-5 修复自身的设计缺陷，属于我自己引入的 bug）：
P1-5 引入的自愈状态机里，`givenUp` 是**永久终态** ——
连续 5 轮发现都找不到可用地址就置 `givenUp = true`，而它**只有 `onConnected` 能清零**。
问题在于：既然已经放弃，就永远连不上，也就永远等不到 `onConnected` → **死锁**。

用户场景必然踩中：Obsidian 启动时 DSH 还没起 → 5 轮（约 10–30 秒）内必然发现不到 →
永久放弃 → 之后 DSH 起来也没人再试。

**为什么 P1-5 的真机验证没发现**：那次测试里「新端口」是**一直活着**的
（代理从一开始就把 27123 指向运行中的 56516），所以第一轮发现就成功，从未进入 `givenUp`。
「先无后有」是完全不同的路径 —— 这正是本轮用户实测补上的空白。

**修复**：
- `givenUp` 从「永久终态」改为「**冷却态**」：新增 `failsSinceGiveUp` 计数，
  满 `REFIND_COOLDOWN_FAILURES`（=3，ECONNREFUSED 下 2s 轮询 ≈6 秒）后自动解除；
  解除时同时清零 `misses`，让下一轮发现按完整额度重试。
- 冷却周期取 3 而非 30：实测一次「发现 + 探测全部候选」只要 **37–100ms**
  （DSH 未运行时没有慢路径），每 6 秒跑一次占空比 <2%，没有省它的必要。
  取 30（≈60 秒）会让「DSH 晚启动」的用户多等近一分钟，是错误取舍。
- 对应更新了自愈状态机的单测：原先断言「放弃后不再尝试」的那条，
  正是被我推翻的错误行为，改为断言「冷却期内不重试、冷却期满必须重试」。

**真机 + 真实时序验证**：
- 状态机真实时间尺度驱动：DSH 6.3 秒后才「启动」，第 21 次发现成功并 rebind，
  `givenUp` 正确复位为 false（日志可见 `givenUp=true → 3 次失败 → false` 的冷却循环）。
- 真实 DSH 端到端：旧地址 `27124`（死端口）→ 4.1 秒发现 `49651` → rebind →
  `connected` + `session/list` ok（120 个会话）。
- 真实 Obsidian UI：换端口后 4 秒自愈，状态栏恢复「DSH 已连接」。

### P1-7 补测试：渲染分类与 URL 判定（此前零覆盖）

补两块长期无自动化保护的逻辑——不是新功能，是把已有的隐性契约钉住。

**1. `src/ui/nodeRender.ts`（新增）：把 `chatView.buildNodeEl` 的分类决策抽成纯函数**

原问题：`buildNodeEl` 是 60+ 行分支瀑布（user/error/command/notice/assistant），
依赖 `this.nodesEl` / `this.runtime`，在 node 测试环境下无法覆盖 →
**渲染分类从未有过测试**。P1-4 加的 notice 分支正是加在其中的；
若日后有人调整分支顺序，notice 会落进 assistant 兜底、渲染成空助手气泡，
而只有真机才能发现。

抽出 `describeNode(node, t): NodePresentation`（kind / cls / text / imageLabel），
`chatView` 改为消费它，DOM 与 Markdown 等副作用仍留在原处。
新增 13 条测试覆盖：五类节点的类名与文案、带图/无图、命令三态、
**notice 不得落到 assistant 兜底**、四种 reason 文案互异、未知 reason 兜底、空助手占位。

反向验证：删掉 notice 分支 → 4 条测试同时变红。

**2. `sameUrl` / `isLoopbackUrl`：从 `main.ts` 移入 `diagnose.ts` 并导出**

原问题：这两个判定写在 `main.ts` 里且未导出，零测试；而它们直接决定
「发现到的地址是否就是当前连不上的地址」（决定自愈会不会空转）与
「是否允许本机端口发现」（决定远端 DSH 会不会被本机端口顶掉）。
同时 `candidateDshUrls` 里还有一份内联的 loopback 判定，属同一规则两处实现。

移入 diagnose 后 `candidateDshUrls` 改用 `isLoopbackUrl`，消除重复。新增 11 条测试。

反向验证时发现并修强了一处**测试自身缺陷**：原用例 `127.0.0.1.evil.com`
并不能防住 `includes/startsWith` 这类退化实现（该串并不以 `127.0.0.1` 结尾）。
补上 `127.0.0.1127.0.0.1` 与 `evil-localhost.com` 两条，现在用 `includes` 实现会立即变红。

**真机确认**：新构建部署后重启 Obsidian，notice 提示、助手回复、思考过程折叠、
工具卡、上下文用量全部渲染正常，状态栏「DSH 已连接」，无 `load-error.log` / `stream-error.log`。

**测试数**：674 → 698（+24），41 个测试文件全通过。

## 五、遗留（未做，建议后续）
- **CI 只有 Ubuntu runner**：P0-3 这类平台相关竞态不会在 CI 变红（本次靠本地 macOS 复现才发现）。建议加 macOS runner。
- **`chatView.ts` 仍无直接测试**：渲染分类已抽出并由 `nodeRender` 覆盖（P1-7），但 `chatView` 本身的 DOM 组装、
  流式/缓存复用、头部与状态区渲染仍需 jsdom 才能测（当前环境无 DOM 库，未引入新依赖）。
- **冷启动换端口**（P1-5）与**DSH 后启动**（P1-6）均已修复并真机验证；后者由用户实测发现，是 P1-5 的回归缺陷。
- **`globalStreams` 的 `isExpectedStreamEnd` 依赖 `err.name` 字符串**：与 `muxStream.ts` 的赋值是隐式契约，
  改类名时需同步（已被回归测试部分覆盖，但建议抽成共享常量）。
- **issues #1/#2/#3 尚未回复/关闭**：草稿见 `docs/issue-triage-2026-10-17.md`；本轮未执行任何 `gh` 写操作。
