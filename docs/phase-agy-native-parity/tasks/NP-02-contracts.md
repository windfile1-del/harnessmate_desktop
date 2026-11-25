# NP-02 · 共享契约、持久化和核心接入

给所有领域 owner 提供唯一的类型、原生事件 feed、generation、存储和 SessionManager/ACP 依赖注入接入缝。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G0 可立即设计和实现增量骨架。与 NP-01 对齐采集格式、NP-03 对齐 projection。G1 是后续领域实现的依赖。 |
| 契约 | 08 v0.1 → G1 v1。Zod 单一事实来源，durable event+snapshot 一事务，additive migration；老 endpoints / turn 语义兼容，默认 feature off。 |
| Git | `codex/agy-np-02-contracts`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-02` |
| 写入范围 | `packages/protocol/src/**` 的新增契约与导出。对 `session-manager.ts`、`sqlite.ts`、`server/app.ts`、`harnesses/types.ts`、`harnesses/jsonrpc.ts`、`strict-acp-adapter.ts`、`agy-driver.ts`、`agy-protocol.ts` 增量接线。`orchestrator-service.ts`、`failover-service.ts` 仅限 AGY 请求来源控制接入。新增 `agy/native/wiring/**` 和专属测试。插件 API 扩展需 U06 决策。 |
| 潜在冲突 | 唯一核心 writer，NP-01/04/05/06/07/15 零直接跨改。和 NP-03 联审 schema、WS/REST cursor。DB 迁移序号由本任务维护。 |
| 范围排除 | 不在 G1 写大规模工作流/Reactive 业务实现，不改其他 adapter 逻辑，不启用 v2 Preview 或未实现 capability，不发 Plugin SDK 新版本。 |

## 工作内容与前端

实现 branded scopes、native ingress、可选 lifecycle/permission/router hooks、版本化 DTO 与 append/subscribe；幂等组件迁移和可断点重读。唯一入口编排权与 consumer 来源校验。默认 legacy turn 和非 AGY 行为一致。和 NP-04 对齐 captured Prompt context 以及单次 SessionManager settlement，给取消、profile 换代、warm pool、reconnect 独立 hooks。通过注册表接入领域实现，先提供可以安全启用的 inert 或 feature-off 骨架。

定义稳定 REST、事件枚举/错误、capability revision、事件序号和最小授权 DTO，给 NP-03 可运行的 fixture/Known Empty 样本。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/src/core/orchestrator-service.ts](../../../packages/daemon/src/core/orchestrator-service.ts)
- [packages/daemon/src/core/failover-service.ts](../../../packages/daemon/src/core/failover-service.ts)
- [packages/daemon/src/db/sqlite.ts](../../../packages/daemon/src/db/sqlite.ts)
- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/src/harnesses/jsonrpc.ts](../../../packages/daemon/src/harnesses/jsonrpc.ts)
- [packages/daemon/src/harnesses/types.ts](../../../packages/daemon/src/harnesses/types.ts)
- [packages/daemon/src/server/app.ts](../../../packages/daemon/src/server/app.ts)
- [packages/protocol/src/canonical.ts](../../../packages/protocol/src/canonical.ts)
- [packages/protocol/src/remote-v1.ts](../../../packages/protocol/src/remote-v1.ts)
- [packages/plugin-api/src/slots.ts](../../../packages/plugin-api/src/slots.ts)

[agentclientprotocol.com · overview](https://agentclientprotocol.com/protocol/v1/overview) · [agentclientprotocol.com · subagents](https://agentclientprotocol.com/protocol/v1/subagents) · [agentclientprotocol.com · migration](https://agentclientprotocol.com/protocol/v2/migration) · [pingdotgg/t3code pull 38916](https://github.com/pingdotgg/t3code/pull/38916)

## 测试、交付及合并

旧 DB/new DB/重复 migration/gate off/事务失效、权限输入验证、不可伪造 consumer provenance，回放 v1 不变。跑 typecheck、build、contracts 与全 test 形成 G1 报告。

类型与 Zod、事件和迁移契约、接口样本、模块 registration、小型集成回归、契约冻结 SHA。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。feature off 先回退 observers，保留新增表。领域任务可回到 G1 commit。

报告写入 `handoffs/NP-02-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-02-contracts.md)
