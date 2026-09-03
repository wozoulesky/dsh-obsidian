import { createSessionView, foldEvent, type SessionView } from "./eventFold";
import type { ProjectionsBlock, SessionControlFrame, SessionEvent, SessionFollowFrame } from "../transport/types";
import { expandHistoryRecords } from "../transport/chunkRows";

interface ProjectionCell {
  value: unknown;
  seq: number;
}

/** 全会话视图模型仓库：follow/control 帧与历史页的统一入口，higher-seq-wins 投影语义。 */
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

  /**
   * 播种 follow 快照（批 4）：展开 chunkrow → 折叠进视图；snapshot.projections 逐键播种
   * （title/plan 等投影以 asOfSeq 为水位，higher-seq-wins）。
   */
  applyFollowSnapshot(sessionId: string, frame: Extract<SessionFollowFrame, { type: "snapshot" }>): void {
    const view = this.ensureView(sessionId);
    for (const event of expandHistoryRecords(frame.records)) foldEvent(view, event);
    this.applyProjectionsBlock(sessionId, frame.projections);
    this.notify();
  }

  /** follow 流的事件帧：仅折叠进已存在的视图（未打开会话不物化，沿用旧 session/event 语义）。 */
  applyFollowEvent(sessionId: string, frame: Extract<SessionFollowFrame, { type: "event" }>): void {
    const view = this.views.get(sessionId);
    if (!view) return;
    foldEvent(view, frame.event);
    this.notify();
  }

  /**
   * 消费 session/control 流帧（批 4）：baseline 全量播种队列/投影（投影允许播种含未打开会话；
   * 队列仅物化到已存在视图）；增量帧对应更新。jobs 帧忽略（插件不展示任务）。
   */
  applyControlFrame(frame: SessionControlFrame): void {
    let changed = false;
    switch (frame.type) {
      case "baseline": {
        // 队列只作用于帧开始前已存在的视图：投影允许播种（会物化未打开会话），
        // 若按播种后的视图集合处理队列，未打开会话也会被队列物化（违反旧语义）。
        const existing = new Set(this.views.keys());
        for (const [sessionId, block] of Object.entries(frame.value.projections)) {
          changed = this.applyProjectionsBlock(sessionId, block) || changed;
        }
        for (const [sessionId, items] of Object.entries(frame.value.queues)) {
          if (!existing.has(sessionId)) continue;
          const view = this.views.get(sessionId) as SessionView;
          view.queueItems = items;
          changed = true;
        }
        break;
      }
      case "queue": {
        const view = this.views.get(frame.sessionId);
        if (!view) break;
        view.queueItems = frame.items;
        changed = true;
        break;
      }
      case "projection": {
        changed = this.applyProjection(frame.sessionId, frame.key, frame.value, frame.seq);
        break;
      }
      case "jobs":
        break; // 忽略
    }
    if (changed) this.notify();
  }

  /** 播种一个投影块（逐键 applyProjection，水位为 block.asOfSeq）。 */
  private applyProjectionsBlock(sessionId: string, block: ProjectionsBlock): boolean {
    let changed = false;
    for (const [key, value] of Object.entries(block.values)) {
      changed = this.applyProjection(sessionId, key, value, block.asOfSeq) || changed;
    }
    return changed;
  }

  /** 用已展开的历史事件播种视图（调用方负责保证 seq 递增顺序）。 */
  seedHistory(sessionId: string, events: SessionEvent[]): void {
    const view = this.ensureView(sessionId);
    for (const event of events) foldEvent(view, event);
    this.notify();
  }

  /**
   * 前插一页更早的历史：在 store 内重建视图（折叠旧页 + 拼接现有节点），
   * 保证 lastSeq/running/title/plan/queueItems 状态一致，并 notify 一次。
   * 计划状态启发式：现有页若未观察到任何计划状态则沿用旧页的。
   */
  prependHistory(sessionId: string, events: SessionEvent[]): void {
    const current = this.views.get(sessionId);
    const rebuilt = createSessionView(sessionId);
    for (const event of events) foldEvent(rebuilt, event);
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
