# 仓库改进审计：缺陷隐患 + 测试盲区 + 体验缺口

> 审计对象：`/Users/sky/Develop/dsh-obsidian`（Obsidian 插件 **DSH Bridge** v0.1.9）
> 审计时间：2026-10-17
> 审计范围：`src/` 全部 37 个 TS 文件（7,517 行）、`tests/` 38 个测试文件、`README.zh.md`、CI 配置、仓库产物
> 定位：**只读审计**。除本文档外未改动 `src/`、`README*`、`main.js` 中的任何字节。
> 本文件中的每条结论都指向 `文件:行号` 或一条可复现命令；无法给出两者之一的结论一律未收录。

---

## 0. 基线：先跑一遍，用真实数字说话

全部命令在干净工作树（`git status --porcelain` 仅显示 3 个未跟踪的 `docs/*.md`）上执行。

| 检查项 | 命令 | 结果 | 退出码 |
|---|---|---|---|
| 单元测试 | `node_modules/.bin/vitest run --config vitest.config.mjs` | `Test Files 38 passed (38)` / `Tests 567 passed \| 2 skipped (569)` / `Duration 3.99s`（多次运行 4.0–5.0 s 波动） | 0 |
| Lint | `node_modules/.bin/eslint src` | 无输出（0 warning / 0 error） | 0 |
| 类型检查 | `node_modules/.bin/tsc -noEmit -skipLibCheck` | 无输出 | 0 |
| 构建 | `node esbuild.config.mjs production` | 产出 `main.js` 158,000 B | 0 |
| 构建可复现 | 上面命令连跑两次 + `shasum -a 256 main.js` | `74746c4aac2d04b91c30ee8df93bad22070242012f467cb0af367bd7541f83ea`，两次一致 | 0 |
| 产物 == 仓库提交版 | `git ls-tree HEAD main.js` → blob `82dbb903e531ee897c9cc141b871eaacde086587` | `git hash-object main.js` 同值，**字节完全一致**，工作树无需 `git checkout -- main.js` | 0 |
| 真机集成冒烟 | `DSH_URL=http://127.0.0.1:56516 node_modules/.bin/vitest run tests/integration/liveServer.test.ts --config vitest.config.mjs` | `Tests 2 passed (2)` | 0 |

**结论：这个仓库的"基本面"是健康的。** lint/type/test/build 四门禁全绿，构建字节可复现这一条比绝大多数 Obsidian 社区插件都严格（`.gitattributes:2` 用 `main.js -text` 钉住行尾，CI `.github/workflows/ci.yml:36-41` 把"两次构建 sha256 一致"作为**阻断式**门禁）。所以本审计不去凑"代码质量问题"的数目，而是集中打**真机上会坏、但测试全绿照不到**的地方。

被测的真机是本地 DSH 桌面版 **0.2.1-rc.2**（`127.0.0.1:56516`，~116 个会话）。下文凡是标 **【真机实测】** 的，都是用 `node_modules/.bin/esbuild` 把 `src/` 打包成 CommonJS 后直接对着这个服务器跑出来的，脚本本身在 §附录 A 给出。

---

## 1. P0 —— 现在就坏，且完全静默

P0 的判据不是"代码丑"，而是：**线上已经在出事，用户看不见，测试永远绿。**
本次只有 1 条达到这个标准，但它是全篇最值钱的一条。

---

### P0-1 `session/control` 基线帧字段缺失 → 控制流第一帧就抛异常并被静默吞掉，队列/投影通道永久失效

**证据链（四段，全部可复现）**

1. **线上帧形状已经变了。** 【真机实测】打开 `session/control` 流，收到的 `baseline` 帧 `Object.keys(frame.value)` 只有 `["projections"]` —— 没有 `queues`，也没有 `jobs`。
   复现命令（脚本见附录 A）：

   ```
   $ node_modules/.bin/esbuild /tmp/probe.ts --bundle --platform=node --format=cjs \
       --define:window=globalThis --external:obsidian --outfile=/tmp/probe.cjs && \
     DSH_URL=http://127.0.0.1:56516 node /tmp/probe.cjs
   baseline keys: [ 'projections' ]
   applyControlFrame: THREW TypeError: Cannot convert undefined or null to object
   ```

2. **插件侧把这俩字段声明成必填，并且无保护地 `Object.entries()`。**
   - `src/transport/types.ts:405-414`：`SessionControlFrame` 的 `baseline` 分支把 `queues: Record<string, QueuedInboxItem[]>` 与 `jobs: Record<string, unknown[]>` 声明为**必填**字段（类型层面撒谎，正好挡住编译器）。
   - `src/core/store.ts:181`：`for (const [sessionId, items] of Object.entries(frame.value.queues))` —— 传 `undefined` 进来，`Object.entries(undefined)` 直接抛 `TypeError`。

3. **异常被完全吞掉，而且这条流不会重开。**
   - `src/core/globalStreams.ts:70`：`startControl()` 的 `void (async () => { try { ... for await ... } catch { /* 静默 */ } })()` —— 空 `catch`，连 `console.error` 都没有。
   - 全仓唯一的重启入口是 `src/main.ts:85`（`onState === "connected"` 时 `globalStreams.startAll()`）。流因为异常结束**不会**改变 mux 连接状态，所以不会触发 `connected`，也就不会再有一帧。

4. **测试用的是旧形状，所以 567 个测试全绿。**
   - `tests/core/store.test.ts:204-218` 的 fixture 手写补齐了 `queues` / `jobs` 字段，正好绕开真实帧的缺字段场景。
   - `tests/core/globalStreams.test.ts:59` 把 store 换成 `{ applyControlFrame: (f) => controls.push(f) }` 的**假对象**，把"store 会不会抛"这件事完全排除了。

**【真机实测】实际后果量化**：baseline 帧 39,213 B，覆盖 9 个会话，会物化 9 个 view、保留 189 个 projection cell（≈41,678 B）；其中 `turnOutline`（12,785 B）、`agentTeam`（11,858 B）UI 根本不消费。

**抛异常的确切位置与"已经做了一半"这一事实（重要，决定后果边界）：**

`src/core/store.ts:178` 先遍历 `frame.value.projections`（**这一步成功**，9 个会话的投影全部写进 `store.projections`，未打开会话也被物化），然后 `:181` 才遍历 `frame.value.queues` 并抛。所以：

- 首帧的**投影数据确实落进去了**，但 `:203` 的 `if (changed) this.notify()` **永远执行不到** → 没有任何视图收到 `onChange` → **UI 不会重绘**。数据在 store 里，界面看不见。
- 抛出后 `for await` 终止 → 流关闭 → 此后所有增量帧（`queue`/`projection`/`jobs`）**一帧都收不到**。

**不修会怎样（具体）：**

- **【用户可感知的主症状】侧栏会话标题/用量/待办停在打开那一刻。** 首帧数据虽然落了库，但 `notify()` 没跑 → 视图不刷新；之后每一条 `projection` 增量帧（`src/core/store.ts:197`）又因为流已死根本收不到。表现：别的窗口里 DSH 已把会话改名、用量已涨，插件侧栏还是旧值，直到重连（重连也只是"再落一次库 + 再不刷新"）或用户手动切走再切回（`openSession` 会 `dropView` 重建）。
- **待发队列（queue）彻底不可用。** `queue` 增量帧（`src/core/store.ts:189`）走同一入口，流死 → 收不到；`baseline` 里的 `queues` 那一半也在抛异常点之后，永远不被应用。
- **【关键】每个连接生命周期只工作"半帧"。** mux 断开重连 → `startAll()` → 新控制流收 baseline → 投影再次落库 → `:181` 再抛 → 流再死。功能表现为"每次重连好一下下，然后又不灵了"，极难归因。
- **零可观测性。** 空 `catch`（`src/core/globalStreams.ts:70`）意味着控制台、`load-error.log`（`src/main.ts:152-158` 只覆盖 onload 路径）、状态栏都不会有任何一个字。用户报障时你手里没有任何线索。

**修法（S 估算，约 1 小时）**

```ts
// src/transport/types.ts:~405  —— 类型改成真实契约（服务端可缺省）
queues?: Record<string, QueuedInboxItem[]>;
jobs?: Record<string, unknown[]>;

// src/core/store.ts:181
for (const [sessionId, items] of Object.entries(frame.value.queues ?? {})) { ... }
// 同文件 jobs 分支（若有）与 :174 之后的同族字段一律 `?? {}`

// src/core/globalStreams.ts:70（和 :53 的 $events 那处同样的空 catch）
} catch (err) {
  if (!ctrl.signal.aborted) console.error("[dsh-bridge] control stream 异常结束:", err);
}
```

配套测试（**必须加，否则下次线上再变形还是绿**）：把 `tests/core/store.test.ts:204-218` 的 fixture 换成**从真机抓的原始帧**（只含 `projections`），断言 `applyControlFrame` 不抛且 `title` 仍被播种；再给 `tests/core/globalStreams.test.ts` 加一条"store 抛异常时该 error 必须被记录、且流不静默死掉"的用例。

**影响面**：`src/core/store.ts`、`src/transport/types.ts`、`src/core/globalStreams.ts` 三个文件；不动协议层、不动 UI。
**风险**：低。全部是"缺省值兜底 + 类型放宽 + 补日志"，没有行为改变，只是让本来该发生的事发生。
**为什么是 P0 而不是 P1**：它是**已经在生产中发生的功能缺失**，不是潜在风险；而且它同时具备"测试绿""无日志""能自愈一帧"三个特性，靠日常使用几乎不可能被发现。

---

## 2. P1 —— 会咬人，但需要特定条件；修起来都不贵

---

### P1-1 冷启动时 `onload` 同步阻塞最长 6 秒，期间面板/命令全部不存在

**证据**：`src/main.ts:22` `PROBE_TIMEOUT_MS = 3000`；`src/main.ts:61-63` 在 `onload` 里 `await` 探测配置 URL，失败再 `await autoSwitchDshUrl(...)`（内部 `findWorkingDshUrl` 会再探一个候选，同样 3 s 超时，`src/core/diagnose.ts:114-148`）。而 `addRibbonIcon` / `registerView` / `addCommand` / `addSettingTab` 全在**这两次 await 之后**（`src/main.ts:126-148`；`registerView` 在 `:126`、`addSettingTab` 在 `:148`、`mux.start()` 在 `:150`）。

**【真机实测】最坏路径**：在 19387 与 3080 上各挂一个"接受连接但永不响应"的监听器（黑洞端口）→ 配置 URL 探测 3,010 ms + 候选探测 3,010 ms = **6,020 ms** 阻塞（正常"端口拒绝"情况仅 46 ms，所以这问题只在 DSH 挂起/防火墙丢包/VPN 场景复现 —— 恰好就是用户最需要看诊断的时候）。

**后果**：Obsidian 侧栏图标点了没反应（视图尚未注册），命令面板搜不到 `DSH`，设置页看不到插件项，Obsidian 自身可能弹出"插件加载缓慢"。用户第一反应是"这插件有问题"，而实际是插件在等 DSH。

**修法（S）**：把"探测 + 自动切换"从 `onload` 的关键路径上摘下来 —— 先用配置的 URL 构造 client 并**立即**注册视图/命令/设置页，探测放到 `void (async () => { ... })()` 里，探到可用 URL 再走一次 `client.reconfigure(url)`（或直接重建 client + `mux.start()`）。顺带解决 P1-2。

**影响面**：`src/main.ts`。**风险**：中 —— 注册顺序变化，需回归"未连接状态下打开面板""onload 抛错时 onunload 仍安全"两条路径。

---

### P1-2 设置页"诊断连接"改写了 `dshUrl` 却提示用户"重启生效"，而插件内没有热切换路径

**证据**：`src/ui/settingsTab.ts:26-32` 探测失败后 `findWorkingDshUrl` → 写 `settings.values.dshUrl` → `new Notice(t("settings.dshUrlDetected"))`；文案在 `src/i18n.ts:130`：**「已保存到设置——重启 Obsidian 或重新启用插件后生效」**。但活的 `DshClient` 和 `RemoteMuxTransport` 的 `baseUrl` 在 `onload` 时构造（`src/main.ts:66-70`），此后**没有任何 reconfigure 接口**。而 `README.zh.md:21` 对用户的承诺是"自动探测常见端口"。

**后果**：用户看到"已修复"，但当前会话仍然连着旧地址；每次改地址都要重载整个 Obsidian。文案是诚实的（它说了要重启），但与 README 的承诺和"诊断"按钮的语义（一键修好）冲突 —— 这是**体验缺口**而不是谎言，所以列 P1 不列 P0。

**修法（S）**：与 P1-1 同一处改造 —— 抽 `applyBaseUrl(url)`：`settings.values.dshUrl = url` → `client.setBaseUrl(url)` → `mux` 重连 → `globalStreams.startAll()`。文案改成「已切换到 {url}」。若暂不做热切换，则把文案改成明确的「请执行命令“重载插件”」，不要让用户自己去重启整个应用。

**影响面**：`src/ui/settingsTab.ts`、`src/main.ts`、`src/i18n.ts`、`i18n.template.json`（同步 1 个 key 的文案）。**风险**：低。

---

### P1-3 输入框没有 IME 合成保护：中文/日文输入按 Enter 选词会直接发出半成品消息

**证据**：`src/ui/inputBox.ts:184` `if (e.key === "Enter" && !e.shiftKey)` → 紧接着 `e.preventDefault()`、`this.textarea.value.trim()`、`this.textarea.value = ""`（`:189`）、`await this.onSend(...)`。全流程**没有 `e.isComposing` 判断，也没有 `compositionstart`/`compositionend` 守卫**：

```
$ grep -rn "isComposing\|compositionstart\|compositionend\|composition" src/ tests/
（无任何匹配）
```

而 placeholder 是中文（`src/i18n.ts:96`），默认字符串 140 个 key **全是中文** —— 目标用户就是用输入法打字的人。

**后果**：中文/日文/韩文用户在用输入法选词时按 Enter，Chromium 会先派发 `keydown`（此时 `isComposing === true`）再派发 `compositionend`。插件在 `keydown` 里就 `preventDefault` + 清空 + 发送了 —— 结果是**把还没上屏的拼音/假名当正文发出去**，并且已清空的输入框无法恢复（与 P1-5 相同的数据丢失路径）。附带风险：`suggestEl` 打开时（`src/ui/inputBox.ts:169-173`）Enter 被用来 `acceptSuggest()`，同样没有合成判断。

**修法（S，约 20 行）**：
```ts
if (e.isComposing || e.keyCode === 229) return;   // onKeydown 最前面
```
外加 `compositionend` 后 20 ms 内忽略 Enter 的兜底（Safari/部分 IME 在 `compositionend` 之后还会补一个 `keydown`）。测试可以用 `tests/ui/inputBox.test.ts` 现有的假 DOM 直接构造 `new KeyboardEvent("keydown", { key: "Enter", isComposing: true })` 来断言"未发送"。

**影响面**：`src/ui/inputBox.ts`。**风险**：低（只加守卫，不改正常路径）。

---

### P1-4 单条坏记录会让整页历史/整个会话快照失败，没有逐条降级

**证据**：`src/transport/chunkRows.ts:31-32` `malformed()` 直接 `throw`；`expandHistoryRecords`（同文件 `:101-106`）对 `records` 循环 `out.push(...expandChunkRow(record))` **没有 per-record try/catch**。调用方：
- `src/core/store.ts:124`（`applyFollowSnapshot` 内的 `expandHistoryRecords`）→ 抛 = **会话打不开**；
- `src/core/sessionManager.ts:348`（`loadOlder`）→ 抛 = UI 弹 `chat.loadFailed`（`src/ui/chatView.ts:129-131`）。

**后果**：持久化日志里只要有一条 `chunkrow/*` 记录字段不全（服务端版本漂移、磁盘截断、老会话迁移残留），该会话就**永久无法打开**——而其他 115 个会话都正常，用户完全无法理解。历史页码同理：一页 20 条里坏 1 条，用户就再也看不到更早的内容。

**修法（S/M）**：`expandHistoryRecords` 内层包 try/catch，坏行降级为一条占位节点（`kind: "system"`，文案「该条历史记录无法解析」）+ `console.warn` 带 `seq`，**不让整页失败**。同时保留"顶层帧结构性错误仍然抛"（协议层不该被静默）。加一条测试：20 条里第 7 条畸形 → 返回 20 条、第 7 条是占位、其余完好。

**影响面**：`src/transport/chunkRows.ts`（+1 测试）。**风险**：低 —— 纯降级，正常数据路径不变。

---

### P1-5 发送失败会丢掉用户刚敲的正文（图片保留，正文不保留）

**证据**：`src/ui/inputBox.ts:186-195` —— 先 `this.textarea.value = ""`（`:189`），再 `await this.onSend(text, images)`，**只有 `ok === true` 才清 `pendingImages`**（`:191-195`），但**正文文本在任何情况下都不回填**。成功路径的回填逻辑不存在（也不需要），失败路径也没有。
现有测试 `tests/ui/inputBox.test.ts:451-461`（「发送失败：保留 chip（用户不必重新选图）」）只断言 chip 还在，**没有断言 `textarea.value` 仍等于原文** —— 所以这个洞一直绿着。

**后果**：网络抖动/DSH 重启时发送失败 → `chat.sendFailed` Notice 弹出 → 输入框空了 → 用户打的长 prompt 没了。图片还在、文字没了，是最恼人的组合（用户往往意识不到可以 Ctrl+Z，因为 `value = ""` 是脚本赋值、不进浏览器的 undo 栈）。

**修法（S）**：`if (!ok) { this.textarea.value = text; this.textarea.setSelectionRange(text.length, text.length); }`（注意回填 `trim` 前的原文，或统一用 trim 后文本）。补断言：`expect(textarea.value).toBe("看这张图")` 到上面那条测试里。

**影响面**：`src/ui/inputBox.ts` + 1 测试断言。**风险**：低。

---

### P1-6 `QuestionModal` 的答案拼装跨了两层事件、且零测试覆盖（脆弱但当前可用）

**证据**：`src/ui/chatView.ts:915` 起：

```
915:  const selected = new Set<string>();
919:  cb.addEventListener("change", () => { if (cb.checked) selected.add(opt.label); else selected.delete(opt.label); });
926:  const answer: AskUserQuestionAnswerItem = { id: q.id, selected: [] };
927:  this.answers.push(answer);
928:  this.contentEl.addEventListener("change", () => { answer.selected = [...selected]; });
```

**如实说明**：我在初稿里把这条判成"可能提交空选"，复核后**下调**——`change` 事件在真浏览器里确实会从 `input` 冒泡到 `contentEl`，两层监听在同一事件里按"先子后父"顺序执行，所以正常点击路径**是对的**。这条列 P1 的真实理由是另外两点：

1. **正确性依赖一个隐式约定**：`selected`（内层）→ `answer.selected`（外层）的同步完全依赖事件冒泡顺序，没有任何直接连接。任何人后续把选项控件包进 `stopPropagation()` 的容器、或改用 `click` 而非 `change`、或把 `contentEl` 换掉，都会**静默**把答案变成 `[]`，没有任何断言会红。
2. **零测试**：`grep -rn "ApprovalModal\|QuestionModal" tests/` **无匹配**。`Modal` stub 已能实例化（`tests/mocks/obsidian.ts:71-83`），所以这不是"测不了"，是"没测"。

**后果**：当前真机行为正常；一旦有人改动选项渲染结构，提交空答案会被服务端当成"无回答"处理，用户却以为自己选了。属于**易碎点 + 无护栏**，不是现存故障。

**修法（S）**：把 `answer` 提到外层，内层监听直接写 `answer.selected`，取消冒泡依赖；补一个不碰真 DOM 的测试：构造 `QuestionModal`，手动 `dispatch("change")` 各选项并断言 `answers` 内容（多选/单选/自由输入三分支各一条）。

**影响面**：`src/ui/chatView.ts:888-953`。**风险**：低。

---

### P1-7 首次打开大会话：36 万字节单帧 + 20 条渲染窗口，但"还有更早"没有任何预兆

**证据**：【真机实测】按 `projections.asOfSeq` 取最大的 3 个会话，`session/follow` 快照：
| asOfSeq | 首帧耗时 | 单帧字节 | records | 折叠耗时 |
|---|---|---|---|---|
| 5706 | 578 ms | 365,395 B | 100 | 1.9 ms |
| 4512 | 17 ms | 349,775 B | 126 | 0.3 ms |
| 1817 | 62 ms | 347,034 B | 96 | 0.4 ms |

值得表扬的是**折叠本身极快**（<2 ms），说明 `eventFold` 没写坏。问题在两处产品行为上：
1. 首帧 578 ms 期间 UI **完全没有任何加载态** —— `src/ui/chatView.ts:141-142` 的空态只有「尚无会话」和静态的「⏳ DSH 正在工作…」，没有"正在加载会话…"。
2. 快照只渲染 20 个节点（`nodeBytes` 9.4 KB），但 `hasMore` 要靠用户自己发现那个「更早」按钮（`src/ui/chatView.ts:118`）。且 `loadOlder` 前插后**没有滚动位置补偿** —— `renderNow` 的 `scrollTop` 只在"钉底/保持原位"两种策略里选（`src/ui/chatView.ts:758`），前插历史后用户视口会**跳到新内容中间**（这是经典的前插补偿缺失；`grep -n scrollHeight src/ui/chatView.ts` 只有注释里提到，代码里从不读）。

**后果**：大会话（半天工作即达到）打开有明显空白期，用户重复点击/以为卡死；点"更早"后失去阅读位置。

**修法（S/M）**：首帧期间显示骨架/「加载中」；`loadOlder` 成功后把「前插前的 `scrollHeight` 差值」加到 `scrollTop`（这一次读布局是**必要**的，且只在前插路径上，不违反"渲染循环不读布局"的既定优化）。

**影响面**：`src/ui/chatView.ts`。**风险**：中（滚动逻辑是全文件最精细的部分，需要真机验证）。

---

## 3. P2 —— 真实存在，但可以先记账

| # | 问题 | 证据 | 影响 | 量级 | 风险 |
|---|---|---|---|---|---|
| P2-1 | **`store` 无淘汰机制**，只有 `dropView`（会话切换/重连时清）；投影 cell 只增不减 | `src/core/store.ts:14-15`、`:255-260` | 【真机实测】仅 9 个会话就留 189 个 cell ≈ 41,678 B；其中 `turnOutline` 12,785 B、`agentTeam` 11,858 B **UI 根本不消费**（`grep -rn "turnOutline\|agentTeam" src/ui/` 为空）。116 个会话全开过之后是线性增长，且投影通道一坏（P0-1）连"清理时机"都没有 | S | 低 —— 加个 LRU cap（如 32 个会话）+ 白名单只存 UI 消费的 key |
| P2-2 | `queueItems` 端到端维护但**零 UI 消费** | `src/core/eventFold.ts:155,185`；`src/core/store.ts:181-192,232`；`grep -rn queueItems src/ui/` → 空 | 死代码面。P0-1 修好后队列数据会真的流动起来，但没有渲染入口 = 白搬 | S | 低 —— 要么接 UI（排队提示条），要么删字段 |
| P2-3 | `runtime.muxState` 写了不读，面板内没有"重连中"提示 | `src/main.ts:35,72,121`；`grep -rn muxState src/ui/` → 空 | 只有状态栏文字在变（`main.ts:72-82`）；侧栏里用户看不到连接状态。重连中发的消息直接失败（P1-5 再丢一次正文） | S | 低 —— 面板 header 加状态点 |
| P2-4 | 审批/提问只在 **有 `DshChatView` 打开时**才弹；且会兜底弹**别的会话**的待办 | `src/ui/chatView.ts:834-846`（只有这两处 `new ApprovalModal\|QuestionModal`；`pendingApprovals[0]` 兜底） | 与 `README.zh.md:13,30` 承诺的"审批会主动提醒"不符：用户切到笔记页/关掉面板后审批永远不弹，DSH 那侧一直挂着 | M | 中 —— 需要 `main.ts` 级监听 + Notice/ribbon 徽标 |
| P2-5 | `approvalCenter` 的待办 Map 在流重启时不清空 | `src/core/approvalCenter.ts:37-38`（只在 `cancel` 帧或应答成功时删）；`ready` 帧只重绑 `clientId` | 若断线期间用户已在别处处理掉某条审批，插件侧仍显示它；点"同意"会得到服务端错误（`approval.failed`）。不会脏数据，只是幽灵弹窗 | S | 低 —— `ready` 帧到达时按 `eventId` 对账或直接清空待办 |
| P2-6 | 空态完全不给连接指引 | `src/ui/chatView.ts:141-142`（只有「尚无会话，点击「新建」开始。」）；「⏳ DSH 正在工作…」是静态 div，与实际 `running` 无关 | 新用户第一次打开、DSH 没启动时，唯一看到的是"点击新建开始"→ 点了报 `openFailed`/`listLoadFailed`。README 讲了怎么连，但 App 里没有任何一步告诉他 | S | 低 —— 空态按 `runtime.muxState` 分支渲染三句话 |
| P2-7 | 错误文案一律 `消息头 + err.message`，没有可执行下一步 | `src/i18n.ts:25-31`（`chat.listLoadFailed`/`openFailed`/`sendFailed`/`loadFailed`）；`classifyDshFailure`（`src/core/diagnose.ts:37`）+ `failureHintKey`（`:53`）**只在设置页诊断里用**（`src/ui/settingsTab.ts:2,18`），主界面从不复用 | 用户看到"发送失败：fetch failed"就卡住了。分类器明明已经知道"DSH 没在运行/端口不对/版本不符/认证失败"，却不对主路径生效 | S | 低 —— 把 `classifyDshFailure` 接进 `send`/`open`/`list` 的 catch 分支 |
| P2-8 | `auth.lastFailure` 死 API | `src/transport/auth.ts:390` | 无消费者 | S | 低 —— 删 |

---

## 4. 测试盲区：先说"哪些不值得补"

覆盖工具缺失（`devDeps` 里无 `@vitest/coverage-*`），所以下面是**按 import 关系**手工核算的：某文件被任何 `tests/**` 直接或间接 import 即算覆盖。

### 4.1 完全无直接测试的文件（按"该不该补"排序）

| 文件 | 行数 | 有没有测试 import | 该不该补 |
|---|---|---|---|
| `src/ui/chatView.ts` | 953 | **仅靠 `tests/build-sanity.test.ts:9-11` 的正则文本断言**（"不得定义 `async open("`） | **该补，且最值钱**。渲染循环、滚动钉底、nodeCache 淘汰、模态生命周期、模型/推理档切换全在里面 —— 也是本审计里 P1-6/P1-7/P2-4/P2-6 的所在地 |
| `src/ui/inlineEditModal.ts` | 108 | 无 | **该补**（中等价值）：选中为空的分支、`onClose` 后不再弹窗、超时（`inlineEditTimeoutSec`）路径 |
| `src/ui/diffPreview.ts` | 31 | 无 | 可补可不补（纯渲染，逻辑已在 `core/wordDiff` 有测试）。**不优先** |
| `src/transport/nodeShims.ts` | 29 | 无 | **不值得**：纯全局补齐，`typeof x === "undefined"` 五个分支，补测试等于抄实现。真机 `onload` 成功即证明可用 |
| `src/utils/timers.ts` | 14 | 无 | **不值得**：`clearTimer` 一行封装 |
| `src/core/narrow.ts` | 50 | 无（但被 `commands`/`sessionProjections`/`eventFold` 大量间接触达） | **不值得单独补**：`readField`/`numberField`/`nonEmptyStringField` 的行为已被上层测试充分传递性覆盖 |

### 4.2 结构性盲区（比"文件没测"更危险）

1. **协议形状没有"契约测试"。** 所有 RPC/WS 用例都用**手写 fixture**（如 `tests/core/store.test.ts:204-218`），fixture 的字段集合等于作者当时的假设。服务端去掉两个字段 → 567 个测试一个都不红 → 就是 P0-1。
   **建议（M）**：把**一次真机采集的原始帧**存成 `tests/fixtures/wire-0.2.1-rc.2/*.json`（baseline、follow snapshot、$events ready、approval waterfall 各一份），加一组"真实帧必须能无异常通过 store/approvalCenter"的用例。这是**唯一能挡住下一轮服务端漂移**的手段，且完全离线可跑（不需要真机）。
2. **`globalStreams` 只有 3 个用例**（`tests/core/globalStreams.test.ts`），全在断言"帧被分发到假 store"，**没有一条覆盖"下游抛异常时流的行为"** —— 正好是 P0-1 的第二现场。
3. **没有 jsdom / happy-dom。** `devDeps` 里两个都没有；`tests/mocks/obsidian.ts` 是手写假 DOM（`.children`、`dispatch`、`type`、`pressEnter`）。这套自研 harness 对 `inputBox`（25 个用例）够用，但**撑不起 `chatView` 的 953 行**（要 `scrollHeight`/`clientHeight`/真实布局）。补 `chatView` 有两条路：
   - **推荐**：继续用现有假 DOM + 只测**决策逻辑**（把"该滚动到哪""该淘汰哪些 node"抽成纯函数导出后单测），不测 DOM 本身。
   - 不推荐：为 `chatView` 引入 jsdom（体积 + 与真实 Obsidian DOM 差异，投入产出比差）。
4. **模态框零覆盖。** `Modal` stub（`tests/mocks/obsidian.ts:71-83`）已经能实例化，`ApprovalModal`/`QuestionModal`/`DiffPreviewModal` 都可以在**不碰真 DOM** 的前提下驱动 `onOpen` + 手动 event。现在的 0 覆盖是白放着的能力。
5. **`tests/integration/liveServer.test.ts` 的 2 个用例在 CI 里恒跳过**（`BASE = process.env.DSH_URL ?? "http://127.0.0.1:3080"`，`skipIfDead` ×2；CI `.github/workflows/ci.yml` 不设 `DSH_URL` 也不起服务）。所以 569 个测试里那 2 个 skipped 是设计如此，不是缺陷 —— 但也意味着**CI 里没有任何一条真机契约验证**（与建议 1 互补：用录制帧代替真机）。

### 4.3 明确说"不值得做"的

- 给 `nodeShims`/`timers`/`narrow` 补直接测试。
- 追求行覆盖率数字。当前 567 个断言密度已经很高；真正的洞是**契约形状**和**UI 决策**，不是行覆盖。
- 为 UI 引入快照测试（`toMatchSnapshot`）。假 DOM 的快照会把"渲染实现细节"固化，改样式就红一片，噪声大于收益。

---

## 5. 体验缺口：用户最常卡的 5 个地方（读 `README.zh.md` + `src/ui/*` 得出）

按"卡住频率 × 自救可能性"排序。每条的判据都注明了来源行。

### ① 连不上时，App 里没有任何一句话告诉用户"去启动 DSH"
- **表现**：首次安装 / DSH 升级后端口变了 → 打开面板看到「尚无会话，点击「新建」开始。」（`src/ui/chatView.ts:142`），点新建 → `chat.openFailed`/`listLoadFailed`（`src/i18n.ts:25-26`）；状态栏有小字（`src/main.ts:72-82`），但不看状态栏就完全没有线索。
- **应为**：空态按连接状态分三支渲染 —— 未连接：「DSH 未运行，请先启动 DSH 桌面版或 CLI，再点此重试」+ 一个重试按钮；连接中：「正在连接 127.0.0.1:3080…」；已连接：「尚无会话，点击「新建」开始。」
- **成本**：S。**收益**：这是新用户 100% 会走的第一条路径。

### ② 大会话首次打开有 0.5–1 s 的白屏，且"还有更早"需要用户自己猜
- **表现**：见 P1-7 实测（578 ms / 365 KB）。空态文案不区分"没会话"和"正在加载会话"。
- **应为**：加载骨架 + 明确的「正在加载最近 20 条…」；「更早」按钮前置到顶部并标注剩余条数（`hasMore` 已经在 `loadOlder` 返回值里，`src/core/sessionManager.ts:349`）。
- **成本**：S/M。**收益**：所有重度用户每天撞。

### ③ 审批/提问在离开面板后不再提醒 —— 与 README 承诺相反
- **表现**：`README.zh.md:13`（「审批就落在你眼前……断线重连后也不会丢」）与 `README.zh.md:30`（「审批 / 提问弹窗……重连后会重新浮现」）说审批会主动提醒；实现里只有 `DshChatView.maybeShowNextApproval`（`src/ui/chatView.ts:834-846`），视图一关就再无声响。DSH 那侧任务就一直挂着。
- **应为**：提示来源移到 `main.ts`（订阅 `approvalCenter.onChange`），面板关闭时用 `new Notice("DSH 需要你确认：…（点击打开）")` + ribbon 图标加未读角标。顺带修 P2-4 的"弹别的会话"兜底。
- **成本**：M。**收益**：这是"人在写笔记、AI 在等你"的核心场景，掉了就等于功能不可用。

### ④ 停止/取消的可见性不足：按了停止之后没有任何"已请求"的中间态
- **表现**：`src/ui/chatView.ts:383-392` 的 header 只有「停止」按钮 → 直接 `manager.cancel`，失败才弹 `chat.stopFailed`。按下到服务端真的停下之间，按钮仍是可点的「停止」，助手气泡仍在增长（`view.running` 要等事件回来才变）。用户会连点。
- **应为**：点击后立刻置为 disabled + 文案「正在停止…」，`running` 变 false 再复原；超时（如 5 s）恢复并提示。
- **成本**：S。**收益**：取消是高频操作，且"没反应就再点"会放大成重复请求。

### ⑤ 错误文案不可执行：全是"动作 + 冒号 + 底层 message"
- **表现**：`src/i18n.ts:25-31` 四条主路径错误；典型内容如「发送失败：fetch failed」/「打开会话失败：…」。而 `classifyDshFailure`（`src/core/diagnose.ts:37`）已经能把失败精确分成 notRunning / unreachable / notResponding / versionMismatch / authFailed / unknown，`failureHintKey`（`:53`）也已经配好了对应的人话——**但只在设置页诊断用**（`src/ui/settingsTab.ts:2,18`）。
- **应为**：`send`/`openConversation`/`loadOlder`/`refresh` 的 catch 分支统一走 `classifyDshFailure` → 按 `failureHintKey` 输出可执行文案（"DSH 未运行，请先启动" / "端口无响应，检查设置里的 URL" / "DSH 版本过旧，请升级到 ≥0.2"）。
- **成本**：S。**收益**：把已写好但没接上的能力接上，是本文档里"投入产出比最高"的一条。

---

## 6. 建议的落地顺序

| 批次 | 内容 | 估算 | 说明 |
|---|---|---|---|
| 第 1 批（当天） | **P0-1** + 真机录制帧契约测试 | S + M | 唯一"线上已坏"项；契约测试防复发 |
| 第 2 批（同步做） | P1-1 & P1-2（同一处改造）、P1-5、P1-3 | S×4 | 都是十几行的改动，且同时改善"首次连接体验" |
| 第 3 批 | P1-4、P1-6、§5-⑤（错误文案接分类器） | S×3 | 都是"已有能力没接上/降级缺失" |
| 第 4 批 | P1-7、§5-①③④ | S/M | 体验层，建议配真机手测 |
| 记账 | P2-1…P2-8 | — | 建议 P2-2（`queueItems` 死字段）与 P0-1 一起决断：接 UI 或删 |

---

## 附录 A：真机探针脚本（本审计所有"【真机实测】"的来源）

```bash
# 1) 控制流基线帧形状 + store 是否抛（P0-1 的证据）
cat > /tmp/probe.ts <<'EOF'
import { DshClient } from "<repo>/src/transport/client";
import { DshCookieAuth } from "<repo>/src/transport/auth";
import { SessionStore } from "<repo>/src/core/store";
(async () => {
  const base = process.env.DSH_URL ?? "http://127.0.0.1:56516";
  const auth = new DshCookieAuth({ baseUrl: base });
  const cookie = await auth.cookieHeader();
  const client = new DshClient({ baseUrl: base, cookieHeader: () => Promise.resolve(cookie) });
  const stream = await client.openStream<any>("session/control", {});
  for await (const frame of stream) {
    console.log("baseline keys:", Object.keys(frame.value));
    try { new SessionStore().applyControlFrame(frame); console.log("applyControlFrame: OK"); }
    catch (err) { console.log("applyControlFrame: THREW", String(err)); }
    break;
  }
  process.exit(0);
})().catch((e) => { console.error("ERR", e); process.exit(1); });
EOF
node_modules/.bin/esbuild /tmp/probe.ts --bundle --platform=node --format=cjs \
  --define:window=globalThis --external:obsidian --outfile=/tmp/probe.cjs --log-level=error
DSH_URL=http://127.0.0.1:56516 node /tmp/probe.cjs
# → baseline keys: [ 'projections' ]
# → applyControlFrame: THREW TypeError: Cannot convert undefined or null to object
```

```bash
# 2) 大会话首帧字节/耗时/折叠耗时（P1-7 的证据）
#    用 projections.asOfSeq 排序取最大的 3 个会话，openStream("session/follow",
#    { request: { address: { kind: "session", sessionId }, maxMessages: 20, assistantStream: true } })
#    统计 snapshot 帧字节数、首帧耗时，再 applyFollowSnapshot 计时。
#    实测：578ms/365,395B/100 records、17ms/349,775B/126、62ms/347,034B/96；折叠 0.3–1.9 ms。
```

> 注：`openStream` 返回的是 `Promise<AsyncIterable<T>>`（`src/transport/client.ts:216`），**必须 `await`**；WS 路径必须传 cookie（`DshCookieAuth.cookieHeader()`），否则握手被拒。这两点都踩过。

## 附录 B：审计期间未改动的东西（透明性声明）

- `src/` **零改动**；`README*` 零改动；`main.js` 未重写（构建产物 sha256 与已提交 blob 一致，无需 `git checkout -- main.js`）。
- 本文档是唯一新增文件。
- 探测脚本一律写到 `/tmp` 并在用完后删除；仓库工作树最终 `git status --porcelain` 只多出 `docs/` 下 4 个未跟踪的 `.md`（其中 3 个是其他并行审计的产出）。
- 环境限制：`~/.npm` 归属 root，`npm install` 类命令一律 EPERM，故全程使用 `node_modules/.bin/*` 与裸 `node`；未安装任何新依赖（因此也无法生成覆盖率数字，覆盖结论是手工按 import 图核算的）。
