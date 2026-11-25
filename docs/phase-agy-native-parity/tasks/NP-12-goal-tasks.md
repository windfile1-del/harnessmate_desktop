# NP-12 · Goal、Schedule 与 Native Tasks

把原生 Goal 和定时 occurrence 接入 Runtime Center，允许当前用户 turn 结束后仍真实观测后续工作。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G2（04/06/07、03b），重启与恢复和 NP-15 联测；原生 Automations 只做证据收口。 |
| 契约 | WorkflowDetail.goal/schedule，WorkId/ActivityId 分离，计划/实际 occurrence、源与时区、command router 与 receipt。 |
| Git | `codex/agy-np-12-goal-tasks`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-12` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/workflows/tasks/**`、`packages/web/src/components/agy/native/tasks/**`、专属 tests。 |
| 潜在冲突 | 04 管 runtime leases，06 管路由，15 管恢复。不要更改共同的 wall-clock 属性定义，版本差写本域。 |
| 范围排除 | 不建立 HM scheduler 或唤醒 prompt，不把 App Automations/Sidecars 仿成 ACP，不重绑用户现有任务。 |

## 工作内容与前端

明确 Goal 真实启动、状态、替换、验证和停止。Schedule 区分单次/cron、已创建、触发、多个 occurrence 与后继活动，使用实际 nextAt 而非本地猜。聚合 Runtime Center 中有限/daemon/定时来源。评估 /tasks 的协议暴露；缺控制留官方入口。只在能证明时设置 lease 和恢复。

Native Tasks 支持按类别区分，Goal 与 Schedule 的下一事件和操作独立，时间采用明确的原生时区或未知。已看到 wake 可跳转。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/core/harness-commands.ts](../../../packages/daemon/src/core/harness-commands.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)
- [docs/phase-agy-native-parity/06_Protocol_Evidence.md](../../../docs/phase-agy-native-parity/06_Protocol_Evidence.md)

[antigravity.google · goal](https://antigravity.google/docs/commands/goal/) · [antigravity.google · schedule](https://antigravity.google/docs/commands/schedule/) · [antigravity.google · automation](https://antigravity.google/docs/commands/automation/) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 测试、交付及合并

T09/T14，小型单次、早取消、已结束用户轮次、重复发生、断网恢复。先模拟 cron，不在 NP 探索中长期挂任务。

Goal 与 Schedule observer、Tasks view、过程测例与 App-only 结案记录。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关闭动作时保留到期历史，仅允许读取。真实已有计划的删除仍由用户经原生端完成。

报告写入 `handoffs/NP-12-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-12-goal-tasks.md)
