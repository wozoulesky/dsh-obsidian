# 批 3 事件流层真机实测证据

- 时间：2026-09-03T18:26:29.939Z
- 目标：http://127.0.0.1:3080（本机 DSH 0.1.2-rc.1，dsh web）
- 探针：tmp/probe-stream.mjs（只读：list + remote.mux 三流 + 不存在会话 error 帧探测；未 create/prompt/cancel）

## 结论

- [1] POST /api/session/list → HTTP 200；items=92
- [2] WS /api/remote.mux 已连接（握手 Cookie: dsh-auth-VPhEEcLKeqRDBoBalzN2Nm7…）
- [2] session/follow（session-9fcbb1cb-b826-49af-8350-051530cdfb8a）首帧 snapshot：cursor=100022，records=686，hasMore=true
- [2] snapshot.header 字段：["version","id","createdAt","cwd","delegationDepth","agentPreset"]
- [2] snapshot.records 类型：event,chunks；projections 键：["title","goal","tokenUsage","contextPressure","contextBreakdown","sessionStats","turnOutline","agentPreset","subagentTiming","subagent","permissions","modelSelection","sessionListMetadata","imageLimits","todos","plan"]
- [2] 3s 内无自然事件帧（可接受：本探针不发送消息）
- [5] chunks 记录（chunkrow/reasoning-chunks）：seq=40757，time=1788444150259，成员数=4128
- [5] 展开首条：{"type":"assistant/chunk","seq":40757,"time":1788444150259,"data":{"turn":2,"step":1,"chunk":{"type":"reasoning-delta","index":0,"text":"The"}}}
- [5] seq+k / time+Σdt 前缀和校验：PASS（dt 含负数=false）
- [5] 展开 chunk 类型：reasoning-delta
- [2b] 不存在会话 follow → error 帧 {"code":"session/not-found","message":"session \"definitely-not-a-session\" not found","details":{"sessionId":"definitely-not-a-session"}}
- [3] session/control 首帧：type=baseline
- [3] baseline.queues 会话数=5；jobs=5；projections=5
- [3] 队列项样本（首个会话队列）：[]
- [4] $events ready 帧：clientId=af5cd5cf-bf85-4f17-b13d-f60bf688e90a；host.home=C:\Users\10352
- [4] 3s 内无 waterfall/emit 帧（本探针不触发审批/提问/会话活动，可接受）
- [6] 物理连接已关闭（cancel 帧随流终止发送，见上方逐流 cancel）

## 备注

- remote.mux 帧协议：open/cancel（客户端）；item/end/error（服务端）。
- $events 的 open payload 必须为 {args:{}}（网关精确校验空 args）。
- follow snapshot 是批 4 首屏播种入口；cursor 用于翻页（throughSeq）。