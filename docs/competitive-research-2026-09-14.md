# Obsidian × 本地 AI Agent 插件生态调研（2026-09-14）

调研对象：把本地 AI Agent 嵌进 Obsidian 的插件生态，重点是「DSH（DeepSeek Harness）in Obsidian」这一族，
基准是我们的插件 `wozoulesky/dsh-obsidian`（市场 id `dsh-bridge`，v0.1.7）。

数据来源（均为首手核验，非二手转述）：

- `obsidianmd/obsidian-releases` 的 `community-plugins.json`（7625 条，本机快照）→ 分发渠道与市场条目
- `community-plugin-stats.json` → 市场下载量（下载量含每次更新计数，不等于用户数，仅作量级参考）
- 各仓库 `gh api` 元数据 / README / 文件树 / release 资产（逐个读过，非依赖搜索结果）

---

## 一、结论速览

1. **这不是"几个雷同项目"，而是一个已成型的赛道**：官方市场里有 10 个 DSH-in-Obsidian 插件、
   22 条含 dsh/deepseek/harness 关键词的市场条目；相邻的 Claude Code / ACP 一族规模大两个数量级。
2. **我们在 DSH 一族里下载量第 5（337）**，头部 `dsh-harness` 是 3601（≈10.7×）。全族 star 0–22，
   说明赛道极早期，**没人建立优势，但获客方式已经分出高下**。
3. **分水岭不是 UI 好不看，而是"能不能不装环境就用上"**。头部三名的共同点：自动安装 DSH/Node、
   静默启动、崩溃重连、更新与诊断；我们 README 第一条前置条件却是"你自己先跑着 DSH"。
4. **我们的路线（原生协议客户端）不是错，但"自研协议层"不是卖点**：同路线还有 `deepseek-harness-native`(355)、
   `DeepShian`(85)，而用 headless spawn 绕开协议漂移的 `DeepHarness` 拿到 763。
5. 我们真正全生态独一份的是三件：**内联编辑词级 diff 落盘、原生审批+提问双弹窗、i18n 字符串表**；
   外加 92 个单测 / TS 构建 / 官方市场上架这套工程化。

---

## 二、DSH-in-Obsidian 全族（市场下载量排序）

| 插件（市场 id） | 接入方式 | 原生聊天 UI | 自建审批 | 内联编辑 | 会话管理 | 自动管理 DSH | 测试 | 下载 | star |
|---|---|---|---|---|---|---|---|---|---|
| **DeepSeek Harness** `dsh-harness` | iframe 嵌官方 UI + Node RPC 胶水 + 70KB 注入桥 | 否（用官方） | 否 | 否 | 有 + 会话格式修复 | **最强**：一键装 git/Node/pnpm/DSH、静默启停、更新、认证自愈、AED 抢救 | vitest 16 文件 | **3601** | 22 |
| **DeepHarness** `deepharness` | spawn `dsh --profile headless` + 自定义 patch 打 DLEVENT 自解析 | 有（chat-view 55KB） | 否（权限模式预设） | 否 | 插件自管 history，每轮新进程 + 记忆回填 | 半（需预装 CLI） | vitest 18 文件 | 763 | 17 |
| **DSH for Vaults** `dsh-ob` | Electron `<webview>` 嵌官方 UI，每库独立端口/数据目录 | 否 | 否 | 否 | DSH 会话 + 按库隔离 + 升级迁移 | 强：便携 Node + 内核、镜像兜底 | 无 | 635 | 0 |
| **DeepSeek Harness Native** `deepseek-harness-native` | **原生客户端**：手写 WS 连 `events.mux`，读 `.credentials.yaml` 铸 cookie，不带 Origin 绕 `isTrustedApiRequest` | 有（折叠/plan-strip/todo-strip） | **有**（approval→respond） | 未见 | 有 | 有 | 5 个回归脚本，无 runner | 355 | 1 |
| **DSH Bridge（我们）** | **原生客户端**：Node http + ws 直连 RPC/mux，自渲染 | 有 | **有**（审批+提问） | **有**（词级 diff） | 有（切换/新建/翻页/重连） | **无** | vitest 92 | 337 | 2 |
| **DSH Dock** `dsh-dock` | spawn `dsh web` + iframe + **自建 loopback 反向代理**（铸 cookie、改写 Host/Origin、HTTP+WS 转发） | 否 | 否 | 否 | 按库隔离 + 端口 hash 派生 | 有 | smoke/verify 脚本 | 195 | 1 |
| **DSH Math Notes Assistant** `dsh-math-assistant` | 面向数学笔记的记忆 agent（左侧栏），自动管理服务 | 有 | 未见 | 未见 | 有 | 有 | 有 CI + QA 脚本 | 125 | 6 |
| **DSH** `dsh` | spawn `node <dsh> --profile headless <task>` 每条消息 | 未见 | 未见 | 未见 | 会话写进 `<vault>/.dsh/sessions/` | 否 | 有 test 目录 | 118 | 4 |
| **DSH Embedded** `dsh-embedded` | spawn `dsh web` + iframe + auth proxy（token→cookie→proxy） | 否 | 否 | 否 | 每库 cwd | 有（杀进程树、清孤儿） | 未见 | 108 | 3 |
| **DeepShian** `deepshian` | 原生 TS 客户端 + 自定义 dsh profile，与 dsh web 会话双向同步 | 有 | 未见 | 未见 | 有（含归档/删除同步） | 有（install modal） | 未见 | 85 | 2 |

未上架但值得记录：`hyci3/obsidian-dsh-tab`（每库独立 DSH_HOME、宣称 119 测试）、
`Easy19613/obsidian-dsh-agent`（**走 ACP**，文件快照撤销、上下文治理）、
`chenzhexii/obsidian-dsh`（原生 RPC，08-14 后停更）、
`zhou20060927-blip/obsidian-dsh-coder`（为拿真流式正式 fork 了 DSH bundle）。

相邻物种（不嵌 DSH，直接在 Obsidian 内跑 agent 内核）：`frank6com/harness-like`（227 下载，原生聊天+审批+内联编辑，**不需要 DSH**）。

---

## 三、相邻族：Claude Code / Codex / ACP（品类天花板在这边）

| 仓库 | 市场 id | 接入方式 | 下载 | star |
|---|---|---|---|---|
| YishenTu/claudian | `realclaudian` | 多 provider 适配层（agent-sdk / app-server JSON-RPC / ACP） | **2,104,168** | 15293 |
| RAIT-09/obsidian-agent-client | `agent-client` | 纯 ACP（`@agentclientprotocol/sdk`，9 种 preset，含 WSL 模式） | **263,765** | 2408 |
| freestylefly/wesight-obsidian | `wesight` | spawn CLI，权限全交 CLI；卖点其实是云端发布流水线 | 14,499 | 404 |
| wuyifan-code/Claudian-plus | `claudian-plus` | claudian 衍生 | 3,165 | — |
| mtymek/opencode-obsidian | 未上架（BRAT） | 本地 `opencode serve` + iframe（须 `--cors app://obsidian.md`） | — | 1138 |
| iansinnott/obsidian-claude-code-mcp | 未上架 | **反向 MCP**：把 vault 暴露给外部 agent（无 chat） | — | 352 |
| Roasbeef/obsidian-claude-code | 未上架 | 进程内 SDK `query()` + PermissionModal | — | 216 |
| deivid11/obsidian-claude-code-plugin | 审核中 | spawn CLI 解析 stream-json，5 语言 i18n | — | 87 |
| SmartAndPoint/obsidian-claude-code | 未上架 | 只走 ACP + 自管二进制下载 | — | 25 |
| m-rgba/obsidian-ai-agent（归档） | — | `--dangerously-skip-permissions`，README 自认"重做会用 ACP" | — | 50 |

**这一族的三条共识**：

- 接入已收敛为 ①进程内 SDK（Claude 专属）②spawn CLI 解析 stream-json ③**ACP 作为跨 agent 标准**（claudian、Agent Client、SmartAndPoint）。
- 渲染全部走**原生自建 UI**，只有 opencode-obsidian 用 webview、iansinnott 用 xterm —— 没人拿终端当主界面。
- 认证一律复用既有 CLI 凭据；**没人自建账号体系**（wesight 是唯一例外，那是商业产品）。

**这一族的普遍空白**（即我们的机会）：上下文占用显示（仅 claudian / Agent Client 有）、
i18n（仅 claudian 10 语言 / deivid11 5 语言）、thinking 折叠、**审批与提问弹窗**（多数直接交给 CLI，
我们与 claudian 是少数自建者）、移动端（全部 `isDesktopOnly`）。

---

## 四、三条技术路线与各自代价

### A. iframe / webview 嵌官方 UI（占多数，也是下载冠军）
- 功能面 = 官方 UI 全量，永远同步，插件只补胶水。
- **真正的成本在认证**：DSH 的 `isTrustedApiRequest` 围栏 + `SameSite=Strict` cookie 让跨站 iframe 无法认证。
  于是 `dsh-dock` 写了 24KB 反向代理，`dsh-embedded` 写了 auth proxy，`dsh-harness` 注入 70KB bridge 重写 fetch/WS/XHR。
  **它们和我们一样要读 `~/.dsh/.credentials.yaml` 的签名密钥** —— 我们 README 里那段安全披露在这个生态里是行业常规。
- 代价：白屏 / 尺寸 0 / 跨域不重绘 / token 过期，头部插件的 30 个 release 基本都在修这些。

### B. spawn `dsh --profile headless`（DeepHarness、`dsh`、`obsidian-dsh-coder`）
- 绕开协议漂移与会话服务，进程即边界；代价是拿不到回合内交互（审批弹窗、计划模式、工具卡实时折叠），
  且每轮要重放记忆。DeepHarness 用自定义 patch 打 DLEVENT 才拿到接近流式的体验。

### C. 原生协议客户端（我们、`deepseek-harness-native`、`DeepShian`）
- 换来一等事件语义：`approval/requested`、`question/requested`、`session/projection`、压缩事件、`beforeSeq` 翻页。
- 代价：吃 DSH 版本漂移（0.1.2 → 0.1.5 的端点与鉴权差异我们已经踩过），且功能面永远追不上官方 UI。

### D. 旁支
- **ACP 客户端**：DSH 侧已有社区 ACP server（`dushaobindoudou/dsh-acp`、`ClickPM/dsh-acp-interactive` ★39、
  `openma-ai/deepseek-harness-acp` ★29、`grunmin/dsh-acp-enhanced` …）。走 ACP 我们就能同时接 DSH + 其他 agent。
- **反向 MCP**：把 vault 供给外部 agent（`iansinnott`、`mingzeng21/dsh-obsidian` ★14、`iamzcr`），与我们方向相反，属互补。

---

## 五、我们 vs 全生态：优势与缺口

**独有（全生态 20+ 仓库里没有第二家同时具备）**

- 内联编辑 → 词级 diff 预览 → 写回编辑器（iframe 派只能"把选区发过去"，spawn 派没有回合内交互）
- 原生**审批 + 提问双弹窗**（`approval/requested`、`question/requested` 全链路）
- 计划模式横幅 + `session/projection` 投影消费；goal 面板；上下文占用；todo；图片附件；压缩摘要折叠
- i18n 字符串表导出（用户可自行翻译）；92 个 vitest 单测 + TS + eslint
- 不装、不启、不管进程：对已经跑着 DSH（含 Linux/WSL/远程）的用户零侵入

**落后（按对获客的影响排序）**

1. **零门槛引导缺失** —— 头部插件一键装 git/Node/pnpm/DSH、静默启动、崩溃重连、认证自愈，我们全无。
2. **无进程生命周期与诊断** —— 无拉起、无孤儿回收、无启动耗时诊断、无更新检查、无会话格式修复。
3. **无按库隔离** —— `dsh-ob` 每库独立端口/数据目录，`hyci3` 每库独立 `DSH_HOME`，我们共用一个实例。
4. **无双向定位桥** —— 竞品：笔记选区 → 注入 `file:line:col` 定位行；DSH 提到的 vault 路径 → 点击跳回笔记。
   我们只有单向 `@` 提及。
5. **无双向导**：会话不随库走（`dsh` 把会话写进 vault），无多会话并行、无文件快照撤销（`Easy19613` 有）。
6. ~~**兼容性口径需复核**~~ **已处置（2026-09-14，TASK-035）** —— 本机 DSH 已是 `0.1.5-rc.1`；`dsh-harness` 明示"兼容 0.1.5，0.1.2–0.1.4 不兼容"，
   而我们 README 原写 "≥0.1.2-rc.1"（读起来像"0.1.5 尚未验证"）。**中英 README 已同步改为按版本线分档的兼容矩阵**，纯文档改动、产物未变。
   遗留元数据问题（未处置）：市场条目作者显示为 `sky`，`manifest.json` 写的是 `wozoulesky`。

---

## 六、判断与建议优先级

**判断**：局部优势、整体偏劣势，但可逆。劣势不在技术深度，在**获客路径**——
用户拿"能不能不装环境就用上"投票，而不是"UI 有多原生"。
真正需要防守的不是 iframe 派（他们被官方 UI 的跨域与 token 问题持续消耗），
而是 `DeepHarness` 这种"headless spawn + 自建原生 UI"的组合：它同时拿到了低门槛和原生体验。

**建议优先级（不改架构即可做）**

1. 设置页做 DSH 探测 + 未运行时引导/一键拉起（含 node/dsh 路径探测与端口占用处理）。
2. 选中文本 → 带 `file:line:col` 定位行发送；面板内 vault 路径可点击跳回笔记。
3. 一键诊断 + DSH 版本兼容检查（把"401/404"变成可读结论），并把 README 的兼容口径改成版本矩阵。
4. 差异化话术重写：把"内联 diff 编辑 / 审批弹窗 / 计划模式 / i18n / 92 单测"提到卖点位置，
   把"需要自备运行中的 DSH"从第一屏挪到前置条件区。
5. 中期选项：加一个 ACP 客户端适配器（DSH 侧 ACP server 已成熟），既是生态对齐，也是多 agent 的扩展路径。

---

## 七、未确认项

- 市场条目 `mv-obcc`(434 下载) 是否属于本族未确认。
- `chenzhexii/obsidian-dsh` 宣称原生 RPC，代码未逐行核完（仓库 08-14 后停更）。
- 下载量含更新计数，不能等同活跃用户；star 数全族极低，不足以判断真实影响。
- `SmartAndPoint` 未能上架的原因（推测与前一个插件 manifest id 冲突）无官方说明。
