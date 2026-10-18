# DSH Bridge 下一版该做什么（2026-10-18 汇总）

> 起因：DSH 已更新到 **0.2.1-rc.2**（桌面端），需要确认本插件（v0.1.9）还差什么。
> 本文是四份专项报告的汇总与排期建议，细节与证据分别见：
>
> | 报告 | 内容 |
> |---|---|
> | [audit-2026-10-17-port.md](audit-2026-10-17-port.md) | 动态端口：根因、三条发现路径的实测对比、推荐方案 |
> | [audit-2026-10-17-protocol.md](audit-2026-10-17-protocol.md) | 0.2.1 协议增量核查：21 个端点/认证/帧协议逐条判定 |
> | [audit-2026-10-17-repo.md](audit-2026-10-17-repo.md) | 仓库审计：缺陷隐患、测试盲区、体验缺口（P0/P1/P2） |
> | [issue-triage-2026-10-17.md](issue-triage-2026-10-17.md) | 三个 open issue 的核实结论与可直接发布的英文回复 |
>
> 日期：2026-10-18 · 基线：`master@0d8d837` = tag `0.1.9`

---

## 0. 一句话结论

**插件的协议没有坏，坏的是「找到 DSH」这一步。** DSH 0.2.1 桌面端把固定端口 `19387` 改成了系统随机分配
（`--port 0`），而插件只探测 `19387`/`3080` 两个写死的端口 —— **升级 DSH 后必然连不上，且自动探测救不回来**。
另外还查出两个与版本无关、但一直潜伏的真实缺陷（控制流首帧崩溃、传输层双连接竞态）。

---

## 1. 两处「必须改」的事实修正（README / 文案已经在说错话）

| 位置 | 现在写的 | 事实 |
|---|---|---|
| `README.md` / `README.zh.md` 前置条件、安装 | 「桌面 App 固定 `http://127.0.0.1:19387`」 | **0.2.1 起是系统随机端口**，每次启动都可能不同 |
| `src/i18n.ts` `settings.dshUrlDesc` / `diag.notRunning` / `diag.unreachable` | 同上，并引导用户去改 19387 | 同上 —— 诊断会把「DSH 正在运行」误报成「没有运行」 |
| `src/core/diagnose.ts:87-95` 注释 | 「都不是动态端口」 | 已失效 |
| `docs/dsh-0.2-compat-audit-2026-10-01.md` 5.1 | 「桌面 App 固定 19387 / `--port 19387`」 | 已被 0.2.1 证伪，需标注过期 |

**证据**（本机 0.2.1-rc.2 实证）：asar 内 16,736 个 packed 文件全量扫描，`19387` 出现 **0 次**；
`dsh-desktop-host` 现为 `args: ["--no-open","--host","127.0.0.1","--port","0"]`；实际监听 `127.0.0.1:56516`。

---

## 2. 优先级排期

### P0 —— 发下一版前必须做

| # | 事项 | 证据/落点 | 工作量 |
|---|---|---|---|
| P0-1 | **端口发现**：`配置 → 静态 19387/3080 → Cookie 库反解 → TCP 扫描兜底` 四级降级 | `src/core/diagnose.ts` + `src/main.ts` 一行；见 port 报告 §6.3/§7.3 | M |
| P0-2 | **控制流 baseline 崩溃**：`frame.value.queues ?? {}` + 类型改可选 + 补日志 | `src/core/store.ts:181`、`src/transport/types.ts:405-414`、`src/core/globalStreams.ts:70` | S |
| P0-3 | **传输层双连接竞态**：`start()` 里 `connect()` → `waitForSocket()` | `src/transport/muxStream.ts:216-217` | S（一行 + 一条回归用例） |
| P0-4 | 修掉上面三处后，README/文案/注释的事实修正 | 见 §1 | S |

### P1 —— 强烈建议同版

| # | 事项 | 证据 |
|---|---|---|
| P1-1 | **冷启动阻塞**：`onload` 里 `await` 探测（最坏实测 **6,020 ms**），期间 view/命令/设置页都不存在 → 探测改为非阻塞（先建 client，命中后热切换） | `src/main.ts:61-63` |
| P1-2 | **输入法 Enter 误发送**：全仓 `isComposing` 零匹配，中文用户选词按 Enter 会发出未上屏内容且输入框已清空 | `src/ui/inputBox.ts:184` |
| P1-3 | **失败路径仍冒中文**：约 21 处传输/系统错误串硬编码中文，经 `{message}` 进 Notice —— 非中文用户翻译完 UI 后，故障时仍看到中文 | `auth.ts`×12、`client.ts`×4 等 |
| P1-4 | **上下文占用条**：`contextPressure` 已随 projection 帧免费下发，修完 P0-2 即零成本可用 | protocol 报告 §5 |
| P1-5 | **CI 增加 macOS runner**：P0-3 这类平台时序竞态在 Ubuntu 上永远绿 | `.github/workflows/ci.yml` |

### P2 —— 下一轮

- `session/rename`、`session/fork`、`session/projections`（可作 P0-1 的兜底）、`session/openWorkspacePath`
- `fileReferences/list`（可替换插件本地 @提及 索引）
- 单条坏 chunkrow 让整页失败、发送失败丢正文、大会话首帧无加载态（见 repo 报告 P1-4/5/7）
- `authorityOf()` 在 HTTPS 下用 `url.host` 而服务端用 `url.origin`（仅影响 HTTPS 远端部署）

---

## 3. 三个 open issue：其实都已经修好了

| Issue | 判定 | 落地版本 | 建议动作 |
|---|---|---|---|
| #1 `open` 撞视图生命周期 | 真的修了（源码 + 发布产物 + 回归测试四层证据） | **0.1.2** `e47c0a5` | close as fixed，**回复须给升级路径**（报告者停在 DSH 0.1.0-rc.6，直接升最新插件会 401/404） |
| #2 外置 i18n | 已按提议实现 | **0.1.4** | close as implemented，但回复要写残留点（P1-3 的中文错误串） |
| #3 流式性能 | 已修，**但跨了两个版本**：0.1.4 做增量渲染，真正降成本在 0.1.7 | **0.1.7+** | close，**回复须要求 ≥0.1.9**；只升到 0.1.4 只拿到一半 |

可直接粘贴的英文回复草稿见 [issue-triage-2026-10-17.md](issue-triage-2026-10-17.md)。
注意：**0.1.3 与 0.1.6 没有 tag/release**（0.1.6 撤回并入 0.1.7），回复里不要写这两个版本号。

---

## 4. 为什么这些缺陷能潜伏这么久（结构性教训）

三个 P0 有同一个特征：**失败无声，而测试恰好绕开了它**。

- P0-2：fixture 手写补齐了服务端早已不发的 `queues` 字段，测试因此永远绿；
  异常被空 `catch` 吞掉，无日志、无 `load-error.log`。
- P0-3：18 个用例都没覆盖「`start()` 与 `open()` 并发」这个不变量；CI 在 Linux 上时序不同，从不变红。
- P0-1：错误路径的文案本身就在说错话，把「端口变了」解释成「DSH 没运行」。

**三条建议**，比修具体 bug 更值钱：

1. **用真机原始帧做契约 fixture**，不要手写补齐字段 —— 这次 P0-2 就是手写 fixture 掩盖的。
2. **别用空 `catch` 吞异常**，至少 `console.warn`；静默失败的成本是「用户以为功能不存在」。
3. **把「平台相关时序」纳入 CI**（至少 macOS runner），否则这类 bug 只会被用户发现。

---

## 5. 生态现状（顺带更新）

同期市场扫描（`community-plugin-stats.json`）显示 DSH 一族已有 **10+ 个同类插件**：

| 插件 | 下载量 |
|---|---|
| `dsh-harness` | 8,092 |
| `deepharness` | 2,453 |
| `dsh-ob` | 1,699 |
| **`dsh-bridge`（本插件）** | **594** |
| `dsh-dock` / `dsh-math-assistant` / `dsh-embedded` / `dsh` | 302 / 228 / 199 / 163 |

两个判断：

- **「未人工审核」不是差距**：DSH 全族（含 8,092 下载的头部）目前都是 unreviewed，不是我们的问题。
- **真正的差距是「要不要用户自己先装好 DSH」**：头部插件卖点都是一键安装 / 自动启动 / 静默后台。
  P0-1 的端口发现只是把「能用」补回来；要和头部竞争，下一步得考虑**自动拉起 DSH**。
- 竞品卖点直接印证了 P0-1 的紧迫性：`dsh-harness` 描述里写「one-click installation, automatic startup,
  silent background operation」，而我们的 README 第一条前置条件仍是「你自己先跑着 DSH」。
