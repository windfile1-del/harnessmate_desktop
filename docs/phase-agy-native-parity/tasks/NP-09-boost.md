# NP-09 · Boost 多段推理

可触发及呈现经证据确认的 AGY Boost 和它特有的验证阶段。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G2（04/05/06/07、03b）。付费试验需用户确认账号资格和单场景预算。 |
| 契约 | `WorkflowDetailSchema` 与 `WorkflowDetailDtoSchema` 的 `kind: 'boost'` 分支、NativeStage、source and revision；无字段 phase 列表省略；用户明确选用 live_workflow。 |
| Git | `codex/agy-np-09-boost`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-09` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/workflows/boost/**`、`packages/web/src/components/agy/native/boost/**` 和专属 tests。 |
| 潜在冲突 | 使用 05、06、07 公共子路由/权限，自己的 projection 与 UI 独立，不能驱动其它包的工作流。 |
| 范围排除 | 无 model 自发模式，不以独立 AGY 实例替代 Boost，不硬编码阶段，不从外部协作框架追因。 |

## 工作内容与前端

记录 model/tier 广告、原生 /boost 启动、子 Agent 角色、真实验证及停止。使用只读实际阶段。存在 initial/improvement/verification 信号才定义标准内部枚举；解析未知角色作为 observed label，不推断进度或轮数。无资格采用确定性提示，保持原始模式意图。

Boost Studio 有可查验证线索、原生阶段和活动。没有 phase 时展示可观察活动与已证启动。默认不自动升级到付费模式。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyComposerControls.tsx](../../../packages/web/src/components/agy/AgyComposerControls.tsx)
- [docs/phase-agy-native-parity/09_Frontend_Design.md](../../../docs/phase-agy-native-parity/09_Frontend_Design.md)

[antigravity.google · boost](https://antigravity.google/docs/boost/) · [antigravity.google · slash-commands](https://antigravity.google/docs/slash-commands/) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 测试、交付及合并

T11，合成未知阶段、重复和 server denied，获得授权后对 App/CLI/ACP 做一个小目标。记录实际可用中断。

Boost resolver/observer、专属 Studio、门控和 fixture，带实际计划等级与证据。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关闭模式入口和 projection，保持通用原生 trace。

报告写入 `handoffs/NP-09-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-09-boost.md)
