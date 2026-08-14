# DSH ⇄ Obsidian 插件（dsh-obsidian）设计 —— Claudian 风格

日期：2026-08-13
状态：已确认（用户批准，v1 全量范围）
参考：[Claudian](https://github.com/YishenTu/claudian)（嵌入 Claude Code/Codex 的 Obsidian 插件）

## 1. 目标与范围

把本地运行的 DeepSeek Harness（DSH，默认 `http://127.0.0.1:3080`）作为 AI 协作者嵌入 Obsidian：

- DSH 会话的工作目录绑定 Obsidian vault，agent 直接在 vault 内读、写、搜索文件；
- Obsidian 内提供聊天侧边栏（流式输出、工具卡片、审批弹窗），与 Claudian 体验对齐；
- 提供内联编辑（选区 + 热键 + 词级 diff 预览）、@提及文件、斜杠命令与计划模式。

### v1 功能清单（用户已确认全选）

| 功能 | 说明 |
|---|---|
| 聊天侧边栏核心 | 会话切换/新建、流式消息、工具调用卡片、审批/提问弹窗 |
| 内联编辑 | 选区 + 热键 → 指令弹窗 → 专用会话执行 → 词级 diff 预览 → 替换选区 |
| @提及文件 | 输入 `@` 模糊搜索 vault 文件，内容作为上下文注入消息 |
| 斜杠命令 + 计划模式 | `/` 列出 DSH 原生命令（`/plan` `/compact` `/feedback` `/goal`…）；`Shift+Tab` 切换计划模式 |

### 明确不做（YAGNI）

- MCP 配置界面（MCP 由 DSH 侧管理）
- 多窗口/多标签页会话管理（v1 用会话切换器；双栏布局 v2）
- 移动端支持
- 多语言 i18n（v1 中文，字符串集中于 locale 文件以便后续扩展）
- 与 Web GUI 的实时双开同步（各自独立客户端，共享同一服务端状态）

## 2. 功能与交互

### 2.1 聊天侧边栏

- ribbon 图标 / 命令面板打开右侧边栏 `ItemView`；
- 顶部：会话切换器（下拉列表显示 DSH 全部会话，vault 绑定会话置顶并带标记）+「新建会话」按钮（`session.create({cwd: vault})`）；
- 中部：对话流——用户消息、assistant 流式文本（chunk 级渲染）、可折叠工具调用/结果卡片、压缩摘要、命令执行卡片；
- 底部：多行输入框 + 发送；输入 `/` 或 `@` 触发联想弹层；
- 审批/提问：DSH 请求写文件等操作时，面板弹窗展示工具名与理由 → 批准/拒绝 → `POST /api/respond`；DSH 向用户提问（ask_user）时渲染选项弹窗。

### 2.2 内联编辑

1. 编辑器选中文本 + 用户自定义热键 → 弹窗输入指令（如「改写得更简洁」）；
2. 插件在**专用会话**（cwd=vault，所有内联编辑复用它，避免会话泛滥；可在设置中重置）中发送指令，模板严格要求：只输出替换后文本、不调用工具、不解释；
3. 等待该回合 `turn/end`，提取最终 assistant 文本；
4. 词级 diff 预览弹窗 → 确认后 `editor.replaceSelection` 应用（Obsidian 原生 Cmd+Z 可撤销）；拒绝则丢弃。

### 2.3 @提及文件

- 输入 `@` 弹出 vault 文件模糊搜索（基于 `vault.getFiles()` 缓存索引）；
- 选中后把文件内容（长文件截断至可配置上限）作为上下文块附在消息中；
- 支持 `@` 文件夹路径：注入该文件夹的文件树（相对路径列表，不含文件内容）。

### 2.4 斜杠命令与计划模式

- 输入 `/` 列出 DSH 命令（`/plan`、`/compact`、`/feedback`、`/goal`…）与说明；v1 命令列表为插件内置清单（与 DSH 内置命令对齐），发送形式为「内容恰好是单个以 `/` 开头的文本块」，由 DSH 服务端命令注册表执行（与 Web GUI 相同路径）；
- `Shift+Tab`（输入框内拦截，接管默认焦点切换行为）切换计划模式：当前 `plan` 投影为 active 时发送 `/plan off`，否则发送 `/plan`；计划模式激活时面板顶部显示横幅，`session/projection(key='plan')` 帧实时更新状态（含 pending 态）。

## 3. 架构与组件

技术栈：TypeScript + esbuild，标准 Obsidian 插件结构。一元调用用 Node 内置 `http` 模块；事件流用打包进来的 `ws` 客户端（WebSocket，Node 环境不自动附加 `Origin` 头，通过 DSH 安全围栏）。

```
src/
├── main.ts                 # 入口：注册视图、命令、设置面板
├── settings.ts             # DSH 地址、模板、截断上限等持久化配置
├── transport/
│   ├── types.ts            # 与 dsh-host-apiproxy 对齐的类型（信封/会话/事件）
│   ├── client.ts           # 一元 RPC：POST /api/<method> 与 /api/respond
│   └── muxStream.ts        # mux 事件流：ws WebSocket 帧解析 + 指数退避重连
├── core/
│   ├── sessionManager.ts   # 会话列表、切换、创建（cwd=vault）
│   ├── eventFold.ts        # SessionEvent 流 → 视图模型（消息/工具卡片/投影/审批）
│   └── approvalCenter.ts   # 审批与提问队列 → 弹窗 → respond
├── ui/
│   ├── chatView.ts         # 侧边栏 ItemView
│   ├── inputBox.ts         # 多行输入 + `/` 与 `@` 联想弹层
│   ├── inlineEditModal.ts  # 内联编辑弹窗
│   └── diffPreview.ts      # 词级 diff 渲染与确认
└── context.ts              # vault 路径、当前文件/选区、@提及解析
```

### 数据流（发消息）

```
输入框 → session.prompt
  → mux 流推送 session/event 帧
  → eventFold 折叠进会话视图模型
     （assistant/chunk 追加流式文本；tool/call|result 组成卡片；
       session/projection 更新标题/计划状态；approval/requested 入审批队列）
  → chatView 重渲染
```

### 关键设计决策

1. **事件折叠最小集**：`turn/start|end`、`user/message`、`assistant/chunk|message`、`tool/call|result`、`command/run|done`、`session/title`、`plan/mode`；mux 控制帧：`session/subscribed`（基线）、`session/queue`（待处理队列）、`session/projection`、`approval/requested|resolved`、`question/requested|resolved`。
2. **历史与翻页**：切换会话时 `session.history`（尾页含投影基线）播种视图模型，mux 流增量更新；「加载更早」用 `beforeSeq` 翻页。
3. **内联编辑专用会话**：与聊天会话隔离，全部内联编辑复用一个专用会话（设置可重置）；指令模板约束「只输出替换文本」；提取失败（无文本/超时）时提示用户，不改动编辑器。
4. **会话范围**：列表默认展示全部会话、vault 绑定置顶标记；「新建」一律 `session.create({cwd: vault路径})`。
5. **重连**：WebSocket 断开后指数退避重连（重开流 + 重新拉尾页历史），面板顶部显示连接状态条。
6. **审批/提问弹窗**：按会话分组；mux 重开时会重放未决审批帧（服务端行为），保证切换会话不丢审批。

## 4. DSH 接口契约（依据 @deepseek-ai/dsh 0.1.0-rc.6 源码确认）

### 传输与信封

- 一元调用：`POST /api/<method>`，请求体 `{type:"client-request", rpcId:"<uuid>", method, payload}`；响应 `{rpcId, result:{ok:true, value}|{ok:false, error:{code,message,details}}}`；客户端校验 rpcId 回显。
- 事件流：`ws://<host>/api/events.mux` 的 **WebSocket 连接**（服务端对纯 HTTP GET 返回 426 upgrade required；rc.6 不支持 SSE 直连）。文本帧 JSON 为 `{type:'server-request', rpcId, method, payload}`，payload 即 MuxFrame；连接后服务端立即推送各已挂载会话的 `session/subscribed` 基线并重放未决审批帧，纯下行（客户端无需发消息）。
- 应答：`POST /api/respond`（审批 outcome / 提问回答），信封与一元调用相同。

### 用到的 API 方法

- `session.list` → `{items: SessionSummary[]}`（sessionId、cwd、blank、updatedAt、running、projections）
- `session.create` `{cwd, sessionId?, agentPreset?}` → `{sessionId}`
- `session.prompt` `{sessionId, mode:'queue'|'steer', content:[{type:'text',text}], clientTimeZone?}` → `{accepted:true}`；内容为单个 `/` 开头文本块时作为斜杠命令由服务端执行
- `session.history` `{sessionId, beforeSeq?, maxMessages?}` → `{events, hasMore, projections?}`
- `session.cancel` `{sessionId}`（停止当前回合）

### Mux 帧类型（events.mux）

- 事件帧：`{type:'session/event', sessionId, event: SessionEvent, view?}`，其中 SessionEvent 类型含 `turn/start|end`、`user/message`、`assistant/chunk`（StreamChunk）、`assistant/message`、`tool/call`、`tool/result`、`command/run|done`、`session/title`、`plan/mode`、压缩事件等
- 控制帧：`session/subscribed`（lastSeq 基线）、`session/queue`、`session/jobs`、`session/projection`（key/value/seq，含 title 与 plan 投影）、`stream/error`
- 审批/提问帧：`approval/requested`（approvalId、toolName、callId、reason）、`approval/resolved`、`question/requested`（AskUserQuestionItem[]）、`question/resolved`

### 安全围栏（api-request-trust）

规则：`Host` 头必须为回环地址或可信 authority；带浏览器标记（Origin/Fetch-Metadata）的请求必须同源。插件一元调用用 Node `http` 模块（无 `Origin` 头、`Host: 127.0.0.1:3080` 为回环 → 放行）；事件流用打包的 `ws` Node 客户端（Node 环境不发 `Origin` → 放行）。**禁止**渲染进程 `fetch`/`requestUrl`/原生 `WebSocket` 直连（会带 `app://obsidian.md` 的 Origin 标记，被围栏拒绝）。

### 已知限制

- Web GUI 无会话深链（单页应用，无路由）；本插件是独立客户端，不与 Web GUI 同步 UI 状态（共享服务端会话数据）。
- vault 必须位于 DSH 实例可访问的目录范围（DSH 沙箱/工作区配置决定），否则文件工具会被拒。
- 审批是否触发取决于 DSH 沙箱策略；触发时若用户不在 Obsidian 前，回合会挂起（与 Web GUI 行为一致）。

## 5. 错误处理

- 连接失败/DSH 未启动 → 面板顶部断连状态条 + Notice；
- `result.ok === false` → 按会话位置渲染错误卡片，展示 `error.code`/`error.message`；
- SSE 坏帧 → 丢弃并计数（单个坏帧不杀流）；`stream/error` 帧 → 渲染流错误提示；
- 内联编辑提取失败（空文本/超时/回合异常结束）→ 提示且不改动编辑器；
- 审批 respond 失败 → 重试按钮保留在弹窗中。

## 6. 测试

- 单元测试（Vitest）：RPC 信封编解码、SSE 帧解析（断帧/坏帧丢弃）、`eventFold` 折叠（录制真实帧样本做快照）、词级 diff、@提及解析、指令模板渲染；
- 集成测试：mock HTTP 服务器模拟 DSH（一元响应 + SSE 推送序列），验证重连、翻页、审批全流程；
- 手动验收清单（真实 DSH 联调）：
  1. 新建会话 → 发消息 → 流式输出、工具卡片、审批弹窗正常
  2. DSH 改文件 → Obsidian 自动刷新；审批拒绝 → 回合中止且错误可见
  3. 内联编辑 → diff 预览 → 应用/放弃；Cmd+Z 撤销
  4. `/plan` 切换计划模式横幅；`@` 提及注入文件内容
  5. 杀掉 DSH → 状态条断连；重启 DSH → 自动重连恢复
- CI：`npm run test && npm run build`（GitHub Actions 可后置，MVP 手动执行）。

## 7. 发布

- 命名：`dsh-obsidian`（社区插件 id 待注册）；
- 标准清单：`manifest.json`（minAppVersion 1.7.2+）+ `versions.json`；
- 先本地安装验证（`vault/.obsidian/plugins/dsh-obsidian/`），后续进官方市场：GitHub 仓库 + release 产物 + `obsidian-releases` PR；
- README：前置条件（本机 DSH 运行中、vault 在 DSH 可访问范围）、安装、功能、隐私说明（数据经本地 DSH 发往模型供应商，与 Web GUI 同策略）。

## 8. 参考

- Claudian 仓库与 README：https://github.com/YishenTu/claudian
- DSH 包源码（本地 npm 缓存 checkout）：`@deepseek-ai/dsh` 0.1.0-rc.6，关键包 `dsh-client-connection`、`dsh-api-gateway`、`dsh-host-apiproxy`、`dsh-api-remotes`、`dsh-session`、`dsh-plan-mode`、`dsh-commands`
