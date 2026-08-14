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

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch (err) {
        console.error("[dsh-obsidian] store 监听器异常:", err);
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

  private applyProjection(sessionId: string, key: string, value: unknown, seq: number): void {
    const cells = this.projections.get(sessionId) ?? new Map<string, ProjectionCell>();
    const prev = cells.get(key);
    if (prev && prev.seq > seq) return; // higher-seq-wins
    cells.set(key, { value, seq });
    this.projections.set(sessionId, cells);
    const view = this.ensureView(sessionId);
    if (key === "title") {
      if (typeof value === "string" && value.length > 0) view.title = value;
    } else if (key === "plan") {
      const plan = value as { active?: boolean; pending?: boolean };
      view.plan = { active: plan.active === true, pending: plan.pending === true };
    }
  }

  /** 处理一帧 mux 推送（rpcId 为帧信封 id，仅审批/提问需要，这里透传保留）。 */
  applyMux(_rpcId: string, frame: MuxFrame): void {
    switch (frame.type) {
      case "session/event":
        foldEvent(this.ensureView(frame.sessionId), frame.event);
        this.notify();
        break;
      case "session/subscribed": {
        const view = this.ensureView(frame.sessionId);
        if (frame.lastSeq > view.lastSeq) view.lastSeq = frame.lastSeq;
        this.notify();
        break;
      }
      case "session/projection":
        this.applyProjection(frame.sessionId, frame.key, frame.value, frame.seq);
        this.notify();
        break;
      case "session/queue": {
        this.ensureView(frame.sessionId).queueItems = frame.items;
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

  /** 清空单个会话视图（重连重建用）。 */
  dropView(sessionId: string): void {
    this.views.delete(sessionId);
    this.notify();
  }
}
