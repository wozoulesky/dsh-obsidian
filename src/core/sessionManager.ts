import { DshClient } from "../transport/client";
import { RemoteStreamError } from "../transport/muxStream";
import { SessionStore } from "./store";
import { narrowCommandDescriptors } from "./commands";
import { DshSettings } from "../settings";
import { expandHistoryRecords } from "../transport/chunkRows";
import type {
  CommandDescriptor,
  CommandExecution,
  CommandSubmitAttachment,
  CreateGoalRequest,
  CreateGoalResult,
  EditGoalRequest,
  GoalRef,
  GoalView,
  ModelCatalog,
  ModelSelection,
  PromptContentPart,
  PromptResult,
  RpcResult,
  SessionFollowFrame,
  SessionFollowRequest,
  SessionSelectModelValue,
  SessionSummary,
} from "../transport/types";

export interface SessionManagerDeps {
  client: DshClient;
  store: SessionStore;
  vaultPath: string;
  settings: DshSettings;
  /** 本地化函数；用于会话标题回退等 UI 文案。 */
  t: (key: string, params?: Record<string, string | number>) => string;
  /**
   * 重连对账后，先前正在流式的内容未能复原时回调（TASK-032 C4）。
   *
   * 场景：**服务端重启**时，进行中的回合从未落库（session log 里只有 user/message），
   * 服务端自己也无法续传，故快照里没有这段文本——重连对账会摘掉半截气泡。
   * 这是忠实于 durable log 的正确行为，但"文字静默消失"会造成困惑，故通知一次。
   *
   * 注意与「仅客户端重连」区分：后者服务端仍持有在飞 attempt，快照带
   * `assistantStream.activeAttempt`，由 `seedAssistantStream` 复原文本 → **不触发**本回调。
   */
  onInterruptedTurnDropped?: (sessionId: string) => void;
}

/**
 * 「流式文本是否幸存」的前缀采样长度（TASK-032 C4）。
 * 取 40 字符：短到足以在服务端落库的文本里稳定命中，长到足以避免偶然重合。
 */
const STREAM_LOSS_PREFIX_SAMPLE = 40;

export class SessionManager {
  /** 会话列表（只读；由 `refresh()` 整体替换，索引同步重建）。 */
  private items: SessionSummary[] = [];
  /** sessionId → 摘要索引：`sessionTitle` 每次头部渲染都要调用，避免 O(n) 线性查找。 */
  private byId = new Map<string, SessionSummary>();
  currentId: string | undefined;

  /** 会话列表（vault 绑定置顶，其余按 updatedAt 降序）。 */
  get sessions(): SessionSummary[] {
    return this.items;
  }

  /**
   * 0.1.5 `assistant-stream` 能力位：
   * - `null` 未知 → 首次带参探测；
   * - `true` 服务端接受（0.1.5+）；
   * - `false` 服务端拒绝该字段（0.1.2-rc.1 等旧版对 args 严格校验）→ 之后一律不带参。
   */
  private assistantStreamSupported: boolean | null = null;

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
    // 线上 list 的 projections 只有 sessionListMetadata/imageLimits/modelSelection（无 title，官方核实）；
    // 标题靠 control baseline 播种进 store 视图——优先读视图，list 字段仅作兜底。
    const viewTitle = this.deps.store.getView(s.sessionId)?.title;
    if (typeof viewTitle === "string" && viewTitle.length > 0) return viewTitle;
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
    this.items = items;
    // 索引与列表同源重建：两者永远一起更新，避免索引陈旧导致标题错配
    this.byId.clear();
    for (const s of items) this.byId.set(s.sessionId, s);
  }

  sessionTitle(sessionId: string): string {
    const summary = this.byId.get(sessionId);
    if (summary) return this.displayTitle(summary);
    // 列表尚无该会话（新建未刷新）时也读 store 视图标题兜底
    const viewTitle = this.deps.store.getView(sessionId)?.title;
    if (typeof viewTitle === "string" && viewTitle.length > 0) return viewTitle;
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

  /**
   * 打开 follow 流并取首帧（含 0.1.5 assistant-stream 能力探测）。
   *
   * 0.1.5 把实时增量从 durable `assistant/chunk` 事件改成了需 opt-in 的 `assistant-stream` 帧；
   * 但服务端对 args 做**严格**校验，旧版 DSH（0.1.2-rc.1）不认识 `assistantStream` 会整条拒绝
   * （`gateway/arguments-invalid`）。因此首次带参，被拒则记住能力位、去掉该字段重试一次——
   * 新旧两版共用同一调用点，旧版行为与本改动前完全一致。
   *
   * 注意：错误帧在**迭代时**才抛出（不是 openStream 时），故探测必须包住首次 next()。
   */
  private async openFollowSeeded(
    sessionId: string,
    signal: AbortSignal
  ): Promise<{ iterator: AsyncIterator<SessionFollowFrame>; first: IteratorResult<SessionFollowFrame> }> {
    const attempt = async (withAssistantStream: boolean) => {
      const request: SessionFollowRequest = {
        address: { kind: "session", sessionId },
        maxMessages: this.deps.settings.values.historyPageSize,
        ...(withAssistantStream ? { assistantStream: true as const } : {}),
      };
      const stream = await this.client.openStream<SessionFollowFrame>("session/follow", { request }, signal);
      const iterator = stream[Symbol.asyncIterator]();
      return { iterator, first: await iterator.next() };
    };

    const wanted = this.assistantStreamSupported !== false;
    try {
      const opened = await attempt(wanted);
      if (wanted) this.assistantStreamSupported = true;
      return opened;
    } catch (err) {
      if (wanted && err instanceof RemoteStreamError && err.code === "gateway/arguments-invalid") {
        this.assistantStreamSupported = false; // 旧版 DSH：降级后不再重试带参
        return attempt(false);
      }
      throw err;
    }
  }

  /** 切换当前会话：follow 首帧 snapshot 播种视图，后台消费 event 帧。 */
  async openSession(sessionId: string): Promise<void> {
    const epoch = ++this.openEpoch;
    this.abortAllFollows();
    const controller = new AbortController();
    this.followControllers.set(sessionId, controller);
    try {
      const { iterator, first } = await this.openFollowSeeded(sessionId, controller.signal);
      if (epoch !== this.openEpoch) {
        controller.abort();
        void iterator.return?.().catch(() => undefined); // 驱动物理层 cancel（终审 M-4 收口）
        return; // 竞态守卫：期间已切换到其他会话
      }
      this.deps.store.dropView(sessionId); // 重建干净视图再播种
      if (controller.signal.aborted) {
        controller.abort();
        void iterator.return?.().catch(() => undefined); // 丢弃路径收口：驱动 cancel，避免 inbox 残留至断线
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

  /** 后台消费 follow 的 event / assistant-stream 帧；异常静默清理句柄（重连由 main.ts 触发 resync）。 */
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
          } else if (frame.type === "assistant-stream") {
            // 0.1.5 瞬态增量通道（带参成功时才有帧）
            this.deps.store.applyFollowAssistantStream(sessionId, frame.frame);
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
    // 重连前正在流式、且已有内容的文本（用于判定它是否被服务端丢弃）
    const streamedText = this.streamingTextOf(sessionId);
    const controller = new AbortController();
    this.followControllers.set(sessionId, controller);
    try {
      const { iterator, first } = await this.openFollowSeeded(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      if (first.done || first.value.type !== "snapshot") {
        controller.abort();
        return; // 服务端暂不可用/协议异常时静默放弃，下一次重连会重试（视图未被改动，内容不丢）
      }
      this.deps.store.dropView(sessionId);
      this.deps.store.applyFollowSnapshot(sessionId, first.value);
      this.notifyIfStreamedTextLost(sessionId, streamedText);
      this.consumeFollow(sessionId, controller, iterator);
    } catch {
      controller.abort();
      this.followControllers.delete(sessionId);
      // 服务端暂不可用时静默放弃，下一次重连会重试
    }
  }

  /** 当前是否有一个正在流式、且已产出文本的 assistant 节点；返回其文本（无则空串）。 */
  private streamingTextOf(sessionId: string): string {
    const view = this.deps.store.getView(sessionId);
    if (!view) return "";
    for (let i = view.nodes.length - 1; i >= 0; i--) {
      const node = view.nodes[i];
      if (node.kind !== "assistant") continue;
      return node.streaming ? node.text : "";
    }
    return "";
  }

  /**
   * 重连对账后判断先前流式文本是否已不在视图中，是则通知一次。
   *
   * 用前缀采样而非全等：服务端若在断线期间正常落库了同一回合，快照里的文本会以相同前缀出现
   * （那种情况不算丢失，不该打扰用户）。文本很短时采样即全文，等价于全等。
   */
  private notifyIfStreamedTextLost(sessionId: string, streamedText: string): void {
    if (streamedText.length === 0) return;
    const sample = streamedText.slice(0, STREAM_LOSS_PREFIX_SAMPLE);
    const view = this.deps.store.getView(sessionId);
    const survived = (view?.nodes ?? []).some((n) => n.kind === "assistant" && n.text.includes(sample));
    if (!survived) this.deps.onInterruptedTurnDropped?.(sessionId);
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
    this.deps.store.prependHistory(sessionId, expandHistoryRecords(res.value.records));
    return res.value.hasMore;
  }

  async prompt(sessionId: string, text: string, mode: "queue" | "steer" = "queue"): Promise<RpcResult<PromptResult>> {
    return this.promptContent(sessionId, [{ type: "text", text }], mode);
  }

  /**
   * 发送富内容 prompt（TASK-030 项 3）：文本 + 图片（内联 base64）content 块。
   *
   * 线上要求"至少一个非空白 text 块或附件"，故**空数组不发**（返回一个本地错误结果，
   * 不浪费一次 RPC，也避免服务端 gateway/arguments-invalid 的噪音）。
   */
  async promptContent(
    sessionId: string,
    content: readonly PromptContentPart[],
    mode: "queue" | "steer" = "queue"
  ): Promise<RpcResult<PromptResult>> {
    if (content.length === 0) {
      return { ok: false, error: { code: "invalid-content", message: "没有可发送的内容" } };
    }
    return this.client.prompt({ sessionId, mode, content: [...content] });
  }

  async cancel(sessionId: string): Promise<RpcResult<{ accepted: true }>> {
    return this.client.cancel({ sessionId });
  }

  /* ---- TASK-030 项 1：模型目录 / 切换 ---- */

  /**
   * 目录拉取（宿主级，与会话无关）。
   * 刻意**不缓存**：目录会随 `llm/adapters-updated`、设置变更而变，调用点是"打开面板"与
   * "用户重新选择"，频率极低，缓存只会带来陈旧数据。
   */
  async modelCatalog(): Promise<RpcResult<ModelCatalog>> {
    return this.client.modelCatalog();
  }

  /** 切换当前会话的模型 / 推理档位（host 在下一次提示词组装边界消费该选择）。 */
  async selectModel(
    sessionId: string,
    selection: ModelSelection
  ): Promise<RpcResult<SessionSelectModelValue>> {
    return this.client.selectModel({ sessionId, ...selection });
  }

  /* ---- TASK-030 项 2：命令 ---- */

  /** 命令清单缓存（按会话：命令可注册在 agent 作用域，不同会话清单可能不同）。 */
  private commands = new Map<string, CommandDescriptor[]>();

  /** 已缓存的命令清单；`null` = 尚未成功拉取（UI 退回内置兜底清单）。 */
  cachedCommands(sessionId: string): CommandDescriptor[] | null {
    return this.commands.get(sessionId) ?? null;
  }

  /**
   * 拉取并缓存命令清单（`commands/list`，参数平铺 `{agentId}`）。
   * 失败时抛错但**保留旧缓存**——联想退回上一次可信清单比清空更接近真相。
   */
  async loadCommands(sessionId: string): Promise<CommandDescriptor[]> {
    const res = await this.client.listCommands(sessionId);
    if (!res.ok) throw new Error(res.error.message);
    const list = narrowCommandDescriptors(res.value);
    this.commands.set(sessionId, list);
    return list;
  }

  /**
   * 执行一条斜杠命令（`commands/execute`，参数平铺 `{agentId,line,submittedAttachments}`）。
   * 返回 `undefined` 值表示未命中任何命令（调用方回退为普通 prompt）。
   */
  async runCommand(
    sessionId: string,
    line: string,
    submittedAttachments: CommandSubmitAttachment[] = []
  ): Promise<RpcResult<CommandExecution | undefined>> {
    return this.client.executeCommand(sessionId, line, submittedAttachments);
  }

  /* ---- TASK-030 项 4：目标（goals/*，参数全部平铺） ---- */

  async goalGet(sessionId: string): Promise<RpcResult<GoalView | undefined>> {
    return this.client.goalGet(sessionId);
  }

  async goalCreate(sessionId: string, request: CreateGoalRequest): Promise<RpcResult<CreateGoalResult>> {
    return this.client.goalCreate(sessionId, request);
  }

  async goalEdit(sessionId: string, ref: GoalRef, request: EditGoalRequest): Promise<RpcResult<GoalView>> {
    return this.client.goalEdit(sessionId, ref, request);
  }

  async goalPause(sessionId: string, ref: GoalRef): Promise<RpcResult<GoalView>> {
    return this.client.goalPause(sessionId, ref);
  }

  async goalResume(sessionId: string, ref: GoalRef): Promise<RpcResult<GoalView>> {
    return this.client.goalResume(sessionId, ref);
  }

  async goalComplete(sessionId: string, ref: GoalRef): Promise<RpcResult<GoalView>> {
    return this.client.goalComplete(sessionId, ref);
  }

  async goalClear(sessionId: string, ref: GoalRef): Promise<RpcResult<GoalRef>> {
    return this.client.goalClear(sessionId, ref);
  }
}
