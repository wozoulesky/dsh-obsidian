/**
 * i18n：内置中英双语（DEFAULT_STRINGS = 中文基准，EN_STRINGS = 英文），
 * 由 main.ts 读 Obsidian 的 `getLanguage()` 后经 `resolveLanguage()` 归一化，
 * 再传给 `loadI18n(paths, read, lang)` / `new I18n(overrides, lang)`。
 *
 * 语言解析规则：`zh*`（zh / zh-cn / zh-tw / zh-hans / zh-hant …）→ 中文；
 * 其它任何语言码（en / ja / de …）→ 英文；拿不到或异常 → 回落中文（保持旧行为不倒退）。
 *
 * 外部覆盖：vault 根 `dsh-bridge.i18n.json` / 插件目录 `i18n.json` 仍优先于内置表，
 * 供用户做第三种语言或局部措辞调整；`i18n.template.json` 只是中文键值基准（供导出翻译模板用），
 * 内置双语后它仅用于新增第三语言，不再影响内置中英文。
 */
export type I18nParams = Record<string, string | number>;

/** 内置语言：中文（zh，历史默认）与英文（en，跟随 Obsidian 语言设置）。 */
export type Language = "zh" | "en";

/** 默认 UI 文案（中文基准）。用户可通过插件目录下的 i18n.json 覆盖，交给本地 DSH 翻译。 */
export const DEFAULT_STRINGS: Record<string, string> = {
  // 通用
  "common.cancel": "放弃",
  "common.apply": "应用替换",

  // 状态栏 / 主命令
  "main.statusConnected": "DSH 已连接",
  "main.statusReconnecting": "DSH 重连中…",
  "main.statusNotRunning": "DSH 未运行（连接被拒绝）· 重连中…",
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
  // 回合异常收尾提示（turn/end reason 非 completed）：必须让用户知道「这条消息没有被处理」。
  // blocked 是最要紧的一条：服务端在开始处理前就拒绝，消息被丢弃，但 prompt 仍返回 accepted。
  "chat.turnBlocked": "这条消息没有被执行：DSH 在开始处理前拒绝了本回合（常见原因：该会话已归档或已不可写）。请新建会话后重试。",
  "chat.turnAborted": "本回合已被中止，上面的消息没有执行完。",
  "chat.turnInterrupted": "本回合被中断，上面的消息没有执行完。",
  "chat.turnMaxTokens": "本回合因达到输出上限而提前停止，回答可能不完整。",
  "chat.turnEndedUnexpectedly": "本回合意外结束（{reason}），上面的消息可能没有执行完。",
  "chat.commandLine": "{status} 命令 {name}",
  "chat.commandLineWithText": "{status} 命令 {name}：{text}",
  "chat.toolRunning": "（执行中）",
  "chat.toolError": "（失败）",
  "chat.reasoning": "思考过程",
  "chat.reasoningRunning": "（生成中）",
  "chat.contextUsage": "上下文 {used} / {window}",
  "chat.contextUsageNoWindow": "上下文 {used}",
  "chat.usageOutput": "输出 {tokens}",
  "chat.todos": "待办",
  "chat.todosDone": "{count} 已完成",
  "chat.todosActive": "{count} 进行中",
  "chat.todosPending": "{count} 待处理",
  "chat.imageCount": "🖼 图片 ×{count}",

  // 命令真执行（TASK-030）
  "chat.commandDone": "命令 {name} 已执行",
  "chat.commandDoneWithText": "命令 {name} 已执行：{text}",
  "chat.commandFailed": "命令 {name} 执行失败：{text}",
  "chat.commandSendFailed": "命令执行失败：{message}",

  // 模型 / 推理档位（TASK-030）
  "chat.effortDefault": "服务端默认",
  "chat.modelSwitchFailed": "切换模型失败：{message}",
  "chat.goalPlaceholder": "目标（例如：完成 X 并给出验证证据）",
  "chat.goalCreate": "创建目标",
  "chat.goalSave": "保存",
  "chat.goalPause": "暂停",
  "chat.goalResume": "继续",
  "chat.goalComplete": "完成",
  "chat.goalEdit": "编辑",
  "chat.goalClear": "清除",
  "chat.goalRounds": "第 {rounds} / {max} 轮",
  "chat.goalPhasePaused": "已暂停",
  "chat.goalPhaseBlocked": "受阻",
  "chat.goalPhaseComplete": "已完成",
  "chat.goalFailed": "目标操作失败：{message}",
  "chat.interruptedTurnDropped": "上一回合因 DSH 中断未保存（内容未落库，无法续传）",

  // 审批弹窗
  "approval.title": "DSH 请求执行：{toolName}",
  "approval.noReason": "（未说明理由）",
  "approval.reject": "拒绝",
  "approval.allowOnce": "允许一次",
  "approval.notAccepted": "应答未被接受，请重试",
  "approval.failed": "审批应答失败，请重试：{message}",

  // 提问弹窗
  "question.title": "DSH 想问你几个问题",
  "question.freeAnswer": "自由回答",
  "question.submit": "提交",
  "question.notAccepted": "应答未被接受，请重试",
  "question.failed": "提问应答失败，请重试：{message}",

  // 输入框
  "input.placeholder": "给 DSH 发任务…（/ 命令，@ 提及文件，Shift+Tab 计划模式）",
  "input.attachImage": "📎 添加图片",
  "input.imagePlaceholder": "选择要发送给 DSH 的图片…",
  "input.imageReadFailed": "图片读取失败（文件可能已被移动或删除）",
  "input.imageUnsupportedType": "不支持的图片格式，仅支持：{types}",
  "input.imageTooMany": "一次最多发送 {count} 张图片",
  "input.imageTooLarge": "图片过大（单张上限 {size}）",
  "input.imageTotalTooLarge": "图片总量过大（单条消息上限 {size}），请分次发送",

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
  "settings.dshUrlDesc": "本地 DSH 服务地址。一般不用手填——插件会自动探测可用地址（桌面版每次启动会分配随机端口；dsh web 命令默认 http://127.0.0.1:3080）；高级用户可在此手动指定。兼容 DSH 0.1.2 线、0.1.5 线与 0.2 线（已在 0.2.0-rc.2 验证）；0.1.2 之前的版本会报 401/404，详见 README 的 DSH 版本兼容性矩阵",
  "settings.dshUrlAutoSwitched": "DSH 地址已自动切换：检测到 DSH 在 {url}（设置里的 {previous} 连不上）",
  "settings.dshUrlDetected": "检测到 DSH 在 {url}，已保存到设置——重启 Obsidian 或重新启用插件后生效",
  "settings.mentionMaxCharsName": "@提及文件内容上限（字符）",
  "settings.mentionMaxCharsDesc": "提及文件时注入内容的最大长度，超长截断",
  "settings.inlineEditTimeoutName": "内联编辑超时（秒）",
  "settings.historyPageSizeName": "历史页大小",
  "settings.historyPageSizeDesc": "每次拉取会话历史的条数",
  "settings.credentialsPathName": "DSH 凭据文件路径（留空自动）",
  "settings.credentialsPathDesc": "默认自动查找 $DSH_HOME/.credentials.yaml，取不到则用 ~/.dsh/.credentials.yaml。若 DSH 用了自定义 home 且连不上，在此填完整路径",
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

  // 连接诊断（把 401/404/ECONNREFUSED 这类原始错误码翻译成可执行结论；见 src/core/diagnose.ts）
  "settings.diagnoseName": "诊断连接",
  "settings.diagnoseDesc": "检查本机 DSH 是否在运行、认证是否可用、版本是否兼容（走一次真实的会话列表调用，结果以通知显示）",
  "settings.diagnoseButton": "诊断",
  "settings.diagnoseOk": "连接正常：DSH 可访问、认证通过、会话列表可读",
  "settings.diagnoseFailed": "连接异常：{hint}（技术细节：{detail}）",
  "settings.diagnoseUnknown": "连接异常，未能归类：{detail}（可把这条错误发给开发者）",
  "diag.notRunning": "本机 DSH 似乎没有在运行（连接被拒绝）——确认 DSH 已启动；若刚启动请稍候，或点「诊断」重新探测",
  "diag.unreachable": "DSH 地址解析不了——确认 DSH 已启动；若刚启动请稍候，或点「诊断」重新探测（地址一般不用手填，插件会自动探测）",
  "diag.notResponding": "DSH 无响应（请求超时）——确认 DSH 进程是否卡住，或端口是否被别的程序占用",
  "diag.versionMismatch": "本机 DSH 版本过旧（接口返回 404）——本插件支持 DSH 0.1.2 线、0.1.5 线与 0.2 线，请升级 DSH（见 README 的 DSH 版本兼容性矩阵）",
  "diag.authFailed": "认证失败（401）——可能是 DSH 版本与插件不匹配，或凭据文件读不到；可在下方指定「DSH 凭据文件路径」，并参见 README 的兼容性矩阵",

  // 内置命令联想（离线兜底清单；在线时描述用服务端返回的）
  "command.clear.desc": "清空当前会话并新建干净会话（/clear）",
  "command.plan.desc": "进入计划模式（/plan off 退出）",
  "command.compact.desc": "压缩会话历史",
  "command.export.desc": "把会话日志导出为 ZIP 下载",
  "command.feedback.desc": "给最近的回复打分反馈",
  "command.goal.desc": "管理长期目标（/goal create <目标>）",
  "command.permission.desc": "切换权限预设（沙箱模式 + 审批策略）",
};

/**
 * 内置英文文案表。键集必须与 DEFAULT_STRINGS 完全一致（tests/i18n.test.ts 有强制校验），
 * 且每条都要保留中文条目的全部 {param} 占位符，否则运行时会把占位符原样显示出来。
 * 术语跟随 Obsidian 社区习惯：vault / note / panel / inline edit / notice。
 */
export const EN_STRINGS: Record<string, string> = {
  // General
  "common.cancel": "Discard",
  "common.apply": "Apply replacement",

  // Status bar / main commands
  "main.statusConnected": "DSH connected",
  "main.statusReconnecting": "DSH reconnecting…",
  "main.statusNotRunning": "DSH not running (connection refused) · reconnecting…",
  "main.openPanel": "Open DSH panel",
  "main.newSession": "New DSH session",
  "main.inlineEdit": "DSH inline edit selection",
  "main.newSessionFailed": "Failed to create session: {message}",
  "main.openPanelFailed": "Couldn't open the DSH panel: right sidebar is unavailable",

  // Chat view
  "chat.noSessionOption": "(no session)",
  "chat.new": "New",
  "chat.stop": "Stop",
  "chat.older": "Load earlier",
  "chat.loadingOlder": "Loading…",
  "chat.listLoadFailed": "Failed to fetch the session list: {message}",
  "chat.openFailed": "Failed to open session: {message}",
  "chat.pleaseCreateSession": "Create a session first",
  "chat.sendFailed": "Send failed: {message}",
  "chat.newSessionFailed": "Failed to create session: {message}",
  "chat.stopFailed": "Failed to stop: {message}",
  "chat.loadFailed": "Failed to load: {message}",
  "chat.planPending": "Switching plan mode…",
  "chat.planActive": "Plan mode is on",
  "chat.noSession": "No sessions yet. Click \"New\" to start.",
  "chat.sessionFallback": "Session {id}",
  "chat.running": "⏳ DSH is working…",
  "chat.clearDone": "Current session cleared: a fresh session was created (history stays in the DSH session list), and the inline-edit session was reset too",
  "chat.clearFailed": "Failed to clear the session: {message}",
  "chat.noText": "(no text)",
  "chat.turnError": "Turn error: {message}",
  "chat.turnBlocked": "This message wasn't executed: DSH rejected the turn before it could start (usually because the session is archived or no longer writable). Create a new session and try again.",
  "chat.turnAborted": "This turn was aborted, so the message above wasn't fully executed.",
  "chat.turnInterrupted": "This turn was interrupted, so the message above wasn't fully executed.",
  "chat.turnMaxTokens": "This turn stopped early because it hit the output limit, so the answer may be incomplete.",
  "chat.turnEndedUnexpectedly": "This turn ended unexpectedly ({reason}), so the message above may not have been fully executed.",
  "chat.commandLine": "{status} Command {name}",
  "chat.commandLineWithText": "{status} Command {name}: {text}",
  "chat.toolRunning": "(running)",
  "chat.toolError": "(failed)",
  "chat.reasoning": "Reasoning",
  "chat.reasoningRunning": "(generating)",
  "chat.contextUsage": "Context {used} / {window}",
  "chat.contextUsageNoWindow": "Context {used}",
  "chat.usageOutput": "Output {tokens}",
  "chat.todos": "To-dos",
  "chat.todosDone": "{count} done",
  "chat.todosActive": "{count} in progress",
  "chat.todosPending": "{count} pending",
  "chat.imageCount": "🖼 Images ×{count}",

  // Command execution (TASK-030)
  "chat.commandDone": "Command {name} executed",
  "chat.commandDoneWithText": "Command {name} executed: {text}",
  "chat.commandFailed": "Command {name} failed: {text}",
  "chat.commandSendFailed": "Command execution failed: {message}",

  // Model / reasoning effort (TASK-030)
  "chat.effortDefault": "Server default",
  "chat.modelSwitchFailed": "Failed to switch model: {message}",
  "chat.goalPlaceholder": "Goal (e.g. finish X and provide verification evidence)",
  "chat.goalCreate": "Create goal",
  "chat.goalSave": "Save",
  "chat.goalPause": "Pause",
  "chat.goalResume": "Resume",
  "chat.goalComplete": "Complete",
  "chat.goalEdit": "Edit",
  "chat.goalClear": "Clear",
  "chat.goalRounds": "Round {rounds} / {max}",
  "chat.goalPhasePaused": "Paused",
  "chat.goalPhaseBlocked": "Blocked",
  "chat.goalPhaseComplete": "Completed",
  "chat.goalFailed": "Goal action failed: {message}",
  "chat.interruptedTurnDropped": "The previous turn wasn't saved because DSH was interrupted (the content never reached storage, so it can't be resumed)",

  // Approval dialog
  "approval.title": "DSH wants to run: {toolName}",
  "approval.noReason": "(no reason given)",
  "approval.reject": "Reject",
  "approval.allowOnce": "Allow once",
  "approval.notAccepted": "Response wasn't accepted, please try again",
  "approval.failed": "Approval response failed, please try again: {message}",

  // Question dialog
  "question.title": "DSH has a few questions for you",
  "question.freeAnswer": "Free-form answer",
  "question.submit": "Submit",
  "question.notAccepted": "Response wasn't accepted, please try again",
  "question.failed": "Question response failed, please try again: {message}",

  // Input box
  "input.placeholder": "Give DSH a task… (/ for commands, @ to mention files, Shift+Tab for plan mode)",
  "input.attachImage": "📎 Add image",
  "input.imagePlaceholder": "Choose images to send to DSH…",
  "input.imageReadFailed": "Failed to read the image (the file may have been moved or deleted)",
  "input.imageUnsupportedType": "Unsupported image type, supported: {types}",
  "input.imageTooMany": "You can send at most {count} images at a time",
  "input.imageTooLarge": "Image too large (limit {size} per image)",
  "input.imageTotalTooLarge": "Images too large in total (limit {size} per message), please send them in batches",

  // Inline edit
  "inline.promptNoSelection": "Select the text you want to change in the editor first.",
  "inline.title": "DSH inline edit",
  "inline.selectedChars": "{count} characters selected. Enter your edit instruction:",
  "inline.placeholder": "e.g. rewrite more concisely",
  "inline.start": "Start",
  "inline.generating": "DSH is generating the edit…",
  "inline.defaultInstruction": "Improve this text",
  "inline.sameContent": "DSH returned the same content as the original, so nothing changed",
  "inline.editFailed": "Inline edit failed: {message}",
  "inline.selectionChanged": "The editor selection changed, so the replacement wasn't applied",
  "inline.busy": "Another inline edit is already running, please wait",
  "inline.turnNoText": "The turn ended without producing usable replacement text",
  "inline.noResult": "DSH didn't produce usable replacement text",
  "inline.timeout": "Inline edit timed out after {seconds}s and was abandoned",
  "inline.doneTitle": "Inline edit finished",
  "inline.largeDiffConfirm": "The content is large, so the word-level preview was skipped. Replace the selected content?",

  // Diff preview
  "diff.title": "Inline edit preview",

  // Settings
  "settings.dshUrlName": "DSH URL",
  "settings.dshUrlDesc": "Local DSH service URL. You usually don't need to fill this in — the plugin auto-detects the address (the desktop app is assigned a random port on each launch; the dsh web command defaults to http://127.0.0.1:3080). Advanced users can specify it manually. Supports DSH 0.1.2, 0.1.5 and 0.2 lines (verified on 0.2.0-rc.2); versions before 0.1.2 return 401/404 — see the DSH version compatibility matrix in the README",
  "settings.dshUrlAutoSwitched": "DSH URL switched automatically: DSH found at {url} (the configured {previous} is unreachable)",
  "settings.dshUrlDetected": "DSH detected at {url} and saved to settings — restart Obsidian or reload the plugin for it to take effect",
  "settings.mentionMaxCharsName": "Mentioned file content limit (characters)",
  "settings.mentionMaxCharsDesc": "Maximum length of file content injected when mentioning a file; longer content is truncated",
  "settings.inlineEditTimeoutName": "Inline edit timeout (seconds)",
  "settings.historyPageSizeName": "History page size",
  "settings.historyPageSizeDesc": "Number of session history entries fetched per page",
  "settings.credentialsPathName": "DSH credentials file path (blank = auto)",
  "settings.credentialsPathDesc": "By default the plugin looks for $DSH_HOME/.credentials.yaml, then ~/.dsh/.credentials.yaml. If DSH uses a custom home and can't connect, enter the full path here",
  "settings.resetSessionName": "Reset the inline-edit session",
  "settings.resetSessionDesc": "The next inline edit will create a brand-new session",
  "settings.resetButton": "Reset",
  "settings.resetDone": "Reset: the next inline edit will create a brand-new session",
  "settings.resetFailed": "Reset failed: {message}",
  "settings.exportI18nName": "Export i18n translation template",
  "settings.exportI18nDesc": "Writes dsh-bridge.i18n.json to the vault root (visible and editable in Obsidian). Changes take effect after reloading the plugin; it takes precedence over i18n.json in the plugin folder",
  "settings.exportI18nButton": "Export",
  "settings.exportI18nDone": "Exported dsh-bridge.i18n.json to the vault root. Changes take effect after reloading the plugin",
  "settings.exportI18nFailed": "Export failed: {message}",

  // Connection diagnostics (translates raw errors like 401/404/ECONNREFUSED into actionable conclusions; see src/core/diagnose.ts)
  "settings.diagnoseName": "Diagnose connection",
  "settings.diagnoseDesc": "Checks whether local DSH is running, whether authentication works, and whether the version is compatible (makes one real session-list request; the result appears as a notice)",
  "settings.diagnoseButton": "Diagnose",
  "settings.diagnoseOk": "Connection OK: DSH reachable, authentication passed, session list readable",
  "settings.diagnoseFailed": "Connection problem: {hint} (technical detail: {detail})",
  "settings.diagnoseUnknown": "Connection problem, couldn't classify it: {detail} (you can send this error to the developer)",
  "diag.notRunning": "DSH doesn't seem to be running on this machine (connection refused) — confirm DSH is started; if it just started, wait a moment or click Diagnose to probe again",
  "diag.unreachable": "The DSH URL can't be resolved — confirm DSH is started; if it just started, wait a moment or click Diagnose to probe again (you usually don't need to set the URL by hand; the plugin auto-detects it)",
  "diag.notResponding": "DSH isn't responding (request timed out) — check whether the DSH process is stuck or the port is taken by another program",
  "diag.versionMismatch": "Local DSH is too old (the API returned 404) — this plugin supports DSH 0.1.2, 0.1.5 and 0.2 lines; please upgrade DSH (see the DSH version compatibility matrix in the README)",
  "diag.authFailed": "Authentication failed (401) — likely a DSH/plugin version mismatch, or the credentials file can't be read; set the \"DSH credentials file path\" below and see the compatibility matrix in the README",

  // Built-in command suggestions (offline fallback list; descriptions come from the server when online)
  "command.clear.desc": "Clear the current session and start a fresh one (/clear)",
  "command.plan.desc": "Enter plan mode (/plan off to exit)",
  "command.compact.desc": "Compact the session history",
  "command.export.desc": "Export the session log as a ZIP download",
  "command.feedback.desc": "Rate feedback on the most recent reply",
  "command.goal.desc": "Manage long-term goals (/goal create <goal>)",
  "command.permission.desc": "Switch permission preset (sandbox mode + approval policy)",
};

function builtinTable(lang: Language): Record<string, string> {
  return lang === "en" ? EN_STRINGS : DEFAULT_STRINGS;
}

/**
 * 把 Obsidian 的 `getLanguage()` 原始返回值归一化为内置语言。
 * zh / zh-CN / zh-TW / zh_Hans / zh-hant … → "zh"；其它任何语言码 → "en"；
 * undefined / null / 空串 / 空白 / 非字符串（拿不到或异常）→ "zh"（保持旧默认，不倒退）。
 */
export function resolveLanguage(raw?: string | null): Language {
  if (typeof raw !== "string") return "zh";
  const normalized = raw.trim().toLowerCase().replace(/_/g, "-");
  if (normalized === "") return "zh";
  return normalized.startsWith("zh") ? "zh" : "en";
}

/**
 * 安全调用语言读取器：`resolveObsidianLanguage(() => getLanguage())`。
 * 读取器缺失或抛错（例如测试环境 mock 里没有 getLanguage）→ 回落中文，绝不让插件加载失败。
 */
export function resolveObsidianLanguage(read?: (() => string | undefined) | null): Language {
  if (typeof read !== "function") return "zh";
  try {
    return resolveLanguage(read());
  } catch {
    return "zh";
  }
}

export class I18n {
  /** 归一化后的当前语言；main.ts 可据此把设置界面也切到同一语言。 */
  readonly lang: Language;

  constructor(
    private overrides: Record<string, string> = {},
    lang: string = "zh"
  ) {
    this.lang = resolveLanguage(lang);
  }

  /**
   * 取文案：外部覆盖优先，其次当前语言内置表，再次另一语言内置表（防漏翻时留下裸 key），
   * 最后返回 key 本身。支持 {param} 占位符。
   */
  t(key: string, params?: I18nParams): string {
    const primary = builtinTable(this.lang);
    const secondary = builtinTable(this.lang === "en" ? "zh" : "en");
    let text = this.overrides[key] ?? primary[key] ?? secondary[key] ?? key;
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
 * lang 决定内置表的语言（默认 "zh"，向后兼容）；外部覆盖在两种语言下都优先。
 */
export async function loadI18n(
  candidatePaths: string[],
  read: (path: string) => Promise<string>,
  lang: string = "zh"
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
      return new I18n(overrides, lang);
    } catch {
      continue; // 文件缺失/读取失败/解析失败：尝试下一个候选
    }
  }
  return new I18n({}, lang);
}
