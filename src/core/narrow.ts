/**
 * 未知负载的收窄原语（投影/事件折叠共用）。
 *
 * 社区审核约束第 5 条禁止"无实际转换的类型断言"，因此一律用 `Reflect.get` 读自有属性
 * （返回 `any`，赋给 `unknown` 无需断言），再按 `typeof` 收窄。
 */

/** 读取未知对象的自有属性（不存在 → undefined）。 */
export function readField(source: object, key: string): unknown {
  const value: unknown = Reflect.get(source, key);
  return value;
}

/** 取有限数字字段；非数字/NaN/Infinity 一律视为缺省。 */
export function numberField(source: object, key: string): number | undefined {
  const value = readField(source, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 取非空字符串字段；缺省/空串/非字符串一律视为缺省。 */
export function nonEmptyStringField(source: object, key: string): string | undefined {
  const value = readField(source, key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 负载是否为可读属性的非 null **非数组**对象。
 *
 * 数组刻意排除：这些收窄函数面对的都是线上对象负载（投影值、事件 data、描述符），
 * 数组能通过 `typeof === "object"` 却读不出任何字段——放进来只会把 `[]` 误判成
 * "字段全缺省的合法对象"（例如 `modelSelection: []` 会被收窄成 `{lastUsed:null,next:null}`）。
 */
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
