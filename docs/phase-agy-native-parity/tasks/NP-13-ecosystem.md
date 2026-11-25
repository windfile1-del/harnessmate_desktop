# NP-13 · 原生生态、Custom Agents 与配置

补全可验证的 Custom Agent、Skills/Rules/Hooks、AGY Plugins/MCP、Projects、模式配置与账户生态。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G1，需 NP-06 command/catalog contract 对齐。与 G2 模式并行，私有文件读产品化决策 U04。 |
| 契约 | CapabilityDescriptor，source/profiles 与 account isolation；配置三层 scope 不漂移，读写范围单独发布。 |
| Git | `codex/agy-np-13-ecosystem`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-13` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/ecosystem/**`、`agy-ecosystem.ts`、`agy-config-scope.ts`、domain 内另经审查的 AGY profile manager 作用域接入，`packages/web/src/components/agy/native/settings/**`、`AgySettingsSlot.tsx`、专属 tests。 |
| 潜在冲突 | 06 处理查询和运行目标；02 持有 REST、auth/policy 共享；15 持续维护 attach；03 管 slots。没有新证明时保持只读。 |
| 范围排除 | 不自动换号、引入第二登录机制、从凭据读 token、模拟原生 CLI、改写用户私有文件、开启 Sidecar 或远程接入、添单活账户设置（待 U07）。 |

## 工作内容与前端

按 source/tier/账号/额外根展示真实的 catalog、有效配置和来源。Custom Agent 列表、切换可能 fork，逐项录制。Skills 1.5.16 优先级、Rules 读取复验、Hooks/Plugins/MCP 管理和管理员政策按原生能力。支持真实 Opt-in 的官方查询，区分原生与 HM 生态。账单、Remote Control、SSH、Remote Agents、Sidecars、IDE/SDK 仅在证据和核准范围内接入。

Settings 按账户/模型/Agent/生态/项目区分，显示命名空间、实际 availability 与来源。Account 操作仍手动，原生工具控制有 UI 说明。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-ecosystem.ts](../../../packages/daemon/src/harnesses/agy/agy-ecosystem.ts)
- [packages/daemon/src/harnesses/agy/agy-config-scope.ts](../../../packages/daemon/src/harnesses/agy/agy-config-scope.ts)
- [packages/daemon/src/harnesses/agy/agy-profile-manager.ts](../../../packages/daemon/src/harnesses/agy/agy-profile-manager.ts)
- [packages/daemon/src/harnesses/agy/agy-launch-context.ts](../../../packages/daemon/src/harnesses/agy/agy-launch-context.ts)
- [packages/daemon/src/harnesses/agy/agy-auth-service.ts](../../../packages/daemon/src/harnesses/agy/agy-auth-service.ts)
- [packages/web/src/components/agy/AgySettingsSlot.tsx](../../../packages/web/src/components/agy/AgySettingsSlot.tsx)

[antigravity.google · customization-discovery](https://antigravity.google/docs/customization-discovery/) · [antigravity.google · agents](https://antigravity.google/docs/cli/commands/agents/) · [antigravity.google · sidecars](https://antigravity.google/docs/sidecars/) · [google-antigravity/antigravity-cli issues 1540](https://github.com/google-antigravity/antigravity-cli/issues/1540) · [google-antigravity/antigravity-cli issues 1610](https://github.com/google-antigravity/antigravity-cli/issues/1610) · [pingdotgg/t3code pull 39485](https://github.com/pingdotgg/t3code/pull/39485)

## 测试、交付及合并

T01/T15/T17，单授权 Profile 能看合法选项，新旧全局目录/重复名、规则/组织约束、同名账号、隔离目录、权限边界。

生态 descriptor、读取服务、管理界面初版，明确没有原生 feed 的条目与既有本机测试。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关闭各域扩展 gate 和读源，既有 Profile 目录及 HM 功能保留。

报告写入 `handoffs/NP-13-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-13-ecosystem.md)
