/**
 * 0.1.5 assistant 流压缩记录展开（对照官方 `expandAssistantStream`，dsh-llm assistant-stream）。
 *
 * 用途：follow 开场快照的 `assistantStream.activeAttempt.stream` 是一段**压缩记录**
 * （`text-chunks` / `reasoning-chunks` / `tool-call-chunks` / `chunk`），
 * 展开后即可复用 eventFold 的增量折叠路径，让断线重连时正在流式的文本被恢复而非丢失。
 *
 * 与 `chunkRows.ts` 的区别（两者都做"压缩行 → 逐条 delta"的前缀展开）：
 * - `chunkRows.ts`：0.1.2-rc.1 历史页/快照的 `{type:"chunks"}` 记录，字段名为 `seq`/`time`。
 * - 本模块：0.1.5 的 assistant 流记录，字段名为 `time0` 且**无 seq**（瞬态，不入 log）。
 *   因插件保留 0.1.2 兼容（能力探测），两者并存。
 *
 * 时间戳（`time0`/`dt` 前缀和）在本插件不参与渲染——`StreamChunk` 不携带时间，故只还原文本序列。
 */
import type { ContentBlock, StreamChunk } from "./types";

/** 逐成员展开一条压缩记录；成员数组/索引非法时返回空数组（瞬态数据，丢弃优于抛错）。 */
function expandRecord(record: Record<string, unknown>): StreamChunk[] {
  const type = record.type;
  if (type !== "text-chunks" && type !== "reasoning-chunks" && type !== "tool-call-chunks") return [];
  const index = record.index;
  if (typeof index !== "number") return [];
  const members = type === "tool-call-chunks" ? record.args : record.texts;
  if (!Array.isArray(members)) return [];
  const out: StreamChunk[] = [];
  for (const member of members) {
    if (typeof member !== "string") continue;
    if (type === "text-chunks") {
      out.push({ type: "text-delta", index, text: member });
      continue;
    }
    if (type === "reasoning-chunks") {
      out.push({ type: "reasoning-delta", index, text: member });
      continue;
    }
    const id = record.id;
    if (typeof id !== "string") continue;
    const name = typeof record.name === "string" ? record.name : undefined;
    out.push({ type: "tool-call-delta", index, id, ...(name === undefined ? {} : { name }), argumentsDelta: member });
  }
  return out;
}

/** 展开一条未压缩的 `chunk` 记录（chunk 本体即一个 StreamChunk）。 */
function expandRawChunk(record: Record<string, unknown>): StreamChunk | null {
  const chunk = record.chunk;
  if (typeof chunk !== "object" || chunk === null) return null;
  const inner = chunk as Record<string, unknown>;
  const type = inner.type;
  const index = inner.index;
  if (typeof index !== "number") return null;
  switch (type) {
    case "block-start":
      return typeof inner.blockType === "string" ? { type: "block-start", index, blockType: inner.blockType } : null;
    case "block-end": {
      const block = inner.block;
      if (typeof block !== "object" || block === null) return null;
      const candidate = block as Record<string, unknown>;
      if (typeof candidate.type !== "string") return null;
      // 线上 block 由服务端按 ContentBlock 序列化；此处仅校验判别字段后透传（内容由折叠层按需读取）
      return { type: "block-end", index, block: candidate as unknown as ContentBlock };
    }
    case "text-delta":
      return typeof inner.text === "string" ? { type: "text-delta", index, text: inner.text } : null;
    case "reasoning-delta":
      return typeof inner.text === "string" ? { type: "reasoning-delta", index, text: inner.text } : null;
    case "tool-call-delta": {
      if (typeof inner.id !== "string" || typeof inner.argumentsDelta !== "string") return null;
      const name = typeof inner.name === "string" ? inner.name : undefined;
      return { type: "tool-call-delta", index, id: inner.id, ...(name === undefined ? {} : { name }), argumentsDelta: inner.argumentsDelta };
    }
    case "usage":
      return { type: "usage", usage: inner.usage };
    case "finish":
      return { type: "finish", reason: inner.reason };
    default:
      return null;
  }
}

/** 展开一段 assistant 流压缩记录（顺序保持；未识别记录跳过）。 */
export function expandAssistantStream(stream: unknown[]): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (const candidate of stream) {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (record.type === "chunk") {
      const chunk = expandRawChunk(record);
      if (chunk) out.push(chunk);
      continue;
    }
    out.push(...expandRecord(record));
  }
  return out;
}
