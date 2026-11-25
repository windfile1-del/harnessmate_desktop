# NP-10 · Teamwork 访谈、项目与里程碑

用官方 AGY Teamwork 的访谈、批准契约和项目级执行语义构建工作台。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G2（04/05/06/07、03b）。审阅控制联合 NP-14，前端骨架可用现成契约及 disabled props 先并行。付费时另授权。 |
| 契约 | `WorkflowDetailSchema` 与 `WorkflowDetailDtoSchema` 的 `kind: 'teamwork'` 分支、typed request/Artifact opaque ID、项目已证 scope、里程碑与 gate。项目路径从原生 event 或授权来源。 |
| Git | `codex/agy-np-10-teamwork`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-10` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/workflows/teamwork/**`、`packages/web/src/components/agy/native/teamwork/**` 与专属 schemas/fixture（私有 DTO）。 |
| 潜在冲突 | NP-14 拥有实际 Artifact reader/control，07 负责原生答复，05 管 lineage/有效作用域。团队专属匿名时间线依 03 props。 |
| 范围排除 | 不通过自然语言伪造批准，不自己创建 Teamwork 项目目录或任务，不为商业试验自动放开额度，不绕安全 constraints。 |

## 工作内容与前端

记录当前 /teamwork 而非假设 preview 名可用，scoping questions、Prompt Artifact、项目目录、Sentinel、Orchestrator、Milestones、Audit 的逐事件证据。核对是否/如何经 ACP 正式批准；拒绝后不创建过程，用确证轨迹显示多个角色。将 HM scope 与原生工作区区分，路径只能授权打开。

全宽项目页有访谈、Prompt Artifact、项目、里程碑/审计与产物，只有真实角色和 gate 状态，缺批准入口指引 App。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-artifacts.ts](../../../packages/daemon/src/harnesses/agy/agy-artifacts.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyArtifactReviewPanel.tsx](../../../packages/web/src/components/agy/AgyArtifactReviewPanel.tsx)
- [docs/phase-agy-native-parity/06_Protocol_Evidence.md](../../../docs/phase-agy-native-parity/06_Protocol_Evidence.md)

[antigravity.google · teamwork](https://antigravity.google/docs/teamwork/) · [antigravity.google · artifact-review](https://antigravity.google/docs/artifact-review/) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16)

## 测试、交付及合并

T12。对照拒绝/批准、访谈问题幂等、首里程碑及断线恢复。没有授权时用已知契约验证降级并提交待实测事项。

Teamwork observer、项目页、对照文档、已证实体与无法取的字段清单。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关闭 Teamwork 或只关闭审阅控制，已呈现历史保持只读。

报告写入 `handoffs/NP-10-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-10-teamwork.md)
