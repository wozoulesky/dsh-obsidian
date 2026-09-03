# 批 1 认证层真机实测证据

- 时间：2026-09-03T16:01:11.324Z
- 目标：http://127.0.0.1:3080（本机 DSH 0.1.2-rc.1，dsh web）
- 凭据：C:\Users\10352\.dsh\.credentials.yaml（secret 未落盘）

## 结论

- HTTP：POST /api/session/list → **200**，body 含 "items" = **true**（88 个会话）
- WS：/api/remote.mux 握手 → **open（101）**
- 首帧：```json
{"type":"item","streamId":"23724b56-c965-4611-9d9b-2244f4c94bc9","value":{"type":"baseline","value":{"queues":{"session-40f203d6-6597-447b-a2f7-4c466571b89f":[],"session-d4d043ca-e495-4500-9998-63fb5a6619c6":[],"session-84c9dfa3-9cee-4d04-8156-3a5ceab0f575":[],"session-9fcbb1cb-b826-49af-8350-051530cdfb8a":[],"cf7f92f2-11a3-41f5-a2ef-cbaf12881304":[]},"jobs":{"session-40f203d6-6597-447b-a2f7-4c466571b89f":[],"session-d4d043ca-e495-4500-9998-63fb5a6619c6":[],"session-84c9dfa3-9cee-4d04-8156-3a5ce
```

## 请求细节

- cookie 名：dsh-auth-b64url(sha256(authority))，authority=127.0.0.1:3080
- 信封：{"type":"client-request","rpcId":"<uuid>","method":"session/list","payload":{"args":{"_request":{}}}}
- WS open 帧：{"type":"open","streamId":"<uuid>","endpoint":"session/control","payload":{"args":{}}}
