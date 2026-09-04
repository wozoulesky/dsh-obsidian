# probe-reconnect 断线重连实测

2026-09-04T00:08:46.843Z

- [probe-reconnect] 会话 session-9fcbb1cb-b826-49af-8350-051530cdfb8a（updatedAt=1788446418797，running=true）
- [probe-reconnect] 第一次 follow：cursor=180399 records=679 hasMore=true lastSeq=180399
- [probe-reconnect] 第二次 follow：cursor=180399 records=679 hasMore=true lastSeq=180399
- [probe-reconnect] cursor 单调不减：PASS（180399 → 180399）
- [probe-reconnect] 尾 seq 稳定/前进：PASS（180399 → 180399）
- [probe-reconnect] 全量重建语义：applyFollowSnapshot 覆盖旧视图，无重复/丢失风险（窗口=records 尾部页）
- [probe-reconnect] PASS：断线重连（resync 重建）机制真机验证通过
