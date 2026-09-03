# 批 2 RPC 层真机实测证据

- 时间：2026-09-03T16:26:25.697Z
- 目标：http://127.0.0.1:3080（本机 DSH 0.1.2-rc.1，dsh web）

## 结论

- session/list：HTTP 200，items=89
- session/follow（WS remote.mux）：snapshot（cursor=93101，records=681，hasMore=true）
- session/page（真实 cursor）：HTTP 200；session-9fcbb1cb-b826-49af-8350-051530cdfb8a throughSeq=93101 → 681 条记录（hasMore=true）
- chunkrow 线上样本：```json
{"type":"chunks","event":{"type":"chunkrow/reasoning-chunks","seq":29076,"time":1788443795756,"data":{"turn":1,"step":50,"index":0,"dt":[0,0,0,0,0,0,1,0,23,392,0,0,1,0,0,0,0,209,0,1,0,45,0,0,0,0,0,0,1,352,0,1,0,75,0,0,0,1,0,0,0,0,0,0,0,294,0,0,0,0,513,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,387,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,5,0,437,0,0,0,0,28,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,35,11,0,48,389,0,0,0,0,167,0,0,0,0,0,1,0,0,210,1,0,0,0,0,0,0,0,130,1,26,0,0,0,0,0,1,0,0,0,191,0,0,0,0,1,0,0,0,0,175,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,294,0,0,0],"texts":["queue","Items"," ","在"," UI"," ","中","未被","消费","（","chat","View"," ","没用","它","），","所以"," queue"," ","流","是","可选","功能","。","plan"," ","横幅","消费","的是"," store",".apply","Project","ion","(\"","plan","\")","。\n\n","再看","几个","关键","点","确认","：\n","1","."," session",".p","rompt"," ","新","契约","：","Session","Prompt","Request"," ","包含"," request","Id","（","brand","ed"," Session","Request","Id","）。","T","ASK","-"
```

## 备注

- 本探针只做只读调用（list/page），不 create/prompt/cancel，避免真机启动 agent。
- 信封：{"type":"client-request","rpcId":"<uuid>","method":"<ns>/<method>","payload":{"args":{...}}}