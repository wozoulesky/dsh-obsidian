/**
 * 把 `ViewNode` 映射成「该如何呈现」的纯规格。
 *
 * 从 `chatView.buildNodeEl` 抽出：那个方法是 60+ 行的分支瀑布，且依赖
 * `this.nodesEl` / `this.runtime`，在 node 测试环境下无法直接覆盖，
 * 导致**渲染分类长期没有自动化保护** —— 分支顺序或 className 改动只有真机才能发现。
 *
 * 只抽「分类 + 类名 + 文本」这层**决策**；Markdown 渲染、工具卡 DOM、
 * 推理折叠等副作用仍留在 chatView（它们需要真实 DOM 与 Obsidian 的渲染器）。
 */
import type { ViewNode } from "../core/eventFold";
import { turnNoticeText, type Translate } from "./sessionStatus";

/** 一个节点应当渲染成什么（纯数据，不含 DOM）。 */
export interface NodePresentation {
  /** 节点类别，便于调用方/测试断言走的是哪条分支。 */
  kind: ViewNode["kind"];
  /** 容器 className。 */
  cls: string;
  /** 纯文本内容（用户消息/错误/命令/notice）；assistant 的正文由调用方另行处理。 */
  text: string;
  /** 带图消息的计数文案（仅 user 且 imageCount > 0 时存在）。 */
  imageLabel?: string;
}

/**
 * 计算节点的呈现规格。
 *
 * 分支顺序**有意义**：`notice` 必须排在 assistant 兜底之前，
 * 否则「回合被拒/中断」会被渲染成一个空助手气泡（P1-4 的原始症状）。
 */
export function describeNode(node: ViewNode, t: Translate): NodePresentation {
  if (node.kind === "user") {
    return {
      kind: "user",
      cls: node.sourceKind === "user" ? "dsh-msg-user" : "dsh-msg-context",
      text: node.text,
      imageLabel: node.imageCount > 0 ? t("chat.imageCount", { count: node.imageCount }) : undefined,
    };
  }
  if (node.kind === "error") {
    return { kind: "error", cls: "dsh-msg-context", text: t("chat.turnError", { message: node.text }) };
  }
  if (node.kind === "command") {
    const statusText = node.status === "running" ? "⏳" : node.status === "success" ? "✓" : "✗";
    return {
      kind: "command",
      cls: "dsh-msg-command",
      text: node.text
        ? t("chat.commandLineWithText", { status: statusText, name: node.name, text: node.text })
        : t("chat.commandLine", { status: statusText, name: node.name }),
    };
  }
  if (node.kind === "notice") {
    // 回合异常收尾（blocked/aborted/interrupted/max-tokens/…）：纯文本提示，不带「错误」前缀，
    // 因为这不是执行中出错，而是**根本没跑**或**提前停了**——两者对用户的含义不同。
    return { kind: "notice", cls: "dsh-msg-context", text: turnNoticeText(node.reason, t) };
  }
  // assistant 兜底：正文为空时给占位，避免空白气泡
  return { kind: "assistant", cls: "dsh-msg-assistant", text: node.text.length > 0 ? node.text : t("chat.noText") };
}
