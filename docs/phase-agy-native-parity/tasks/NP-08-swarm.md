# NP-08 · Swarm 与共享 Board

以真实 AGY Swarm 执行作为唯一来源，呈现可证协调、worker 和 Board，并明确上游未发信息。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G2（04/05/06/07、03b）。低成本真机使用单一账号和一个经授权的 worker 场景。 |
| 契约 | WorkflowDetail.swarm、worker identity、runtime scope、命令 descriptor 与 native request receipt，Board resource/帖子稳定 ID 分页。 |
| Git | `codex/agy-np-08-swarm`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-08` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/workflows/swarm/**`、`packages/web/src/components/agy/native/swarm/**` 与专属 fixture/tests。 |
| 潜在冲突 | NP-05 的 child/lineage、07 的请求、06 的 live lane 是前置。03 负责 shell，08 提供专属页及 capability 间接注册。 |
| 范围排除 | 无本地编排、自动发送 mention 或生成 Board；不读未验证的私有数据库，不把多个 HM 子会话叫 Swarm。 |

## 工作内容与前端

采 /swarm 的真实 trigger/广告与 coordinator 更新。Worker/verifier 状态、Board 和 mention 需对应 native ID 与相同 scope。优先 ACP；按证据测试只读 Board 源。若不存在可信源，交付 coordinator 轨迹、支持边界和官方查看。Worker 身份已证时可链接子审批，不移动原生上下文。

Overview、Workers、Board、Activity 带来源与未知状态；缺 board feed 时展示官方入口说明，worker 不由工具标题生成。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/harnesses/agy/agy-child-work.ts](../../../packages/daemon/src/harnesses/agy/agy-child-work.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)
- [docs/phase-agy-native-parity/04_T3Code_Research.md](../../../docs/phase-agy-native-parity/04_T3Code_Research.md)

[antigravity.google · swarm](https://antigravity.google/docs/swarm/) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) · [pingdotgg/t3code discussions 39503](https://github.com/pingdotgg/t3code/discussions/39503)

## 测试、交付及合并

T10 观察 worker idle、真实 mention 后活性、权限、失败与 coordinator settle。对缺帧源测试禁动作与不显示假进度。

Swarm observer、Studio、原生证据或上游结案、对应接口和率先覆盖的功能列表。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关闭 Swarm gate 或 Board 单独 gate，保留已捕获的 coordinator 轨迹。

报告写入 `handoffs/NP-08-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-08-swarm.md)
