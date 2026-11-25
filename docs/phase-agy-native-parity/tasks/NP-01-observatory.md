# NP-01 · 协议观测与事件录制

能够以时间线和关联 ID 区分 AGY 未发帧、传输接收、适配器归属、持久化或 Web 投影，建立可重复的 Windows 最小录制和回放。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G0，可与 NP-02、NP-03a 独立开始。最终 daemon tap 接线需要 NP-02 的 G1 接入缝。 |
| 契约 | 证据 E01–E07；测试策略 capture metadata；NativeIngress 的 connection/ordinal/replay；Recorder 输出不进生产业务事件。 |
| Git | `codex/agy-np-01-observatory`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-01` |
| 写入范围 | `scripts/agy-np/observatory/**`、`packages/daemon/tests/fixtures/agy-np/**`、专属 recorder tests 与 `evidence/scenarios/`。 |
| 潜在冲突 | NP-02 写 transport/event 接线。先用回调接口证明工具，再以最小 diff 提交接线需求给 owner。 |
| 范围排除 | 无产品状态重构、自动账号登录、付费任务、捕获或发布私人 session/原始日志。不得改共享 JSON-RPC、SessionManager 与 app-store。 |

## 工作内容与前端

保留 NP-00 探针的默认无身份路径。补一键 live 录制、dry-run、格式迁移和 JSON schema。让同一 alias 能贯穿 raw/normalized/native canonical/UI。包括 stderr 分类、进程退出、drop/overflow、延时和未知字段，明确 synthetic/replay/live provenance。入站与出站默认以字段 allowlist 重建，保留固定测试值的加盐关联，仅读可授权测试场景。现有 1.5.14 fixture 原状保存。具备单账户授权时先做 T01/T02。

无新增产品页面。需要可比较的四层简表与支持复制安全诊断编号的输入格式给 NP-03。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [docs/phase-agy-native-parity/evidence/probe-acp.mjs](../../../docs/phase-agy-native-parity/evidence/probe-acp.mjs)
- [packages/daemon/src/harnesses/jsonrpc.ts](../../../packages/daemon/src/harnesses/jsonrpc.ts)
- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/tests/agy-replay-protocol.test.ts](../../../packages/daemon/tests/agy-replay-protocol.test.ts)

[antigravity.google · acp](https://antigravity.google/docs/ide/extensions/acp/) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 测试、交付及合并

T01–T06 的采集形状；至少包含畸形行、无日志泄露、强制超时、连接与审批相关性验证。授权前只执行无身份/合成。每个失败 fixture 写出判定条件。

录制工具、脱敏器、至少两份最小 replay、Windows 执行说明、采样来源及限制报告。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关 recorder opt-in，可撤销工具提交。fixture/证据历史保持可读。

报告写入 `handoffs/NP-01-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-01-observatory.md)
