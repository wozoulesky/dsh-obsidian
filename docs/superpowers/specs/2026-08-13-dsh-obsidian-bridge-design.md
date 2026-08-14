# DSH ⇄ Obsidian 桥接插件（dsh-obsidian-bridge）设计

日期：2026-08-13
状态：已确认（用户批准）

## 1. 目标与范围

把本地运行的 DeepSeek Harness（DSH，Web GUI 位于 `http://127.0.0.1:3080`）接入 Obsidian：

- DSH 以 Obsidian vault（或其子文件夹）为工作目录，直接用文件工具读写笔记；
- 任务在 DSH Web GUI 中发起、观察执行过程；
- 插件**不提供**聊天界面，笔记文件的变化就是结果（Obsidian 自动检测外部改动并刷新）；
- 插件提供从 Obsidian 侧一键「把选区/笔记/文件夹交给 DSH」的桥接命令。

### 明确不做（YAGNI）

- 聊天面板 / 流式渲染界面
- SSE 事件流（`/api/events.mux`、`/api/events.host`）消费
- 审批桥（在 Obsidian 内批准/拒绝 DSH 的文件操作请求）
- 移动端支持
- 多 vault 会话同步

### 后续演进（非本期）

- 状态栏显示 DSH 连接/运行状态（需 SSE）
- Obsidian 内审批弹窗（需 `/api/respond`）

## 2. 功能清单

| 命令 | 触发位置 | 行为 |
|---|---|---|
| `打开 DSH（当前 vault）` | 命令面板 + 侧边栏图标 | 确保存在 cwd=vault 的 DSH 会话（不存在则创建），然后浏览器打开 Web GUI |
| `发送选区到 DSH` | 编辑器命令 + 右键菜单 | 弹输入框写任务 → 把「任务 + 文件路径 + 选中内容」发给 vault 会话，打开 Web GUI |
| `在 DSH 中处理此笔记` | 文件菜单（当前笔记） | 同选区逻辑，但上下文是整篇笔记内容 |
| `在 DSH 中处理此文件夹` | 文件菜单（文件夹） | 创建 cwd=该文件夹的会话并打开 GUI |

### 会话复用策略

插件持久化「vault 路径 + 实际 cwd」→ sessionId 映射（存插件 data.json；cwd 按第 2 节设置的 cwd 模式解析，因此映射 key 也随 cwd 变化）：

- 查 `session.list` 找 cwd 匹配当前实际 cwd 的会话；
- 若会话已被删除则重建；
- 复用策略（设置项）：`复用最近一次会话` / `每次都新建` / `仅复用空白会话（blank:true）`。

### 设置项

- DSH 地址：默认 `http://127.0.0.1:3080`
- cwd 模式：`vault 根目录` / `当前笔记所在文件夹`（仅影响「发送选区」「处理此笔记」；「处理此文件夹」命令始终用所选文件夹，忽略该设置）
- 会话复用策略（见上）
- 任务提示词模板：默认模板要求 DSH 直接编辑对应文件（含文件路径与上下文占位符）

## 3. 架构与组件

技术栈：TypeScript，标准 Obsidian 插件结构（esbuild 打包，`manifest.json` + `versions.json`）。零运行时依赖，HTTP 用 Node 内置 `http`/`https` 模块。

```
src/
├── main.ts                 # 插件入口：注册命令、菜单、设置面板
├── settings.ts             # 设置定义与持久化
├── api/
│   ├── dshClient.ts        # DSH HTTP 客户端：POST /api/<method>，RPC 信封编解码
│   └── types.ts            # 与 DSH API 对齐的类型
├── sessionManager.ts       # 会话复用：vault→sessionId 映射的查找/创建/持久化
└── context.ts              # 从编辑器/文件树提取上下文（选区、笔记路径、文件夹）
```

### 数据流（发送选区到 DSH）

```
Obsidian 编辑器选区
  → context.ts 组装任务提示词（模板 + 文件路径 + 选区内容）
  → sessionManager 查找/创建 cwd=vault 的会话（session.create）
  → dshClient POST /api/session.prompt
  → 浏览器打开 Web GUI（shell.openExternal）
  → DSH agent 在 Web GUI 中执行任务、用文件工具改写 vault 文件
  → Obsidian vault 监听器检测到外部改动 → 自动刷新笔记
```

## 4. 与 DSH 的接口约定

### 传输与信封（依据 @deepseek-ai/dsh 0.1.0-rc.6 源码确认）

- 一元调用：`POST /api/<method>`，请求体：

```json
{ "type": "client-request", "rpcId": "<uuid>", "method": "session.prompt", "payload": { } }
```

- 响应：`{ "rpcId": "<同款 uuid>", "result": { "ok": true, "value": ... } }` 或 `{ "ok": false, "error": { "code", "message", "details" } }`
- 客户端校验 `rpcId` 回显与 `result.ok`。

### 用到的三个 API

- `session.create`：`{ workspaceId?, cwd?, sessionId?, agentPreset? }` → `{ sessionId, agentPreset? }`。同 sessionId + 同 cwd 重试幂等返回同一会话。
- `session.list`：`{ cursor? }` → `{ items: SessionSummary[] }`；`SessionSummary` 含 `sessionId`、`cwd`、`blank`、`updatedAt`、`running` 等。
- `session.prompt`：`{ sessionId, mode: 'queue'|'steer', content: PromptContentPart[], clientTimeZone? }` → `{ accepted: true }`。文本块形如 `{ type: 'text', text: string }`。

### 安全围栏（api-request-trust）

围栏规则：`Host` 头必须为回环地址或可信 authority；浏览器标记（`Origin`/Fetch-Metadata）必须同源。插件使用 Node `http` 模块发起请求：无 `Origin` 头、`Host: 127.0.0.1:3080` 为回环 → 通过围栏。**不得**使用渲染进程 `fetch`/`requestUrl`（会带浏览器标记，可能被拒）。

### 已知限制

- Web GUI 为单页应用，无会话深链；「打开 GUI」即打开 `http://127.0.0.1:3080`，新会话会实时出现在会话列表。
- DSH 写文件若触发审批，需用户在 Web GUI 中批准（本期无审批桥）。
- vault 必须位于 DSH 实例可访问的目录范围（DSH 沙箱/工作区配置决定），否则文件工具会被拒。

## 5. 错误处理

- DSH 未启动 / 连接失败 → Notice「无法连接 DSH，请先启动 DSH 服务」
- `result.ok === false` → Notice 展示 `error.code` / `error.message`
- `rpcId` 不匹配 / 响应格式非法 → Notice「DSH 返回异常」，console 记录原始响应
- 会话创建失败（如 `agent-preset-not-found`）→ 透传错误消息
- 浏览器打开失败不影响已提交的任务

## 6. 测试

- 手动验收清单（与真实 DSH 服务联调）：
  1. 首次「打开 DSH（当前 vault）」→ 会话创建且 cwd 正确；在 Web GUI 验证 DSH 能用工具读写 vault 文件
  2. 再次运行 → 复用同一会话，不重复创建
  3. 发送选区 → Web GUI 出现任务消息；DSH 修改文件后 Obsidian 自动刷新
  4. 关闭 DSH 服务再运行 → 友好错误提示
- 单元测试（Vitest）：
  - RPC 信封编解码（mock HTTP 响应）
  - 任务模板渲染（占位符替换、选区/路径注入）
  - 会话匹配逻辑（cwd 匹配、blank 优先、删除后重建）
  - `context.ts`（假 vault 适配器）
- CI：MVP 仅要求本地 `npm run test && npm run build` 通过，不强制配置 CI。

## 7. 发布

- 命名：`dsh-obsidian-bridge`
- 标准插件清单：`manifest.json`（minAppVersion、版本）、`versions.json`
- 本地安装：复制构建产物到 vault 的 `.obsidian/plugins/<id>/` 并启用
- 后续进入官方社区市场：GitHub 仓库 + release 产物，提 PR 到 `obsidian-releases`（本期只做本地安装）
- README：前置条件（本地 DSH 运行中、vault 在 DSH 可访问范围）、安装与使用说明
