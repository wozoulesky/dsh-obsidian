# DSH Bridge

把本地运行的 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为 AI 协作者嵌入 Obsidian：vault 就是它的工作目录，DSH 可以直接读、写、搜索你的笔记。

[English](./README.md)

## 为什么选它

市面上多数 Obsidian ↔ agent 桥接要么嵌一个网页界面，要么套一层命令行。这个插件是**原生客户端**：直接讲 DSH 自己的 RPC 与事件流，再用 Obsidian 自己的 UI 渲染一切。

- **原生，不是套壳**——聊天、工具卡片、审批、计划模式都是真正的 Obsidian 界面：跟随你的主题、字体与快捷键。
- **内联编辑带词级 diff**——选中文本、给一句指令、看 diff、应用；`Cmd+Z` 即可撤销。
- **审批就落在你眼前**——DSH 的写文件/执行确认与追问都在面板内弹出，不用切窗口，断线重连后也不会丢。
- **连接诊断**——`401` / `404` / 连接被拒会被翻译成一句可执行的结论（设置 →「诊断连接」）。
- **经得起长期使用**——550 个单元测试、TypeScript 严格构建、产物字节可复现、已上架社区插件库。

插件是客户端而非运行时：它需要一个本地 DSH 来对话（见「前置条件」）。出问题时，诊断按钮会告诉你到底是哪一边的问题。

## 前置条件

- 本机运行中的 DSH 服务（默认 `http://127.0.0.1:3080`）
- 你的 vault 位于 DSH 可访问的目录范围（DSH 沙箱/工作区配置决定）
- Obsidian ≥ 1.7.2，仅桌面端

## 功能

**对话**

- **聊天侧边栏**：流式回复、工具调用卡片、会话切换与新建、加载更早、断线自动重同步
- **审批 / 提问弹窗**：可重试、按会话分组，重连后会重新浮现
- **思考过程**：正文上方的可折叠推理块，流式跟随、回合结束定格
- **图片附件**：从 vault 选图随消息发送，agent 可直接读图

**编辑笔记**

- **内联编辑**：选中文本 + 热键（在 Obsidian 设置中分配）→ 指令 → 词级 diff 预览 → 替换；应用前会复检选区，大段内容降级为确认弹窗
- **@提及文件**：输入 `@` 选择 vault 文件（内容注入）或文件夹（注入目录树），超长截断、缺失有提示
- **斜杠命令与计划模式**：命令清单来自正在运行的 DSH（始终与你的安装一致），另含本地 `/clear`；`Shift+Tab` 切换计划模式

**上下文与掌控**

- **模型与推理档位**：面板内直接切换 provider/模型与 reasoning effort，分组取自你的 DSH 模型目录
- **上下文用量**：状态行显示上下文占用（投影 tokens / 上下文窗口）与输出 tokens
- **待办清单**：展示 agent 的实时待办，含待办/进行中/已完成三态
- **Goal 面板**：查看与操作长期目标（创建 / 暂停 / 继续 / 完成 / 清除）

长会话不会无限膨胀：DSH 压缩历史时，被替换的消息会收敛进摘要而不是持续堆积。

## 截图演示

| 聊天侧边栏 | @ 提及文件选择 |
| --- | --- |
| ![聊天侧边栏：流式会话](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/01-chat-panel.png) | ![@ 提及文件选择弹层](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/02-mention-picker.png) |

| 内联编辑 diff 预览 | 工具审批弹窗 |
| --- | --- |
| ![内联编辑词级 diff 预览](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/03-inline-edit-diff.png) | ![DSH 工具审批弹窗](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/04-approval.png) |

| 思考过程与上下文用量 | 待办与目标 |
| --- | --- |
| ![流式中的可折叠思考过程块 + 上下文/输出用量状态行](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/05-thinking-context.png) | ![实时待办清单（三态）+ Goal 目标条](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/06-todos-goal.png) |

| 模型与推理档位 | 连接诊断 |
| --- | --- |
| ![按 provider 分组的模型下拉 + 推理档位选择](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/07-model-effort.png) | ![设置 →「诊断连接」报告连接正常](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/09-diagnose-ok.png) |

## 安装（社区插件库）

1. 设置 → 第三方插件 → 浏览 → 搜索 **DSH Bridge** → 安装 → 启用（仅桌面端）
2. 确保本地 DSH 正在运行（默认 `http://127.0.0.1:3080`）

偏好手动安装？从 [GitHub Release 页面](https://github.com/wozoulesky/dsh-obsidian/releases) 下载最新产物，解压到 `vault/.obsidian/plugins/dsh-bridge/`。

## 安装（本地开发）

1. `npm install && npm run build`
2. 把 `main.js`、`manifest.json`、`styles.css` 复制到 `vault/.obsidian/plugins/dsh-bridge/`
3. 设置 → 第三方插件 → 启用「DSH Bridge」

## 隐私

所有数据经本地 DSH 转发到其配置的模型供应商，与 DSH Web GUI 使用同一策略。插件本身不发送任何遥测。

## 翻译 / 本地化

插件内置一套 key-value UI 文案表（默认中文）。切换成其他语言：

1. 在插件设置面板点击「导出 i18n 模板」——会在 **vault 根目录**生成 `dsh-bridge.i18n.json`（Obsidian 文件树里直接可见）。
2. 把冒号后的值替换成目标语言（可交给本地 DSH 或任意翻译工具）。
3. 重载 Obsidian（或在设置里关/开插件）生效；反复编辑重载即可调整。

vault 根目录的文件优先；插件目录（`.obsidian/plugins/dsh-bridge/`）里旧式的 `i18n.json` 仍作为回退读取。缺失键或非法 JSON 会静默回落默认文案。v0.1.x 中面向模型的指令（内联编辑提示词、@提及展开文本）仍保持中文；这张 UI 文案表可安全翻译。

## 开发

```bash
npm install
npm run dev    # 监听构建
npm test       # 单元测试（550）
```

## 架构

传输层：一元 RPC 走 Node `http`（`POST /api/<namespace>/<method>` + `{args}` 载荷 + 自签 browser-session cookie）；事件流走 `ws` WebSocket（`/api/remote.mux` — `session/follow`、`session/control`、`$events`）。核心层把会话事件折叠为视图模型；UI 层渲染侧边栏与弹窗。

### DSH 版本兼容性

| DSH 版本线 | 插件版本 | 状态 |
| --- | --- | --- |
| **0.1.5 线**（已在 `0.1.5-rc.1` 验证） | 0.1.6+（含 0.1.7） | ✅ **真机验收通过**（2026-09-13）：流式输出、审批弹窗、内联编辑 diff、断线重连 |
| **0.1.2 线**（`0.1.2-rc.1`、`0.1.2`） | 0.1.5+ | ✅ **支持**——本插件最初适配的契约。0.1.6+ 通过能力探测继续兼容：0.1.5 的流式通道按字段请求，服务端拒绝则自动去参重试。真机验收于插件 0.1.5 完成，此后由单测保持 |
| 0.1.2 之前（如 `0.1.0-rc.6`） | ≤ 0.1.4 | ❌ **不支持**——返回 401/404。请升级 DSH，或继续使用插件 0.1.4 |
| 比已验证版本更新的 DSH | 最新插件 | ⚠️ **未验证**——DSH 迭代频繁，已经两次改到本插件的契约（0.1.2 → 0.1.5）。升级 DSH 后面板异常时，请先确认插件是否已更新 |

**直接文件系统访问（依社区审核要求披露）：** DSH 的 browser-session 认证需要读取签名密钥 `~/.dsh/.credentials.yaml`（DSH 进程的凭据库，位于 vault 之外）。本插件对该文件**只读**——绝不写入、绝不记录其内容，仅用该密钥签发 DSH 的 browser-session API（0.1.2-rc.1 起）所需的每请求 cookie。vault API 无法访问该路径（在 vault 根目录之外），因此这一处必须使用 Node `fs`。

## 关联项目

- [obsidian-project-management](https://github.com/wozoulesky/obsidian-project-management)：本插件开发协作所遵循的 Obsidian 项目协作 Skill（项目记录以本机 Obsidian Vault 为唯一事实来源）
