/**
 * 未知负载 → 人类可读字符串。
 *
 * 背景（社区审核 `@typescript-eslint/no-base-to-string`，2026-09-13 报告）：
 * 直接 `String(unknown)` 在值是对象时会退化成 `"[object Object]"` —— 写进节点 id 会变成
 * 无意义且可能互相碰撞的缓存键，写进错误消息则丢掉全部诊断信息。
 *
 * 放在 `utils/` 而非 `core/narrow.ts`：`transport/` 也要用它，
 * 而 transport → core 是逆向分层依赖（core 已依赖 transport/types）。
 */

/** 未知负载 → 字符串；**绝不返回 `"[object Object]"`**。 */
export function describeUnknown(value: unknown): string {
  if (value instanceof Error) return value.message;
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "boolean":
    case "bigint":
    case "symbol":
      return String(value);
    case "function":
      return value.name.length > 0 ? `[function ${value.name}]` : "[function]";
    default:
      break;
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  try {
    const json = JSON.stringify(value);
    if (typeof json === "string") return json;
  } catch {
    /* 循环引用等无法序列化：退回 Object.prototype.toString */
  }
  return Object.prototype.toString.call(value);
}
