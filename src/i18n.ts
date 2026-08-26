export type I18nParams = Record<string, string | number>;

/** 默认 UI 文案（中文）。用户可通过插件目录下的 i18n.json 覆盖，交给本地 DSH 翻译。 */
export const DEFAULT_STRINGS: Record<string, string> = {
  // 通用
  "common.cancel": "放弃",
  "common.apply": "应用替换",

  // 状态栏 / 主命令
  "main.statusConnected": "DSH 已连接",
  "main.statusReconnecting": "DSH 重连中…",
  "main.openPanel": "打开 DSH 面板",
  "main.newSession": "新建 DSH 会话",
  "main.inlineEdit": "DSH 内联编辑选区",
  "main.newSessionFailed": "新建会话失败：{message}",
  "main.openPanelFailed": "无法打开 DSH 面板：右侧栏不可用",

  // 聊天视图
  "chat.noSessionOption": "（无会话）",
  "chat.new": "新建",
  "chat.stop": "停止",
  "chat.older": "加载更早",
  "chat.loadingOlder": "加载中…",
  "chat.listLoadFailed": "会话列表拉取失败：{message}",
  "chat.openFailed": "打开会话失败：{message}",
  "chat.pleaseCreateSession": "请先创建会话",
  "chat.sendFailed": "发送失败：{message}",
  "chat.newSessionFailed": "新建会话失败：{message}",
  "chat.stopFailed": "停止失败：{message}",
  "chat.loadFailed": "加载失败：{message}",
  "chat.planPending": "计划模式切换中…",
  "chat.planActive": "计划模式已开启",
  "chat.noSession": "尚无会话，点击「新建」开始。",
  "chat.sessionFallback": "会话 {id}",
  "chat.running": "⏳ DSH 正在工作…",
  "chat.clearDone": "已清空当前会话：新建了干净会话（历史保留在 DSH 会话列表），内联编辑专用会话也已重置",
  "chat.clearFailed": "清空会话失败：{message}",
  "chat.noText": "（无文本）",
  "chat.turnError": "回合错误：{message}",
  "chat.commandLine": "{status} 命令 {name}",
  "chat.commandLineWithText": "{status} 命令 {name}：{text}",
  "chat.toolRunning": "（执行中）",
  "chat.toolError": "（失败）",

  // 审批弹窗
  "approval.title": "DSH 请求执行：{toolName}",
  "approval.noReason": "（未说明理由）",
  "approval.reject": "拒绝",
  "approval.allowOnce": "允许一次",
  "approval.alreadyHandled": "该审批已在别处处理",
  "approval.notAccepted": "应答未被接受，请重试",
  "approval.failed": "审批应答失败，请重试：{message}",

  // 提问弹窗
  "question.title": "DSH 想问你几个问题",
  "question.freeAnswer": "自由回答",
  "question.submit": "提交",
  "question.alreadyHandled": "该提问已在别处处理",
  "question.notAccepted": "应答未被接受，请重试",
  "question.failed": "提问应答失败，请重试：{message}",

  // 输入框
  "input.placeholder": "给 DSH 发任务…（/ 命令，@ 提及文件，Shift+Tab 计划模式）",

  // 内联编辑
  "inline.promptNoSelection": "请先在编辑器中选择要修改的文本。",
  "inline.title": "DSH 内联编辑",
  "inline.selectedChars": "已选择 {count} 个字符，输入修改指令：",
  "inline.placeholder": "例如：改写得更简洁",
  "inline.start": "开始",
  "inline.generating": "DSH 正在生成修改…",
  "inline.defaultInstruction": "优化这段文本",
  "inline.sameContent": "DSH 返回的内容与原文一致，未发生修改",
  "inline.editFailed": "内联编辑失败：{message}",
  "inline.selectionChanged": "编辑器选区已变化，未应用替换",
  "inline.busy": "已有内联编辑正在进行，请稍候",
  "inline.turnNoText": "回合已结束，但未产生可用的替换文本",
  "inline.noResult": "DSH 没有产生可用的替换文本",
  "inline.timeout": "内联编辑超时（{seconds}s），已放弃",
  "inline.doneTitle": "内联编辑完成",
  "inline.largeDiffConfirm": "内容较大，已跳过词级预览。确认替换所选内容？",

  // diff 预览
  "diff.title": "内联编辑预览",

  // 设置
  "settings.dshUrlName": "DSH 地址",
  "settings.dshUrlDesc": "本地 DSH 服务地址（默认 http://127.0.0.1:3080）",
  "settings.mentionMaxCharsName": "@提及文件内容上限（字符）",
  "settings.mentionMaxCharsDesc": "提及文件时注入内容的最大长度，超长截断",
  "settings.inlineEditTimeoutName": "内联编辑超时（秒）",
  "settings.historyPageSizeName": "历史页大小",
  "settings.historyPageSizeDesc": "每次拉取会话历史的条数",
  "settings.resetSessionName": "重置内联编辑专用会话",
  "settings.resetSessionDesc": "下次内联编辑将创建全新会话",
  "settings.resetButton": "重置",
  "settings.resetDone": "已重置：下次内联编辑将创建全新会话",
  "settings.resetFailed": "重置失败：{message}",
  "settings.exportI18nName": "导出 i18n 翻译模板",
  "settings.exportI18nDesc": "在 vault 根目录生成 dsh-bridge.i18n.json（Obsidian 可见可编辑），翻译后重载插件生效；优先于插件目录 i18n.json",
  "settings.exportI18nButton": "导出",
  "settings.exportI18nDone": "已导出 dsh-bridge.i18n.json 到 vault 根目录，翻译后重载插件生效",
  "settings.exportI18nFailed": "导出失败：{message}",

  // 内置命令联想
  "command.clear.desc": "清空当前会话并新建干净会话（/clear）",
  "command.plan.desc": "进入计划模式（/plan off 退出）",
  "command.compact.desc": "压缩会话历史",
  "command.feedback.desc": "给最近的回复打分反馈",
  "command.goal.desc": "管理长期目标（/goal create <目标>）",
};

export class I18n {
  constructor(private overrides: Record<string, string> = {}) {}

  /** 取文案：外部覆盖优先，其次默认，最后返回 key 本身。支持 {param} 占位符。 */
  t(key: string, params?: I18nParams): string {
    let text = this.overrides[key] ?? DEFAULT_STRINGS[key] ?? key;
    if (params) {
      text = text.replace(/\{(\w+)\}/g, (m, name: string) =>
        params[name] !== undefined ? String(params[name]) : m
      );
    }
    return text;
  }
}

/**
 * 按候选路径顺序读取外部 i18n 文件（vault 根优先、插件目录兼容），
 * 第一个读取成功且解析为 JSON 对象的使用；读取失败/非法 JSON/非对象 → 尝试下一个；全部失败 → 内置默认（不抛错）。
 */
export async function loadI18n(
  candidatePaths: string[],
  read: (path: string) => Promise<string>
): Promise<I18n> {
  for (const path of candidatePaths) {
    try {
      const raw = await read(path);
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
      const overrides: Record<string, string> = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string") overrides[key] = value;
      }
      return new I18n(overrides);
    } catch {
      continue; // 文件缺失/读取失败/解析失败：尝试下一个候选
    }
  }
  return new I18n();
}
