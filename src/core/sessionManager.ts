import { DshClient } from "../transport/client";
import { RemoteStreamError } from "../transport/muxStream";
import { SessionStore } from "./store";
import { DshSettings } from "../settings";
import { expandHistoryRecords } from "../transport/chunkRows";
import type { HistoryEntry, PromptResult, RpcResult, SessionFollowFrame, SessionSummary } from "../transport/types";

export interface SessionManagerDeps {
  client: DshClient;
  store: SessionStore;
  vaultPath: string;
  settings: DshSettings;
  /** 本地化函数；用于会话标题回退等 UI 文案。 */
  t: (key: string, params?: Record<string, string | number>) => string;
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
    // 统一成 "/" 归一：Windows 用 "\\"，macOS/Linux 用 "/"，不能硬编码一种分隔符
    const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const cwd = norm(s.cwd);
    const vault = norm(this.deps.vaultPath);
    return cwd === vault || cwd.startsWith(vault + "/");
  }

  private displayTitle(s: SessionSummary): string {
    const title = s.projections?.values?.title;
    if (typeof title === "string" && title.length > 0) return title;
    return this.deps.t("chat.sessionFallback", { id: s.sessionId.slice(0, 8) });
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
    if (summary) return this.displayTitle(summary);
    return this.deps.t("chat.sessionFallback", { id: sessionId.slice(0, 8) });
  }

  /** 创建 cwd=vault 的新会话。 */
  async newSession(): Promise<string> {
    const res = await this.client.create({ cwd: this.deps.vaultPath });
    if (!res.ok) throw new Error(res.error.message);
    await this.refresh().catch(() => undefined); // 创建已成功，列表刷新失败不阻塞
    return res.value.sessionId;
  }

  /** 会话是否存在：follow 探测（maxMessages:1）——snapshot → true；session/not-found → false。 */
  async exists(sessionId: string): Promise<boolean> {
    const controller = new AbortController();
    try {
      const stream = await this.client.openStream<SessionFollowFrame>(
        "session/follow",
        { request: { address: { kind: "session", sessionId }, maxMessages: 1 } },
        controller.signal
      );
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      await iterator.return?.(undefined);
      controller.abort(); // 探测完即断，避免残留订阅
      return !first.done && first.value.type === "snapshot";
    } catch (err) {
      // 新契约错误码带斜杠：session/not-found（旧码 session-not-found 已失效）
      if (err instanceof RemoteStreamError && err.code === "session/not-found") return false;
      return false; // 其它错误（transport/断线）按"不可用"处理，触发重建
    } finally {
      controller.abort();
    }
  }

  private openEpoch = 0;
  /** 每个会话的活跃 follow 句柄（AbortController）；切换/重开/resync 时 abort 旧代。 */
  private followControllers = new Map<string, AbortController>();

  /** 中止指定会话的活跃 follow。 */
  private abortFollow(sessionId: string): void {
    const old = this.followControllers.get(sessionId);
    if (old) {
      old.abort();
      this.followControllers.delete(sessionId);
    }
  }

  /** 切换当前会话：中止全部旧 follow（防泄漏，与旧「仅当前会话实时」语义一致）。 */
  private abortAllFollows(): void {
    for (const controller of this.followControllers.values()) controller.abort();
    this.followControllers.clear();
  }

  /** 切换当前会话：follow 首帧 snapshot 播种视图，后台消费 event 帧。 */
  async openSession(sessionId: string): Promise<void> {
    const epoch = ++this.openEpoch;
    this.abortAllFollows();
    const controller = new AbortController();
    this.followControllers.set(sessionId, controller);
    try {
      const stream = await this.client.openStream<SessionFollowFrame>(
        "session/follow",
        { request: { address: { kind: "session", sessionId }, maxMessages: this.deps.settings.values.historyPageSize } },
        controller.signal
      );
      if (epoch !== this.openEpoch) {
        controller.abort();
        return; // 竞态守卫：期间已切换到其他会话
      }
      this.deps.store.dropView(sessionId); // 重建干净视图再播种
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (epoch !== this.openEpoch || controller.signal.aborted) {
        controller.abort();
        return;
      }
      if (first.done) throw new Error("DSH follow 流在首帧前结束");
      const frame = first.value;
      if (frame.type !== "snapshot") {
        // 协议违约：首帧必须是 snapshot（服务端保证），否则后续折叠无基线
        controller.abort();
        throw new Error("DSH follow 流首帧不是 snapshot");
      }
      this.deps.store.applyFollowSnapshot(sessionId, frame);
      this.currentId = sessionId;
      this.consumeFollow(sessionId, controller, iterator);
    } catch (err) {
      controller.abort();
      this.followControllers.delete(sessionId);
      if (epoch === this.openEpoch) throw err; // 本代仍是最新：错误抛给调用方（chatView Notice）
    }
  }

  /** 后台消费 follow 的 event 帧；异常静默清理句柄（重连由 main.ts 触发 resync）。 */
  private consumeFollow(
    sessionId: string,
    controller: AbortController,
    iterator: AsyncIterator<SessionFollowFrame>
  ): void {
    void (async () => {
      try {
        while (true) {
          const next = await iterator.next();
          if (controller.signal.aborted) return;
          if (next.done) return;
          const frame = next.value;
          if (frame.type === "event") {
            this.deps.store.applyFollowEvent(sessionId, frame);
          }
          // snapshot 不应在首帧之后再次出现：忽略
        }
      } catch {
        /* RemoteStreamError / RemoteStreamCarrierError / abort：静默结束 */
      } finally {
        await iterator.return?.().catch(() => undefined); // 触发物理层 cancel 帧
        if (this.followControllers.get(sessionId) === controller) {
          this.followControllers.delete(sessionId);
        }
        controller.abort();
      }
    })();
  }

  /** 重连后重新拉取尾页并重建视图（用于 current 会话与内联编辑会话）；不改变 currentId。 */
  async resyncSession(sessionId: string): Promise<void> {
    this.openEpoch += 1; // 使进行中的 openSession 失效，避免交错覆盖
    this.abortFollow(sessionId);
    const controller = new AbortController();
    this.followControllers.set(sessionId, controller);
    try {
      const stream = await this.client.openStream<SessionFollowFrame>(
        "session/follow",
        { request: { address: { kind: "session", sessionId }, maxMessages: this.deps.settings.values.historyPageSize } },
        controller.signal
      );
      if (controller.signal.aborted) return;
      const iterator = stream[Symbol.asyncIterator]();
      const first = await iterator.next();
      if (first.done || first.value.type !== "snapshot") {
        controller.abort();
        return; // 服务端暂不可用/协议异常时静默放弃，下一次重连会重试
      }
      this.deps.store.dropView(sessionId);
      this.deps.store.applyFollowSnapshot(sessionId, first.value);
      this.consumeFollow(sessionId, controller, iterator);
    } catch {
      controller.abort();
      this.followControllers.delete(sessionId);
      // 服务端暂不可用时静默放弃，下一次重连会重试
    }
  }

  /** 加载更早一页；返回是否还有更早内容。 */
  async loadOlder(sessionId: string): Promise<boolean> {
    const view = this.deps.store.ensureView(sessionId);
    // 新契约 page：throughSeq 必填（窗口尾 cursor，恒 ≤ 服务端 log 尾）；beforeSeq 为窗口最小 seq，
    // host 取严格早于 beforeSeq 的更早页。throughSeq:-1 恒空页，勿用。
    const throughSeq = view.lastSeq;
    const beforeSeq = view.firstSeq >= 0 ? view.firstSeq : 0;
    const res = await this.client.page({
      address: { kind: "session", sessionId },
      throughSeq,
      beforeSeq,
      maxMessages: this.deps.settings.values.historyPageSize,
    });
    if (!res.ok) throw new Error(res.error.message);
    const events = expandHistoryRecords(res.value.records);
    const entries: HistoryEntry[] = events.map((event) => ({ event }));
    this.deps.store.prependHistory(sessionId, entries);
    return res.value.hasMore;
  }

  async prompt(sessionId: string, text: string, mode: "queue" | "steer" = "queue"): Promise<RpcResult<PromptResult>> {
    return this.client.prompt({ sessionId, mode, content: [{ type: "text", text }] });
  }

  async cancel(sessionId: string): Promise<RpcResult<{ accepted: true }>> {
    return this.client.cancel({ sessionId });
  }
}
