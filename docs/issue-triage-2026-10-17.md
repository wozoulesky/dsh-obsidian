# Issue 分诊：核实 #1 / #2 / #3 是否真的修好了

核查执行时间：2026-10-18 00:20–00:35（+08:00）。文件按 Lead 指派命名为 `issue-triage-2026-10-17.md`。
核查对象：仓库 `wozoulesky/dsh-obsidian`，`master@0d8d837` = tag `0.1.9`，工作区干净，`git log 0.1.9..HEAD` 为 0 条，无 open PR。
方法：**不采信 release notes 与已有关闭评论**，逐条回到源码、提交、测试与**已发布产物**取证。全程只读：只用了 `gh issue view` / `gh api GET` / `gh release download` / `git log|show`，未发帖、未改 label、未 close。

---

## 0. 结论速览

| Issue | 判定 | 修复落点 | 已发布？ | 建议动作 |
|---|---|---|---|---|
| #1 `open` 与 Obsidian 视图生命周期撞名 | **确实已修复**，证据链完整（源码 + 发布产物 + 静态回归测试 + tag 归属） | 插件 **0.1.2**，commit `e47c0a5` | ✅ 0.1.2 起全部版本 | **close as fixed**，附 0.1.2 证据链接 + 升级路径 |
| #2 外置 i18n 文件 | **确实已实现**，与 issue 提法一致（key-value 表 + 用户本地翻译） | 插件 **0.1.4**，commits `4a4e6ef` / `f0ea669` / `1e78743` / `1ac89db` | ✅ 0.1.4 起全部版本 | **close as implemented**，但回复里必须写明残留点（见 2.3；英文草稿覆盖其中最要紧的 2 条） |
| #3 聊天视图流式性能 | **已修复，但不是一个版本完成的**：增量渲染在 **0.1.4**，把"长会话每次渲染 O(全文)"这个真正致命的成本降下来是在 **0.1.7**（0.1.6 已撤回并入 0.1.7） | 0.1.2→0.1.4 增量渲染；0.1.4→0.1.7 热点成本（`kind｜rev` 签名、rAF 合帧、单次几何读） | ✅ 0.1.7 起全部版本 | **close as fixed**，但回复必须要求 **≥0.1.9**，并说明"只升到 0.1.4 只拿到一半" |

一句话：三条都可以关，但 #2/#3 不能"关了就算完"——回复里要把残留点（系统错误串仍是中文、渲染路径无 DOM 级自动化测试、滚动是"复位"不是真锚定）写清楚，否则下一个用户会拿着同样的现象再来一次。

---

## 1. Issue #1 — `open` 方法与视图生命周期撞名

- 提交者：`Linai1017`，2026-08-17，环境 插件 v0.1.1 + DSH 0.1.0-rc.6
- 现状：`OPEN`（作者已于 2026-08-21 回帖称 0.1.2 修复，但 issue 一直挂着）

### 1.1 现状判定

**已修复，判定 close。** issue 里的根因分析完全正确，修复方式也与建议一致（改名 + 非字符串守卫 + 回归测试），且修复落在**已发布**的 0.1.2 里，不只是落在仓库源码里。

### 1.2 证据（四层，互相独立）

| 层 | 证据 | 结论 |
|---|---|---|
| 修复前 | tag `0.1.1` 的 `src/ui/chatView.ts:84`：`private async open(sessionId: string): Promise<void>` | 撞名方法确实存在 |
| 修复提交 | `e47c0a5`（2026-08-22）`fix(chatView): rename view method open -> openConversation to avoid Obsidian lifecycle collision`；`git tag --contains e47c0a5` → `0.1.2 0.1.4 0.1.5 0.1.7 0.1.8 0.1.9` | 修复自 0.1.2 起存在于所有后续版本 |
| 当前源码 | `src/ui/chatView.ts:196` `private async openConversation(...)`；`:197` 守卫 `if (typeof sessionId !== "string" \|\| sessionId.length === 0) return;`；`:190-195` 注释写明碰撞原因；4 处调用点 `:172`、`:321`、`:370`、`:377` 全部改名 | 双重防线（改名 + 守卫）都在 |
| 回归测试 | `tests/build-sanity.test.ts:5` `it("chatView 不得定义 \`open\` 方法（Obsidian 视图生命周期碰撞回归）")`，断言 `expect(src).not.toMatch(/\basync open\(/)` 且 `toContain("openConversation")`；该测试**在 tag 0.1.2 中已存在**（`git show 0.1.2:tests/build-sanity.test.ts`） | 一旦有人把 `open` 加回来，CI 立刻红 |
| 已发布产物 | 0.1.2 release 资产 `main.js` 中 `async open(` **不存在**，存在 `openConversation(t){if(!(typeof t!="string"\|\|t.length===0))try{` | 用户实际下载到的产物含修复 |

补充（产物一致性）：0.1.4 与 0.1.9 的 release 资产与仓库内 `main.js` **字节完全一致**（0.1.4 `df2c9e4e…a93cc2cb`，0.1.9 `74746c4a…541f83ea`）。0.1.2 例外：`diff` 仅第 1 行构建横幅不同（仓库版带构建时间戳、非 ASCII；发布版为 `/* dsh-obsidian */`），JS 正文一致——属旧构建脚本的横幅差异，与 issue 无关。

### 1.3 英文回复草稿（可直接发布）

```text
Thanks for the report — and for the root-cause analysis, which was exactly right.

What was wrong: DshChatView (an ItemView) defined `private async open(sessionId)`. That name collides with Obsidian's own view lifecycle: when the workspace is restored, Obsidian calls `view.open(state)` with the view state object `{}`, the plugin treated it as a sessionId, and `session.history` rejected it with `invalid payload for session.history`.

Fixed in v0.1.2 (commit e47c0a5, https://github.com/wozoulesky/dsh-obsidian/commit/e47c0a592196e885dc562ae80a12dcb87ffd4c25):
- renamed to `openConversation`, all call sites updated — src/ui/chatView.ts:196
- added a defensive guard: a non-string or empty argument is ignored — src/ui/chatView.ts:197
- added a static regression test that fails if a method named `open` ever comes back — tests/build-sanity.test.ts:5

I verified this against the code and against the artifact you actually download: the 0.1.2 release's `main.js` no longer contains `async open(` and does contain the guarded `openConversation`.

One upgrade note, since you're on DSH 0.1.0-rc.6. Plugin 0.1.5+ requires DSH >= 0.1.2-rc.1 (older servers return 401/404), so:
- staying on DSH 0.1.0-rc.6: upgrade the plugin to v0.1.4 — it's the last version that supports pre-0.1.2 DSH, and it already contains this fix;
- upgrading DSH: use the current plugin, v0.1.9.

Closing this as fixed. If it still happens on either combination, reopen and paste the exact notice text plus your plugin and DSH versions.
```

### 1.4 建议动作

- **close as fixed**（先发回复，再关闭）。按任务约定本次核查不动 label / 不 assign，是否补 `bug` label 由 Lead 决定。
- 不需要复测：#1 是可静态判定的一次性撞名，且发布产物已核对。
- 唯一需要注意的：回复里必须给**升级路径**，因为该用户停在不受支持的 DSH 0.1.0-rc.6 上，直接让他升最新插件会 401/404（`README.md:106-112` 兼容性矩阵第 4 行明确写了 `≤ 0.1.4`）。

---

## 2. Issue #2 — 外置 i18n 文件

- 提交者：`tobejohe`，2026-08-22，环境 插件 v0.1.2
- 现状：`OPEN`（作者已于 2026-08-26 回帖称 0.1.4 实现）

### 2.1 现状判定

**已按 issue 提议的路线实现，判定 close as implemented。** 提议的核心是"key–value 表 + 用户拿去本地翻译、不需要官方维护翻译"，这正是实现的样子：表在代码里、`导出模板`按钮把模板写到 vault 根、改完重载生效、缺 key/坏 JSON 静默回落。

### 2.2 证据

| 证据 | 位置 | 说明 |
|---|---|---|
| 字符串表 | `src/i18n.ts:4` `DEFAULT_STRINGS`（**140** 条，内置默认中文） | 全部 UI 文案集中在此 |
| 取文案语义 | `src/i18n.ts:172-185` 的 `I18n` 类，`:176-184` `t()`：`overrides[key] ?? DEFAULT_STRINGS[key] ?? key`，支持 `{param}` | 外部覆盖优先、最后回落 key 本身 |
| 加载优先级 | `src/main.ts:51-55` `loadI18n(["dsh-bridge.i18n.json", "<插件目录>/i18n.json"], vault.adapter.read)`；`src/i18n.ts:191` 起 `loadI18n` 按序尝试，第一个成功且为 JSON 对象的生效，非字符串值忽略，全失败 → 内置默认且不抛错 | vault 根优先、插件目录 legacy 兼容、静默回落 |
| 导出按钮 | 声明式路径 `src/ui/settingsTab.ts:97-107`；命令式回退 `display()` `src/ui/settingsTab.ts:213-221`。两者都 `await app.vault.adapter.write("dsh-bridge.i18n.json", JSON.stringify(DEFAULT_STRINGS, null, 2))` 并给 Notice | 写到 **vault 根**（Obsidian 文件树可见可编辑），不是 `.obsidian` 隐藏目录 |
| 模板与代码不漂移 | `tests/i18n.test.ts:82` `it("模板键与 DEFAULT_STRINGS 完全一致，避免文档与实现漂移")`；实测键集相等：140 / 140，双向 diff 为空，全部为字符串值 | 译者永远拿到当前版本的完整键集 |
| 其余单测 | `tests/i18n.test.ts` 共 12 条：默认中文、覆盖优先、未知 key 回落、占位符、仅保留字符串、缺文件/坏 JSON/非对象回落、候选顺序（vault 根优先）、首个候选坏时降级、vault 根坏不阻塞插件目录 | 本次实测 12/12 通过 |
| 提交 | `4a4e6ef`（2026-08-26，i18n 模块 + 全量 `t()` 改造）、`f0ea669`（导出按钮 + vault 根优先）、`1e78743`（模板键一致性测试）、`1ac89db`（声明式设置里按钮从 `action` 改 `render`，修复导出按钮被重复渲染 4 个）；`git tag --contains` 均为 `0.1.4+` | 0.1.4 发布内容 |
| 已发布产物 | 0.1.4 release 资产 `main.js`（sha256 == 仓库 `0.1.4:main.js`）含 `dsh-bridge.i18n.json`、`exportI18nName` | 用户下载得到的产物含该功能 |
| 文档 | `README.md:84-92`「Translations / Localization」三步说明 + 优先级 + 模型面向文案不翻译的披露 | 已向用户公开 |

### 2.3 残留点（如实列出，回复里要写）

1. **并非"全部字符串"都在表里。** 除已披露的模型面向文案（`src/ui/prompts.ts:151-152` 的 @提及注入文本、`src/core/inlineEdit.ts:129-133` 内联编辑 prompt）外，还有约 **21 处用户可见的系统/传输错误串仍硬编码中文**，且会经 `{message}` 拼进 Notice 或诊断 detail 显示给用户，例如：
   - `src/transport/auth.ts:77,83,94,97,169,188,196,247,250,291,303,306`（凭据文件/baseUrl 类）
   - `src/transport/client.ts:184,188,193,201`（协议/信封类）
   - `src/transport/muxStream.ts:350`、`src/core/sessionManager.ts:232,237,368`、`src/core/eventFold.ts:391`
   - 这些文案经 `src/ui/chatView.ts:130,167,204,303,309` 等 `t("...{message}")` 外壳显示 —— 外壳可翻译，内层仍是中文。
   即：非中文用户把 UI 翻译完后，**故障路径**仍会冒中文。这是一处真实的"只修了一部分"。
2. **导出按钮没有自动化测试。** `tests/ui/settingsTab.test.ts` 覆盖的是诊断/重置/数值防抖/`hide()` 落盘，导出按钮的点击 → 落盘路径**零覆盖**；`1ac89db` 修的"导出按钮重复 4 个"也是真机发现、靠人眼验收的，没有回归用例。
3. 修改译文需**重载插件**才生效（已文档化，非缺陷，但要在回复里讲明，否则用户会以为文件没生效）。
4. 静默回落是**双刃**：键名写错不会有任何提示，用户只会看到"有些地方还是中文"。

### 2.4 英文回复草稿（可直接发布）

```text
Thank you for the kind words — and sorry for the slow follow-up. Your suggestion went in exactly the direction you proposed: implemented in v0.1.4, no official translations and no maintenance burden on the plugin side.

How it works now:
- All UI strings live in a single key-value table (140 keys), built-in default Chinese — src/i18n.ts:4
- Settings -> "Export i18n template" writes `dsh-bridge.i18n.json` to the ROOT of your vault (visible and editable in Obsidian's file explorer, no hidden .obsidian path) — src/ui/settingsTab.ts:97
- Replace the values (or hand the file to your local DSH / any translator) and reload the plugin — done
- Load priority: vault-root `dsh-bridge.i18n.json` -> plugin-dir `i18n.json` (legacy path still read) -> built-in defaults. Missing keys or invalid JSON fall back to the defaults silently — src/main.ts:51, src/i18n.ts:191
- The template's key set is kept in sync with the code by a unit test, so a translator always gets the complete current set — tests/i18n.test.ts:82
Docs: README "Translations / Localization".

Two caveats I'd rather state up front than let you discover them:
1. Not every string is in the table yet. Model-facing instructions (inline-edit prompt, @mention expansion) intentionally stay Chinese — translating them can change model behavior. Beyond those, a number of low-level transport/auth error messages (credential file problems, protocol/envelope errors) are still Chinese-only, and they do show up inside some failure notices. The normal UI path is fully translatable; some error paths are not.
2. Re-export the template after upgrading the plugin — it is a snapshot of the built-in defaults of the version you exported from. And a reload is required for edits to take effect.

Closing this as implemented. Reopen if the exported file doesn't behave as described and I'll dig in.
```

### 2.5 建议动作

- **close as implemented**（先发回复）。
- 建议同时开一个 follow-up issue（不要塞回 #2）：**"i18n 覆盖率：系统/传输错误串仍硬编码中文"** + **"导出 i18n 模板按钮缺自动化测试"**，两者都是本次核查发现的真实残留，且都属于低风险可增量修复。
- 不需要用户复测：功能是新增能力，不是 bug 修复。

---

## 3. Issue #3 — 聊天视图流式性能

- 提交者：`tobejohe`，2026-08-22，环境 插件 v0.1.2 + Obsidian 1.7.2+（Linux）
- 现状：`OPEN`（作者已有 2 条回帖：2026-08-26 04:08 认领、2026-08-26 15:36 称 0.1.4 修复）

### 3.1 现状判定

**已修复，但不是单版本完成的，评论里的"Fixed in v0.1.4"只对了一半。**

- issue 描述的三级恶化（第 1 条流畅 → 第 2 条流式中无法滚动 → 第 3 条整机卡死）的**根因判定正确**：0.1.2 的 `renderNow()` 每次都用 `this.msgEl.empty()` 清空整个消息容器，再对**每条**消息重跑 `MarkdownRenderer.render`；只有 150ms 节流，所以成本随会话长度线性增长。
- **0.1.4** 修掉了"全量重建"这件事（节点缓存 + 签名、流式期纯文本、结束才 Markdown、陈旧 DOM 清理、滚动保持、"加载更早"反馈）。
- **但 0.1.4 的签名本身仍是最贵的那种**：`nodeSignature()` 每次渲染都拼接正文全文 + 每张工具卡 `truncate(resultText, 4000)`。长会话下这是每帧 MB 级分配，正是"长会话越用越卡"的残留来源。
- 真正把热点成本降下来的是 **0.1.6 的内容**（`fb2b766`，2026-09-13），而 **0.1.6 已被撤回、其内容并入 0.1.7**（`c976b61` "release: 0.1.7（合并已撤回的 0.1.6 + 社区审核整改）"；远端与本机均**没有** `0.1.6` tag，`releases/tags/0.1.6` 返回 404）。仓库内也确实只有 `0.1.7` 合入后才有 `kind|rev` 签名与 `eventFoldRev.test.ts`。

因此对用户的正确说法是：**请用 ≥0.1.9；只升到 0.1.4 会以为"还是有点卡"**。

### 3.2 证据

**修复前（tag 0.1.2，复现用户描述）**
- `src/ui/chatView.ts:206-221`：`render()` 仅 150ms 节流。
- `src/ui/chatView.ts:223-230`：`renderNow()` 里 `this.msgEl.empty()`。
- `src/ui/chatView.ts:270`：对每条消息 `void MarkdownRenderer.render(this.app, text, body, "", this)` —— 即"清空 + 全量重渲染 + 全量 Markdown"，与用户读 `main.js` 得出的判断一致。

**0.1.4（增量渲染落地）**
- `4a4e6ef`（2026-08-26）`feat: issue#2/#3 聊天视图增量渲染与外部 i18n`：引入 `src/ui/chatNode.ts`（`nodeCacheKey` / `nodeSignature` / `canReuseNode`）与 `chatView` 的 `nodeCache` 复用循环。
- `edcd6d2`（2026-08-26）`fix(chatView): 真机验收修复——流式重复 DOM、INP/CLS、滚动跳动、加载更早无反馈`：`git show edcd6d2:src/ui/chatView.ts | grep -n` → `:268` `atBottom` 判定、`:300` `// 签名变化：先销毁旧 DOM！`、`:315` `if (atBottom) msg.scrollTop = msg.scrollHeight;`。
- `b8f8ea1`（2026-08-26）：`dsh-streaming-text`（`styles.css:12` `white-space: pre-wrap`）降低结束渲染的 CLS；"加载更早"按钮改用 visibility 隐藏避免 CLS。
- `0a3e271`（2026-08-26）：切换会话后重置 `olderHasMore`。
- 该版本签名（`git show 0.1.4:src/ui/chatNode.ts:10-27`）仍是 `user|${node.text}…` / `assistant|${node.text}|…${truncate(...,4000)}` —— **这就是"只修了一半"的证据**。

**0.1.7（热点成本）**
- `fb2b766` → 合入 `c976b61`。`src/ui/chatNode.ts:15-17`：`nodeSignature(node) => \`${node.kind}|${node.rev}\``（O(1)，注释明写"不再拼接正文/工具卡全文（旧实现每个节点每次渲染都要复制一遍文本，长会话下是 MB 级分配）"）。
- `src/ui/chatNode.ts:40-41`：`canReuseNode` 增加**对象同一性**守卫（视图重建后同 id 新对象即便 `kind|rev` 巧合相等也不复用，杜绝过期 DOM）。
- `src/ui/chatView.ts:664-677`：`scheduleFrame()` 用 `requestAnimationFrame` 合帧（后台窗口/测试环境回退 16ms 定时器）；`render()` 的 150ms 闸门保留在 `:643-655`。
- `src/ui/chatView.ts:691-697`：几何只在 DOM 变更**前**读一次；`:757-758` 变更后只写一次 `scrollTop`，钉底写钳位哨兵 `SCROLL_TO_BOTTOM = 1e7`（`:35`）而**不再读** `scrollHeight` —— 避免强制同步布局。
- `src/core/eventFold.ts:222` `REASONING_BUMP_INTERVAL_MS = 250`（推理增量按时间窗节流，最多 ~4 次/秒）；`:224` `bump() { node.rev += 1 }`，所有影响渲染的就地修改都会 bump。

**测试**
- `tests/ui/chatNode.test.ts`（HEAD 为 **10** 条；该文件自 0.1.4 起存在，当时是 **5** 条针对全文拼接签名的用例，0.1.7 起改为 10 条覆盖 `kind|rev` 与对象同一性）：`key 包含 sessionId 与 node.id…`、`签名 = kind|rev…`、`签名长度与正文无关（旧实现拼接全文 + 4000 字截断的工具卡）`、`节点对象被替换（视图重建后同 id 新对象）→ 不复用，即使 kind 与 rev 巧合相等`。
- `tests/core/eventFoldRev.test.ts`（**24** 条，0.1.7 新增；0.1.4/0.1.5 无此文件）：rev 契约回归（text-delta/reasoning-delta/工具卡/收尾/重复事件不 bump 等）。
- 本次实测：`tests/ui/chatNode.test.ts + tests/core/eventFoldRev.test.ts + tests/i18n.test.ts + tests/build-sanity.test.ts` = **48/48 通过**。

**真机**：作者回帖称 ~18k 事件长会话、Obsidian 1.13.7、INP 恢复正常、CLS 0.09。**注意：仓库里没有这次验收的任何记录/日志/截图**（`docs/` 下无性能记录，`git log` 也无对应验收提交），所以这一条只能算"维护者自述"，不是可复现证据。3.4 的回复草稿把它写成第一人称的实测（因为发帖人就是做过这次实测的维护者本人），但**不要**升级成"由 CI/仓库证据保证"，且第 3.3 节的边界必须在同一帖里交代 —— 否则就是拿自述当证明。

### 3.3 残留点（如实列出）

1. **渲染路径没有自动化测试。** vitest 环境是 `node`（`vitest.config.mjs`），`tests/mocks/obsidian.ts` 没有 `ItemView`/`MarkdownRenderer` 桩，也没有 jsdom。`chatView` 的缓存复用循环、滚动读写、rAF 合帧**全部**只靠真机验收；单测只覆盖 `chatNode` 的纯函数与 `eventFold` 的 rev 契约。也就是说：**若有人再次把复用循环写坏，CI 不会红**。这是 #3 最值得写进回复的诚实边界。
2. **"滚动锚定"是复位，不是真锚定。** 实现是"变更前存 `scrollTop`、变更后原样写回"（`chatView.ts:696,758`），没有 CSS `overflow-anchor`，也没有 `scrollHeight` 差值补偿（为了不触发强制同步布局，明确不做）。后果：**向上翻历史时点"加载更早"，视口停在同样的偏移量上，正文内容整体下移** —— 你正在读的那一行会跑掉。这在 0.1.4 的注释里被表述为"滚动保持"，实际语义是"不抢回底部"，两者不等价。
3. **流式期的单节点重建仍是整块重建。** 每个 text-delta 都会 bump → 签名变化 → 当前 assistant 节点整块 `buildNodeEl` 重建（`chatView.ts:742-748`，构建函数在 `:762`）。成本从"O(整个会话)"降到"O(当前消息)"，量级已够，但严格说不是"只追加新文本"。
4. **没有性能门槛。** CI（`.github/workflows/ci.yml`）只有 lint/test/build/构建可复现，没有基准或长会话回归；性能回退只能靠用户报告发现。

### 3.4 英文回复草稿（可直接发布）

```text
Thanks again for the careful analysis — your diagnosis was correct: the old render path called msgEl.empty() and rebuilt every message, including a full Markdown re-render, on every incoming stream chunk. That is why cost grew with session length.

The fix landed in two steps, and the second one matters for exactly the symptoms you described. So please use v0.1.9 (current) rather than 0.1.4 — 0.1.4 only gets you half of it.

v0.1.4 — incremental rendering:
- message nodes are cached by key (sessionId:node.id) plus a content signature; unchanged nodes keep their existing DOM, only the streaming node is rebuilt
- Markdown is rendered once when the turn ends; while streaming the body is plain text with pre-wrap
- stale node DOM is removed (there had been a real-device regression where old elements accumulated, which duplicated messages and pushed INP/CLS up)
- scrolling: at the bottom the view follows the stream; when you have scrolled up it no longer yanks you back
- "load earlier" got loading feedback, a double-click guard, and auto-hides when there is no more history

v0.1.7 — the hot path (0.1.6 was withdrawn and its content merged into 0.1.7):
- the cache signature went from "concatenate the whole message text, plus up to 4000 chars of every tool result, on every render" to kind|rev — an O(1) signature; in long sessions the old one allocated megabytes per frame
- object-identity guard, so a rebuilt view cannot reuse stale DOM when a coincidentally equal rev shows up
- renders are coalesced into requestAnimationFrame (the 150 ms gate is kept)
- scroll geometry is read once before the DOM mutation and scrollTop written once after it — no forced synchronous layout
- reasoning deltas are throttled to at most one repaint per 250 ms

I verified this on a very long session (~18k events) with Obsidian 1.13.7: no freezing, smooth scrolling, INP back to normal, CLS 0.09. Regression tests pin the contracts that the fix depends on: tests/ui/chatNode.test.ts (10 tests, incl. the kind|rev signature and the object-identity guard) and tests/core/eventFoldRev.test.ts (24 tests, the rev/bump contract).

Two limitations I'd rather state than hide:
- There is no automated DOM-level test for the render path itself (the unit tests cover the pure cache/signature and rev functions only), so this is real-device-accepted rather than regression-proof in CI.
- "Scroll position" is preserved by restoring scrollTop, not by CSS scroll anchoring. Concretely: if you load older history while scrolled up, the viewport keeps the same offset rather than pinning the line you were reading.

Closing this as fixed. If you can still reproduce it on 0.1.9, tell me the session size and your Obsidian version and I'll dig further.
```

### 3.5 建议动作

- **close as fixed**，但回复必须先纠偏"0.1.4 就修好了"这一表述（这是现存评论里的事实性瑕疵，会误导后来者）。
- 若用户愿意配合，请其提供 **会话事件规模 + Obsidian 版本 + 是否仍在 0.1.4/0.1.5**；只要报告环境是 ≤0.1.5，一律先让其升 0.1.9 再说。
- 建议开 follow-up：**"chatView 渲染路径缺 DOM 级回归测试（无 jsdom）+ 无性能门槛"**、**"加载更早时视口内容下移：滚动锚定是复位不是锚定"**。两者都不属于 #3 的原始诉求（#3 的诉求是流式期卡死），不阻塞关闭。

---

## 4. 是否存在"master 上有修复但没发布"

**没有。** `git log 0.1.9..HEAD` = 0 条提交；`origin/master` == `master` == `0d8d837`（= tag `0.1.9`，2026-10-01）；无 open PR。三个 issue 的相关修复**全部落在已发布版本**里：

| 提交 | 日期 | 内容 | 首发版本 |
|---|---|---|---|
| `e47c0a5` | 2026-08-22 | #1 改名 + 守卫 | 0.1.2 |
| `4a4e6ef` | 2026-08-26 | #3 增量渲染 + #2 i18n 模块 | 0.1.4 |
| `f0ea669` | 2026-08-26 | #2 导出模板 + vault 根优先 | 0.1.4 |
| `1e78743` | 2026-08-26 | #2 模板键一致性测试 | 0.1.4 |
| `1ac89db` | 2026-08-26 | #2 导出按钮重复渲染修复 | 0.1.4 |
| `edcd6d2` / `b8f8ea1` / `0a3e271` | 2026-08-26 | #3 真机修复（重复 DOM / INP / CLS / 滚动） | 0.1.4 |
| `fb2b766`（并入 `c976b61`） | 2026-09-13 | #3 热点成本（`kind\|rev` / rAF / 单次几何读 / rev 契约） | **0.1.7**（0.1.6 已撤回） |

**版本号事实清单（回复里别写错）**：存在 tag 的是 `0.1.0 0.1.1 0.1.2 0.1.4 0.1.5 0.1.7 0.1.8 0.1.9`；**没有 `0.1.3`，也没有 `0.1.6`** 的 tag/release。0.1.3 只作为提交存在并被 0.1.4 继承；0.1.6 被撤回、内容并入 0.1.7。当前最新 = **0.1.9**。

---

## 5. 三条 issue 的共同残留（如实汇总，供后续排期）

| # | 残留 | 影响 | 与 issue 的关系 | 建议 |
|---|---|---|---|---|
| R1 | 约 21 处系统/传输错误串仍硬编码中文（`auth.ts` ×12、`client.ts` ×4、`muxStream.ts:350`、`sessionManager.ts:232/237/368`、`eventFold.ts:391`） | 非中文用户翻译完 UI 后，**故障路径**仍显示中文 | #2 只完成了 UI 面向部分 | 新开 follow-up issue |
| R2 | `chatView` 渲染/缓存/滚动路径无自动化测试（node 环境、无 jsdom、无 ItemView 桩） | 复用逻辑被写坏时 CI 不红 | #3 的修复质量依赖真机 | 新开 follow-up issue |
| R3 | 滚动"锚定"是 `scrollTop` 复位，加载更早时视口内容下移 | 长会话反复上翻时体验掉档 | #3 衍生 | 记入 backlog（`overflow-anchor: none` 或 `scrollHeight` 差值补偿二选一） |
| R4 | 导出 i18n 模板按钮零测试覆盖（`1ac89db` 的 4 重复按钮靠人眼发现） | 回归风险 | #2 衍生 | 与 R1 合并成一个 issue |
| R5 | 无性能基准/长会话 CI 门槛 | 性能回退只能靠用户报告 | #3 衍生 | backlog |

---

## 6. 发布顺序建议（Lead 执行时按此走）

1. 三条按 #1 → #2 → #3 依次发回复（英文草稿在第 1.3 / 2.4 / 3.4 节，均已含链接与版本号，可直接粘）。
2. #1、#2 发完即 close；#3 发完即 close（回复里已包含"如仍复现请补充 session 规模与 Obsidian 版本"）。
3. **不要**改 label、不要 assign、不要引用未发布版本号（本仓库没有 0.1.3/0.1.6）。
4. 关闭后按第 5 节开 2 个 follow-up（R1+R4 合并、R2+R3+R5 可合并），把残留留住，避免"关掉即遗忘"。
5. 本文件的"证据"编号（`e47c0a5`、`4a4e6ef` 等）可直接用于回复里的 commit 链接格式：`https://github.com/wozoulesky/dsh-obsidian/commit/<sha>`。

---

## 附录 A — 证据复现命令（只读）

```bash
# #1 修复前/后 + 发布产物
git show 0.1.1:src/ui/chatView.ts | grep -n "private async open"
git show 0.1.2:src/ui/chatView.ts | sed -n '86,96p'
git show 0.1.2:tests/build-sanity.test.ts | head -14
gh release download 0.1.2 --pattern main.js --output /tmp/rel-012-main.js \
  && node -e 'const s=require("fs").readFileSync("/tmp/rel-012-main.js","utf8");console.log(s.includes("async open("), s.includes("openConversation"))'

# #2 加载优先级 / 导出按钮 / 模板键一致性
sed -n '45,60p' src/main.ts
sed -n '90,110p' src/ui/settingsTab.ts
git show 0.1.4:main.js | grep -c "dsh-bridge.i18n.json"

# #3 修复前（全量重建）与 0.1.4 签名（仍是全文拼接）
git show 0.1.2:src/ui/chatView.ts | grep -n "msgEl.empty\|MarkdownRenderer.render"
git show 0.1.4:src/ui/chatNode.ts | sed -n '9,28p'
git ls-tree -r --name-only 0.1.4 tests | grep -c eventFoldRev   # → 0：0.1.4 没有该测试文件

# #3 0.1.7 的热点成本
sed -n '15,17p;40,41p' src/ui/chatNode.ts
sed -n '218,226p' src/core/eventFold.ts
sed -n '691,698p;755,759p' src/ui/chatView.ts

# 归属与发布状态
for c in e47c0a5 4a4e6ef f0ea669 fb2b766; do printf "$c: "; git tag --contains $c | tr '\n' ' '; echo; done
git tag -l; git log --oneline 0.1.9..HEAD; gh pr list --state open

# 本次实际跑过的测试
node node_modules/vitest/vitest.mjs run --config vitest.config.mjs \
  tests/ui/chatNode.test.ts tests/core/eventFoldRev.test.ts tests/i18n.test.ts tests/build-sanity.test.ts
```

## 附录 B — 测试基数与已知抖动（引用数字时注意）

- 本次实测（HEAD = 0.1.9）：定向 4 文件 **48/48 通过**；全量 `567 passed / 2 skipped / 569 tests / 38 files`（跳过的 2 条是 `tests/integration/liveServer.test.ts` 的真机集成用例，服务不可达自动 skip）。
- **已知抖动**：`tests/transport/muxStream.test.ts` 的 `open 发 open 帧（endpoint/payload），收 item 帧产出 value` 在本次核查的多次全量运行中多次出现 `Test timed out in 15000ms`（同一提交下也有多次全量通过）；单独跑该文件 18/18 通过。属传输层时序抖动，**与 #1/#2/#3 无关**，但引用"全绿"时建议注明"含 1 条已知传输抖动"。
- 本地 `npm` 不可用（EPERM），上述测试均以 `node node_modules/vitest/vitest.mjs run --config vitest.config.mjs` 直跑；`npm run lint` 等价命令 `node node_modules/eslint/bin/eslint.js src` → 0 问题；`node node_modules/typescript/bin/tsc -noEmit -skipLibCheck` → 0 错误。
