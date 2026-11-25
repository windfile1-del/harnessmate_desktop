# 独立开发提示词 · NP-12 Goal、Schedule 与 Native Tasks

你负责 HarnessMate Desktop 的 **NP-12 Goal、Schedule 与 Native Tasks**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。从本地标签 `agy-np-g3-wave1` 切分支，按 [第二批开工安排](../handoffs/G3_Wave2_Launch_Plan.md) 校验提交。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

在本域保存 occurrence 的原生来源和状态，和 NP-15 对齐恢复证据。由总指挥在第一批观察门控内接入经过审查的只读投影。

把原生 Goal 和定时 occurrence 接入 Runtime Center，允许当前用户 turn 结束后仍真实观测后续工作。

**依赖与可并行范围**　G2（04/06/07、03b），重启与恢复和 NP-15 联测；原生 Automations 只做证据收口。

**接口契约**　WorkflowDetail.goal/schedule，WorkId/ActivityId 分离，计划/实际 occurrence、源与时区、command router 与 receipt。

使用建议分支 `codex/agy-np-12-goal-tasks`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-12-goal-tasks.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/core/harness-commands.ts](../../../packages/daemon/src/core/harness-commands.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)
- [docs/phase-agy-native-parity/06_Protocol_Evidence.md](../../../docs/phase-agy-native-parity/06_Protocol_Evidence.md)

[antigravity.google · goal](https://antigravity.google/docs/commands/goal/) · [antigravity.google · schedule](https://antigravity.google/docs/commands/schedule/) · [antigravity.google · automation](https://antigravity.google/docs/commands/automation/) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/workflows/tasks/**`、`packages/web/src/components/agy/native/tasks/**`、专属 tests。

**具体实现**　明确 Goal 真实启动、状态、替换、验证和停止。Schedule 区分单次/cron、已创建、触发、多个 occurrence 与后继活动，使用实际 nextAt 而非本地猜。聚合 Runtime Center 中有限/daemon/定时来源。评估 /tasks 的协议暴露；缺控制留官方入口。只在能证明时设置 lease 和恢复。

**交互和前端**　Native Tasks 支持按类别区分，Goal 与 Schedule 的下一事件和操作独立，时间采用明确的原生时区或未知。已看到 wake 可跳转。

**范围排除**　不建立 HM scheduler 或唤醒 prompt，不把 App Automations/Sidecars 仿成 ACP，不重绑用户现有任务。

**所有权和冲突处理**　04 管 runtime leases，06 管路由，15 管恢复。不要更改共同的 wall-clock 属性定义，版本差写本域。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T09/T14，小型单次、早取消、已结束用户轮次、重复发生、断网恢复。先模拟 cron，不在 NP 探索中长期挂任务。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. Goal 与 Schedule observer、Tasks view、过程测例与 App-only 结案记录。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关闭动作时保留到期历史，仅允许读取。真实已有计划的删除仍由用户经原生端完成。

报告写入 `handoffs/NP-12-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
