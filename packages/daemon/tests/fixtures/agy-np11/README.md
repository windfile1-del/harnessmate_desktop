# NP-11 Dynamic Workflows Replay Fixtures (`packages/daemon/tests/fixtures/agy-np11/`)

本目录保存 NP-11 专属离线确定性回放夹具（与 NP-01 `agy-np/` 和既有 `agy-1.5.14/` 完全隔离）。

每个夹具首行为 `scenario_meta`，显式声明 `source`（均为 `synthetic`）、`applicableCliVersions`、`provenanceOrigin` 与 `verdictCriteria`。这些夹具用于离线验证 T13 observer、受限读取边界、节点失败、被拒、缺字段及 AGY 1.5.16 问题转发，**不作为真机 L2–L5 实录证明**。

| 文件 | 场景 | 适用版本参考 | 验证重点 |
| --- | --- | --- | --- |
| `t13-parallel-serial-comparison.ndjson` | T13 两项无修改只读任务并发（Phase 1）+ 串行汇总（Phase 2），对照纯串行对比运行 | `1.5.15`, `1.5.16` | 脚本只读预览、`after` 依赖边 DAG、`blocking` 保持与终态释放、并发 vs 串行各自独立 workflow/work ID、结构化 JSON 结果与日志分页 |
| `t13-denied-partial-and-missing-fields.ndjson` | 脚本被拒 + 节点部分失败 + 缺 `after` 边/缺字段/省略补丁 | `1.5.15`, `1.5.16` | 拒绝脚本转 `cancelled`/`denied` 且不执行任何节点；Node A 成功留结果、Node B 失败非零退出；缺 `after` 时 `hasVerifiedDag=false`；局部省略补丁保留旧值；`ScriptPath` 脱敏且绝不读盘 |
| `t13-1516-question-forwarding.ndjson` | AGY 1.5.16 经父会话转发的工作流权限与 `interaction_*` 结构化问题 | `1.5.16` | 保留外层 `actualNativeSessionId` 与 `forwardedToParentSession=true`；数值与字符串 `RpcId` 精确往返；`accept-edits` 下绝不自动授权；固定选项拒绝自由文本伪造 |
