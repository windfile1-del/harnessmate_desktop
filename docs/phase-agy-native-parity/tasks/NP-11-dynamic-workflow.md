# NP-11 · Dynamic Workflows 与执行轨迹

观察 AGY 自己生成和执行的工作流脚本、phase、agent execution 与结果。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G2（04/05/06/07、03b），按 T13 单次授权后录制。Artifact 类型读取走 NP-14 的接口。 |
| 契约 | WorkflowDetail.dynamic、steps/edges 可选、results artifacts、held activity 和原生审批。Stage ID 和 append events 来自实录证据。 |
| Git | `codex/agy-np-11-dynamic-workflow`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-11` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/workflows/dynamic/**`、`packages/web/src/components/agy/native/workflow/**`、独立 fixtures/tests。 |
| 潜在冲突 | 07 批准、05 Child、04 lease、14 安全 Artifact 访问均经共享 port，11 只维护 Workflow 视图。 |
| 范围排除 | 客户端不读取未授权脚本路径、不解释 Python 来执行或修改流程，不模拟 phase，不调用多 Harness Orchestrator。 |

## 工作内容与前端

从原生 trigger 到脚本授权、派生子任务、并行/串行活动、脚本结果及异常。在真实数据供应时 parse structured outputs 和确定依赖，记录已观察日志的范围和 provenance。验收脚本仅在明确用户/原生权限下由 AGY 执行。被拒、部分结果、无 DAG 都是可呈现状态。

脚本审阅、执行节点/时序、结果浏览。缺 edge 展示 timeline。大日志和外部结果按批准范围分页。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/harnesses/agy/agy-artifacts.ts](../../../packages/daemon/src/harnesses/agy/agy-artifacts.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)

[antigravity.google · dynamic-workflows](https://antigravity.google/docs/dynamic-workflows/) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) · [pingdotgg/t3code pull 38916](https://github.com/pingdotgg/t3code/pull/38916)

## 测试、交付及合并

T13，两个无修改任务的最小并发/串行对照，节点失败、被拒及缺字段通过测试。1.5.16 question forwarding 独立断言。

Workflow observer、Studio、节点/日志/结果 fixtures，列出原生字段适用版本。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。开关禁用模式，已观察原生工具与已读产物保留。

报告写入 `handoffs/NP-11-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-11-dynamic-workflow.md)
