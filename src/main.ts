import { Editor, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { installNodeShims } from "./transport/nodeShims";
import { DshSettings } from "./settings";
import { DshClient } from "./transport/client";
import { DshCookieAuth } from "./transport/auth";
import type { MuxState, RemoteMuxTransport } from "./transport/muxStream";
import type { RemoteEventDownlinkFrame, SessionControlFrame } from "./transport/types";
import { SessionStore } from "./core/store";
import { SessionManager } from "./core/sessionManager";
import { ApprovalCenter } from "./core/approvalCenter";
import { InlineEditService } from "./core/inlineEdit";
import { DshChatView, VIEW_TYPE_DSH_CHAT } from "./ui/chatView";
import { InlineEditModal } from "./ui/inlineEditModal";
import { DshSettingTab } from "./ui/settingsTab";
import { I18n, loadI18n } from "./i18n";

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

  async onload(): Promise<void> {
    try {
      installNodeShims();
      await this.settings.load();
      this.statusBarEl = this.addStatusBarItem();

      const i18n = await loadI18n(
        // 优先级：vault 根 dsh-bridge.i18n.json（用户可见可编辑，TASK-015）→ 插件目录 i18n.json（兼容旧路径）
        ["dsh-bridge.i18n.json", `${this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`}/i18n.json`],
        (path) => this.app.vault.adapter.read(path)
      );

      const store = new SessionStore();
      const baseUrl = this.settings.dshUrl;
      let runtime: DshRuntime;

      /* ---- 两条全局长流（$events / session/control）的当前代句柄：重连重开时 abort 旧代，避免残留迭代与新代串流 ---- */
      let eventsStreamGen: AbortController | null = null;
      let controlStreamGen: AbortController | null = null;

      /** 重开 $events 流：abort 旧代 → openStream → 每帧 approvals.ingest；断线/异常静默结束，下次 onState("connected") 重开。 */
      const startEventsStream = (): void => {
        const controller = new AbortController();
        eventsStreamGen?.abort();
        eventsStreamGen = controller;
        void (async () => {
          try {
            const stream = await runtime.client.openStream<RemoteEventDownlinkFrame>("$events", {}, controller.signal);
            for await (const frame of stream) {
              if (controller.signal.aborted) return;
              runtime.approvals.ingest(frame);
            }
          } catch {
            /* 断线（RemoteStreamCarrierError）/ abort / 流错误：静默结束；重连由 onState("connected") 触发重开 */
          }
        })();
      };

      /** 重开 session/control 流：abort 旧代 → openStream → 每帧 store.applyControlFrame。服务端语义：每代首帧重发 baseline，无需本地重建。 */
      const startControlStream = (): void => {
        const controller = new AbortController();
        controlStreamGen?.abort();
        controlStreamGen = controller;
        void (async () => {
          try {
            const stream = await runtime.client.openStream<SessionControlFrame>("session/control", {}, controller.signal);
            for await (const frame of stream) {
              if (controller.signal.aborted) return;
              runtime.store.applyControlFrame(frame);
            }
          } catch {
            /* 断线/异常：静默结束；重连由 onState("connected") 触发重开（服务端会重发 baseline） */
          }
        })();
      };

      const client = new DshClient({
        baseUrl,
        auth: new DshCookieAuth({ baseUrl }),
        transportOptions: {
          onState: (state) => {
            runtime.muxState = state;
            this.statusBarEl.setText(state === "connected" ? i18n.t("main.statusConnected") : i18n.t("main.statusReconnecting"));
            if (state === "connected") {
              // 物理连接就绪：重开两条全局流（首次连接与每次重连统一走这里；
              // $events 重开会拿新 clientId，approvals 由 ready 帧重新绑定）
              startEventsStream();
              startControlStream();
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
      const manager = new SessionManager({ client, store, vaultPath: this.vaultPath(), settings: this.settings, t: (key, params) => i18n.t(key, params) });
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
    this.runtime?.mux?.stop();
  }
}
