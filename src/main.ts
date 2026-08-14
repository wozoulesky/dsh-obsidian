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
