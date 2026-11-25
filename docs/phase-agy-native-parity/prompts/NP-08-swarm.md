# 独立开发提示词 · NP-08 Swarm 与共享 Board

开工前核对 [G3 第一批开发安排](../handoffs/G3_Launch_Plan.md) 与 [G2 修复复验](../reviews/G2-candidate-verification.md)。以 `agy-np-g2` 解析到的同一个提交为基础。先交付本任务的离线 observer、工作台、降级行为与回放。原生触发和控制依据已验字段与明确的测试授权逐步接通。

你负责 HarnessMate Desktop 的 **NP-08 Swarm 与共享 Board**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

以真实 AGY Swarm 执行作为唯一来源，呈现可证协调、worker 和 Board，并明确上游未发信息。

**依赖与可并行范围**　G2（04/05/06/07、03b）。低成本真机使用单一账号和一个经授权的 worker 场景。

**接口契约**　`WorkflowDetailSchema` 与 `WorkflowDetailDtoSchema` 的 `kind: 'swarm'` 分支、worker identity、runtime scope、命令 descriptor 与 native request receipt，Board resource/帖子稳定 ID 分页。

使用建议分支 `codex/agy-np-08-swarm`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-08-swarm.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/harnesses/agy/agy-child-work.ts](../../../packages/daemon/src/harnesses/agy/agy-child-work.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)
- [docs/phase-agy-native-parity/04_T3Code_Research.md](../../../docs/phase-agy-native-parity/04_T3Code_Research.md)

[antigravity.google · swarm](https://antigravity.google/docs/swarm/) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) · [pingdotgg/t3code discussions 39503](https://github.com/pingdotgg/t3code/discussions/39503)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/workflows/swarm/**`、`packages/web/src/components/agy/native/swarm/**` 与专属 fixture/tests。

**具体实现**　采 /swarm 的真实 trigger/广告与 coordinator 更新。Worker/verifier 状态、Board 和 mention 需对应 native ID 与相同 scope。优先 ACP；按证据测试只读 Board 源。若不存在可信源，交付 coordinator 轨迹、支持边界和官方查看。Worker 身份已证时可链接子审批，不移动原生上下文。

**交互和前端**　Overview、Workers、Board、Activity 带来源与未知状态；缺 board feed 时展示官方入口说明，worker 不由工具标题生成。

**范围排除**　无本地编排、自动发送 mention 或生成 Board；不读未验证的私有数据库，不把多个 HM 子会话叫 Swarm。

**所有权和冲突处理**　NP-05 的 child/lineage、07 的请求、06 的 live lane 是前置。03 负责 shell，08 提供专属页及 capability 间接注册。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T10 观察 worker idle、真实 mention 后活性、权限、失败与 coordinator settle。对缺帧源测试禁动作与不显示假进度。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. Swarm observer、Studio、原生证据或上游结案、对应接口和率先覆盖的功能列表。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关闭 Swarm gate 或 Board 单独 gate，保留已捕获的 coordinator 轨迹。

报告写入 `handoffs/NP-08-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
