# 独立开发提示词 · NP-11 Dynamic Workflows 与执行轨迹

开工前核对 [G3 第一批开发安排](../handoffs/G3_Launch_Plan.md) 与 [G2 修复复验](../reviews/G2-candidate-verification.md)。以 `agy-np-g2` 解析到的同一个提交为基础。先交付本任务的离线 observer、工作台、降级行为与回放。原生触发和控制依据已验字段与明确的测试授权逐步接通。

你负责 HarnessMate Desktop 的 **NP-11 Dynamic Workflows 与执行轨迹**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

观察 AGY 自己生成和执行的工作流脚本、phase、agent execution 与结果。

**依赖与可并行范围**　G2（04/05/06/07、03b），按 T13 单次授权后录制。Artifact 类型读取走 NP-14 的接口。

**接口契约**　`WorkflowDetailSchema` 与 `WorkflowDetailDtoSchema` 的 `kind: 'dynamic'` 分支、steps/edges 可选、results artifacts、held activity 和原生审批。Stage ID 和 append events 来自实录证据。

使用建议分支 `codex/agy-np-11-dynamic-workflow`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-11-dynamic-workflow.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/harnesses/agy/agy-artifacts.ts](../../../packages/daemon/src/harnesses/agy/agy-artifacts.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)

[antigravity.google · dynamic-workflows](https://antigravity.google/docs/dynamic-workflows/) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) · [pingdotgg/t3code pull 38916](https://github.com/pingdotgg/t3code/pull/38916)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/workflows/dynamic/**`、`packages/web/src/components/agy/native/workflow/**`、独立 fixtures/tests。

**具体实现**　从原生 trigger 到脚本授权、派生子任务、并行/串行活动、脚本结果及异常。在真实数据供应时 parse structured outputs 和确定依赖，记录已观察日志的范围和 provenance。验收脚本仅在明确用户/原生权限下由 AGY 执行。被拒、部分结果、无 DAG 都是可呈现状态。

**交互和前端**　脚本审阅、执行节点/时序、结果浏览。缺 edge 展示 timeline。大日志和外部结果按批准范围分页。

**范围排除**　客户端不读取未授权脚本路径、不解释 Python 来执行或修改流程，不模拟 phase，不调用多 Harness Orchestrator。

**所有权和冲突处理**　07 批准、05 Child、04 lease、14 安全 Artifact 访问均经共享 port，11 只维护 Workflow 视图。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T13，两个无修改任务的最小并发/串行对照，节点失败、被拒及缺字段通过测试。1.5.16 question forwarding 独立断言。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. Workflow observer、Studio、节点/日志/结果 fixtures，列出原生字段适用版本。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。开关禁用模式，已观察原生工具与已读产物保留。

报告写入 `handoffs/NP-11-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
