# 独立开发提示词 · NP-13 原生生态、Custom Agents 与配置

你负责 HarnessMate Desktop 的 **NP-13 原生生态、Custom Agents 与配置**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

补全可验证的 Custom Agent、Skills/Rules/Hooks、AGY Plugins/MCP、Projects、模式配置与账户生态。

**依赖与可并行范围**　G1，需 NP-06 command/catalog contract 对齐。与 G2 模式并行，私有文件读产品化决策 U04。

**接口契约**　CapabilityDescriptor，source/profiles 与 account isolation；配置三层 scope 不漂移，读写范围单独发布。

使用建议分支 `codex/agy-np-13-ecosystem`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-13-ecosystem.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-ecosystem.ts](../../../packages/daemon/src/harnesses/agy/agy-ecosystem.ts)
- [packages/daemon/src/harnesses/agy/agy-config-scope.ts](../../../packages/daemon/src/harnesses/agy/agy-config-scope.ts)
- [packages/daemon/src/harnesses/agy/agy-profile-manager.ts](../../../packages/daemon/src/harnesses/agy/agy-profile-manager.ts)
- [packages/daemon/src/harnesses/agy/agy-launch-context.ts](../../../packages/daemon/src/harnesses/agy/agy-launch-context.ts)
- [packages/daemon/src/harnesses/agy/agy-auth-service.ts](../../../packages/daemon/src/harnesses/agy/agy-auth-service.ts)
- [packages/web/src/components/agy/AgySettingsSlot.tsx](../../../packages/web/src/components/agy/AgySettingsSlot.tsx)

[antigravity.google · customization-discovery](https://antigravity.google/docs/customization-discovery/) · [antigravity.google · agents](https://antigravity.google/docs/cli/commands/agents/) · [antigravity.google · sidecars](https://antigravity.google/docs/sidecars/) · [google-antigravity/antigravity-cli issues 1540](https://github.com/google-antigravity/antigravity-cli/issues/1540) · [google-antigravity/antigravity-cli issues 1610](https://github.com/google-antigravity/antigravity-cli/issues/1610) · [pingdotgg/t3code pull 39485](https://github.com/pingdotgg/t3code/pull/39485)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/ecosystem/**`、`agy-ecosystem.ts`、`agy-config-scope.ts`、domain 内另经审查的 AGY profile manager 作用域接入，`packages/web/src/components/agy/native/settings/**`、`AgySettingsSlot.tsx`、专属 tests。

**具体实现**　按 source/tier/账号/额外根展示真实的 catalog、有效配置和来源。Custom Agent 列表、切换可能 fork，逐项录制。Skills 1.5.16 优先级、Rules 读取复验、Hooks/Plugins/MCP 管理和管理员政策按原生能力。支持真实 Opt-in 的官方查询，区分原生与 HM 生态。账单、Remote Control、SSH、Remote Agents、Sidecars、IDE/SDK 仅在证据和核准范围内接入。

**交互和前端**　Settings 按账户/模型/Agent/生态/项目区分，显示命名空间、实际 availability 与来源。Account 操作仍手动，原生工具控制有 UI 说明。

**范围排除**　不自动换号、引入第二登录机制、从凭据读 token、模拟原生 CLI、改写用户私有文件、开启 Sidecar 或远程接入、添单活账户设置（待 U07）。

**所有权和冲突处理**　06 处理查询和运行目标；02 持有 REST、auth/policy 共享；15 持续维护 attach；03 管 slots。没有新证明时保持只读。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T01/T15/T17，单授权 Profile 能看合法选项，新旧全局目录/重复名、规则/组织约束、同名账号、隔离目录、权限边界。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 生态 descriptor、读取服务、管理界面初版，明确没有原生 feed 的条目与既有本机测试。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关闭各域扩展 gate 和读源，既有 Profile 目录及 HM 功能保留。

报告写入 `handoffs/NP-13-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
