# NP-17 · 集成与独立验收

复核每个工作包和整个专项的 Windows App/CLI/ACP 对照，形成可交付的 L0–L5 结论。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G3 后 NP-16 与其他各 task 的评审合并。真实账户、长时和模式额度由 U01 授权，缺证允许保守结案。 |
| 契约 | 冻结 G1 契约、G3 执行和 G4 发布记录。Matrix、测试策略、review/handoff 模板为验收基准。 |
| Git | `codex/agy-np-17-integration`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-17` |
| 写入范围 | `scripts/agy-np/e2e/**`、独立验收 fixtures、`reviews/NP-17-*.md`、`handoffs/NP-17-*.md`。集成 owner 才可推进 branch。 |
| 潜在冲突 | NP-17 独立于原实现者。总指挥汇总 MASTER_PROGRESS 和矩阵，17 只提交审查附件和对照差异。 |
| 范围排除 | 不新增产品功能、擅自安装包或默认切 main、合并未审改动、执行真实付费任务或向外提交日志。 |

## 工作内容与前端

用固定 SHA 重跑合同、回放、构建、交叉 Harness，该版官方 AGY 的 Windows App/CLI/raw/HM 对照。复核每个 capability 的 observed evidence、等级、功能 gate、限制和上游联系。不把 unsupported 当 bug，也不提级缺 raw 的功能。提交主控可复核记录与上线/回退清单。发现问题由 owner 修并再次独立验收。

验证 Windows真实工作台和原生客户端操作对照，包括可操作、只读、无数据和请求过期四类体验。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [docs/phase-agy/06_Acceptance_Report.md](../../../docs/phase-agy/06_Acceptance_Report.md)
- [packages/daemon/tests/agy-replay-protocol.test.ts](../../../packages/daemon/tests/agy-replay-protocol.test.ts)
- [packages/daemon/tests/handoff-v2.test.ts](../../../packages/daemon/tests/handoff-v2.test.ts)
- [packages/daemon/tests/adapters-codex.test.ts](../../../packages/daemon/tests/adapters-codex.test.ts)
- [packages/daemon/tests/adapters-claude.test.ts](../../../packages/daemon/tests/adapters-claude.test.ts)
- [packages/daemon/tests/phase3-external-adapters.test.ts](../../../packages/daemon/tests/phase3-external-adapters.test.ts)
- [packages/web/tests/phase-agy-ui.test.tsx](../../../packages/web/tests/phase-agy-ui.test.tsx)
- [package.json](../../../package.json)

[antigravity.google · changelog](https://antigravity.google/docs/changelog/) · [antigravity.google · acp](https://antigravity.google/docs/ide/extensions/acp/) · [pingdotgg/t3code discussions 39503](https://github.com/pingdotgg/t3code/discussions/39503)

## 测试、交付及合并

T01–T18 按优先级；全量测试/span 录制；持续真机+降级互斥；发布测试需显式安装与部署范围。

按 Capability ID 的验收对照表、完整证据引用、发布与回滚建议、阻塞与未通过列表。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。按 gates/单个 merge revert 回退，旧数据可读，验收报告附回退后复跑。

报告写入 `handoffs/NP-17-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-17-integration.md)
