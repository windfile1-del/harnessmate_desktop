# NP-15 · 会话恢复与协议兼容

建立原生数据、进程连接与 HM 历史之间可追踪的恢复，维持 ACP v1 并为 v2 分线。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G2（02/04/05/07、03b）。可先按 G1 契约编写重放/版本探针，Recovery 需与 NP-12 联测。 |
| 契约 | RuntimeBinding/generation、NativeIngress channel、asOfSeq、stale reason。v1 load 与 resume 分开，v2 preview 只在受控下实例化。 |
| Git | `codex/agy-np-15-recovery`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-15` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/recovery/**`、`harnesses/history-scanner.ts` 的 AGY 作用域、专属 recovery tests。Core migration/adapter wiring 交 02。 |
| 潜在冲突 | NP-02 共享启动与 SQLite owner，NP-04 lease、07 receipt 清除；NP-05 child read-only；NP-13 account。恢复 UI 依 NP-03 shared selectors。 |
| 范围排除 | 不自动重发用户 Prompt、旧审批或原生任务。没有权限时不改安装文件/私有数据库。没有证据不宣称旧 daemon 跨进程存活。 |

## 工作内容与前端

启动由绑定恢复、profile/source/revision guard、连接丢失标 reconciling。按真实能力选 attach/replay，历史不应投递审批或伪造实时状态。原生 job 可续的条件来自新连接或读源证据。旧 session list 和 HM Handoff 保留。为 v2 提供 codec tests，默认 v1。逐版本测试 cancellation/session close 与 Windows 进程树，坏版本可以降级。

状态为连接恢复中、最后见、失效审批、可恢复/需手工接入，给正常历史读取路径。无授权时不弹自动登录。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/src/db/sqlite.ts](../../../packages/daemon/src/db/sqlite.ts)
- [packages/daemon/src/harnesses/history-scanner.ts](../../../packages/daemon/src/harnesses/history-scanner.ts)
- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/tests/agy-replay-protocol.test.ts](../../../packages/daemon/tests/agy-replay-protocol.test.ts)
- [packages/daemon/tests/handoff-v2.test.ts](../../../packages/daemon/tests/handoff-v2.test.ts)

[agentclientprotocol.com · session-setup](https://agentclientprotocol.com/protocol/v1/session-setup) · [agentclientprotocol.com · migration](https://agentclientprotocol.com/protocol/v2/migration) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [pingdotgg/t3code pull 38916](https://github.com/pingdotgg/t3code/pull/38916)

## 测试、交付及合并

T09/T14/T15，新旧 DB、乱序 attach、重连后晚 response、进程崩溃/网络/Windows 重启、v1/v2 负面和旧客户端。Handoff/Orchestrator 回归。

recovery service、版本适配、兼容与崩溃记录、Windows 运行指南。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关闭主动 reconcile，历史 native feed 只读并保留；新增 DB 不删，旧版本能启动。

报告写入 `handoffs/NP-15-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-15-recovery.md)
