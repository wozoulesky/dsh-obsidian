import { Editor, getLanguage, Notice, Plugin, requireApiVersion, WorkspaceLeaf } from "obsidian";
import { installNodeShims } from "./transport/nodeShims";
import { DshSettings } from "./settings";
import { DshClient } from "./transport/client";
import { DshCookieAuth, readDshHomeEnv } from "./transport/auth";
import type { MuxState, RemoteMuxTransport } from "./transport/muxStream";
import { SessionStore } from "./core/store";
import { SessionManager } from "./core/sessionManager";
import { ApprovalCenter } from "./core/approvalCenter";
import { GlobalStreams } from "./core/globalStreams";
import { InlineEditService } from "./core/inlineEdit";
import { DshChatView, VIEW_TYPE_DSH_CHAT } from "./ui/chatView";
import { InlineEditModal } from "./ui/inlineEditModal";
import { DshSettingTab } from "./ui/settingsTab";
import { I18n, loadI18n, resolveObsidianLanguage } from "./i18n";
import { candidateDshUrls, discoverDshUrls, firstReachableDshUrl } from "./core/diagnose";

/** 两个 DSH 地址是否指向同一入口（按 URL.href 归一化，容忍结尾斜杠差异；非法地址退化为字符串比较）。 */
function sameUrl(a: string, b: string): boolean {
  const norm = (u: string): string => {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
}

/**
 * 地址是否指向本机。与 `candidateDshUrls` 的 loopback 判定保持一致：
 * `localhost` 也算（macOS 上可能先解析到 ::1，但插件探测的都是 127.0.0.1）。
 */
function isLoopbackUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * 探测超时：回环上健康 DSH 的 `session/list` 是毫秒级，3s 只用兜住「端口被占用但不应答」的僵死情况。
 * 探测在 onload 上，超时必须短——最坏耗时 = 配置地址 1 次 + 候选并发 1 次。
 */
const PROBE_TIMEOUT_MS = 3000;

export interface DshRuntime {
  plugin: DshPlugin;
  settings: DshSettings;
  i18n: I18n;
  client: DshClient;
  /** remote.mux 物理层（client.mux）：main.ts 接状态栏与生命周期，会话 follow 由 SessionManager 按需开。 */
  mux: RemoteMuxTransport;
  store: SessionStore;
  manager: SessionManager;
  approvals: ApprovalCenter;
  inlineEdit: InlineEditService;
  muxState: MuxState | null;
}

export default class DshPlugin extends Plugin {
  settings = new DshSettings(this);
  runtime!: DshRuntime;
  statusBarEl!: HTMLElement;
  /** 两条全局长流的生命周期（onload 创建，onunload stop）。 */
  private globalStreams: GlobalStreams | null = null;

  async onload(): Promise<void> {
    try {
      installNodeShims();
      await this.settings.load();
      this.statusBarEl = this.addStatusBarItem();

      // UI 语言跟随 Obsidian：中文环境用中文，其它语言用内置英文；读取失败回落中文。
      // `getLanguage()` 自 Obsidian 1.8.7 起提供，而本插件 minAppVersion 是 1.7.2，
      // 因此用 requireApiVersion 守卫：老宿主上不调用该 API，交给 resolveObsidianLanguage 回落中文，
      // 绝不在 1.7.x 上因缺函数而抛错拖垮 onload。
      const lang = resolveObsidianLanguage(() =>
        requireApiVersion("1.8.7") ? getLanguage() : undefined
      );
      const i18n = await loadI18n(
        // 优先级：vault 根 dsh-bridge.i18n.json（用户可见可编辑，TASK-015）→ 插件目录 i18n.json（兼容旧路径）
        ["dsh-bridge.i18n.json", `${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/i18n.json`],
        (path) => this.app.vault.adapter.read(path),
        lang
      );

      const store = new SessionStore();
      // 端口自动探测。优先尊重配置地址（用户可能是刻意手填的），连不上才换候选：
      // 1. 静态候选（19387 桌面旧版 / 3080 `dsh web`）—— 零成本，覆盖绝大多数老安装；
      // 2. 动态发现（`discoverDshUrls`）—— DSH 0.2.1+ 桌面端用 `--port 0` 系统随机端口，
      //    靠反解 Chromium Cookie 库拿到真实端口（≈0.2–0.5 s）。
      // 注意：桌面端**每次启动都换端口**，所以「配置地址失效 → 走发现」现在是常态而非异常，
      // 这段必须是快路径。故把「探测配置地址」与「发现并探测候选」**并发**跑：
      // 配置地址仍优先（命中就不用发现结果），最坏耗时从 3s+3s 降到 3s。
      // 方案评估与实测：docs/audit-2026-10-17-port.md
      const configuredUrl = this.settings.dshUrl;
      const configuredOk = this.probeDshUrl(configuredUrl);
      const discoveredUrl = this.autoSwitchDshUrl(configuredUrl, i18n, configuredOk);
      const baseUrl = (await configuredOk) ? configuredUrl : await discoveredUrl;
      let runtime: DshRuntime;

      const client = new DshClient({
        baseUrl,
        auth: new DshCookieAuth(this.authOptions(baseUrl)),
        transportOptions: {
          onState: (state) => {
            runtime.muxState = state;
            // 断线原因要能落到状态栏：ECONNREFUSED = DSH 没在跑（最高频的「为什么连不上」），
            // 此时直接说「未运行」，而不是让用户对着「重连中…」猜。
            this.statusBarEl.setText(
              state === "connected"
                ? i18n.t("main.statusConnected")
                : client.mux.serviceDown
                  ? i18n.t("main.statusNotRunning")
                  : i18n.t("main.statusReconnecting")
            );
            if (state === "connected") {
              // 物理连接就绪：重开两条全局流（首次连接与每次重连统一走这里；
              // $events 重开会拿新 clientId，approvals 由 ready 帧重新绑定）
              this.globalStreams?.startAll();
              // 重连后 resync current 会话与内联编辑会话（沿用旧逻辑：view 存在的才重建）
              void (async () => {
                const targets = new Set<string>();
                if (runtime.manager.currentId) targets.add(runtime.manager.currentId);
                const inlineId = this.settings.values.inlineEditSessionId;
                if (inlineId && runtime.store.getView(inlineId)) targets.add(inlineId);
                for (const id of targets) {
                  runtime.manager.resyncSession(id).catch((err) => console.error("[dsh-bridge] 重连同步失败:", err));
                }
              })();
            }
          },
        },
      });
      const approvals = new ApprovalCenter(client);
      const manager = new SessionManager({
        client,
        store,
        vaultPath: this.vaultPath(),
        settings: this.settings,
        t: (key, params) => i18n.t(key, params),
        // 服务端重启会丢掉进行中的回合（从未落库），重连对账时半截气泡被摘除——告知一次，避免文字静默消失
        onInterruptedTurnDropped: () => new Notice(i18n.t("chat.interruptedTurnDropped")),
      });
      this.globalStreams = new GlobalStreams(client, store, approvals, {
        // 全局流消费循环里的**非预期**异常（帧契约变化/解析 bug）必须留下痕迹：
        // 只 console 的话用户看不到，落一份日志到插件目录便于让用户回传。
        onUnexpectedError: (err) => {
          console.error("[dsh-bridge] 全局流消费异常:", err);
          void this.writePluginLog("stream-error.log", err);
        },
      });
      runtime = {
        plugin: this,
        settings: this.settings,
        i18n,
        client,
        mux: client.mux,
        store,
        manager,
        approvals,
        inlineEdit: undefined as unknown as InlineEditService,
        muxState: null,
      };
      runtime.inlineEdit = new InlineEditService({ manager, store, settings: this.settings, t: (key, params) => i18n.t(key, params) });
      this.runtime = runtime;

      this.registerView(VIEW_TYPE_DSH_CHAT, (leaf: WorkspaceLeaf) => new DshChatView(leaf, runtime));
      this.addRibbonIcon("bot", i18n.t("main.openPanel"), () => void this.activateView());
      this.addCommand({ id: "open-panel", name: i18n.t("main.openPanel"), callback: () => void this.activateView() });
      this.addCommand({
        id: "new-session",
        name: i18n.t("main.newSession"),
        callback: async () => {
          try {
            await manager.newSession();
            await this.activateView();
            const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT)[0]?.view;
            if (view instanceof DshChatView) view.refreshHeader();
          } catch (err) {
            new Notice(i18n.t("main.newSessionFailed", { message: err instanceof Error ? err.message : String(err) }));
          }
        },
      });
      this.addCommand({
        id: "inline-edit",
        name: i18n.t("main.inlineEdit"),
        editorCallback: (editor: Editor) => new InlineEditModal(this.app, this.runtime, editor).open(),
      });
      this.addSettingTab(new DshSettingTab(this.app, this));

      client.mux.start();
      manager.refresh().catch((err) => console.error("[dsh-bridge] 会话列表拉取失败:", err));
    } catch (err) {
      try {
        const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
        await this.app.vault.adapter.write(`${dir}/load-error.log`, err instanceof Error ? (err.stack ?? err.message) : String(err));
      } catch {
        // 忽略日志写入失败
      }
      throw err;
    }
  }

  /**
   * 把异常追加到插件目录下的日志文件（尽力而为，绝不因写日志失败而影响功能）。
   * 用户回传这份文件就能定位「静默失效」类问题，无需开控制台。
   */
  private async writePluginLog(fileName: string, err: unknown): Promise<void> {
    try {
      const dir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
      const path = `${dir}/${fileName}`;
      const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
      let previous = "";
      try {
        previous = await this.app.vault.adapter.read(path);
      } catch {
        // 首次写入：文件还不存在
      }
      const stamped = `[${new Date().toISOString()}] ${text}\n`;
      // 只保留最近 32KB，避免无限增长
      const merged = (previous + stamped).slice(-32 * 1024);
      await this.app.vault.adapter.write(path, merged);
    } catch {
      // 日志是辅助手段：写不进去就算了，不能反过来影响功能
    }
  }

  /** 凭据选项：探测用的一次性客户端与正式客户端共用，避免两处漂移（dshCredentialsPath 优先，$DSH_HOME → ~/.dsh）。 */
  private authOptions(baseUrl: string): ConstructorParameters<typeof DshCookieAuth>[0] {
    return {
      baseUrl,
      credentialsPath: this.settings.values.dshCredentialsPath || undefined,
      dshHome: readDshHomeEnv(),
    };
  }

  /**
   * 用一次真实 `session.list` 探测某地址是不是可用的 DSH——同时穿过认证与 RPC 两层，
   * 通过即代表核心链路可用（判据与 `probeDshConnection` 一致，只是这里自带客户端）。
   *
   * 一次性客户端是安全的：`RemoteMuxTransport` 的构造函数无副作用（不 `start()` 就不建 socket / 定时器 / 焦点监听）。
   * 任何异常一律返回 false——探测是尽力而为，不能把插件加载或设置面板拖挂。
   */
  async probeDshUrl(url: string): Promise<boolean> {
    try {
      const client = new DshClient({ baseUrl: url, auth: new DshCookieAuth(this.authOptions(url)), timeoutMs: PROBE_TIMEOUT_MS });
      const result = await client.list();
      return result.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * 探测可用入口：动态发现（0.2.1 随机端口）+ 静态候选（桌面 19387 / CLI 3080），
   * 合并去重后按优先级并发探测；配置地址本身不重复进候选。都不通返回 null。
   *
   * @param allowScan 允许 TCP 扫描兜底（≈1.3–1.9 s）。只在用户主动点「诊断」时为 true——
   *                  onload 路径必须快，不能把插件加载拖慢一秒多。
   */
  /**
   * 探测可用入口：动态发现（0.2.1 随机端口）+ 静态候选（桌面 19387 / CLI 3080），
   * 合并去重后按优先级并发探测；配置地址本身不重复进候选。都不通返回 null。
   *
   * @param allowScan 允许 TCP 扫描兜底（≈1.3–1.9 s）。只在用户主动点「诊断」时为 true——
   *                  onload 路径必须快，不能把插件加载拖慢一秒多。
   * @param configuredOk 配置地址是否已被判定可用。若可用则**完全跳过**发现：
   *                  尊重用户手填的地址，也避免并发场景下多写一次盘、多弹一个 Notice。
   */
  async findWorkingDshUrl(configuredUrl: string, allowScan = false, configuredOk?: Promise<boolean>): Promise<string | null> {
    if (configuredOk && (await configuredOk)) return null; // 配置地址可用：无需换
    // 与 candidateDshUrls 同一条纪律：本地端口发现只对 loopback 成立。
    // 用户若刻意配了远端 DSH，绝不能用本机随机端口把它顶掉。
    const discovered = isLoopbackUrl(configuredUrl)
      ? await discoverDshUrls({ scan: allowScan }).catch(() => [] as string[])
      : [];
    // candidateDshUrls 已剔除配置地址；这里只需把「动态发现里等于配置地址」的项去掉。
    const candidates = [
      ...new Set([...discovered.filter((url) => !sameUrl(url, configuredUrl)), ...candidateDshUrls(configuredUrl)]),
    ];
    return firstReachableDshUrl(candidates, (url) => this.probeDshUrl(url));
  }

  /** 探测到替代入口则落盘并提示；没探测到就原样返回配置地址（保持旧行为：让 mux 继续重试并给出「未运行」状态）。 */
  private async autoSwitchDshUrl(configuredUrl: string, i18n: I18n, configuredOk?: Promise<boolean>): Promise<string> {
    const found = await this.findWorkingDshUrl(configuredUrl, false, configuredOk);
    if (found === null) return configuredUrl;
    this.settings.values.dshUrl = found;
    await this.settings.save().catch(() => {
      // 落盘失败不影响本次会话：内存值已改，连接照常建立
    });
    new Notice(i18n.t("settings.dshUrlAutoSwitched", { url: found, previous: configuredUrl }));
    return found;
  }

  vaultPath(): string {
    return (this.app.vault.adapter as unknown as { getBasePath(): string }).getBasePath();
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT)[0];
    if (!leaf) {
      const right = workspace.getRightLeaf(false);
      if (!right) {
        new Notice(this.runtime.i18n.t("main.openPanelFailed"));
        return;
      }
      await right.setViewState({ type: VIEW_TYPE_DSH_CHAT, active: true });
      leaf = right;
    }
    await workspace.revealLeaf(leaf);
  }

  onunload(): void {
    this.globalStreams?.stop();
    this.runtime?.mux?.stop();
    // 设置面板的逐键写入是防抖的（见 DshSettings.saveDebounced）：卸载时若仍有挂起写入，
    // 必须立刻发起落盘，否则用户最后改的那次设置会随插件一起丢掉。
    // 注意：saveData 是异步的，Obsidian 不会等它完成——这里只能把写请求尽早发出（<300ms 的窗口）。
    void this.settings.flush().catch((err) => console.error("[dsh-bridge] 卸载时设置落盘失败:", err));
  }
}
