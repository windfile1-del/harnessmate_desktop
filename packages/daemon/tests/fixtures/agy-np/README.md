# NP-01 Observatory Replay Fixtures (`packages/daemon/tests/fixtures/agy-np/`)

本目录保存 NP-01 专用离线确定性回放夹具（与既有 `packages/daemon/tests/fixtures/agy-1.5.14/` 完全隔离，原 1.5.14 夹具保持原状不动）。

每个夹具首行为 `scenario_meta`，显式声明 `source`（provenance）、`provenanceOrigin` 与 `verdictCriteria`（包含每个失败夹具的明确判定条件）。

| 文件 | 场景 | 来源 | 失败/验收判定条件 |
| --- | --- | --- | --- |
| `t01-single-turn.ndjson` | T01 单次正常 turn | `synthetic` | 四层齐全、命令与模型配置握手、`end_turn` 对齐、零泄露 |
| `t02-reactive-20s-wake.ndjson` | T02 20s 有限后台 + wake + 只读工具 | `synthetic` | 后台启动→早回 `end_turn`→`NP00_FINITE_DONE` 终态→只读工具→`NP01_WAKE_CHECK` 文本，无人工补发 prompt |
| `t03-long-finite-timeout-exit.ndjson` | T03 长时任务强制超时 + 非零退出（失败夹具） | `synthetic` | 必须记录 `timeout`（15min+ 强制超时）、`stderr_classified`（`transport_error`）、`process_exit`（`exitCode: 137`）、异常 `transport_timeout` + `process_exit`、零泄露 |
| `t04-parallel-finite-and-daemon.ndjson` | T04 两并行有限任务（B 先于 A）+ 1 daemon | `synthetic` | A/B/D 各自独立 tool/task 别名，`NP01_DAEMON_READY` / `NP01_BG_B_DONE` / `NP01_BG_A_DONE` 按序关联 |
| `t05-double-wake-and-usage-only.ndjson` | T05 双次 wake + 晚工具终态 + usage-only | `synthetic` | 记录双次 wake、`tool_call_update`、`usage_update` 与未知字段 `update.experimentalWakeEpoch` |
| `t06-post-turn-permission-and-child.ndjson` | T06 轮次外审批（数值 ID）+ child 表单（字符串 ID） | `synthetic` | 验证 `rpcIdType`（`number` vs `string`）、安全警告标志、`childAlias`、`approvalAlias` 与审批往返延时 |
| `failure-malformed-and-secret-trap.ndjson` | 畸形行 + 分片 JSON + 敏感信息泄露陷阱（失败夹具） | `synthetic` | 必须捕获 `>=2` 畸形行、正确拼装分片帧、分类 3 类 stderr（`oauth_url_suppressed`、`auth_required`、`stack_trace`），且输出中 **0 泄露** 任何陷阱凭据/邮箱/路径/Prompt/Response 正文 |
