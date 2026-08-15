# DSH for Obsidian

把本地运行的 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为 AI 协作者嵌入 Obsidian：vault 就是它的工作目录，DSH 可以直接读、写、搜索你的笔记。

[English](./README.en.md)

## 前置条件

- 本机运行中的 DSH 服务（默认 `http://127.0.0.1:3080`）
- 你的 vault 位于 DSH 可访问的目录范围（DSH 沙箱/工作区配置决定）
- Obsidian ≥ 1.7.2，仅桌面端

## 功能

- **聊天侧边栏**：流式回复、工具调用卡片、审批/提问弹窗、会话切换与新建
- **内联编辑**：选中文本 + 热键（在 Obsidian 设置中分配）→ 指令 → 词级 diff 预览 → 替换
- **@提及文件**：输入 `@` 选择 vault 文件，内容注入上下文
- **斜杠命令与计划模式**：`/plan`、`/compact`、`/feedback`、`/goal`；`Shift+Tab` 切换计划模式

## 安装（本地）

1. `npm install && npm run build`
2. 把 `main.js`、`manifest.json`、`styles.css` 复制到 `vault/.obsidian/plugins/dsh-obsidian/`
3. 设置 → 第三方插件 → 启用「DSH for Obsidian」

## 隐私

所有数据经本地 DSH 转发到其配置的模型供应商，与 DSH Web GUI 使用同一策略。插件本身不发送任何遥测。

## 开发

```bash
npm install
npm run dev    # 监听构建
npm test       # 单元测试
```

## 架构

传输层：一元 RPC 走 Node `http`（`POST /api/<method>`、`/api/respond`）；事件流走 `ws` WebSocket（`/api/events.mux`，服务端拒绝 SSE）。核心层把会话事件折叠为视图模型；UI 层渲染侧边栏与弹窗。详见 `docs/superpowers/specs/2026-08-13-dsh-obsidian-design.md`。
