/**
 * TASK-030 项 1：模型/推理档位选择器纯函数层单测。
 *
 * 目录样本逐字取自真机 `session/modelCatalog`（tmp/probe-task030.notes.md）：
 * - `default` = {provider:"commandcode-pro", model:"deepseek/deepseek-v4.1-flash", reasoningEffort:"max"}
 * - 三个 group：deepseek-official / opencode-go / commandcode-pro
 * - `reasoning.efforts` 是**对象数组** `{id,name,description?}`；部分模型无 reasoning（如 Kimi K2.7 Code）；
 *   `opencode-go` 的 flash 有 efforts 但**没有** defaultEffort（这是"切换模型时不下发档位"的真实场景）。
 *
 * DOM 同步用轻量替身驱动（无需 jsdom）：验证分组渲染与"集合未变不重建"的增量契约。
 */
import { describe, expect, it } from "vitest";
import {
  currentSelection,
  decodeSelectionValue,
  effortForModel,
  effortLabel,
  effortOptions,
  encodeSelectionValue,
  findCatalogModel,
  modelOptions,
  reasoningChoice,
  selectionRequest,
  syncEffortSelect,
  syncModelSelect,
  type GroupedSelectLike,
} from "../../src/ui/modelSelect";
import type { ModelCatalog } from "../../src/transport/types";

const EFFORTS = [
  { id: "off", name: "Off", description: "Use for simple tasks that do not need reasoning." },
  { id: "low", name: "Low" },
  { id: "high", name: "High" },
  { id: "max", name: "Max" },
];

/** 真机目录（截取三组各若干模型）。 */
const CATALOG: ModelCatalog = {
  default: { provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "max" },
  routableProviders: ["deepseek-official", "opencode-go", "commandcode-pro"],
  groups: [
    {
      id: "deepseek-official",
      name: "DeepSeek",
      models: [
        { id: "deepseek-flash", name: "DeepSeek-V41-Flash", reasoning: { efforts: EFFORTS, defaultEffort: "high" } },
        { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", reasoning: { efforts: EFFORTS, defaultEffort: "high" } },
      ],
    },
    {
      id: "opencode-go",
      name: "opencode-go",
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", reasoning: { efforts: EFFORTS } }],
    },
    {
      id: "commandcode-pro",
      name: "commandcode-pro",
      models: [
        { id: "moonshotai/Kimi-K2.7-Code", name: "Kimi K2.7 Code" },
        { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", reasoning: { efforts: [{ id: "low", name: "Low" }, { id: "high", name: "High" }, { id: "max", name: "Max" }] } },
      ],
    },
  ],
  failures: [],
};

describe("encodeSelectionValue / decodeSelectionValue", () => {
  it("往返一致（模型 id 含 / 也不歧义）", () => {
    const value = encodeSelectionValue({ provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash" });
    expect(decodeSelectionValue(value)).toEqual({ provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash" });
  });

  it("非本模块编码的形态 → null（缺分隔符/空 provider/空 model）", () => {
    expect(decodeSelectionValue("")).toBeNull();
    expect(decodeSelectionValue("plain-model")).toBeNull();
    expect(decodeSelectionValue("\u0000model")).toBeNull();
    expect(decodeSelectionValue("provider\u0000")).toBeNull();
  });
});

describe("modelOptions", () => {
  it("按 groups 顺序展平，label 带提供方名，group 为分组标题", () => {
    const options = modelOptions(CATALOG);
    expect(options.map((o) => o.group)).toEqual(["DeepSeek", "DeepSeek", "opencode-go", "commandcode-pro", "commandcode-pro"]);
    expect(options[0].label).toBe("DeepSeek-V41-Flash · DeepSeek");
    expect(decodeSelectionValue(options[3].value)).toEqual({ provider: "commandcode-pro", model: "moonshotai/Kimi-K2.7-Code" });
  });

  it("目录缺失 → 空数组（UI 隐藏整行）", () => {
    expect(modelOptions(undefined)).toEqual([]);
  });
});

describe("findCatalogModel / reasoningChoice / effortForModel", () => {
  it("按 provider+model 精确定位（provider 不同则不算命中）", () => {
    expect(findCatalogModel(CATALOG, { provider: "opencode-go", model: "deepseek-v4-flash" })?.name).toBe("DeepSeek V4 Flash");
    expect(findCatalogModel(CATALOG, { provider: "deepseek-official", model: "deepseek-v4-flash" })).toBeUndefined();
  });

  it("无 reasoning 的模型 → 无档位可选（下拉隐藏）", () => {
    const choice = reasoningChoice(CATALOG, { provider: "commandcode-pro", model: "moonshotai/Kimi-K2.7-Code" });
    expect(choice).toEqual({ efforts: [], selected: "" });
    expect(effortOptions(choice, "服务端默认")).toEqual([]);
    expect(effortForModel(CATALOG, { provider: "commandcode-pro", model: "moonshotai/Kimi-K2.7-Code" })).toBe("");
  });

  it("当前档位：投影里的 reasoningEffort 且仍在 efforts 内才回显", () => {
    expect(reasoningChoice(CATALOG, { provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "high" }).selected).toBe("high");
    // 陈旧投影（档位不在该模型的 efforts 里）→ 空串，不硬映射
    expect(reasoningChoice(CATALOG, { provider: "commandcode-pro", model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "off" }).selected).toBe("");
  });

  it("切换模型时提交的档位 = 新模型的 defaultEffort；无默认 → 空串（不下发该字段）", () => {
    expect(effortForModel(CATALOG, { provider: "deepseek-official", model: "deepseek-flash" })).toBe("high");
    expect(effortForModel(CATALOG, { provider: "opencode-go", model: "deepseek-v4-flash" })).toBe("");
  });
});

describe("currentSelection / selectionRequest", () => {
  it("投影优先（next ?? lastUsed），无投影退回目录默认", () => {
    expect(currentSelection({ lastUsed: { provider: "a", model: "old" }, next: { provider: "b", model: "new" } }, CATALOG)).toEqual({ provider: "b", model: "new" });
    expect(currentSelection(undefined, CATALOG)).toEqual(CATALOG.default);
    expect(currentSelection({ lastUsed: null, next: null }, undefined)).toBeUndefined();
  });

  it("selectionRequest：空档位不下发 reasoningEffort 键（网关对多余键严格拒绝）", () => {
    const value = encodeSelectionValue({ provider: "p", model: "m" });
    expect(selectionRequest("s1", value, "")).toEqual({ sessionId: "s1", provider: "p", model: "m" });
    expect(selectionRequest("s1", value, "high")).toEqual({ sessionId: "s1", provider: "p", model: "m", reasoningEffort: "high" });
  });

  it("selectionRequest 对非法 value 返回 null（不构造半成品请求）", () => {
    expect(selectionRequest("s1", "garbage", "")).toBeNull();
  });
});

describe("effortLabel / effortOptions", () => {
  it("有描述时附描述，无描述只用名称", () => {
    expect(effortLabel({ id: "off", name: "Off", description: "简单任务" })).toBe("Off — 简单任务");
    expect(effortLabel({ id: "low", name: "Low" })).toBe("Low");
    expect(effortLabel({ id: "low", name: "Low", description: "" })).toBe("Low");
  });

  it("首项为空串（= 服务端默认），其余为各档位", () => {
    const options = effortOptions({ efforts: EFFORTS, selected: "high" }, "服务端默认");
    expect(options.map((o) => o.value)).toEqual(["", "off", "low", "high", "max"]);
    expect(options[0].label).toBe("服务端默认");
  });
});

/**
 * 模型下拉的假元素：记录 optgroup/option 的创建结构。
 *
 * 关键：optgroup 的分组标题按**真实浏览器语义**取 `attr.label`——`<optgroup>` 的
 * textContent 不显示标题。TASK-031 G1 真机验收正是因为替身与实现一起误用了 `text`，
 * 才让「三个分组标题全不可见」漏到真机。故此处同时记录 `text` 与 `attr.label` 以便断言。
 */
function fakeGroupedSelect() {
  const options: Array<{ value: string; text: string }> = [];
  const groups: Array<{ label: string; options: string[] }> = [];
  const stats = { emptied: 0, created: 0 };
  const select: GroupedSelectLike = {
    value: "",
    options,
    empty() {
      stats.emptied += 1;
      options.length = 0;
      groups.length = 0;
    },
    createEl(_tag, o) {
      const group = { label: o?.attr?.label ?? "", options: [] as string[] };
      groups.push(group);
      return {
        createEl(_t, opt) {
          stats.created += 1;
          options.push({ value: opt?.value ?? "", text: opt?.text ?? "" });
          group.options.push(opt?.value ?? "");
          return undefined;
        },
      };
    },
  };
  return { select, options, groups, stats };
}

describe("syncModelSelect（分组 + 增量）", () => {
  it("首次同步：按 group 切分 optgroup，并选中当前值", () => {
    const { select, options, groups, stats } = fakeGroupedSelect();
    const rebuilt = syncModelSelect(select, modelOptions(CATALOG), encodeSelectionValue({ provider: "opencode-go", model: "deepseek-v4-flash" }));
    expect(rebuilt).toBe(true);
    expect(stats.emptied).toBe(1);
    expect(groups.map((g) => g.label)).toEqual(["DeepSeek", "opencode-go", "commandcode-pro"]);
    expect(groups[0].options).toHaveLength(2);
    expect(options).toHaveLength(5);
    expect(select.value).toBe("opencode-go\u0000deepseek-v4-flash");
  });

  it("回归（TASK-031 G1）：分组标题写在 optgroup 的 label 属性上，不是 textContent", () => {
    // 真机现象：浏览器只认 <optgroup label>，标题写 textContent 会一个都不显示。
    // 本用例断言"必须走 label 属性"，防止实现或替身任一侧再退回 text。
    const { select, groups } = fakeGroupedSelect();
    syncModelSelect(select, modelOptions(CATALOG), "");
    expect(groups.every((g) => g.label.length > 0)).toBe(true);
    expect(groups.map((g) => g.label)).toEqual(["DeepSeek", "opencode-go", "commandcode-pro"]);
  });

  it("选项集合未变 → 不重建 DOM（empty/createEl 不再被调用），但仍同步选中项", () => {
    const { select, stats } = fakeGroupedSelect();
    const options = modelOptions(CATALOG);
    syncModelSelect(select, options, "a\u0000b");
    const after = { ...stats };
    const rebuilt = syncModelSelect(select, options, "c\u0000d");
    expect(rebuilt).toBe(false);
    expect(stats).toEqual(after);
    expect(select.value).toBe("c\u0000d");
  });

  it("label 变化（同 value 序列）→ 不重建，但文本更新", () => {
    const { select, options, stats } = fakeGroupedSelect();
    const base = modelOptions(CATALOG);
    syncModelSelect(select, base, "");
    const createdBefore = stats.created;
    const renamed = base.map((option, i) => (i === 0 ? { ...option, label: "改名了" } : option));
    const rebuilt = syncModelSelect(select, renamed, "");
    expect(rebuilt).toBe(false);
    expect(stats.created).toBe(createdBefore);
    expect(options[0].text).toBe("改名了");
  });

  it("目录变化（模型数量变）→ 重建", () => {
    const { select, stats } = fakeGroupedSelect();
    syncModelSelect(select, modelOptions(CATALOG), "");
    const rebuilt = syncModelSelect(select, modelOptions({ ...CATALOG, groups: [CATALOG.groups[0]] }), "");
    expect(rebuilt).toBe(true);
    expect(stats.emptied).toBe(2);
  });
});

describe("syncEffortSelect（平铺档位下拉）", () => {
  function fakeFlatSelect() {
    const options: Array<{ value: string; text: string }> = [];
    const stats = { emptied: 0, created: 0 };
    return {
      options,
      stats,
      select: {
        value: "",
        options,
        empty() {
          stats.emptied += 1;
          options.length = 0;
        },
        createEl(_tag: "option", o?: { text?: string; value?: string }) {
          stats.created += 1;
          options.push({ value: o?.value ?? "", text: o?.text ?? "" });
          return undefined;
        },
      },
    };
  }

  it("档位变化 → 重建并选中；无档位 → 清空为 0 项", () => {
    const { select, options, stats } = fakeFlatSelect();
    const opts = effortOptions({ efforts: EFFORTS, selected: "high" }, "服务端默认");
    expect(syncEffortSelect(select, opts, "high")).toBe(true);
    expect(options.map((o) => o.value)).toEqual(["", "off", "low", "high", "max"]);
    expect(select.value).toBe("high");

    const before = { ...stats };
    expect(syncEffortSelect(select, opts, "high")).toBe(false);
    expect(stats).toEqual(before);

    expect(syncEffortSelect(select, [], "")).toBe(true);
    expect(options).toHaveLength(0);
  });
});
