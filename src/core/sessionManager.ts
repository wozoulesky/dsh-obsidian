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
    await this.refresh().catch(() => undefined); // 创建已成功，列表刷新失败不阻塞
    return res.value.sessionId;
  }

  /** 会话是否存在（用 1 条历史探测）。 */
  async exists(sessionId: string): Promise<boolean> {
    const res = await this.client.history({ sessionId, maxMessages: 1 });
    if (res.ok) return true;
    return res.error.code !== "session-not-found";
  }

  private openEpoch = 0;

  /** 切换当前会话：拉取尾页历史播种视图。 */
  async openSession(sessionId: string): Promise<void> {
    const epoch = ++this.openEpoch;
    const res = await this.client.history({ sessionId, maxMessages: this.deps.settings.values.historyPageSize });
    if (!res.ok) throw new Error(res.error.message);
    if (epoch !== this.openEpoch) return; // 竞态守卫：期间已切换到其他会话
    this.deps.store.dropView(sessionId); // 重建干净视图再播种
    this.deps.store.seedHistory(sessionId, res.value.events);
    if (res.value.projections) {
      for (const [key, value] of Object.entries(res.value.projections.values)) {
        this.deps.store.applyProjection(sessionId, key, value, res.value.projections.asOfSeq);
      }
    }
    this.currentId = sessionId;
  }

  /** 加载更早一页；返回是否还有更早内容。 */
  async loadOlder(sessionId: string): Promise<boolean> {
    const view = this.deps.store.ensureView(sessionId);
    // 以已折叠事件的最小 seq 为界，避免与当前页重叠（重叠会把旧 turn 标记重新折叠进视图）
    const beforeSeq = view.firstSeq >= 0 ? view.firstSeq : 0;
    const res = await this.client.history({ sessionId, beforeSeq, maxMessages: this.deps.settings.values.historyPageSize });
    if (!res.ok) throw new Error(res.error.message);
    this.deps.store.prependHistory(sessionId, res.value.events);
    return res.value.hasMore;
  }

  async prompt(sessionId: string, text: string, mode: "queue" | "steer" = "queue"): Promise<RpcResult<PromptResult>> {
    return this.client.prompt({ sessionId, mode, content: [{ type: "text", text }] });
  }

  async cancel(sessionId: string): Promise<RpcResult<{ accepted: true }>> {
    return this.client.cancel({ sessionId });
  }
}
