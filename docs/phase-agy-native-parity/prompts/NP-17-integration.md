# 独立开发提示词 · NP-17 集成与独立验收

你负责 HarnessMate Desktop 的 **NP-17 集成与独立验收**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 本轮开工

可从本地 `agy-np-g3-wave2` 并行准备验收装置、只读样本和清单。正式独立验收等待总指挥提供含 NP-16 验证的固定 SHA。分别记录合成、回放、实机 ACP 与官方 Windows App 对照。U01 使用 Gemini 3.8 Flash 和专用 Profile。

见 [开工安排](../handoffs/G4_Launch_Plan.md) 和 [G3 第二批复验](../reviews/G3-wave2-verification.md)。

## 目标与开工条件

复核每个工作包和整个专项的 Windows App/CLI/ACP 对照，形成可交付的 L0–L5 结论。

**依赖与可并行范围**　G3 后 NP-16 与其他各 task 的评审合并。真实账户、长时和模式额度由 U01 授权，缺证允许保守结案。

**接口契约**　冻结 G1 契约、G3 执行和 G4 发布记录。Matrix、测试策略、review/handoff 模板为验收基准。

使用建议分支 `codex/agy-np-17-integration`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-17-integration.md) 和以下源码。第三方实现用于对照。

- [docs/phase-agy/06_Acceptance_Report.md](../../../docs/phase-agy/06_Acceptance_Report.md)
- [packages/daemon/tests/agy-replay-protocol.test.ts](../../../packages/daemon/tests/agy-replay-protocol.test.ts)
- [packages/daemon/tests/handoff-v2.test.ts](../../../packages/daemon/tests/handoff-v2.test.ts)
- [packages/daemon/tests/adapters-codex.test.ts](../../../packages/daemon/tests/adapters-codex.test.ts)
- [packages/daemon/tests/adapters-claude.test.ts](../../../packages/daemon/tests/adapters-claude.test.ts)
- [packages/daemon/tests/phase3-external-adapters.test.ts](../../../packages/daemon/tests/phase3-external-adapters.test.ts)
- [packages/web/tests/phase-agy-ui.test.tsx](../../../packages/web/tests/phase-agy-ui.test.tsx)
- [package.json](../../../package.json)

[antigravity.google · changelog](https://antigravity.google/docs/changelog/) · [antigravity.google · acp](https://antigravity.google/docs/ide/extensions/acp/) · [pingdotgg/t3code discussions 39503](https://github.com/pingdotgg/t3code/discussions/39503)

## 工作与权限范围

**允许写入**　`scripts/agy-np/e2e/**`、独立验收 fixtures、`reviews/NP-17-*.md`、`handoffs/NP-17-*.md`。集成 owner 才可推进 branch。

**具体实现**　用固定 SHA 重跑合同、回放、构建、交叉 Harness，该版官方 AGY 的 Windows App/CLI/raw/HM 对照。复核每个 capability 的 observed evidence、等级、功能 gate、限制和上游联系。不把 unsupported 当 bug，也不提级缺 raw 的功能。提交主控可复核记录与上线/回退清单。发现问题由 owner 修并再次独立验收。

**交互和前端**　验证 Windows真实工作台和原生客户端操作对照，包括可操作、只读、无数据和请求过期四类体验。

**范围排除**　不新增产品功能、擅自安装包或默认切 main、合并未审改动、执行真实付费任务或向外提交日志。

**所有权和冲突处理**　NP-17 独立于原实现者。总指挥汇总 MASTER_PROGRESS 和矩阵，17 只提交审查附件和对照差异。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T01–T18 按优先级；全量测试/span 录制；持续真机+降级互斥；发布测试需显式安装与部署范围。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 按 Capability ID 的验收对照表、完整证据引用、发布与回滚建议、阻塞与未通过列表。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。按 gates/单个 merge revert 回退，旧数据可读，验收报告附回退后复跑。

报告写入 `handoffs/NP-17-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
