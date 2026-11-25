# 独立开发提示词 · NP-10 Teamwork 访谈、项目与里程碑

你负责 HarnessMate Desktop 的 **NP-10 Teamwork 访谈、项目与里程碑**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

用官方 AGY Teamwork 的访谈、批准契约和项目级执行语义构建工作台。

**依赖与可并行范围**　G2（04/05/06/07、03b）。审阅控制联合 NP-14，前端骨架 可用现成契约及 disabled props 先并行。付费时另授权。

**接口契约**　WorkflowDetail.teamwork、typed request/Artifact opaque ID、项目已证 scope、里程碑与 gate。项目路径从原生 event 或授权来源。

使用建议分支 `codex/agy-np-10-teamwork`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-10-teamwork.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-artifacts.ts](../../../packages/daemon/src/harnesses/agy/agy-artifacts.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyArtifactReviewPanel.tsx](../../../packages/web/src/components/agy/AgyArtifactReviewPanel.tsx)
- [docs/phase-agy-native-parity/06_Protocol_Evidence.md](../../../docs/phase-agy-native-parity/06_Protocol_Evidence.md)

[antigravity.google · teamwork](https://antigravity.google/docs/teamwork/) · [antigravity.google · artifact-review](https://antigravity.google/docs/artifact-review/) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/workflows/teamwork/**`、`packages/web/src/components/agy/native/teamwork/**` 与专属 schemas/fixture（私有 DTO）。

**具体实现**　记录当前 /teamwork 而非假设 preview 名可用，scoping questions、Prompt Artifact、项目目录、Sentinel、Orchestrator、Milestones、Audit 的逐事件证据。核对是否/如何经 ACP 正式批准；拒绝后不创建过程，用确证轨迹显示多个角色。将 HM scope 与原生工作区区分，路径只能授权打开。

**交互和前端**　全宽项目页有访谈、Prompt Artifact、项目、里程碑/审计与产物，只有真实角色和 gate 状态，缺批准入口指引 App。

**范围排除**　不通过自然语言伪造批准，不自己创建 Teamwork 项目目录或任务，不为商业试验自动放开额度，不绕安全 constraints。

**所有权和冲突处理**　NP-14 拥有实际 Artifact reader/control，07 负责原生答复，05 管 lineage/有效作用域。团队专属匿名时间线依 03 props。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T12。对照拒绝/批准、访谈问题幂等、首里程碑及断线恢复。没有授权时用已知契约验证降级并提交待实测事项。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. Teamwork observer、项目页、对照文档、已证实体与无法取的字段清单。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关闭 Teamwork 或只关闭审阅控制，已呈现历史保持只读。

报告写入 `handoffs/NP-10-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
