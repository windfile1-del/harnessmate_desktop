# 独立开发提示词 · NP-02 共享契约、持久化和核心接入

你负责 HarnessMate Desktop 的 **NP-02 共享契约、持久化和核心接入**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

给所有领域 owner 提供唯一的类型、原生事件 feed、generation、存储和 SessionManager/ACP 依赖注入接入缝。

**依赖与可并行范围**　G0 可立即设计和实现增量骨架。与 NP-01 对齐采集格式、NP-03 对齐 projection。G1 是后续领域实现的依赖。

**接口契约**　08 v0.1 → G1 v1。Zod 单一事实来源，durable event+snapshot 一事务，additive migration；老 endpoints / turn 语义兼容，默认 feature off。

使用建议分支 `codex/agy-np-02-contracts`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-02-contracts.md) 和以下源码。第三方实现用于对照。

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

## 工作与权限范围

**允许写入**　`packages/protocol/src/**` 的新增契约与导出。对 `session-manager.ts`、`sqlite.ts`、`server/app.ts`、`harnesses/types.ts`、`harnesses/jsonrpc.ts`、`strict-acp-adapter.ts`、`agy-driver.ts`、`agy-protocol.ts` 增量接线。`orchestrator-service.ts`、`failover-service.ts` 仅限 AGY 请求来源控制接入。新增 `agy/native/wiring/**` 和专属测试。插件 API 扩展需 U06 决策。

**具体实现**　实现 branded scopes、native ingress、可选 lifecycle/permission/router hooks、版本化 DTO 与 append/subscribe；幂等组件迁移和可断点重读。唯一入口编排权与 consumer 来源校验。默认 legacy turn 和非 AGY 行为一致。和 NP-04 对齐 captured Prompt context 以及单次 SessionManager settlement，给取消、profile 换代、warm pool、reconnect 独立 hooks。通过注册表接入领域实现，先提供可以安全启用的 inert 或 feature-off 骨架。

**交互和前端**　定义稳定 REST、事件枚举/错误、capability revision、事件序号和最小授权 DTO，给 NP-03 可运行的 fixture/Known Empty 样本。

**范围排除**　不在 G1 写大规模工作流/Reactive 业务实现，不改其他 adapter 逻辑，不启用 v2 Preview 或未实现 capability，不发 Plugin SDK 新版本。

**所有权和冲突处理**　唯一核心 writer，NP-01/04/05/06/07/15 零直接跨改。和 NP-03 联审 schema、WS/REST cursor。DB 迁移序号由本任务维护。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. 旧 DB/new DB/重复 migration/gate off/事务失效、权限输入验证、不可伪造 consumer provenance，回放 v1 不变。跑 typecheck、build、contracts 与全 test 形成 G1 报告。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 类型与 Zod、事件和迁移契约、接口样本、模块 registration、小型集成回归、契约冻结 SHA。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。feature off 先回退 observers，保留新增表。领域任务可回到 G1 commit。

报告写入 `handoffs/NP-02-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
