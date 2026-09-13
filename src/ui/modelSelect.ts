/**
 * 模型 / 推理档位选择器的纯函数层（TASK-030 项 1）。
 *
 * 与 `headerSelect.ts` 同一思路：把"显示什么"与"怎么写 DOM"分开，让规则能在无 DOM 的
 * 测试环境里被直接驱动。契约事实（真机实测，见 tmp/probe-task030.notes.md）：
 * - `session/modelCatalog` 返回 `{default, routableProviders, groups:[{id,name,models}], failures}`；
 * - 每个 model 的 `reasoning.efforts` 是 `{id,name,description?}[]`（**不是字符串数组**），
 *   `reasoning.defaultEffort` 可能缺省（该模型没有默认档）；
 * - 当前选择来自 `modelSelection` 投影，官方 UI 取 `next ?? catalog.default`。
 */
import { effectiveModelSelection } from "../core/sessionProjections";
import { syncSelectOptions, type HeaderSelectLike } from "./headerSelect";
import type {
  ModelCatalog,
  ModelCatalogModel,
  ModelReasoningEffort,
  ModelSelection,
  ModelSelectionProjection,
} from "../transport/types";

/**
 * `<option>` 的 value 编码：`provider\u0000model`。
 * 用 NUL 作分隔符——provider/model 里不可能出现它（模型 id 含 `/`、`-`、`.`，provider 含 `-`），
 * 因此解码无歧义，也不像 `|` 那样可能与模型名冲突。
 */
const VALUE_SEPARATOR = "\u0000";

export function encodeSelectionValue(selection: Pick<ModelSelection, "provider" | "model">): string {
  return `${selection.provider}${VALUE_SEPARATOR}${selection.model}`;
}

/** 解码 `<option>` value；非本模块编码的形态 → null。 */
export function decodeSelectionValue(value: string): { provider: string; model: string } | null {
  const at = value.indexOf(VALUE_SEPARATOR);
  if (at <= 0) return null;
  const provider = value.slice(0, at);
  const model = value.slice(at + VALUE_SEPARATOR.length);
  if (model.length === 0) return null;
  return { provider, model };
}

/** 一个模型下拉项（`group` 为提供方分组标题）。 */
export interface ModelOption {
  value: string;
  label: string;
  group: string;
}

/** 把目录展平成下拉项（保持 groups 顺序与组内顺序，即服务端给出的顺序）。 */
export function modelOptions(catalog: ModelCatalog | undefined): ModelOption[] {
  if (!catalog) return [];
  const out: ModelOption[] = [];
  for (const group of catalog.groups) {
    for (const model of group.models) {
      out.push({
        value: encodeSelectionValue({ provider: group.id, model: model.id }),
        label: `${model.name} · ${group.name}`,
        group: group.name,
      });
    }
  }
  return out;
}

/** 在目录里按 provider+model 找模型项；找不到 → undefined（会话选的是目录外的路由）。 */
export function findCatalogModel(catalog: ModelCatalog | undefined, selection: ModelSelection | undefined): ModelCatalogModel | undefined {
  if (!catalog || !selection) return undefined;
  for (const group of catalog.groups) {
    if (group.id !== selection.provider) continue;
    const model = group.models.find((m) => m.id === selection.model);
    if (model) return model;
  }
  return undefined;
}

/** 推理档位下拉的取值：可选档位 + 当前档位（缺省时为空串，即"用服务端默认"）。 */
export interface ReasoningChoice {
  efforts: ModelReasoningEffort[];
  /** 当前档位 id；空串表示未显式选择（服务端按 defaultEffort/适配器默认处理）。 */
  selected: string;
}

/**
 * 受支持模型的推理档位。
 *
 * 当前档位 = 会话选择里的 `reasoningEffort`（且必须仍在该模型的 efforts 里）→ 否则空串。
 * 空串渲染成"服务端默认"选项：官方客户端在**切换模型**时会下发新模型的 `defaultEffort`
 * （见 dsh-client-ui-model-selection 的 selectionOf），而"当前值不在 efforts 里"这种
 * 陈旧投影（例如刚换了 provider）不应该被我们硬映射到某个档位。
 */
export function reasoningChoice(catalog: ModelCatalog | undefined, selection: ModelSelection | undefined): ReasoningChoice {
  const model = findCatalogModel(catalog, selection);
  const efforts = model?.reasoning?.efforts ?? [];
  if (efforts.length === 0) return { efforts: [], selected: "" };
  const explicit = selection?.reasoningEffort;
  const selected = explicit !== undefined && efforts.some((e) => e.id === explicit) ? explicit : "";
  return { efforts, selected };
}

/**
 * 切换模型时要提交的推理档位（与官方客户端一致）：新模型的 `defaultEffort`，
 * 缺省则空串（= 不下发该字段，由服务端决定）。
 */
export function effortForModel(catalog: ModelCatalog | undefined, selection: ModelSelection | undefined): string {
  return findCatalogModel(catalog, selection)?.reasoning?.defaultEffort ?? "";
}

/** 档位下拉项的显示文本（有描述时附在后面，与官方 UI 的提示风格一致）。 */
export function effortLabel(effort: ModelReasoningEffort): string {
  return effort.description === undefined || effort.description.length === 0 ? effort.name : `${effort.name} — ${effort.description}`;
}

/**
 * 当前选择（供 UI 显示与提交）：投影 `next ?? lastUsed` → 目录默认 → undefined。
 * 会话刚建立、投影还没到达时退回目录默认值，因此下拉不会是空的。
 */
export function currentSelection(
  projection: ModelSelectionProjection | undefined,
  catalog: ModelCatalog | undefined
): ModelSelection | undefined {
  return effectiveModelSelection(projection, catalog?.default);
}

/** 提交给 `session/selectModel` 的请求体（会话 id + provider/model + 可选档位）。 */
export function selectionRequest(
  sessionId: string,
  value: string,
  reasoningEffort: string
): { sessionId: string; provider: string; model: string; reasoningEffort?: string } | null {
  const decoded = decodeSelectionValue(value);
  if (!decoded) return null;
  return {
    sessionId,
    provider: decoded.provider,
    model: decoded.model,
    ...(reasoningEffort.length === 0 ? {} : { reasoningEffort }),
  };
}

/* ---- DOM 同步（与 headerSelect 相同的"最小元素表面"手法，测试用轻量替身驱动） ---- */

/**
 * `<select>` 上我们关心的那点表面（真实 HTMLSelectElement 天然满足）。
 *
 * `optgroup` 的分组标题必须是 **`label` 属性**：浏览器只认 `<optgroup label="…">`，
 * 写进 textContent 不会显示任何标题（真机验收 TASK-031 G1 实测：三个分组标题全不可见）。
 */
export interface GroupedSelectLike {
  value: string;
  options: ArrayLike<{ readonly value: string; text: string }>;
  empty(): void;
  createEl(
    tag: "optgroup",
    o?: { attr?: { label: string } }
  ): { createEl(tag: "option", o?: { text?: string; value?: string }): unknown };
}

/**
 * 同步模型下拉（按 `groups` 分组渲染）。
 *
 * 与 `syncSelectOptions` 同样的增量契约：选项集合（各 optgroup 的 value 序列）未变时
 * **不重建**，只更新文本与选中项；变化时才 `empty()` 重建。返回是否重建了结构。
 *
 * 注：`group` 只影响 optgroup 归属，不参与"集合是否变化"的判定——组名改动不值得重建整棵 DOM。
 */
export function syncModelSelect(select: GroupedSelectLike, options: readonly ModelOption[], selected: string): boolean {
  const sameShape =
    select.options.length === options.length &&
    options.every((option, i) => select.options[i]?.value === option.value);
  if (!sameShape) {
    select.empty();
    let currentGroup: string | null = null;
    let groupEl: ReturnType<GroupedSelectLike["createEl"]> | null = null;
    for (const option of options) {
      if (groupEl === null || option.group !== currentGroup) {
        currentGroup = option.group;
        // 分组标题走 label 属性（textContent 对 <optgroup> 无效）
        groupEl = select.createEl("optgroup", { attr: { label: option.group } });
      }
      groupEl.createEl("option", { text: option.label, value: option.value });
    }
  } else {
    for (let i = 0; i < options.length; i++) {
      const el = select.options[i];
      if (el.text !== options[i].label) el.text = options[i].label;
    }
  }
  if (select.value !== selected) select.value = selected;
  return !sameShape;
}

/** 推理档位下拉的取值集合（首项为空串 = 不显式指定档位）。 */
export interface EffortOption {
  value: string;
  label: string;
}

/** 档位下拉项：仅当模型声明了 efforts 时非空（空数组 → UI 隐藏该下拉）。 */
export function effortOptions(choice: ReasoningChoice, defaultLabel: string): EffortOption[] {
  if (choice.efforts.length === 0) return [];
  return [{ value: "", label: defaultLabel }, ...choice.efforts.map((e) => ({ value: e.id, label: effortLabel(e) }))];
}

/** 复用 headerSelect 的增量同步（档位下拉是平铺选项，无需分组）。 */
export function syncEffortSelect(
  select: HeaderSelectLike,
  options: readonly EffortOption[],
  selected: string
): boolean {
  return syncSelectOptions(select, options.map((option) => ({ value: option.value, label: option.label })), selected);
}
