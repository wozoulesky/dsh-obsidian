/**
 * chunkrow 解包层（批 3）。
 *
 * 线上事实（对照本机 0.1.2-rc.1 官方源码 + 真机实测核实）：
 * - 历史页/快照的 {type:"chunks"} 记录携带 `chunkrow/text-chunks | reasoning-chunks | tool-call-chunks`
 *   压缩行（字段名为 seq/time，承载行首 seq0/time0；官方 dsh-session/chunk-rows 的裸行
 *   seq0/time0 在 history.js 导出为 wire 形态时改名为 seq/time）。
 * - 展开算法与官方 chunk-rows.js `expandRow` 一致：成员 k 的 seq = seq + k，
 *   time = time + Σdt[0..k)（前缀和；dt 允许负数——官方允许时钟回拨）。
 * - 展开后的每条 event 形状与 src/core/eventFold.ts 的 applyChunk 消费形状一致：
 *   `{type:"assistant/chunk", seq, time, data:{turn, step, chunk:{type:"text-delta"|"reasoning-delta"|"tool-call-delta", index, text|argumentsDelta}}}`。
 * - 防呆：dt 长度必须 = 成员数 - 1；成员数组非空且全为字符串；seq/time/turn/step/index 为数字；
 *   非法记录抛错（官方语义：malformed 行是损坏数据，静默丢弃会吞掉整段 run）。
 *   未知/非法 record.type 原样透传为单条 event（与官方 decodeStorageRecord 一致：非行值原样通过）。
 */

import type { ChunkRowEvent, SessionEvent, SessionHistoryRecord } from "./types";

/** 展开后的 assistant/chunk 事件负载形状（与 eventFold.applyChunk 消费形状一致）。 */
export type ExpandedChunkEvent = SessionEvent & {
  type: "assistant/chunk";
  data: {
    turn: number;
    step: number;
    chunk:
      | { type: "text-delta" | "reasoning-delta"; index: number; text: string }
      | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string };
  };
};

function malformed(tag: string, why: string): never {
  throw new Error(`malformed chunkrow/${tag} record: ${why}`);
}

/** 校验并展开一个 chunkrow 压缩行（纯函数，行结构非法时抛错）。 */
export function expandChunkRowEvent(row: ChunkRowEvent): ExpandedChunkEvent[] {
  const data = row.data as Record<string, unknown>;
  const members =
    row.type === "chunkrow/tool-call-chunks" ? (data.args as string[] | undefined) : (data.texts as string[] | undefined);
  if (!Array.isArray(members) || members.length === 0 || members.some((m) => typeof m !== "string")) {
    malformed(row.type, "members must be a non-empty string array");
  }
  const dt = data.dt as number[] | undefined;
  if (!Array.isArray(dt) || dt.length !== members.length - 1 || dt.some((g) => typeof g !== "number")) {
    malformed(row.type, `dt length ${Array.isArray(dt) ? dt.length : "?"} does not match ${members.length} members`);
  }
  for (const key of ["seq", "time"] as const) {
    if (typeof (row as unknown as Record<string, unknown>)[key] !== "number") {
      malformed(row.type, `${key} must be a number`);
    }
  }
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const turn = num(data.turn);
  const step = num(data.step);
  const index = num(data.index);
  if (turn === undefined || step === undefined || index === undefined) {
    malformed(row.type, "turn/step/index must be numbers");
  }
  const id = typeof data.id === "string" ? data.id : undefined;
  if (row.type === "chunkrow/tool-call-chunks" && id === undefined) {
    malformed(row.type, "tool-call id must be a string");
  }
  const name = typeof data.name === "string" ? data.name : undefined;

  const events: ExpandedChunkEvent[] = [];
  let time = row.time;
  for (let k = 0; k < members.length; k++) {
    if (k > 0) time += dt[k - 1];
    let chunk: ExpandedChunkEvent["data"]["chunk"];
    if (row.type === "chunkrow/tool-call-chunks") {
      chunk = { type: "tool-call-delta", index, id: id as string, ...(name === undefined ? {} : { name }), argumentsDelta: members[k] };
    } else {
      const deltaType = row.type === "chunkrow/text-chunks" ? "text-delta" : "reasoning-delta";
      chunk = { type: deltaType, index, text: members[k] };
    }
    events.push({
      type: "assistant/chunk",
      seq: row.seq + k,
      time,
      data: { turn, step, chunk },
    });
  }
  return events;
}

/**
 * 展开一个历史记录：{type:"event"} 原样返回 [event]；{type:"chunks"} 展开为逐条 assistant/chunk。
 * 非法 record（非对象/类型未知）防呆：原样透传（与官方「非行值原样通过」语义一致）。
 */
export function expandChunkRow(record: SessionHistoryRecord): SessionEvent[] {
  if (typeof record !== "object" || record === null) {
    return [record as SessionEvent];
  }
  if (record.type === "event") return [record.event];
  if (record.type === "chunks") return expandChunkRowEvent(record.event);
  return [record as SessionEvent];
}

/** 展开一个历史记录数组（页面/快照 records 的整体解包入口，批 4 播种用）。 */
export function expandHistoryRecords(records: SessionHistoryRecord[]): SessionEvent[] {
  const out: SessionEvent[] = [];
  for (const record of records) out.push(...expandChunkRow(record));
  return out;
}
