# DSH Bridge

把本地运行的 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为 AI 协作者嵌入 Obsidian：vault 就是它的工作目录，DSH 可以直接读、写、搜索你的笔记。

[English](./README.md)

## 前置条件

- 本机运行中的 DSH 服务（默认 `http://127.0.0.1:3080`）
- 你的 vault 位于 DSH 可访问的目录范围（DSH 沙箱/工作区配置决定）
- Obsidian ≥ 1.7.2，仅桌面端

## 功能

- **聊天侧边栏**：流式回复、工具调用卡片、审批/提问弹窗、会话切换与新建
- **内联编辑**：选中文本 + 热键（在 Obsidian 设置中分配）→ 指令 → 词级 diff 预览 → 替换
- **@提及文件**：输入 `@` 选择 vault 文件，内容注入上下文
- **斜杠命令与计划模式**：`/plan`、`/compact`、`/feedback`、`/goal`；`Shift+Tab` 切换计划模式

## 截图演示

| 聊天侧边栏 | @ 提及文件选择 |
| --- | --- |
| ![聊天侧边栏：流式会话](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/01-chat-panel.png) | ![@ 提及文件选择弹层](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/02-mention-picker.png) |

| 内联编辑 diff 预览 | 工具审批弹窗 |
| --- | --- |
| ![内联编辑词级 diff 预览](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/03-inline-edit-diff.png) | ![DSH 工具审批弹窗](https://raw.githubusercontent.com/wozoulesky/dsh-obsidian/master/docs/screenshots/04-approval.png) |

## 安装（本地）

1. `npm install && npm run build`
2. 把 `main.js`、`manifest.json`、`styles.css` 复制到 `vault/.obsidian/plugins/dsh-bridge/`
3. 设置 → 第三方插件 → 启用「DSH Bridge」

## 隐私

所有数据经本地 DSH 转发到其配置的模型供应商，与 DSH Web GUI 使用同一策略。插件本身不发送任何遥测。

## 翻译 / 本地化

插件内置一套 key-value UI 文案表。想翻译成自己的语言：

1. 从仓库或最新 release 复制 `i18n.template.json`，放到插件目录并改名 `i18n.json`（`.obsidian/plugins/dsh-bridge/i18n.json`）。
2. 把文件交给本地 DSH 或任意翻译工具，替换冒号后的数值。
3. 重载 Obsidian（或在设置里关/开插件）即可生效。

缺失键或非法 JSON 会静默回落默认文案。v0.1.x 中面向模型的指令（内联编辑提示词、@提及展开文本）仍保持中文；这张 UI 文案表可安全翻译。

## 开发

```bash
npm install
npm run dev    # 监听构建
npm test       # 单元测试
```

## 架构

传输层：一元 RPC 走 Node `http`（`POST /api/<method>`、`/api/respond`）；事件流走 `ws` WebSocket（`/api/events.mux`，服务端拒绝 SSE）。核心层把会话事件折叠为视图模型；UI 层渲染侧边栏与弹窗。

## 关联项目

- [obsidian-project-management](https://github.com/wozoulesky/obsidian-project-management)：本插件开发协作所遵循的 Obsidian 项目协作 Skill（项目记录以本机 Obsidian Vault 为唯一事实来源）
