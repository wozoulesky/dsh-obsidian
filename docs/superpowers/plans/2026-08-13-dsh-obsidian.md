# DSH for Obsidian 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Claudian 风格的 Obsidian 插件 `dsh-obsidian`：把本地 DeepSeek Harness（DSH）作为 AI 协作者嵌入 vault（聊天侧边栏、内联编辑、@提及、斜杠命令与计划模式）。

**Architecture:** 插件经 DSH 本地 HTTP API 通信：一元 RPC 走 Node `http`（`POST /api/<method>` + `/api/respond`），实时事件走打包的 `ws` WebSocket 客户端（`ws://127.0.0.1:3080/api/events.mux`，服务端拒绝 SSE GET，返回 426）。核心层把会话事件流折叠为视图模型（消息/工具卡片/投影），UI 层渲染侧边栏与弹窗。纯逻辑全部单测（Vitest + mock HTTP/WS 服务），Obsidian DOM 部分走手动验收。

**Tech Stack:** TypeScript、esbuild（cjs 输出、node builtins 全部 external）、`ws`（打包进产物）、Vitest、Obsidian Plugin API。

**设计文档：** `docs/superpowers/specs/2026-08-13-dsh-obsidian-design.md`

---

## 文件结构总览

```
manifest.json / package.json / tsconfig.json / esbuild.config.mjs / vitest.config.ts / styles.css / .gitignore
src/
├── main.ts                    # 入口与全局接线（Task 9 初版、Task 10/11 增补）
├── settings.ts                # 设置定义、加载/保存（Task 1）
├── transport/
│   ├── nodeShims.ts           # Buffer/global/process 垫片（Task 1）
│   ├── types.ts               # 线上类型 + mintId()（Task 2）
│   ├── client.ts              # DshClient：一元 RPC + respond（Task 3）
│   └── muxStream.ts           # MuxStream：WS 帧流 + 退避重连（Task 4）
├── core/
│   ├── eventFold.ts           # 事件 → 视图模型纯函数（Task 5）
│   ├── store.ts               # SessionStore：按会话聚合并接收 mux 帧（Task 6）
│   ├── sessionManager.ts      # 会话列表/切换/创建/翻页（Task 7）
│   ├── approvalCenter.ts      # 审批/提问队列 + respond（Task 8）
│   ├── wordDiff.ts            # 词级 diff（Task 10）
│   └── inlineEdit.ts          # 内联编辑服务（Task 10）
├── ui/
│   ├── prompts.ts             # 内建命令清单 + @提及解析（Task 9）
│   ├── chatView.ts            # 侧边栏视图 + 审批/提问弹窗（Task 9）
│   ├── inputBox.ts            # 输入框 + 联想弹层 + Shift+Tab（Task 9）
│   ├── diffPreview.ts         # diff 预览弹窗（Task 10）
│   ├── inlineEditModal.ts     # 内联编辑指令弹窗（Task 10）
│   └── settingsTab.ts         # 设置面板（Task 11）
tests/                         # 与 src 对应的 *.test.ts
```

**环境约束（实施者必须知道）：**
- Obsidian 渲染进程 nodeIntegration=false；插件运行时 `require` 可用（node builtins 裸名，如 `require('buffer')`）。esbuild 必须 external 全部 node builtins（`builtin-modules` 包提供清单）。
- 任何经浏览器栈的请求（`fetch`/`requestUrl`/原生 `WebSocket`）都会带 `Origin: app://obsidian.md`，被 DSH 安全围栏拒绝；**只允许** Node `http` 与 `ws`。
- 版本线格式（已从 rc.6 源码确认）：一元请求 `{type:'client-request', rpcId, method, payload}`；响应 `{type:'server-response', rpcId, result}`；mux 帧信封 `{type:'server-request', rpcId, method, payload}`；应答 `{type:'client-response', rpcId, result}`，`POST /api/respond` 回执 `{accepted:true} | {accepted:false, reason:'not-pending'|'bad-response'}`。

---

## Task 1: 项目脚手架

**Files:**
- Create: `package.json`、`tsconfig.json`、`esbuild.config.mjs`、`vitest.config.ts`、`manifest.json`、`styles.css`、`.gitignore`、`src/settings.ts`、`src/transport/nodeShims.ts`、`src/main.ts`

- [ ] **Step 1: 创建 package.json**

```json
{
  "name": "dsh-obsidian",
  "version": "0.1.0",
  "description": "把 DeepSeek Harness (DSH) 嵌入 Obsidian：聊天侧边栏、内联编辑、@提及与斜杠命令",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "test": "vitest run"
  },
  "keywords": ["obsidian", "dsh", "deepseek", "agent"],
  "license": "MIT",
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.10",
    "builtin-modules": "^3.3.0",
    "esbuild": "^0.21.0",
    "obsidian": "^1.7.2",
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "target": "ES2018",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noImplicitAny": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "lib": ["ES2018", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*.ts", "tests/**/*.ts", "types/**/*.d.ts"]
}
```

- [ ] **Step 3: 创建 esbuild.config.mjs**

```js
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
  banner: { js: `/* dsh-obsidian — built ${new Date().toISOString()} */` },
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "bufferutil",
    "utf-8-validate",
    ...builtins,
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
```

- [ ] **Step 4: 创建 vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    passWithNoTests: true,
  },
});
```

- [ ] **Step 5: 创建 manifest.json**

```json
{
  "id": "dsh-obsidian",
  "name": "DSH for Obsidian",
  "version": "0.1.0",
  "minAppVersion": "1.7.2",
  "description": "将本地 DeepSeek Harness (DSH) 作为 AI 协作者嵌入 vault：聊天、内联编辑、@提及与斜杠命令",
  "author": "dsh-bridge",
  "isDesktopOnly": true
}
```

- [ ] **Step 6: 创建 styles.css**

```css
.dsh-chat { display: flex; flex-direction: column; height: 100%; }
.dsh-chat-header { padding: 8px; border-bottom: 1px solid var(--background-modifier-border); }
.dsh-chat-status { font-size: 0.85em; color: var(--text-muted); }
.dsh-chat-messages { flex: 1 1 auto; overflow-y: auto; padding: 8px; }
.dsh-msg-user { background: var(--background-secondary); border-radius: 8px; padding: 6px 10px; margin: 6px 0; }
.dsh-msg-assistant { margin: 6px 0; }
.dsh-msg-context { font-size: 0.85em; color: var(--text-muted); border-left: 2px solid var(--background-modifier-border); padding-left: 8px; margin: 4px 0; }
.dsh-msg-command { font-size: 0.9em; color: var(--text-accent); border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 4px 8px; margin: 6px 0; }
.dsh-tool-card { border: 1px solid var(--background-modifier-border); border-radius: 6px; padding: 4px 8px; margin: 6px 0; font-size: 0.9em; }
.dsh-tool-card summary { cursor: pointer; color: var(--text-muted); }
.dsh-tool-result { white-space: pre-wrap; max-height: 200px; overflow-y: auto; font-family: var(--font-monospace); font-size: 0.85em; }
.dsh-plan-banner { background: var(--color-orange); color: var(--text-on-accent); padding: 4px 10px; border-radius: 6px; margin-bottom: 6px; }
.dsh-input-wrap { padding: 8px; border-top: 1px solid var(--background-modifier-border); position: relative; }
.dsh-input { width: 100%; min-height: 44px; resize: vertical; }
.dsh-suggest { position: absolute; bottom: 100%; left: 8px; right: 8px; max-height: 200px; overflow-y: auto; background: var(--background-primary); border: 1px solid var(--background-modifier-border); border-radius: 6px; z-index: 10; }
.dsh-suggest-item { padding: 4px 8px; cursor: pointer; }
.dsh-suggest-item.dsh-active { background: var(--background-modifier-hover); }
.dsh-diff-add { background: var(--background-modifier-success); }
.dsh-diff-del { background: var(--background-modifier-error); text-decoration: line-through; }
.dsh-diff-eq { color: var(--text-normal); }
```

- [ ] **Step 7: 创建 .gitignore**

```
node_modules/
main.js
*.map
data.json
```

- [ ] **Step 8: 创建 src/settings.ts**

```ts
export interface DshPluginSettings {
  dshUrl: string;
  mentionMaxChars: number;
  inlineEditTimeoutSec: number;
  historyPageSize: number;
  inlineEditSessionId: string;
}

export const DEFAULT_SETTINGS: DshPluginSettings = {
  dshUrl: "http://127.0.0.1:3080",
  mentionMaxChars: 8000,
  inlineEditTimeoutSec: 180,
  historyPageSize: 50,
  inlineEditSessionId: "",
};

/** 设置模型：负责 load/save 与便捷访问器；UI 面板在 Task 11 的 settingsTab.ts。 */
export class DshSettings {
  values: DshPluginSettings = { ...DEFAULT_SETTINGS };

  constructor(
    private host: {
      loadData(): Promise<unknown>;
      saveData(data: unknown): Promise<void>;
    }
  ) {}

  async load(): Promise<void> {
    const data = (await this.host.loadData()) as Partial<DshPluginSettings> | null;
    this.values = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
  }

  async save(): Promise<void> {
    await this.host.saveData(this.values);
  }

  /** 去掉尾部斜杠的 DSH 地址。 */
  get dshUrl(): string {
    return this.values.dshUrl.replace(/\/+$/, "");
  }
}
```

- [ ] **Step 9: 创建 src/transport/nodeShims.ts**

```ts
/**
 * Obsidian 渲染进程以 nodeIntegration=false 运行，但插件运行时仍可 require 内置模块。
 * 打包进产物的 `ws` 依赖 Buffer/global/process.nextTick，这里补齐缺失的全局。
 */
declare function require(module: string): unknown;

export function installNodeShims(): void {
  const g = globalThis as Record<string, unknown>;
  if (typeof g.Buffer === "undefined") {
    const buffer = require("buffer") as { Buffer: unknown };
    g.Buffer = buffer.Buffer;
  }
  if (typeof g.global === "undefined") {
    g.global = g;
  }
  const proc = g.process as (NodeJS.Process & Record<string, unknown>) | undefined;
  if (proc && typeof proc.nextTick !== "function") {
    proc.nextTick = (fn: () => void) => queueMicrotask(fn);
  }
}
```

- [ ] **Step 10: 创建最小 src/main.ts**

```ts
import { Plugin } from "obsidian";
import { installNodeShims } from "./transport/nodeShims";
import { DshSettings } from "./settings";

export default class DshPlugin extends Plugin {
  settings = new DshSettings(this);

  async onload(): Promise<void> {
    installNodeShims();
    await this.settings.load();
  }

  onunload(): void {}
}
```

- [ ] **Step 11: 安装依赖并验证构建与测试**

Run: `npm install`
Run: `npm run build`
Expected: 生成 `main.js`，无报错。
Run: `npm test`
Expected: `No test files found`（passWithNoTests 生效），退出码 0。

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.config.mjs vitest.config.ts manifest.json styles.css .gitignore src/settings.ts src/transport/nodeShims.ts src/main.ts
git commit -m "chore: 项目脚手架（esbuild + vitest + 设置模型 + node 垫片）"
```

---

## Task 2: 线上类型与 id 生成

**Files:**
- Create: `src/transport/types.ts`
- Test: `tests/transport/types.test.ts`

- [ ] **Step 1: 写失败测试 tests/transport/types.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { isServerResponse, mintId } from "../../src/transport/types";

describe("mintId", () => {
  it("生成符合 UUID v4 格式的唯一字符串", () => {
    const a = mintId();
    const b = mintId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});

describe("isServerResponse", () => {
  it("接受合法响应信封", () => {
    expect(isServerResponse({ type: "server-response", rpcId: "x", result: { ok: true, value: 1 } })).toBe(true);
  });
  it("拒绝缺少字段或类型错误的值", () => {
    expect(isServerResponse(null)).toBe(false);
    expect(isServerResponse({})).toBe(false);
    expect(isServerResponse({ type: "client-request", rpcId: "x", method: "m", payload: {} })).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/transport/types.test.ts`
Expected: FAIL —— 找不到 `../../src/transport/types`。

- [ ] **Step 3: 实现 src/transport/types.ts**

```ts
/* DSH 线上契约类型（依据 @deepseek-ai/dsh 0.1.0-rc.6 源码确认）。 */

/* ---- RPC 信封 ---- */

export interface RpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

export interface ClientRequest {
  type: "client-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface ServerResponse {
  type: "server-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export interface ServerRequest {
  type: "server-request";
  rpcId: string;
  method: string;
  payload: unknown;
}

export interface ClientResponse {
  type: "client-response";
  rpcId: string;
  result: RpcResult<unknown>;
}

export type RpcReceipt = { accepted: true } | { accepted: false; reason: "not-pending" | "bad-response" };

export function isServerResponse(x: unknown): x is ServerResponse {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return o.type === "server-response" && typeof o.rpcId === "string" && typeof o.result === "object" && o.result !== null;
}

/** 浏览器安全 UUID v4（不依赖 secure context，Electron 渲染进程可用）。 */
export function mintId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/* ---- 会话域 ---- */

export interface SessionSummary {
  sessionId: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  parentSessionId?: string;
  origin?: "subagent";
  cwd?: string;
  agentPreset?: string;
  projections?: ProjectionsBlock;
}

export interface SessionListResult {
  items: SessionSummary[];
}

export interface SessionCreatePayload {
  cwd?: string;
  sessionId?: string;
  agentPreset?: string;
}

export interface SessionCreateResult {
  sessionId: string;
  agentPreset?: string;
}

export type PromptContentPart = { type: "text"; text: string };

export interface PromptPayload {
  sessionId: string;
  mode: "queue" | "steer";
  content: PromptContentPart[];
  clientTimeZone?: string;
}

export interface PromptResult {
  accepted: true;
  command?: { kind: "success"; text?: string };
}

export interface HistoryPayload {
  sessionId: string;
  beforeSeq?: number;
  maxMessages?: number;
}

export interface HistoryResult {
  events: HistoryEntry[];
  hasMore: boolean;
  projections?: ProjectionsBlock;
}

export interface HistoryEntry {
  event: SessionEvent;
  view?: unknown;
}

export interface ProjectionsBlock {
  asOfSeq: number;
  values: Record<string, unknown>;
}

/* ---- 会话事件（最小子集 + 折叠所需的负载形状） ---- */

export interface SessionEvent {
  type: string;
  seq: number;
  time: number;
  data: Record<string, unknown>;
  ignorable?: true;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "image"; attachment: unknown }
  | { type: "tool-call"; id: string; name: string; arguments: string }
  | { type: "tool-result"; toolCallId: string; content: ContentBlock[]; isError?: boolean };

export interface UserMessage {
  id: string;
  role: "user";
  content: ContentBlock[];
  source: { kind: string };
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  source: { kind: "model"; provider: string; model: string };
}

export interface ToolResultMessage {
  id: string;
  role: "user";
  content: [{ type: "tool-result"; toolCallId: string; content: ContentBlock[]; isError?: boolean }];
  source: { kind: "tool"; callId: string };
}

export type StreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: ContentBlock }
  | { type: "usage"; usage: unknown }
  | { type: "finish"; reason: unknown };

/* ---- mux 帧 ---- */

export interface AskUserQuestionOption {
  label: string;
  description?: string;
}

export interface AskUserQuestionItem {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  options?: AskUserQuestionOption[];
  multiSelect?: boolean;
  intent?: { kind: "plan-review"; approve: string };
}

export interface QueuedInboxItem {
  id: string;
  placement: "queued" | "steering" | "context";
  message: unknown;
}

export type MuxFrame =
  | { type: "session/event"; sessionId: string; event: SessionEvent; view?: unknown }
  | { type: "session/subscribed"; sessionId: string; lastSeq: number }
  | { type: "session/queue"; sessionId: string; items: QueuedInboxItem[] }
  | { type: "session/jobs"; sessionId: string; jobs: unknown[] }
  | { type: "session/projection"; sessionId: string; key: string; value: unknown; seq: number }
  | { type: "approval/requested"; sessionId: string; approvalId: string; toolName: string; callId?: string; reason?: string }
  | { type: "approval/resolved"; sessionId: string; approvalId: string; outcome: string }
  | { type: "question/requested"; sessionId: string; questions: AskUserQuestionItem[] }
  | { type: "question/resolved"; sessionId: string; questionRpcId: string; outcome: "answered" | "cancelled" }
  | { type: "stream/error"; error: RpcError };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/transport/types.test.ts`
Expected: PASS（2 个 describe 全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/transport/types.ts tests/transport/types.test.ts
git commit -m "feat(transport): 线上类型定义与 UUID 生成"
```

---

## Task 3: DshClient（一元 RPC + respond）

**Files:**
- Create: `src/transport/client.ts`
- Test: `tests/transport/client.test.ts`

- [ ] **Step 1: 写失败测试 tests/transport/client.test.ts**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage } from "http";
import { DshClient, transportFailure } from "../../src/transport/client";

let server: Server;
let baseUrl: string;
let lastBody: unknown;

function json(res: IncomingMessage, body: unknown, status = 200): void {
  void res;
  void body;
  void status;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      try {
        lastBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        lastBody = null;
      }
      const url = req.url ?? "";
      if (url.startsWith("/api/session.prompt")) {
        const b = lastBody as { rpcId: string; method: string };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: b.rpcId, result: { ok: true, value: { accepted: true } } }));
      } else if (url === "/api/respond") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accepted: true }));
      } else if (url === "/api/session.create") {
        const b = lastBody as { rpcId: string; payload: { cwd?: string; forceMismatch?: boolean } };
        const echoId = b.payload?.forceMismatch === true ? "other-id" : b.rpcId;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "server-response", rpcId: echoId, result: { ok: true, value: { sessionId: "sess-1" } } }));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("DshClient", () => {
  it("prompt 发送正确信封并解析成功响应", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.prompt({ sessionId: "s", mode: "queue", content: [{ type: "text", text: "你好" }] });
    expect(res.ok).toBe(true);
    expect(lastBody).toMatchObject({ type: "client-request", method: "session.prompt" });
  });

  it("create 透传 cwd 载荷", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.create({ cwd: "C:\\vault" });
    expect(res.ok && res.value.sessionId).toBe("sess-1");
    expect(lastBody).toMatchObject({ payload: { cwd: "C:\\vault" } });
  });

  it("响应 rpcId 不匹配时返回 internal 错误", async () => {
    const client = new DshClient({ baseUrl });
    const res = await client.call("session.create", { forceMismatch: true }, { forceRpcId: "mine" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("internal");
      expect(res.error.message).toContain("rpcId");
    }
  });

  it("非 2xx 状态码抛 transportFailure", async () => {
    const client = new DshClient({ baseUrl: `${baseUrl}/definitely-missing` });
    await expect(client.list()).rejects.toBeInstanceOf(transportFailure);
  });

  it("respond 使用 client-response 信封并回传回执", async () => {
    const client = new DshClient({ baseUrl });
    const receipt = await client.respond("rpc-x", { sessionId: "s", approvalId: "a", outcome: "allowed-once" });
    expect(receipt.accepted).toBe(true);
    expect(lastBody).toMatchObject({
      type: "client-response",
      rpcId: "rpc-x",
      result: { ok: true, value: { outcome: "allowed-once" } },
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/transport/client.test.ts`
Expected: FAIL —— 找不到 `../../src/transport/client`。

- [ ] **Step 3: 实现 src/transport/client.ts**

```ts
import * as http from "http";
import { mintId, isServerResponse, type ClientRequest, type ClientResponse, type RpcResult, type RpcReceipt, type ServerResponse, type HistoryPayload, type HistoryResult, type PromptPayload, type PromptResult, type SessionCreatePayload, type SessionCreateResult, type SessionListResult, type CancelPayload, type CancelResult } from "./types";

export class TransportFailure extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransportFailure";
  }
}

export const transportFailure = TransportFailure;

/** Node http POST，返回响应文本；非 2xx 抛 TransportFailure。 */
export function postJson(url: string, body: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port ? Number(u.port) : 80,
        path: u.pathname,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(text);
          } else {
            reject(new TransportFailure(`HTTP ${String(res.statusCode)} for ${url}`));
          }
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new TransportFailure(`timeout after ${timeoutMs}ms`)));
    req.on("error", (err) => reject(new TransportFailure(err.message, err)));
    req.write(body);
    req.end();
  });
}

export interface DshClientOptions {
  baseUrl: string;
  timeoutMs?: number;
  /** 测试钩子：强制某个调用的 rpcId（服务端据此回显不匹配的 id）。 */
  forceRpcId?: string;
}

export class DshClient {
  constructor(private opts: DshClientOptions) {}

  /** 通用一元调用：铸造 rpcId → POST /api/<method> → 校验回显 → 返回 result。 */
  async call<T>(method: string, payload: unknown, overrides?: { forceRpcId?: string }): Promise<RpcResult<T>> {
    const rpcId = overrides?.forceRpcId ?? this.opts.forceRpcId ?? mintId();
    const request: ClientRequest = { type: "client-request", rpcId, method, payload };
    const timeoutMs = this.opts.timeoutMs ?? 30000;
    const text = await postJson(`${this.opts.baseUrl}/api/${method}`, JSON.stringify(request), timeoutMs);
    let full: unknown;
    try {
      full = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: { code: "internal", message: "DSH 返回了无法解析的响应" },
      };
    }
    if (!isServerResponse(full)) {
      return { ok: false, error: { code: "internal", message: "DSH 响应信封格式非法" } };
    }
    if (full.rpcId !== rpcId) {
      return {
        ok: false,
        error: { code: "internal", message: `rpcId 不匹配：发送 ${rpcId}，收到 ${full.rpcId}` },
      };
    }
    return full.result as RpcResult<T>;
  }

  /** 应答服务端请求（审批/提问），rpcId 必须回显请求帧的信封 rpcId。 */
  async respond<T>(rpcId: string, value: T): Promise<RpcReceipt> {
    const message: ClientResponse = { type: "client-response", rpcId, result: { ok: true, value } };
    const timeoutMs = this.opts.timeoutMs ?? 30000;
    const text = await postJson(`${this.opts.baseUrl}/api/respond`, JSON.stringify(message), timeoutMs);
    const receipt = JSON.parse(text) as RpcReceipt;
    if (receipt.accepted === true) return receipt;
    if (receipt.accepted === false) return receipt;
    return { accepted: false, reason: "bad-response" };
  }

  list(): Promise<RpcResult<SessionListResult>> {
    return this.call<SessionListResult>("session.list", {});
  }

  create(payload: SessionCreatePayload): Promise<RpcResult<SessionCreateResult>> {
    return this.call<SessionCreateResult>("session.create", payload);
  }

  prompt(payload: PromptPayload): Promise<RpcResult<PromptResult>> {
    return this.call<PromptResult>("session.prompt", payload);
  }

  history(payload: HistoryPayload): Promise<RpcResult<HistoryResult>> {
    return this.call<HistoryResult>("session.history", payload);
  }

  cancel(payload: CancelPayload): Promise<RpcResult<CancelResult>> {
    return this.call<CancelResult>("session.cancel", payload);
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/transport/client.test.ts`
Expected: PASS（5 个用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/transport/client.ts tests/transport/client.test.ts
git commit -m "feat(transport): DshClient 一元 RPC 与 respond"
```

---

## Task 4: MuxStream（WebSocket 事件流 + 重连）

**Files:**
- Create: `src/transport/muxStream.ts`
- Test: `tests/transport/muxStream.test.ts`

- [ ] **Step 1: 写失败测试 tests/transport/muxStream.test.ts**

```ts
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { MuxStream, type MuxSink } from "../../src/transport/muxStream";
import type { MuxFrame } from "../../src/transport/types";

let wss: WebSocketServer;
let port = 0;
let connections: WebSocket[] = [];

function makeSink() {
  const frames: { rpcId: string; frame: MuxFrame }[] = [];
  const states: string[] = [];
  const sink: MuxSink = {
    onFrame: (rpcId, frame) => frames.push({ rpcId, frame }),
    onState: (s) => states.push(s),
  };
  return { sink, frames, states };
}

beforeAll(async () => {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", resolve));
  port = (wss.address() as { port: number }).port;
  wss.on("connection", (ws) => {
    connections.push(ws);
    const push = (payload: MuxFrame) => ws.send(JSON.stringify({ type: "server-request", rpcId: "r1", method: "events.mux", payload }));
    setTimeout(() => {
      push({ type: "session/subscribed", sessionId: "s1", lastSeq: 3 });
      push({ type: "session/event", sessionId: "s1", event: { type: "turn/start", seq: 4, time: 1, data: { turn: 1 } } });
    }, 10);
  });
});

afterAll(() => new Promise<void>((resolve) => wss.close(() => resolve())));

describe("MuxStream", () => {
  it("连接后接收帧并报告状态", async () => {
    connections = [];
    const { sink, frames, states } = makeSink();
    const stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 20 });
    stream.start();
    await vi.waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    expect(frames[0].frame).toMatchObject({ type: "session/subscribed", sessionId: "s1" });
    expect(states).toContain("connected");
    stream.stop();
  });

  it("坏帧被丢弃且不中断流", async () => {
    connections = [];
    const { sink, frames, states } = makeSink();
    const stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 20 });
    stream.start();
    await vi.waitFor(() => expect(connections.length).toBe(1), { timeout: 2000 });
    connections[0].send("not-json");
    await new Promise((r) => setTimeout(r, 50));
    expect(frames.length).toBe(0);
    expect(states.filter((s) => s === "connected").length).toBe(1);
    stream.stop();
  });

  it("服务端断开后自动重连", async () => {
    connections = [];
    const { sink, states } = makeSink();
    const stream = new MuxStream(`http://127.0.0.1:${port}`, sink, { backoffBaseMs: 20 });
    stream.start();
    await vi.waitFor(() => expect(connections.length).toBe(1), { timeout: 2000 });
    connections[0].close();
    await vi.waitFor(() => expect(connections.length).toBe(2), { timeout: 2000 });
    expect(states.filter((s) => s === "reconnecting").length).toBeGreaterThanOrEqual(1);
    stream.stop();
    await new Promise((r) => setTimeout(r, 100));
    const countAfterStop = connections.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(connections.length).toBe(countAfterStop);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/transport/muxStream.test.ts`
Expected: FAIL —— 找不到 `../../src/transport/muxStream`。

- [ ] **Step 3: 实现 src/transport/muxStream.ts**

```ts
import WebSocket from "ws";
import type { MuxFrame, ServerRequest } from "./types";

export type MuxState = "connected" | "reconnecting";

export interface MuxSink {
  /** 每帧：信封 rpcId + MuxFrame payload。 */
  onFrame(rpcId: string, frame: MuxFrame): void;
  /** 状态变化（去重后的转换）。 */
  onState(state: MuxState): void;
}

export interface MuxStreamOptions {
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** 与 /api/events.mux 的纯下行 WebSocket 连接，指数退避自动重连。 */
export class MuxStream {
  private socket: WebSocket | null = null;
  private stopped = false;
  private attempt = 0;
  private lastState: MuxState | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;

  constructor(
    private baseUrl: string,
    private sink: MuxSink,
    options: MuxStreamOptions = {}
  ) {
    this.backoffBaseMs = options.backoffBaseMs ?? 500;
    this.backoffMaxMs = options.backoffMaxMs ?? 30000;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    this.emitState("reconnecting");
    const url = this.baseUrl.replace(/^http/, "ws") + "/api/events.mux";
    const socket = new WebSocket(url, { handshakeTimeout: 5000 });
    this.socket = socket;
    socket.on("open", () => {
      this.attempt = 0;
      this.emitState("connected");
    });
    socket.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ServerRequest;
        this.sink.onFrame(msg.rpcId, msg.payload as MuxFrame);
      } catch (err) {
        console.error("[dsh-obsidian] 丢弃非法 mux 帧:", err);
      }
    });
    socket.on("close", () => this.scheduleReconnect());
    socket.on("error", () => {
      /* close 事件随后触发；这里不直接重连，避免与 close 重复调度 */
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempt += 1;
    const delay = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (this.attempt - 1));
    this.timer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, delay);
  }

  private emitState(state: MuxState): void {
    if (this.lastState !== state) {
      this.lastState = state;
      this.sink.onState(state);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
    this.socket = null;
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/transport/muxStream.test.ts`
Expected: PASS（3 个用例通过；首个用例需 `import { vi } from "vitest"`）。

- [ ] **Step 5: Commit**

```bash
git add src/transport/muxStream.ts tests/transport/muxStream.test.ts
git commit -m "feat(transport): MuxStream WebSocket 事件流与退避重连"
```

---

## Task 5: eventFold（事件折叠纯函数）

**Files:**
- Create: `src/core/eventFold.ts`
- Test: `tests/core/eventFold.test.ts`

- [ ] **Step 1: 写失败测试 tests/core/eventFold.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { createSessionView, foldEvent, type SessionView } from "../../src/core/eventFold";
import type { SessionEvent } from "../../src/transport/types";

function ev(type: string, seq: number, data: Record<string, unknown>): SessionEvent {
  return { type, seq, time: seq * 1000, data };
}

describe("foldEvent", () => {
  it("user/message 生成用户节点，工具类来源跳过", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("user/message", 1, { id: "m1", role: "user", content: [{ type: "text", text: "你好" }], source: { kind: "user" } }));
    foldEvent(view, ev("user/message", 2, { id: "m2", role: "user", content: [{ type: "text", text: "tool-data" }], source: { kind: "tool", callId: "c1" } }));
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "user", text: "你好" });
  });

  it("assistant/chunk 增量流式追加文本", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("turn/start", 1, { turn: 1 }));
    foldEvent(view, ev("assistant/chunk", 2, { turn: 1, step: 1, chunk: { type: "block-start", index: 0, blockType: "text" } }));
    foldEvent(view, ev("assistant/chunk", 3, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "你" } }));
    foldEvent(view, ev("assistant/chunk", 4, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "好" } }));
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "assistant", text: "你好", streaming: true });
  });

  it("assistant/message 终结流式节点并生成工具卡片", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/chunk", 1, { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "查一下" } }));
    foldEvent(view, ev("assistant/message", 2, {
      turn: 1,
      step: 1,
      message: {
        id: "am1",
        role: "assistant",
        content: [
          { type: "text", text: "查一下" },
          { type: "tool-call", id: "c1", name: "read", arguments: '{"path":"a.md"}' },
        ],
        source: { kind: "model", provider: "deepseek", model: "v4" },
      },
    }));
    const node = view.nodes[0];
    expect(node).toMatchObject({ kind: "assistant", streaming: false });
    if (node.kind === "assistant") {
      expect(node.toolCards).toHaveLength(1);
      expect(node.toolCards[0]).toMatchObject({ id: "c1", name: "read", status: "running" });
    }
  });

  it("tool/result 落卡到对应工具卡片", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("assistant/message", 1, {
      turn: 1, step: 1,
      message: { id: "am1", role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", arguments: "{}" }], source: { kind: "model", provider: "p", model: "m" } },
    }));
    foldEvent(view, ev("tool/result", 2, {
      turn: 1, step: 1,
      message: { id: "tr1", role: "user", content: [{ type: "tool-result", toolCallId: "c1", content: [{ type: "text", text: "文件内容" }], isError: false }], source: { kind: "tool", callId: "c1" } },
    }));
    const node = view.nodes[0];
    if (node.kind === "assistant") {
      expect(node.toolCards[0]).toMatchObject({ status: "done", resultText: "文件内容" });
    }
  });

  it("command/run 与 command/done 生成命令卡片", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("command/run", 1, { commandId: "cmd1", name: "plan", args: undefined, source: { kind: "user" } }));
    expect(view.nodes[0]).toMatchObject({ kind: "command", status: "running" });
    foldEvent(view, ev("command/done", 2, { commandId: "cmd1", kind: "success", text: "计划模式已开启" }));
    expect(view.nodes[0]).toMatchObject({ kind: "command", status: "success", text: "计划模式已开启" });
  });

  it("session/title 与 plan/mode 更新头部状态", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("session/title", 1, { title: "我的会话", source: "fallback" }));
    expect(view.title).toBe("我的会话");
    foldEvent(view, ev("plan/mode", 2, { active: true }));
    expect(view.plan.active).toBe(true);
  });

  it("turn/start 与 turn/end 维护 running 标志", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("turn/start", 1, { turn: 1 }));
    expect(view.running).toBe(true);
    foldEvent(view, ev("turn/end", 2, { turn: 1, reason: { kind: "completed" } }));
    expect(view.running).toBe(false);
  });

  it("回合出错时追加错误节点", () => {
    const view = createSessionView("s1");
    foldEvent(view, ev("turn/start", 1, { turn: 1 }));
    foldEvent(view, ev("turn/end", 2, { turn: 1, reason: { kind: "error", error: { message: "模型挂了", code: "E1" } } }));
    expect(view.nodes.at(-1)).toMatchObject({ kind: "error", text: "回合错误：模型挂了" });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/eventFold.test.ts`
Expected: FAIL —— 找不到 `../../src/core/eventFold`。

- [ ] **Step 3: 实现 src/core/eventFold.ts**

```ts
import type { ContentBlock, SessionEvent, StreamChunk } from "../transport/types";

export interface ToolCard {
  id: string;
  name: string;
  args: string;
  status: "running" | "done" | "error";
  resultText?: string;
}

export interface UserNode {
  kind: "user";
  id: string;
  text: string;
  sourceKind: string;
  seq: number;
}

export interface AssistantNode {
  kind: "assistant";
  id: string;
  text: string;
  reasoning: string;
  toolCards: ToolCard[];
  /** 是否还在流式输出（未收到 assistant/message 或 turn/end）。 */
  streaming: boolean;
  seq: number;
}

export interface CommandNode {
  kind: "command";
  id: string;
  name: string;
  text?: string;
  status: "running" | "success" | "error";
  seq: number;
}

export interface ErrorNode {
  kind: "error";
  id: string;
  text: string;
  seq: number;
}

export type ViewNode = UserNode | AssistantNode | CommandNode | ErrorNode;

export interface SessionView {
  sessionId: string;
  nodes: ViewNode[];
  title: string | null;
  plan: { active: boolean; pending: boolean };
  queueItems: unknown[];
  lastSeq: number;
  running: boolean;
}

export function createSessionView(sessionId: string): SessionView {
  return { sessionId, nodes: [], title: null, plan: { active: false, pending: false }, queueItems: [], lastSeq: -1, running: false };
}

/** 从内容块提取可见文本（text 块以空行连接）。 */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
}

function lastAssistant(view: SessionView): AssistantNode | undefined {
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const n = view.nodes[i];
    if (n.kind === "assistant") return n;
  }
  return undefined;
}

function findCard(view: SessionView, callId: string): ToolCard | undefined {
  for (const n of view.nodes) {
    if (n.kind === "assistant") {
      const card = n.toolCards.find((c) => c.id === callId);
      if (card) return card;
    }
  }
  return undefined;
}

function applyChunk(node: AssistantNode, chunk: StreamChunk): void {
  switch (chunk.type) {
    case "text-delta":
      node.text += chunk.text;
      break;
    case "reasoning-delta":
      node.reasoning += chunk.text;
      break;
    case "tool-call-delta": {
      const card = node.toolCards.find((c) => c.id === chunk.id) ?? node.toolCards[node.toolCards.length - 1];
      if (card && card.status === "running") card.args += chunk.argumentsDelta;
      break;
    }
    case "block-end": {
      if (chunk.block.type === "tool-call") {
        node.toolCards.push({ id: chunk.block.id, name: chunk.block.name, args: chunk.block.arguments, status: "running" });
      }
      break;
    }
    default:
      break;
  }
}

/** 把一个 SessionEvent 折叠进视图模型（纯函数，原地更新 view）。 */
export function foldEvent(view: SessionView, event: SessionEvent): void {
  if (event.seq > view.lastSeq) view.lastSeq = event.seq;
  const data = event.data;

  switch (event.type) {
    case "turn/start":
      view.running = true;
      break;
    case "turn/end": {
      view.running = false;
      const reason = data.reason as { kind?: string; error?: { message?: string; code?: string } };
      if (reason?.kind === "error") {
        view.nodes.push({ kind: "error", id: `err-${event.seq}`, text: `回合错误：${reason.error?.message ?? "未知错误"}`, seq: event.seq });
      }
      const node = lastAssistant(view);
      if (node) node.streaming = false;
      break;
    }
    case "user/message": {
      const sourceKind = ((data.source as { kind?: string }) ?? {}).kind ?? "user";
      if (sourceKind === "tool") break; // 工具结果走 tool/result 事件
      const text = blocksToText((data.content as ContentBlock[]) ?? []);
      view.nodes.push({ kind: "user", id: String(data.id ?? `u-${event.seq}`), text, sourceKind, seq: event.seq });
      break;
    }
    case "assistant/chunk": {
      const node = lastAssistant(view)?.streaming ? lastAssistant(view) : undefined;
      const target: AssistantNode = node ?? {
        kind: "assistant",
        id: `a-${event.seq}`,
        text: "",
        reasoning: "",
        toolCards: [],
        streaming: true,
        seq: event.seq,
      };
      if (!node) view.nodes.push(target);
      applyChunk(target, data.chunk as StreamChunk);
      break;
    }
    case "assistant/message": {
      const message = data.message as { id?: string; content?: ContentBlock[] };
      const content = message?.content ?? [];
      const text = blocksToText(content);
      const toolCalls = content.filter((b): b is Extract<ContentBlock, { type: "tool-call" }> => b.type === "tool-call");
      const existing = lastAssistant(view);
      const target: AssistantNode = existing?.streaming
        ? existing
        : {
            kind: "assistant",
            id: String(message?.id ?? `a-${event.seq}`),
            text: "",
            reasoning: "",
            toolCards: [],
            streaming: false,
            seq: event.seq,
          };
      if (!existing?.streaming) view.nodes.push(target);
      target.streaming = false;
      if (target.text.length === 0) target.text = text;
      for (const call of toolCalls) {
        if (!target.toolCards.some((c) => c.id === call.id)) {
          target.toolCards.push({ id: call.id, name: call.name, args: call.arguments, status: "running" });
        }
      }
      break;
    }
    case "tool/result": {
      const message = data.message as { content?: ContentBlock[]; source?: { callId?: string } };
      const callId = message?.source?.callId;
      if (!callId) break;
      const card = findCard(view, callId);
      if (card) {
        card.status = ((data.error ?? undefined) !== undefined ? "error" : "done") as ToolCard["status"];
        card.resultText = blocksToText(message?.content ?? []);
      }
      break;
    }
    case "command/run":
      view.nodes.push({
        kind: "command",
        id: String(data.commandId ?? `cmd-${event.seq}`),
        name: String(data.name ?? ""),
        status: "running",
        seq: event.seq,
      });
      break;
    case "command/done": {
      const id = String(data.commandId ?? "");
      for (const n of view.nodes) {
        if (n.kind === "command" && n.id === id) {
          n.status = data.kind === "success" ? "success" : "error";
          n.text = typeof data.text === "string" ? data.text : undefined;
        }
      }
      break;
    }
    case "session/title":
      if (typeof data.title === "string" && data.title.length > 0) view.title = data.title;
      break;
    case "plan/mode":
      view.plan.active = data.active === true;
      view.plan.pending = false;
      break;
    default:
      break; // 未知事件类型（含可忽略扩展）直接跳过
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/eventFold.test.ts`
Expected: PASS（8 个用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/core/eventFold.ts tests/core/eventFold.test.ts
git commit -m "feat(core): 会话事件折叠为视图模型"
```

---

## Task 6: SessionStore（按会话聚合 + mux 帧分发）

**Files:**
- Create: `src/core/store.ts`
- Test: `tests/core/store.test.ts`

- [ ] **Step 1: 写失败测试 tests/core/store.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { SessionStore } from "../../src/core/store";
import type { MuxFrame } from "../../src/transport/types";

describe("SessionStore", () => {
  it("session/event 帧折叠进对应会话视图", () => {
    const store = new SessionStore();
    store.applyMux("r1", {
      type: "session/event",
      sessionId: "s1",
      event: { type: "user/message", seq: 1, time: 1, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } },
    });
    const view = store.ensureView("s1");
    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]).toMatchObject({ kind: "user", text: "hi" });
  });

  it("session/projection 更新 title 与 plan", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "session/projection", sessionId: "s1", key: "title", value: "标题A", seq: 1 });
    store.applyMux("r2", { type: "session/projection", sessionId: "s1", key: "plan", value: { active: true, pending: true }, seq: 2 });
    const view = store.ensureView("s1");
    expect(view.title).toBe("标题A");
    expect(view.plan).toEqual({ active: true, pending: true });
  });

  it("投影按 higher-seq-wins 覆盖，旧 seq 不覆盖新值", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "session/projection", sessionId: "s1", key: "title", value: "新", seq: 5 });
    store.applyMux("r2", { type: "session/projection", sessionId: "s1", key: "title", value: "旧", seq: 3 });
    expect(store.ensureView("s1").title).toBe("新");
  });

  it("session/subscribed 更新 lastSeq 基线", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "session/subscribed", sessionId: "s1", lastSeq: 42 });
    expect(store.ensureView("s1").lastSeq).toBe(42);
  });

  it("seedHistory 按序折叠并触发变更回调", () => {
    const store = new SessionStore();
    let changed = 0;
    store.onChange(() => changed++);
    store.seedHistory("s1", [
      { event: { type: "session/title", seq: 1, time: 1, data: { title: "T", source: "fallback" } } },
      { event: { type: "user/message", seq: 2, time: 2, data: { id: "m1", role: "user", content: [{ type: "text", text: "hello" }], source: { kind: "user" } } } },
    ]);
    const view = store.ensureView("s1");
    expect(view.title).toBe("T");
    expect(view.nodes).toHaveLength(1);
    expect(changed).toBe(1);
  });

  it("unknown 帧类型被安全忽略", () => {
    const store = new SessionStore();
    store.applyMux("r1", { type: "whatever/else" } as unknown as MuxFrame);
    expect(store.ensureView("s1").nodes).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/store.test.ts`
Expected: FAIL —— 找不到 `../../src/core/store`。

- [ ] **Step 3: 实现 src/core/store.ts**

```ts
import { createSessionView, foldEvent, type SessionView } from "./eventFold";
import type { HistoryEntry, MuxFrame } from "../transport/types";

interface ProjectionCell {
  value: unknown;
  seq: number;
}

/** 全会话视图模型仓库：mux 帧与历史页的统一入口，higher-seq-wins 投影语义。 */
export class SessionStore {
  private views = new Map<string, SessionView>();
  private projections = new Map<string, Map<string, ProjectionCell>>();
  private listeners = new Set<() => void>();

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[dsh-obsidian] store 监听器异常:", err);
      }
    }
  }

  ensureView(sessionId: string): SessionView {
    let view = this.views.get(sessionId);
    if (!view) {
      view = createSessionView(sessionId);
      this.views.set(sessionId, view);
    }
    return view;
  }

  getView(sessionId: string): SessionView | undefined {
    return this.views.get(sessionId);
  }

  private applyProjection(sessionId: string, key: string, value: unknown, seq: number): void {
    const cells = this.projections.get(sessionId) ?? new Map<string, ProjectionCell>();
    const prev = cells.get(key);
    if (prev && prev.seq > seq) return; // higher-seq-wins
    cells.set(key, { value, seq });
    this.projections.set(sessionId, cells);
    const view = this.ensureView(sessionId);
    if (key === "title") {
      if (typeof value === "string" && value.length > 0) view.title = value;
    } else if (key === "plan") {
      const plan = value as { active?: boolean; pending?: boolean };
      view.plan = { active: plan.active === true, pending: plan.pending === true };
    }
  }

  /** 处理一帧 mux 推送（rpcId 为帧信封 id，仅审批/提问需要，这里透传保留）。 */
  applyMux(_rpcId: string, frame: MuxFrame): void {
    switch (frame.type) {
      case "session/event":
        foldEvent(this.ensureView(frame.sessionId), frame.event);
        this.notify();
        break;
      case "session/subscribed": {
        const view = this.ensureView(frame.sessionId);
        if (frame.lastSeq > view.lastSeq) view.lastSeq = frame.lastSeq;
        this.notify();
        break;
      }
      case "session/projection":
        this.applyProjection(frame.sessionId, frame.key, frame.value, frame.seq);
        this.notify();
        break;
      case "session/queue": {
        this.ensureView(frame.sessionId).queueItems = frame.items;
        this.notify();
        break;
      }
      default:
        break; // 审批/提问/jobs/stream-error 由 ApprovalCenter 等处理，store 忽略
    }
  }

  /** 用历史页播种视图（调用方负责保证 seq 递增顺序）。 */
  seedHistory(sessionId: string, entries: HistoryEntry[]): void {
    const view = this.ensureView(sessionId);
    for (const entry of entries) foldEvent(view, entry.event);
    this.notify();
  }

  /** 清空单个会话视图（重连重建用）。 */
  dropView(sessionId: string): void {
    this.views.delete(sessionId);
    this.notify();
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/store.test.ts`
Expected: PASS（6 个用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/core/store.ts tests/core/store.test.ts
git commit -m "feat(core): SessionStore 会话聚合与投影语义"
```

---

## Task 7: SessionManager（列表/切换/创建/翻页）

**Files:**
- Create: `src/core/sessionManager.ts`
- Test: `tests/core/sessionManager.test.ts`

- [ ] **Step 1: 写失败测试 tests/core/sessionManager.test.ts**

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import { DshClient } from "../../src/transport/client";
import { SessionStore } from "../../src/core/store";
import { SessionManager } from "../../src/core/sessionManager";
import type { DshSettings } from "../../src/settings";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { rpcId: string; method: string; payload: Record<string, unknown> };
      const url = req.url ?? "";
      let value: unknown = {};
      if (url === "/api/session.list") {
        value = {
          items: [
            { sessionId: "remote-1", updatedAt: 3, running: false, blank: false, cwd: "C:\\elsewhere" },
            { sessionId: "vault-1", updatedAt: 2, running: true, blank: false, cwd: "C:\\vault" },
            { sessionId: "vault-2", updatedAt: 1, running: false, blank: true, cwd: "C:\\vault" },
          ],
        };
      } else if (url === "/api/session.create") {
        value = { sessionId: "new-1" };
      } else if (url === "/api/session.history") {
        const p = body.payload as { beforeSeq?: number };
        if (p.beforeSeq === 5) {
          value = { events: [{ event: { type: "user/message", seq: 4, time: 4, data: { id: "m0", role: "user", content: [{ type: "text", text: "更早的消息" }], source: { kind: "user" } } } }], hasMore: false };
        } else {
          value = {
            events: [
              { event: { type: "session/title", seq: 9, time: 9, data: { title: "标题", source: "fallback" } } },
              { event: { type: "user/message", seq: 10, time: 10, data: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" } } } },
            ],
            hasMore: true,
          };
        }
      } else if (url === "/api/session.prompt") {
        value = { accepted: true };
      } else if (url === "/api/session.cancel") {
        value = { accepted: true };
      } else {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "server-response", rpcId: body.rpcId, result: { ok: true, value } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function makeManager() {
  const client = new DshClient({ baseUrl });
  const store = new SessionStore();
  const settings = { values: { historyPageSize: 50 } } as unknown as DshSettings;
  return { client, store, manager: new SessionManager({ client, store, vaultPath: "C:\\vault", settings }) };
}

describe("SessionManager", () => {
  it("refresh 拉取列表且 vault 绑定会话置顶", async () => {
    const { manager } = makeManager();
    await manager.refresh();
    expect(manager.sessions.map((s) => s.sessionId)).toEqual(["vault-1", "vault-2", "remote-1"]);
  });

  it("newSession 以 vault 为 cwd 创建并返回 id", async () => {
    const { manager } = makeManager();
    const id = await manager.newSession();
    expect(id).toBe("new-1");
  });

  it("openSession 播种历史并设为当前会话", async () => {
    const { manager, store } = makeManager();
    await manager.openSession("vault-1");
    expect(manager.currentId).toBe("vault-1");
    expect(store.ensureView("vault-1").title).toBe("标题");
  });

  it("loadOlder 用最早 seq 翻页并前插", async () => {
    const { manager, store } = makeManager();
    await manager.openSession("vault-1");
    const hadMore = await manager.loadOlder("vault-1");
    expect(hadMore).toBe(false);
    expect(store.ensureView("vault-1").nodes[0]).toMatchObject({ text: "更早的消息" });
  });

  it("prompt/cancel 转发到 client", async () => {
    const { manager } = makeManager();
    const res = await manager.prompt("s", "你好", "queue");
    expect(res.ok).toBe(true);
    const cancel = await manager.cancel("s");
    expect(cancel.ok).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/sessionManager.test.ts`
Expected: FAIL —— 找不到 `../../src/core/sessionManager`。

- [ ] **Step 3: 实现 src/core/sessionManager.ts**

```ts
import { DshClient } from "../transport/client";
import { SessionStore } from "./store";
import { DshSettings } from "../settings";
import type { PromptResult, RpcResult, SessionSummary } from "../transport/types";

export interface SessionManagerDeps {
  client: DshClient;
  store: SessionStore;
  vaultPath: string;
  settings: DshSettings;
}

export class SessionManager {
  sessions: SessionSummary[] = [];
  currentId: string | undefined;

  constructor(private deps: SessionManagerDeps) {}

  private get client(): DshClient {
    return this.deps.client;
  }

  private isVaultBound(s: SessionSummary): boolean {
    if (!s.cwd) return false;
    const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
    return norm(s.cwd ?? "") === norm(this.deps.vaultPath) || norm(s.cwd ?? "").startsWith(norm(this.deps.vaultPath) + "\\");
  }

  private displayTitle(s: SessionSummary): string {
    const title = s.projections?.values?.title;
    return typeof title === "string" && title.length > 0 ? title : `会话 ${s.sessionId.slice(0, 8)}`;
  }

  /** 拉取会话列表；vault 绑定置顶，其余按 updatedAt 降序。 */
  async refresh(): Promise<void> {
    const res = await this.client.list();
    if (!res.ok) throw new Error(res.error.message);
    const items = [...res.value.items];
    items.sort((a, b) => {
      const va = this.isVaultBound(a) ? 0 : 1;
      const vb = this.isVaultBound(b) ? 0 : 1;
      if (va !== vb) return va - vb;
      return b.updatedAt - a.updatedAt;
    });
    this.sessions = items;
  }

  sessionTitle(sessionId: string): string {
    const summary = this.sessions.find((s) => s.sessionId === sessionId);
    return summary ? this.displayTitle(summary) : `会话 ${sessionId.slice(0, 8)}`;
  }

  /** 创建 cwd=vault 的新会话。 */
  async newSession(): Promise<string> {
    const res = await this.client.create({ cwd: this.deps.vaultPath });
    if (!res.ok) throw new Error(res.error.message);
    await this.refresh();
    return res.value.sessionId;
  }

  /** 会话是否存在（用 1 条历史探测）。 */
  async exists(sessionId: string): Promise<boolean> {
    const res = await this.client.history({ sessionId, maxMessages: 1 });
    if (res.ok) return true;
    return res.error.code !== "session-not-found";
  }

  /** 切换当前会话：拉取尾页历史播种视图。 */
  async openSession(sessionId: string): Promise<void> {
    const res = await this.client.history({ sessionId, maxMessages: this.deps.settings.values.historyPageSize });
    if (!res.ok) throw new Error(res.error.message);
    this.deps.store.dropView(sessionId); // 重建干净视图再播种
    this.deps.store.seedHistory(sessionId, res.value.events);
    if (res.value.projections) {
      for (const [key, value] of Object.entries(res.value.projections.values)) {
        if (key === "title" && typeof value === "string" && value.length > 0) this.deps.store.ensureView(sessionId).title = value;
      }
    }
    this.currentId = sessionId;
  }

  /** 加载更早一页；返回是否还有更早内容。 */
  async loadOlder(sessionId: string): Promise<boolean> {
    const view = this.deps.store.ensureView(sessionId);
    let oldest = Number.MAX_SAFE_INTEGER;
    for (const n of view.nodes) oldest = Math.min(oldest, n.seq);
    const beforeSeq = oldest === Number.MAX_SAFE_INTEGER ? view.lastSeq : oldest;
    const res = await this.client.history({ sessionId, beforeSeq, maxMessages: this.deps.settings.values.historyPageSize });
    if (!res.ok) throw new Error(res.error.message);
    // 前插：重建视图，先折叠旧页再折叠现有页。
    const current = view.nodes;
    this.deps.store.dropView(sessionId);
    this.deps.store.seedHistory(sessionId, res.value.events);
    const merged = this.deps.store.ensureView(sessionId);
    // 用保留的现有节点重新折叠（按 seq 重放，简单起见直接重建 nodes 顺序）
    merged.nodes = [...merged.nodes, ...current];
    return res.value.hasMore;
  }

  async prompt(sessionId: string, text: string, mode: "queue" | "steer" = "queue"): Promise<RpcResult<PromptResult>> {
    return this.client.prompt({ sessionId, mode, content: [{ type: "text", text }] });
  }

  async cancel(sessionId: string): Promise<RpcResult<{ accepted: true }>> {
    return this.client.cancel({ sessionId });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/sessionManager.test.ts`
Expected: PASS（5 个用例全部通过）。

- [ ] **Step 5: Commit**

```bash
git add src/core/sessionManager.ts tests/core/sessionManager.test.ts
git commit -m "feat(core): SessionManager 会话管理"
```

---

## Task 8: ApprovalCenter（审批/提问队列与应答）

**Files:**
- Create: `src/core/approvalCenter.ts`
- Test: `tests/core/approvalCenter.test.ts`

- [ ] **Step 1: 写失败测试 tests/core/approvalCenter.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { ApprovalCenter } from "../../src/core/approvalCenter";
import type { MuxFrame } from "../../src/transport/types";
import type { DshClient } from "../../src/transport/client";

const fakeClient = {
  respond: async (rpcId: string, value: unknown) => {
    (fakeClient as unknown as { calls: unknown[] }).calls.push({ rpcId, value });
    return { accepted: true } as const;
  },
} as unknown as DshClient & { calls: { rpcId: string; value: unknown }[] };

(fakeClient as unknown as { calls: unknown[] }).calls = [];

describe("ApprovalCenter", () => {
  it("approval/requested 入队，decide 应答正确载荷，resolved 出队", async () => {
    const center = new ApprovalCenter(fakeClient);
    let changed = 0;
    center.onChange(() => changed++);
    const frame: MuxFrame = {
      type: "approval/requested",
      sessionId: "s1",
      approvalId: "a1",
      toolName: "write",
      callId: "c1",
      reason: "写入 vault/note.md",
    };
    center.ingest("rpc-approval-1", frame);
    expect(center.pendingApprovals).toHaveLength(1);
    expect(changed).toBe(1);

    const receipt = await center.decideApproval(center.pendingApprovals[0], "allowed-once");
    expect(receipt.accepted).toBe(true);
    const calls = (fakeClient as unknown as { calls: { rpcId: string; value: unknown }[] }).calls;
    expect(calls.at(-1)).toEqual({
      rpcId: "rpc-approval-1",
      value: { sessionId: "s1", approvalId: "a1", outcome: "allowed-once" },
    });

    center.ingest("rpc-resolve", { type: "approval/resolved", sessionId: "s1", approvalId: "a1", outcome: "allowed-once" });
    expect(center.pendingApprovals).toHaveLength(0);
  });

  it("question/requested 入队，answer 应答 answers 载荷", async () => {
    const center = new ApprovalCenter(fakeClient);
    center.ingest("rpc-q-1", {
      type: "question/requested",
      sessionId: "s1",
      questions: [{ id: "q1", question: "选哪个？", options: [{ label: "A" }, { label: "B" }] }],
    });
    expect(center.pendingQuestions).toHaveLength(1);
    await center.answerQuestion(center.pendingQuestions[0], [{ id: "q1", selected: ["A"] }]);
    const calls = (fakeClient as unknown as { calls: { rpcId: string; value: unknown }[] }).calls;
    expect(calls.at(-1)).toEqual({
      rpcId: "rpc-q-1",
      value: { sessionId: "s1", answer: { answers: [{ id: "q1", selected: ["A"] }] } },
    });
    center.ingest("rpc-q-resolve", { type: "question/resolved", sessionId: "s1", questionRpcId: "rpc-q-1", outcome: "answered" });
    expect(center.pendingQuestions).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/approvalCenter.test.ts`
Expected: FAIL —— 找不到 `../../src/core/approvalCenter`。

- [ ] **Step 3: 实现 src/core/approvalCenter.ts**

```ts
import type { DshClient } from "../transport/client";
import type { AskUserQuestionAnswerItem, MuxFrame, RpcReceipt } from "../transport/types";

export interface PendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

export interface PendingQuestion {
  rpcId: string;
  sessionId: string;
  questions: MuxFrame extends { questions: infer Q } ? Q : never;
}

export class ApprovalCenter {
  private approvals = new Map<string, PendingApproval>();
  private questions = new Map<string, PendingQuestion>();
  private listeners = new Set<() => void>();

  constructor(private client: DshClient) {}

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[dsh-obsidian] approval 监听器异常:", err);
      }
    }
  }

  get pendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()];
  }

  get pendingQuestions(): PendingQuestion[] {
    return [...this.questions.values()];
  }

  /** 接入一帧 mux：审批/提问入队或出队。 */
  ingest(rpcId: string, frame: MuxFrame): void {
    switch (frame.type) {
      case "approval/requested": {
        this.approvals.set(`${frame.sessionId}/${frame.approvalId}`, {
          rpcId,
          sessionId: frame.sessionId,
          approvalId: frame.approvalId,
          toolName: frame.toolName,
          callId: frame.callId,
          reason: frame.reason,
        });
        this.notify();
        break;
      }
      case "approval/resolved": {
        if (this.approvals.delete(`${frame.sessionId}/${frame.approvalId}`)) this.notify();
        break;
      }
      case "question/requested": {
        this.questions.set(rpcId, { rpcId, sessionId: frame.sessionId, questions: frame.questions });
        this.notify();
        break;
      }
      case "question/resolved": {
        if (this.questions.delete(frame.questionRpcId)) this.notify();
        break;
      }
      default:
        break;
    }
  }

  decideApproval(p: PendingApproval, outcome: "allowed-once" | "rejected"): Promise<RpcReceipt> {
    return this.client.respond(p.rpcId, { sessionId: p.sessionId, approvalId: p.approvalId, outcome });
  }

  answerQuestion(p: PendingQuestion, answers: AskUserQuestionAnswerItem[]): Promise<RpcReceipt> {
    return this.client.respond(p.rpcId, { sessionId: p.sessionId, answer: { answers } });
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/approvalCenter.test.ts`
Expected: PASS（2 个用例通过）。

- [ ] **Step 5: Commit**

```bash
git add src/core/approvalCenter.ts tests/core/approvalCenter.test.ts
git commit -m "feat(core): ApprovalCenter 审批与提问应答"
```

---

## Task 9: 聊天侧边栏（视图 + 输入框 + 提及/命令助手）

**Files:**
- Create: `src/ui/prompts.ts`、`src/ui/chatView.ts`、`src/ui/inputBox.ts`
- Test: `tests/ui/prompts.test.ts`
- Modify: `src/main.ts`（接线）

- [ ] **Step 1: 写失败测试 tests/ui/prompts.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, collectMentionPaths, resolveMentions, truncate } from "../../src/ui/prompts";

describe("BUILTIN_COMMANDS", () => {
  it("包含 /plan 且所有命令以 / 开头", () => {
    expect(BUILTIN_COMMANDS.some((c) => c.name === "/plan")).toBe(true);
    for (const c of BUILTIN_COMMANDS) expect(c.name.startsWith("/")).toBe(true);
  });
});

describe("collectMentionPaths", () => {
  it("提取 @file: 标记中的路径", () => {
    expect(collectMentionPaths("改一下 @file:notes/a.md 和 @file:todo/b.md 的风格")).toEqual(["notes/a.md", "todo/b.md"]);
  });
  it("无标记返回空数组", () => {
    expect(collectMentionPaths("普通文本")).toEqual([]);
  });
});

describe("resolveMentions", () => {
  it("把 @file: 标记替换为引用块并截断长内容", async () => {
    const read = async (path: string) => (path === "a.md" ? "AAAA" : null);
    const out = await resolveMentions("看下 @file:a.md", read, 3);
    expect(out).toBe("看下 文件 a.md：\n> AAA…");
  });
  it("文件不存在时替换为错误说明", async () => {
    const out = await resolveMentions("看下 @file:missing.md", async () => null, 100);
    expect(out).toContain("找不到文件");
  });
});

describe("truncate", () => {
  it("超过上限时截断并加省略号", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
  });
  it("不超上限原样返回", () => {
    expect(truncate("abc", 3)).toBe("abc");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/ui/prompts.test.ts`
Expected: FAIL —— 找不到 `../../src/ui/prompts`。

- [ ] **Step 3: 实现 src/ui/prompts.ts**

```ts
export interface BuiltinCommand {
  name: string;
  description: string;
}

/** v1 内置命令清单（与 DSH 内置命令对齐；服务端执行，插件只负责联想与发送）。 */
export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: "/plan", description: "进入计划模式（/plan off 退出）" },
  { name: "/compact", description: "压缩会话历史" },
  { name: "/feedback", description: "给最近的回复打分反馈" },
  { name: "/goal", description: "管理长期目标（/goal create <目标>）" },
];

const MENTION_RE = /@file:([^\s@]+)/g;

export function collectMentionPaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(MENTION_RE)) out.push(m[1]);
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

/** 把 @file:路径 标记替换为文件内容引用（长内容截断；缺失文件给出说明）。 */
export async function resolveMentions(
  text: string,
  read: (path: string) => Promise<string | null>,
  maxChars: number
): Promise<string> {
  let out = text;
  for (const path of collectMentionPaths(text)) {
    const content = await read(path);
    const replacement = content === null
      ? `（找不到文件 ${path}，请检查路径）`
      : `文件 ${path}：\n> ${truncate(content, maxChars).replace(/\n/g, "\n> ")}`;
    out = out.replace(`@file:${path}`, replacement);
  }
  return out;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/ui/prompts.test.ts`
Expected: PASS。

- [ ] **Step 5: 实现 src/ui/inputBox.ts**

```ts
import { App, TFile } from "obsidian";
import { BUILTIN_COMMANDS } from "./prompts";
import type { DshRuntime } from "../main";
import type { SessionView } from "../core/eventFold";

/** 多行输入框 + `/` 与 `@` 联想弹层 + Shift+Tab 计划模式切换。 */
export class DshInputBox {
  private wrap: HTMLElement;
  private textarea: HTMLTextAreaElement;
  private suggestEl: HTMLElement | null = null;
  private suggestKind: "slash" | "mention" | null = null;
  private suggestItems: string[] = [];
  private suggestIndex = 0;

  constructor(
    private container: HTMLElement,
    private runtime: DshRuntime,
    private getView: () => SessionView | undefined,
    private onSend: (text: string) => Promise<void>
  ) {
    this.wrap = container.createDiv({ cls: "dsh-input-wrap" });
    this.textarea = this.wrap.createEl("textarea", { cls: "dsh-input", attr: { placeholder: "给 DSH 发任务…（/ 命令，@ 提及文件，Shift+Tab 计划模式）" } });
    this.textarea.addEventListener("keydown", (e) => this.onKeydown(e));
    this.textarea.addEventListener("input", () => this.updateSuggest());
  }

  focus(): void {
    this.textarea.focus();
  }

  private async onKeydown(e: KeyboardEvent): Promise<void> {
    if (this.suggestEl) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.suggestIndex = (this.suggestIndex + 1) % this.suggestItems.length;
        this.renderSuggest();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        this.suggestIndex = (this.suggestIndex - 1 + this.suggestItems.length) % this.suggestItems.length;
        this.renderSuggest();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        this.acceptSuggest();
        return;
      }
      if (e.key === "Escape") {
        this.closeSuggest();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = this.textarea.value.trim();
      if (text.length === 0) return;
      this.textarea.value = "";
      this.closeSuggest();
      await this.onSend(text);
      return;
    }
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      await this.togglePlan();
    }
  }

  private async togglePlan(): Promise<void> {
    const view = this.getView();
    if (!view) return;
    const target = view.plan.active ? "/plan off" : "/plan";
    await this.onSend(target);
  }

  private updateSuggest(): void {
    const value = this.textarea.value;
    const cursor = this.textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const tokenMatch = before.match(/(?:^|\s)([@/])([^\s@/]*)$/);
    if (!tokenMatch) {
      this.closeSuggest();
      return;
    }
    const kind = tokenMatch[1] === "@" ? "mention" : "slash";
    const query = tokenMatch[2].toLowerCase();
    const items = kind === "slash"
      ? BUILTIN_COMMANDS.filter((c) => c.name.startsWith(query)).map((c) => `${c.name} — ${c.description}`)
      : this.mentionCandidates(query).slice(0, 20);
    if (items.length === 0) {
      this.closeSuggest();
      return;
    }
    this.suggestKind = kind;
    this.suggestItems = items;
    this.suggestIndex = 0;
    this.renderSuggest();
  }

  private mentionCandidates(query: string): string[] {
    const files: TFile[] = this.runtime.plugin.app.vault.getFiles();
    const lower = query.toLowerCase();
    return files
      .filter((f) => f.path.toLowerCase().includes(lower))
      .map((f) => `@file:${f.path}`);
  }

  private renderSuggest(): void {
    this.closeSuggest();
    this.suggestEl = this.wrap.createDiv({ cls: "dsh-suggest" });
    this.suggestItems.forEach((item, i) => {
      const el = this.suggestEl!.createDiv({ cls: "dsh-suggest-item" + (i === this.suggestIndex ? " dsh-active" : "") });
      el.setText(item);
      el.addEventListener("click", () => {
        this.suggestIndex = i;
        this.acceptSuggest();
      });
    });
  }

  private acceptSuggest(): void {
    if (!this.suggestEl) return;
    const item = this.suggestItems[this.suggestIndex];
    if (item === undefined) return;
    const value = this.textarea.value;
    const cursor = this.textarea.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const start = Math.max(before.lastIndexOf("@"), before.lastIndexOf("/"));
    const insert = this.suggestKind === "mention" ? item : item.split(" — ")[0];
    this.textarea.value = before.slice(0, start) + insert + value.slice(cursor);
    this.closeSuggest();
    this.textarea.focus();
  }

  private closeSuggest(): void {
    this.suggestEl?.remove();
    this.suggestEl = null;
    this.suggestKind = null;
    this.suggestItems = [];
  }
}
```

- [ ] **Step 6: 实现 src/ui/chatView.ts**

```ts
import { App, ItemView, MarkdownRenderer, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import { DshInputBox } from "./inputBox";
import { resolveMentions, truncate } from "./prompts";
import type { DshRuntime } from "../main";
import type { SessionView, ViewNode } from "../core/eventFold";
import type { PendingApproval, PendingQuestion } from "../core/approvalCenter";
import type { AskUserQuestionAnswerItem } from "../transport/types";

export const VIEW_TYPE_DSH_CHAT = "dsh-chat";

export class DshChatView extends ItemView {
  private headerEl!: HTMLElement;
  private planEl!: HTMLElement;
  private msgEl!: HTMLElement;
  private input!: DshInputBox;
  private lastRenderAt = 0;

  constructor(leaf: WorkspaceLeaf, private runtime: DshRuntime) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_DSH_CHAT;
  }

  getDisplayText(): string {
    return "DSH";
  }

  getIcon(): string {
    return "bot";
  }

  private get view(): SessionView | undefined {
    return this.runtime.manager.currentId ? this.runtime.store.getView(this.runtime.manager.currentId) : undefined;
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("dsh-chat");

    this.headerEl = contentEl.createDiv({ cls: "dsh-chat-header" });
    this.renderHeader();
    this.planEl = contentEl.createDiv();
    this.msgEl = contentEl.createDiv({ cls: "dsh-chat-messages" });
    this.input = new DshInputBox(contentEl, this.runtime, () => this.view, (text) => this.send(text));

    this.runtime.store.onChange(() => this.render());
    this.runtime.approvals.onChange(() => {
      this.render();
      this.maybeShowNextApproval();
    });

    await this.runtime.manager.refresh();
    this.renderHeader();
    if (this.runtime.manager.sessions.length > 0 && !this.runtime.manager.currentId) {
      const first = this.runtime.manager.sessions[0];
      await this.open(first.sessionId);
    }
  }

  private async open(sessionId: string): Promise<void> {
    try {
      await this.runtime.manager.openSession(sessionId);
      this.render();
      this.renderHeader();
    } catch (err) {
      new Notice(`打开会话失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async send(text: string): Promise<void> {
    const sessionId = this.runtime.manager.currentId;
    if (!sessionId) {
      new Notice("请先创建会话");
      return;
    }
    try {
      const resolved = await resolveMentions(text, (path) => this.readVaultFile(path), this.runtime.settings.values.mentionMaxChars);
      const res = await this.runtime.manager.prompt(sessionId, resolved, "queue");
      if (!res.ok) new Notice(`发送失败：${res.error.message}`);
    } catch (err) {
      new Notice(`发送失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async readVaultFile(path: string): Promise<string | null> {
    try {
      return await this.runtime.plugin.app.vault.adapter.read(path);
    } catch {
      return null;
    }
  }

  private renderHeader(): void {
    this.headerEl.empty();
    const row = this.headerEl.createDiv();
    const select = row.createEl("select");
    select.createEl("option", { text: "（无会话）", value: "" });
    for (const s of this.runtime.manager.sessions) {
      const opt = select.createEl("option", { text: this.runtime.manager.sessionTitle(s.sessionId) + (s.running ? " ⏳" : ""), value: s.sessionId });
      if (s.sessionId === this.runtime.manager.currentId) opt.selected = true;
    }
    select.addEventListener("change", () => {
      if (select.value) void this.open(select.value);
    });
    const newBtn = row.createEl("button", { text: "新建" });
    newBtn.addEventListener("click", async () => {
      try {
        const id = await this.runtime.manager.newSession();
        await this.open(id);
      } catch (err) {
        new Notice(`新建会话失败：${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const stopBtn = row.createEl("button", { text: "停止" });
    stopBtn.addEventListener("click", async () => {
      if (this.runtime.manager.currentId) {
        const res = await this.runtime.manager.cancel(this.runtime.manager.currentId);
        if (!res.ok) new Notice(`停止失败：${res.error.message}`);
      }
    });
  }

  /** 渲染当前会话（限流：chunk 高频推送时每 150ms 最多重绘一次）。 */
  private render(): void {
    const now = Date.now();
    if (now - this.lastRenderAt < 150) {
      if (!this.renderPending) {
        this.renderPending = true;
        setTimeout(() => {
          this.renderPending = false;
          this.renderNow();
        }, 150);
      }
      return;
    }
    this.lastRenderAt = now;
    this.renderNow();
  }

  private renderPending = false;

  private renderNow(): void {
    const view = this.view;
    this.planEl.empty();
    if (view) {
      if (view.plan.pending) this.planEl.createDiv({ cls: "dsh-plan-banner", text: "计划模式切换中…" });
      else if (view.plan.active) this.planEl.createDiv({ cls: "dsh-plan-banner", text: "计划模式已开启" });
    }
    this.msgEl.empty();
    if (!view) {
      this.msgEl.createDiv({ text: "尚无会话，点击「新建」开始。", cls: "dsh-chat-status" });
      return;
    }
    const olderBtn = this.msgEl.createEl("button", { text: "加载更早" });
    olderBtn.addEventListener("click", async () => {
      try {
        await this.runtime.manager.loadOlder(view.sessionId);
        this.renderNow();
      } catch (err) {
        new Notice(`加载失败：${err instanceof Error ? err.message : String(err)}`);
      }
    });
    for (const node of view.nodes) this.renderNode(node);
    if (view.running) this.msgEl.createDiv({ cls: "dsh-chat-status", text: "⏳ DSH 正在工作…" });
  }

  private renderNode(node: ViewNode): void {
    if (node.kind === "user") {
      const el = this.msgEl.createDiv({ cls: node.sourceKind === "user" ? "dsh-msg-user" : "dsh-msg-context" });
      el.setText(node.text);
      return;
    }
    if (node.kind === "error") {
      const el = this.msgEl.createDiv({ cls: "dsh-msg-context" });
      el.setText(node.text);
      return;
    }
    if (node.kind === "command") {
      const el = this.msgEl.createDiv({ cls: "dsh-msg-command" });
      const statusText = node.status === "running" ? "⏳" : node.status === "success" ? "✓" : "✗";
      el.setText(`${statusText} 命令 ${node.name}${node.text ? `：${node.text}` : ""}`);
      return;
    }
    const wrap = this.msgEl.createDiv({ cls: "dsh-msg-assistant" });
    const body = wrap.createDiv();
    const text = node.text.length > 0 ? node.text : (node.streaming ? "…" : "（无文本）");
    void MarkdownRenderer.render(this.app, text, body, "", this);
    for (const card of node.toolCards) {
      const details = wrap.createEl("details", { cls: "dsh-tool-card" });
      details.createEl("summary", { text: `🛠 ${card.name}${card.status === "running" ? "（执行中）" : card.status === "error" ? "（失败）" : ""}` });
      const pre = details.createDiv({ cls: "dsh-tool-result" });
      pre.setText(truncate(card.resultText ?? card.args ?? "", 4000));
    }
  }

  private maybeShowNextApproval(): void {
    const p = this.runtime.approvals.pendingApprovals.find((a) => a.sessionId === this.runtime.manager.currentId) ?? this.runtime.approvals.pendingApprovals[0];
    if (p && !this.approvalModalOpen) {
      this.approvalModalOpen = true;
      new ApprovalModal(this.app, p, this.runtime.approvals, () => (this.approvalModalOpen = false)).open();
    }
    const q = this.runtime.approvals.pendingQuestions[0];
    if (q && !this.questionModalOpen) {
      this.questionModalOpen = true;
      new QuestionModal(this.app, q, this.runtime.approvals, () => (this.questionModalOpen = false)).open();
    }
  }

  private approvalModalOpen = false;
  private questionModalOpen = false;
}

export class ApprovalModal extends Modal {
  constructor(
    app: App,
    private p: PendingApproval,
    private center: { decideApproval(p: PendingApproval, outcome: "allowed-once" | "rejected"): Promise<unknown> },
    private onCloseCb: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`DSH 请求执行：${this.p.toolName}`);
    this.contentEl.createEl("p").setText(this.p.reason ?? "（未说明理由）");
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText("拒绝").onClick(() => void this.decide("rejected")))
      .addButton((b) => b.setButtonText("允许一次").setCta().onClick(() => void this.decide("allowed-once")));
  }

  private async decide(outcome: "allowed-once" | "rejected"): Promise<void> {
    await this.center.decideApproval(this.p, outcome);
    this.close();
  }

  onClose(): void {
    this.onCloseCb();
  }
}

export class QuestionModal extends Modal {
  private answers: AskUserQuestionAnswerItem[] = [];

  constructor(
    app: App,
    private p: PendingQuestion,
    private center: { answerQuestion(p: PendingQuestion, answers: AskUserQuestionAnswerItem[]): Promise<unknown> },
    private onCloseCb: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("DSH 想问你几个问题");
    for (const q of this.p.questions) {
      this.contentEl.createEl("h6").setText(q.header ?? q.question);
      if (q.detail) this.contentEl.createEl("p").setText(q.detail);
      const options = q.options ?? [];
      const selected = new Set<string>();
      if (options.length === 0) {
        const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: "自由回答" } });
        this.answers.push({ id: q.id, selected: [], custom: "" });
        input.addEventListener("input", () => {
          const a = this.answers.find((x) => x.id === q.id);
          if (a) a.custom = input.value;
        });
      } else {
        for (const opt of options) {
          const label = this.contentEl.createEl("label");
          const cb = label.createEl("input", { attr: { type: q.multiSelect ? "checkbox" : "radio", name: `q-${q.id}` } });
          cb.addEventListener("change", () => {
            if (cb.checked) selected.add(opt.label);
            else selected.delete(opt.label);
          });
          label.appendText(opt.label + (opt.description ? `（${opt.description}）` : ""));
          this.contentEl.createEl("br");
        }
        this.answers.push({ id: q.id, selected: [] });
        this.contentEl.addEventListener("change", () => {
          const a = this.answers.find((x) => x.id === q.id);
          if (a) a.selected = [...selected];
        });
      }
    }
    new Setting(this.contentEl).addButton((b) => b.setButtonText("提交").setCta().onClick(() => void this.submit()));
  }

  private async submit(): Promise<void> {
    await this.center.answerQuestion(this.p, this.answers);
    this.close();
  }

  onClose(): void {
    this.onCloseCb();
  }
}
```

- [ ] **Step 7: 更新 src/main.ts 完成接线**

```ts
import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { installNodeShims } from "./transport/nodeShims";
import { DshSettings } from "./settings";
import { DshClient } from "./transport/client";
import { MuxStream, type MuxState } from "./transport/muxStream";
import { SessionStore } from "./core/store";
import { SessionManager } from "./core/sessionManager";
import { ApprovalCenter } from "./core/approvalCenter";
import { DshChatView, VIEW_TYPE_DSH_CHAT } from "./ui/chatView";

export interface DshRuntime {
  plugin: DshPlugin;
  settings: DshSettings;
  client: DshClient;
  mux: MuxStream;
  store: SessionStore;
  manager: SessionManager;
  approvals: ApprovalCenter;
  muxState: MuxState | null;
}

export default class DshPlugin extends Plugin {
  settings = new DshSettings(this);
  runtime!: DshRuntime;
  statusBarEl!: HTMLElement;

  async onload(): Promise<void> {
    installNodeShims();
    await this.settings.load();
    this.statusBarEl = this.addStatusBarItem();

    const client = new DshClient({ baseUrl: this.settings.dshUrl });
    const store = new SessionStore();
    const approvals = new ApprovalCenter(client);
    const manager = new SessionManager({ client, store, vaultPath: this.vaultPath(), settings: this.settings });
    const runtime: DshRuntime = {
      plugin: this,
      settings: this.settings,
      client,
      store,
      manager,
      approvals,
      mux: undefined as unknown as MuxStream,
      muxState: null,
    };
    const mux = new MuxStream(this.settings.dshUrl, {
      onFrame: (rpcId, frame) => {
        store.applyMux(rpcId, frame);
        approvals.ingest(rpcId, frame);
      },
      onState: (state) => {
        runtime.muxState = state;
        this.statusBarEl.setText(state === "connected" ? "DSH 已连接" : "DSH 重连中…");
      },
    });
    runtime.mux = mux;
    this.runtime = runtime;

    this.registerView(VIEW_TYPE_DSH_CHAT, (leaf: WorkspaceLeaf) => new DshChatView(leaf, runtime));
    this.addRibbonIcon("bot", "打开 DSH 面板", () => void this.activateView());
    this.addCommand({ id: "open-panel", name: "打开 DSH 面板", callback: () => void this.activateView() });
    this.addCommand({
      id: "new-session",
      name: "新建 DSH 会话",
      callback: async () => {
        try {
          await manager.newSession();
          await this.activateView();
        } catch (err) {
          new Notice(`新建会话失败：${err instanceof Error ? err.message : String(err)}`);
        }
      },
    });

    mux.start();
    manager.refresh().catch((err) => console.error("[dsh-obsidian] 会话列表拉取失败:", err));
  }

  vaultPath(): string {
    return (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) as WorkspaceLeaf;
      await leaf.setViewState({ type: VIEW_TYPE_DSH_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  onunload(): void {
    this.runtime?.mux?.stop();
  }
}
```

- [ ] **Step 8: 构建与全部测试**

Run: `npm test`
Expected: 全部 PASS。
Run: `npm run build`
Expected: 生成 main.js，无类型错误。

- [ ] **Step 9: 手动验收（真实 DSH + Obsidian）**

1. 将 `main.js`、`manifest.json`、`styles.css` 复制到测试 vault 的 `.obsidian/plugins/dsh-obsidian/`，启用插件；
2. 启动本地 DSH → ribbon 图标打开面板 → 状态条显示「DSH 已连接」；
3. 点「新建」→ 输入框发「列出当前目录文件」→ 面板出现流式回复与工具卡片；
4. 输入 `/` 出现命令联想，选 `/plan` 发送 → 顶部出现计划模式横幅；
5. 输入 `@` 选一个 vault 文件 → 发送「总结一下这个文件」→ 回复中包含文件内容；
6. DSH 请求写文件时弹出审批窗，允许/拒绝均生效；
7. 关闭 DSH 进程 → 状态条变为「重连中」；重启 DSH → 自动恢复。

- [ ] **Step 10: Commit**

```bash
git add src/ui/prompts.ts src/ui/chatView.ts src/ui/inputBox.ts src/main.ts tests/ui/prompts.test.ts
git commit -m "feat(ui): 聊天侧边栏、输入联想与全局接线"
```

---

## Task 10: 内联编辑（wordDiff + 服务 + 弹窗）

**Files:**
- Create: `src/core/wordDiff.ts`、`src/core/inlineEdit.ts`、`src/ui/diffPreview.ts`、`src/ui/inlineEditModal.ts`
- Test: `tests/core/wordDiff.test.ts`、`tests/core/inlineEdit.test.ts`
- Modify: `src/main.ts`（注册内联编辑命令）

- [ ] **Step 1: 写失败测试 tests/core/wordDiff.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { wordDiff } from "../../src/core/wordDiff";

describe("wordDiff", () => {
  it("相同文本输出单个 equal", () => {
    expect(wordDiff("hello world", "hello world")).toEqual([{ type: "equal", text: "hello world" }]);
  });

  it("纯插入", () => {
    expect(wordDiff("a c", "a b c")).toEqual([
      { type: "equal", text: "a " },
      { type: "add", text: "b " },
      { type: "equal", text: "c" },
    ]);
  });

  it("纯删除", () => {
    expect(wordDiff("a b c", "a c")).toEqual([
      { type: "equal", text: "a " },
      { type: "del", text: "b " },
      { type: "equal", text: "c" },
    ]);
  });

  it("相邻同类型操作合并", () => {
    expect(wordDiff("x", "y z")).toEqual([
      { type: "add", text: "y z" },
      { type: "del", text: "x" },
    ]);
  });

  it("中文按词切分", () => {
    const ops = wordDiff("今天 天气", "今天 天气 很好");
    expect(ops).toEqual([
      { type: "equal", text: "今天 天气" },
      { type: "add", text: " 很好" },
    ]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/core/wordDiff.test.ts`
Expected: FAIL。

- [ ] **Step 3: 实现 src/core/wordDiff.ts**

```ts
export type DiffOp = { type: "equal" | "add" | "del"; text: string };

/** 以空白为边界的词级 diff（LCS + 相邻同类合并）。 */
export function wordDiff(before: string, after: string): DiffOp[] {
  const tokens = (s: string): string[] => s.split(/(\s+)/).filter((t) => t.length > 0);
  const a = tokens(before);
  const b = tokens(after);
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      push(ops, "equal", a[i]);
      i++;
      j++;
    } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) {
      push(ops, "add", b[j]);
      j++;
    } else {
      push(ops, "del", a[i]);
      i++;
    }
  }
  return ops;
}

function push(ops: DiffOp[], type: DiffOp["type"], text: string): void {
  const last = ops[ops.length - 1];
  if (last && last.type === type) last.text += text;
  else ops.push({ type, text });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/core/wordDiff.test.ts`
Expected: PASS（算法已按 LCS DP 手工推演验证：`"a b c"→"a c"` 得 `equal("a "), del("b "), equal("c")`；`"x"→"y z"` 得 `add("y z"), del("x")`）。

- [ ] **Step 5: 写失败测试 tests/core/inlineEdit.test.ts**

```ts
import { describe, expect, it } from "vitest";
import { extractLastAssistantText, renderInlineEditPrompt, sleep } from "../../src/core/inlineEdit";
import { createSessionView } from "../../src/core/eventFold";

describe("renderInlineEditPrompt", () => {
  it("包含路径、选区与指令", () => {
    const p = renderInlineEditPrompt("notes/a.md", "原文", "改简洁");
    expect(p).toContain("notes/a.md");
    expect(p).toContain("原文");
    expect(p).toContain("改简洁");
    expect(p).toContain("只输出替换后的文本");
  });
});

describe("extractLastAssistantText", () => {
  it("提取最后一条已终结的 assistant 文本", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "user", id: "u", text: "x", sourceKind: "user", seq: 1 });
    view.nodes.push({ kind: "assistant", id: "a1", text: "```markdown\n结果A\n```", reasoning: "", toolCards: [], streaming: false, seq: 2 });
    view.nodes.push({ kind: "assistant", id: "a2", text: "结果B", reasoning: "", toolCards: [], streaming: false, seq: 3 });
    expect(extractLastAssistantText(view)).toBe("结果B");
  });

  it("去掉 markdown 代码围栏", () => {
    const view = createSessionView("s");
    view.nodes.push({ kind: "assistant", id: "a", text: "```\n纯文本\n```", reasoning: "", toolCards: [], streaming: false, seq: 1 });
    expect(extractLastAssistantText(view)).toBe("纯文本");
  });

  it("无 assistant 节点时抛错", () => {
    const view = createSessionView("s");
    expect(() => extractLastAssistantText(view)).toThrow();
  });
});

describe("sleep", () => {
  it("大约等待指定毫秒", async () => {
    const t0 = Date.now();
    await sleep(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });
});
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/core/inlineEdit.test.ts`
Expected: FAIL。

- [ ] **Step 7: 实现 src/core/inlineEdit.ts**

```ts
import { SessionManager } from "./sessionManager";
import { SessionStore } from "./store";
import { DshSettings } from "../settings";
import type { SessionView } from "./eventFold";

export interface InlineEditDeps {
  manager: SessionManager;
  store: SessionStore;
  settings: DshSettings;
}

/** 内联编辑服务：专用会话 + 只输出替换文本的指令模板 + 等待回合结束。 */
export class InlineEditService {
  constructor(private deps: InlineEditDeps) {}

  async edit(selection: string, notePath: string, instruction: string): Promise<string> {
    const sessionId = await this.ensureSession();
    const view = this.deps.store.ensureView(sessionId);
    const sinceSeq = view.lastSeq;
    const prompt = renderInlineEditPrompt(notePath, selection, instruction);
    const res = await this.deps.manager.prompt(sessionId, prompt, "queue");
    if (!res.ok) throw new Error(res.error.message);
    const done = await this.waitForTurnEnd(sessionId, sinceSeq, this.deps.settings.values.inlineEditTimeoutSec * 1000);
    return extractLastAssistantText(done);
  }

  private async ensureSession(): Promise<string> {
    const stored = this.deps.settings.values.inlineEditSessionId;
    if (stored && (await this.deps.manager.exists(stored))) return stored;
    const id = await this.deps.manager.newSession();
    this.deps.settings.values.inlineEditSessionId = id;
    await this.deps.settings.save();
    return id;
  }

  /** 轮询 store，直到该会话出现新回合结束且生成了终结的 assistant 文本；超时抛错。 */
  private async waitForTurnEnd(sessionId: string, sinceSeq: number, timeoutMs: number): Promise<SessionView> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const view = this.deps.store.getView(sessionId);
      const lastAssistant = view ? [...view.nodes].reverse().find((n) => n.kind === "assistant") : undefined;
      if (
        view &&
        !view.running &&
        view.lastSeq > sinceSeq &&
        lastAssistant &&
        lastAssistant.kind === "assistant" &&
        !lastAssistant.streaming &&
        lastAssistant.text.length > 0
      ) {
        return view;
      }
      await sleep(500);
    }
    throw new Error(`内联编辑超时（${Math.round(timeoutMs / 1000)}s），已放弃`);
  }
}

export function renderInlineEditPrompt(notePath: string, selection: string, instruction: string): string {
  return [
    "你是 Obsidian 内联编辑助手。只输出替换后的文本：不要调用任何工具，不要解释，不要输出 markdown 代码块，不要省略原文的任何部分。",
    `文件：${notePath}`,
    "以下引号内是原始文本，请完整输出修改后的版本：",
    `<<<${selection}>>>`,
    `指令：${instruction}`,
  ].join("\n");
}

/** 提取最后一个已终结 assistant 节点的文本，并剥掉可能包裹的 markdown 围栏。 */
export function extractLastAssistantText(view: SessionView): string {
  for (let i = view.nodes.length - 1; i >= 0; i--) {
    const n = view.nodes[i];
    if (n.kind === "assistant" && !n.streaming && n.text.length > 0) {
      let text = n.text.trim();
      const fence = text.match(/^```[^\n]*\n([\s\S]*)\n```$/);
      if (fence) text = fence[1];
      return text;
    }
  }
  throw new Error("DSH 没有产生可用的替换文本");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run tests/core/inlineEdit.test.ts`
Expected: PASS。

- [ ] **Step 9: 实现 src/ui/diffPreview.ts**

```ts
import { App, Modal } from "obsidian";
import type { DiffOp } from "../core/wordDiff";

export class DiffPreviewModal extends Modal {
  constructor(
    app: App,
    private ops: DiffOp[],
    private onApply: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("内联编辑预览");
    const wrap = this.contentEl.createDiv({ cls: "dsh-diff-wrap" });
    for (const op of this.ops) {
      const span = wrap.createSpan({ cls: op.type === "add" ? "dsh-diff-add" : op.type === "del" ? "dsh-diff-del" : "dsh-diff-eq" });
      span.setText(op.text);
    }
    const bar = this.contentEl.createDiv();
    const cancel = bar.createEl("button", { text: "放弃" });
    cancel.addEventListener("click", () => this.close());
    const apply = bar.createEl("button", { text: "应用替换" });
    apply.addEventListener("click", () => {
      this.onApply();
      this.close();
    });
  }
}
```

- [ ] **Step 10: 实现 src/ui/inlineEditModal.ts**

```ts
import { App, Editor, Modal, Notice, Setting } from "obsidian";
import { wordDiff } from "../core/wordDiff";
import { DiffPreviewModal } from "./diffPreview";
import type { DshRuntime } from "../main";

export class InlineEditModal extends Modal {
  private instruction = "";

  constructor(
    app: App,
    private runtime: DshRuntime,
    private editor: Editor
  ) {
    super(app);
  }

  onOpen(): void {
    const selection = this.editor.getSelection();
    if (selection.trim().length === 0) {
      this.contentEl.createEl("p", { text: "请先在编辑器中选择要修改的文本。" });
      return;
    }
    this.titleEl.setText("DSH 内联编辑");
    this.contentEl.createEl("p", { text: `已选择 ${selection.length} 个字符，输入修改指令：` });
    const input = this.contentEl.createEl("input", { attr: { type: "text", placeholder: "例如：改写得更简洁" } });
    input.value = this.instruction;
    input.addEventListener("input", () => (this.instruction = input.value));
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText("开始").setCta().onClick(() => void this.run())
    );
  }

  private async run(): Promise<void> {
    const selection = this.editor.getSelection();
    const path = this.runtime.plugin.app.workspace.getActiveFile()?.path ?? "";
    const notice = new Notice("DSH 正在生成修改…", 0);
    try {
      const result = await this.runtime.inlineEdit.edit(selection, path, this.instruction || "优化这段文本");
      notice.hide();
      new DiffPreviewModal(this.app, wordDiff(selection, result), () => {
        this.editor.replaceSelection(result);
      }).open();
      this.close();
    } catch (err) {
      notice.hide();
      new Notice(`内联编辑失败：${err instanceof Error ? err.message : String(err)}`);
      this.close();
    }
  }
}
```

- [ ] **Step 11: 更新 src/main.ts 注册命令与依赖**

在 `src/main.ts` 顶部追加 import：

```ts
import { InlineEditService } from "./core/inlineEdit";
import { InlineEditModal } from "./ui/inlineEditModal";
```

`DshRuntime` 接口追加字段：

```ts
  inlineEdit: InlineEditService;
```

在 `onload` 中 `runtime` 构造后（`this.runtime = runtime;` 之前）追加：

```ts
    runtime.inlineEdit = new InlineEditService({ manager, store, settings: this.settings });
```

在 `addCommand` 区块追加：

```ts
    this.addCommand({
      id: "inline-edit",
      name: "DSH 内联编辑选区",
      editorCallback: (editor: Editor) => new InlineEditModal(this.app, this.runtime, editor).open(),
    });
```

并在 `main.ts` 顶部 import 处追加 `import type { Editor } from "obsidian";`（合并进现有 `import { Notice, Plugin, WorkspaceLeaf } from "obsidian";` 行：`import { Editor, Notice, Plugin, WorkspaceLeaf } from "obsidian";`）。

- [ ] **Step 12: 构建与全部测试**

Run: `npm test`
Expected: 全部 PASS。
Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 13: 手动验收**

1. 编辑器选中一段文字，设置 → 快捷键给「DSH 内联编辑选区」分配热键（如 Ctrl+Alt+E）；
2. 触发命令 → 输入指令 → 等待生成 → diff 预览红绿对比正确；
3. 「应用替换」后选区被替换，Cmd+Z 可撤销；「放弃」不改动；
4. DSH 关闭时触发 → 超时/连接错误提示，编辑器不被改动。

- [ ] **Step 14: Commit**

```bash
git add src/core/wordDiff.ts src/core/inlineEdit.ts src/ui/diffPreview.ts src/ui/inlineEditModal.ts src/main.ts tests/core/wordDiff.test.ts tests/core/inlineEdit.test.ts
git commit -m "feat: 内联编辑（词级 diff 预览与专用会话）"
```

---

## Task 11: 计划模式横幅、设置面板与收尾打磨

**Files:**
- Create: `src/ui/settingsTab.ts`
- Modify: `src/main.ts`、`src/ui/chatView.ts`（若验收发现问题）

- [ ] **Step 1: 实现 src/ui/settingsTab.ts**

```ts
import { App, PluginSettingTab, Setting } from "obsidian";
import type DshPlugin from "../main";

export class DshSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: DshPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    new Setting(containerEl).setName("DSH 地址").setDesc("本地 DSH 服务地址（默认 http://127.0.0.1:3080）").addText((t) =>
      t.setValue(s.values.dshUrl).onChange(async (v) => {
        s.values.dshUrl = v.trim();
        await s.save();
      })
    );

    new Setting(containerEl).setName("@提及文件内容上限（字符）").setDesc("提及文件时注入内容的最大长度，超长截断").addText((t) =>
      t.setValue(String(s.values.mentionMaxChars)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.mentionMaxChars = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName("内联编辑超时（秒）").addText((t) =>
      t.setValue(String(s.values.inlineEditTimeoutSec)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.inlineEditTimeoutSec = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName("历史页大小").setDesc("每次拉取会话历史的条数").addText((t) =>
      t.setValue(String(s.values.historyPageSize)).onChange(async (v) => {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) {
          s.values.historyPageSize = Math.floor(n);
          await s.save();
        }
      })
    );

    new Setting(containerEl).setName("重置内联编辑专用会话").setDesc("下次内联编辑将创建全新会话").addButton((b) =>
      b.setButtonText("重置").onClick(async () => {
        s.values.inlineEditSessionId = "";
        await s.save();
      })
    );
  }
}
```

- [ ] **Step 2: main.ts 注册设置面板**

在 `src/main.ts` 顶部追加 import：

```ts
import { DshSettingTab } from "./ui/settingsTab";
```

在 `addCommand` 区块之后追加：

```ts
    this.addSettingTab(new DshSettingTab(this.app, this));
```

- [ ] **Step 3: 打磨计划模式横幅**

`chatView.ts` 的 `renderNow()` 中横幅逻辑已在 Task 9 实现（pending/active 两态）。`plan.pending` 的置位采用双保险（固定实现，不做二选一）：

1. **投影优先**：服务端 `session/projection(key='plan')` 帧携带 `{active, pending}`（store 已按 higher-seq-wins 应用）；
2. **本地兜底**：`inputBox.ts` 的 `togglePlan()` 发送命令后立即置位。将 Task 9 中 `togglePlan` 方法体替换为：

```ts
  private async togglePlan(): Promise<void> {
    const view = this.getView();
    if (!view) return;
    const target = view.plan.active ? "/plan off" : "/plan";
    view.plan.pending = true; // 本地兜底：投影帧到达时（higher-seq-wins）覆盖为权威值
    await this.onSend(target);
  }
```

`plan/mode` 事件（eventFold）与投影帧都会把 `pending` 清为权威值，因此兜底置位不会卡在「切换中」。

- [ ] **Step 4: 构建与全部测试**

Run: `npm test`
Expected: 全部 PASS。
Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 5: 手动验收（全量清单）**

1. 面板：新建/切换/停止会话、流式输出、工具卡片、错误卡片、加载更早；
2. 审批：写文件弹窗允许/拒绝；提问弹窗单选/多选/自由输入；
3. 内联编辑：diff 预览、应用/放弃、撤销；
4. `/plan` 计划横幅、`Shift+Tab` 切换、`/compact` 等命令可发送；
5. `@` 提及：文件内容注入、缺失文件提示、长文件截断；
6. 断连重连：状态条三态、恢复后事件继续；
7. 设置面板：DSH 地址等全部字段保存生效；
8. 关闭 Obsidian 再打开：会话列表恢复、专用会话 id 持久化。

- [ ] **Step 6: Commit**

```bash
git add src/ui/settingsTab.ts src/main.ts src/ui/chatView.ts
git commit -m "feat: 设置面板与计划模式打磨"
```

---

## Task 12: 发布准备（README、versions.json、打包）

**Files:**
- Create: `README.md`、`version-bump.mjs`、`versions.json`
- Modify: `package.json`（version 脚本）

- [ ] **Step 1: 创建 version-bump.mjs**

```js
import { readFileSync, writeFileSync } from "fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const target = process.env.npm_config_new_version ?? process.argv[2];
if (!target) {
  console.error("用法: node version-bump.mjs <新版本>");
  process.exit(1);
}
manifest.version = target;
pkg.version = target;
writeFileSync("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
let versions = {};
try {
  versions = JSON.parse(readFileSync("versions.json", "utf8"));
} catch {
  versions = {};
}
versions[target] = "1.7.2";
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");
console.log(`版本已更新为 ${target}`);
```

- [ ] **Step 2: 创建 README.md**

```markdown
# DSH for Obsidian

把本地运行的 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 作为 AI 协作者嵌入 Obsidian：vault 就是它的工作目录，DSH 可以直接读、写、搜索你的笔记。

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
```

- [ ] **Step 3: 创建 versions.json**

```json
{
  "0.1.0": "1.7.2"
}
```

- [ ] **Step 4: package.json 增加 version 脚本**

`scripts` 中加入：`"version": "node version-bump.mjs $npm_package_version && git add manifest.json versions.json package.json"`。

- [ ] **Step 5: 生产构建 + 全量测试**

Run: `npm test`
Expected: 全部 PASS。
Run: `npm run build`
Expected: 生成压缩版 `main.js`。
Run: `git check-ignore main.js`
Expected: 返回 `main.js`（dev 阶段被忽略）。

- [ ] **Step 6: 将 main.js 纳入版本库并 Commit**

`main.js` 被 .gitignore 排除（dev 用），但发布 artifact 必须携带它（社区插件分发只消费 release 里的 main.js + manifest.json + versions.json）。在发布提交中强制加入：

```bash
git add README.md version-bump.mjs versions.json package.json
git add -f main.js
git commit -m "chore: 发布准备（README、版本脚本、versions.json 与构建产物）"
```

> 注：Task 1 代码审查确认 `.gitignore:3` 忽略 `main.js`；`git add -f` 是唯一使发布产物完整的手段。后续若接入 GitHub Actions 发布流程，应在 release 步骤中重新构建并上传 main.js（并同步强制提交）。

---

## 完成定义

- [ ] `npm test` 全绿（覆盖：类型/id、client、muxStream、eventFold、store、sessionManager、approvalCenter、prompts、wordDiff、inlineEdit）
- [ ] `npm run build` 生产构建成功
- [ ] Task 9/10/11 的三组手动验收清单全部通过（真实 DSH 联调）
- [ ] 全部任务已按顺序提交，`git status` 干净
