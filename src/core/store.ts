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

  /** 注册变更监听，返回解除函数（视图关闭时必须调用，避免泄漏）。 */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[dsh-bridge] store 监听器异常:", err);
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

  /** 应用一个投影单元（higher-seq-wins）；返回 true 表示视图可见状态发生了变化（调用方才需要 notify）。 */
  applyProjection(sessionId: string, key: string, value: unknown, seq: number): boolean {
    const cells = this.projections.get(sessionId) ?? new Map<string, ProjectionCell>();
    const prev = cells.get(key);
    if (prev && prev.seq > seq) return false; // higher-seq-wins
    cells.set(key, { value, seq });
    this.projections.set(sessionId, cells);
    const view = this.ensureView(sessionId);
    if (key === "title") {
      if (typeof value === "string" && value.length > 0) {
        view.title = value;
        return true;
      }
      return false;
    }
    if (key === "plan") {
      if (typeof value !== "object" || value === null) return false;
      const plan = value as { active?: boolean; pending?: boolean };
      view.plan = { active: plan.active === true, pending: plan.pending === true };
      return true;
    }
    return false;
  }

  /** 处理一帧 mux 推送；事件/队列/基线仅作用于已存在的视图（避免为所有已挂载会话物化视图），投影则允许播种（含未打开会话的标题/计划）。 */
  applyMux(_rpcId: string, frame: MuxFrame): void {
    switch (frame.type) {
      case "session/event": {
        const view = this.views.get(frame.sessionId);
        if (!view) return;
        foldEvent(view, frame.event);
        this.notify();
        break;
      }
      case "session/subscribed": {
        const view = this.views.get(frame.sessionId);
        if (!view) return;
        let changed = false;
        if (frame.lastSeq > view.lastSeq) {
          view.lastSeq = frame.lastSeq;
          changed = true;
        }
        if (view.running) {
          view.running = false; // 流重开基线：丢弃陈旧的在飞回合状态，避免永久 ⏳
          changed = true;
        }
        if (changed) this.notify();
        break;
      }
      case "session/projection": {
        if (this.applyProjection(frame.sessionId, frame.key, frame.value, frame.seq)) {
          this.notify();
        }
        break;
      }
      case "session/queue": {
        const view = this.views.get(frame.sessionId);
        if (!view) return;
        view.queueItems = frame.items;
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

  /**
   * 前插一页更早的历史：在 store 内重建视图（折叠旧页 + 拼接现有节点），
   * 保证 lastSeq/running/title/plan/queueItems 状态一致，并 notify 一次。
   * 计划状态启发式：现有页若未观察到任何计划状态则沿用旧页的。
   */
  prependHistory(sessionId: string, entries: HistoryEntry[]): void {
    const current = this.views.get(sessionId);
    const rebuilt = createSessionView(sessionId);
    for (const entry of entries) foldEvent(rebuilt, entry.event);
    if (current) {
      rebuilt.nodes = [...rebuilt.nodes, ...current.nodes];
      if (current.lastSeq > rebuilt.lastSeq) rebuilt.lastSeq = current.lastSeq;
      if (current.running) rebuilt.running = true;
      if (current.lastTurnStartSeq > rebuilt.lastTurnStartSeq) rebuilt.lastTurnStartSeq = current.lastTurnStartSeq;
      if (current.lastTurnEndSeq > rebuilt.lastTurnEndSeq) rebuilt.lastTurnEndSeq = current.lastTurnEndSeq;
      rebuilt.title = current.title ?? rebuilt.title;
      rebuilt.plan = current.plan.active || current.plan.pending ? current.plan : rebuilt.plan;
      rebuilt.queueItems = current.queueItems;
    }
    this.views.set(sessionId, rebuilt);
    this.notify();
  }

  /** 在 store 内设置标题并 notify（供历史尾页投影播种使用）。 */
  setTitle(sessionId: string, title: string): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    view.title = title;
    this.notify();
  }

  /** 清空单个会话视图与其投影单元（重连重建用）。 */
  dropView(sessionId: string): void {
    this.views.delete(sessionId);
    this.projections.delete(sessionId);
    this.notify();
  }
}
