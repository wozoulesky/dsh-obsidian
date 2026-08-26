import { Editor, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { installNodeShims } from "./transport/nodeShims";
import { DshSettings } from "./settings";
import { DshClient } from "./transport/client";
import { MuxStream, type MuxState } from "./transport/muxStream";
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
  mux: MuxStream;
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
      const client = new DshClient({ baseUrl: this.settings.dshUrl });
      const store = new SessionStore();
      const approvals = new ApprovalCenter(client);
      const manager = new SessionManager({ client, store, vaultPath: this.vaultPath(), settings: this.settings, t: (key, params) => i18n.t(key, params) });
      const runtime: DshRuntime = {
        plugin: this,
        settings: this.settings,
        i18n,
        client,
        store,
        manager,
        approvals,
        mux: undefined as unknown as MuxStream,
        inlineEdit: undefined as unknown as InlineEditService,
        muxState: null,
      };
      const mux = new MuxStream(this.settings.dshUrl, {
        onFrame: (rpcId, frame) => {
          store.applyMux(rpcId, frame);
          approvals.ingest(rpcId, frame);
        },
        onState: (state) => {
          runtime.muxState = state;
          this.statusBarEl.setText(state === "connected" ? i18n.t("main.statusConnected") : i18n.t("main.statusReconnecting"));
          if (state === "connected") {
            void (async () => {
              const targets = new Set<string>();
              if (manager.currentId) targets.add(manager.currentId);
              const inlineId = this.settings.values.inlineEditSessionId;
              if (inlineId && store.getView(inlineId)) targets.add(inlineId);
              for (const id of targets) {
                manager.resyncSession(id).catch((err) => console.error("[dsh-bridge] 重连同步失败:", err));
              }
            })();
          }
        },
      });
      runtime.mux = mux;
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

      mux.start();
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
