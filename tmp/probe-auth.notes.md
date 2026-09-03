# 批 1 认证层真机实测证据

- 时间：2026-09-03T15:32:09.468Z
- 目标：http://127.0.0.1:3080（本机 DSH 0.1.2-rc.1，dsh web）
- 凭据：C:\Users\10352\.dsh\.credentials.yaml（secret 未落盘）

## 结论

- HTTP：POST /api/session/list → **200**，body 含 "items" = **true**（86 个会话）
- WS：/api/remote.mux 握手 → **open（101）**
- 首帧：```json
{"type":"item","streamId":"d65d6cf9-8f34-4b53-bf00-2d9a5ecdf6a8","value":{"type":"baseline","value":{"queues":{"session-40f203d6-6597-447b-a2f7-4c466571b89f":[],"session-d4d043ca-e495-4500-9998-63fb5a6619c6":[],"session-84c9dfa3-9cee-4d04-8156-3a5ceab0f575":[],"session-9fcbb1cb-b826-49af-8350-051530cdfb8a":[],"6f150614-d197-47f0-811e-a92dd2b2f98c":[]},"jobs":{"session-40f203d6-6597-447b-a2f7-4c466571b89f":[],"session-d4d043ca-e495-4500-9998-63fb5a6619c6":[],"session-84c9dfa3-9cee-4d04-8156-3a5ce
```

## 请求细节

- cookie 名：dsh-auth-b64url(sha256(authority))，authority=127.0.0.1:3080
- 信封：{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{"args":{"_request":{}}}}
- WS open 帧：{"type":"open","streamId":"<uuid>","endpoint":"session/control","payload":{"args":{}}}
