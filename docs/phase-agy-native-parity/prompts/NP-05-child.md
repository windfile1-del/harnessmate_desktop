# 独立开发提示词 · NP-05 原生子 Agent 身份与会话路由

你负责 HarnessMate Desktop 的 **NP-05 原生子 Agent 身份与会话路由**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

将 native child、launch tool、batch、原生记录和权限目标在可验证时关联，提供真实独立子时间线。

**依赖与可并行范围**　G1（NP-01/02），NP-07 可依赖 ChildSessionRouter 契约先并行。G2 需要共同验收。

**接口契约**　AgentIdentity、NativeRelationship、alias namespace、NativeIngress；可选 ACP v1/v2 child 契约、只读 schema gated staleness。

使用建议分支 `codex/agy-np-05-child`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-05-child.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-child-work.ts](../../../packages/daemon/src/harnesses/agy/agy-child-work.ts)
- [packages/daemon/src/harnesses/agy/agy-profile-manager.ts](../../../packages/daemon/src/harnesses/agy/agy-profile-manager.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)
- [docs/phase-agy-native-parity/06_Protocol_Evidence.md](../../../docs/phase-agy-native-parity/06_Protocol_Evidence.md)

[agentclientprotocol.com · subagents](https://agentclientprotocol.com/protocol/v1/subagents) · [antigravity.google · subagents](https://antigravity.google/docs/subagents/) · [antigravity.google · agents](https://antigravity.google/docs/cli/commands/agents/) · [pingdotgg/t3code discussions 39503](https://github.com/pingdotgg/t3code/discussions/39503)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/child/**`、`harnesses/agy/agy-child-work.ts`、`packages/web/src/components/agy/native/child/**` 与专属测试。

**具体实现**　保持 tool/record/conversation 三种 ID namespace，verified lineage 后建立 stable mapping。对 E06 的真实 App record shape 与 CLI 差异用版本化 parser，不把 parent transcript 作为 child。实现 capped bounded scans、buffer 与 dedup、未知/冲突/环/跨 profile 拒绝。ACP 子扩展只在完整路由时声明；支持原生 child cancel 的目标须来自 child.capabilities。请求外层真实发送方交给 07，记录转发 parent 与 inferred display owner 区别。

**交互和前端**　Subagent Manager 有主 Agent 回返、父树、批次、真实子 timeline、来源和需操作。只读来源明确，未知 child 禁危险控件。

**范围排除**　无 child Prompt/steer 模拟、无直接 load child、无私有文件写入、无推测 Board 或用 HM subagent_runs 伪造原生关系。

**所有权和冲突处理**　NP-02 注册 reader API，NP-03 将旧 batch 卡接新 opaque IDs。NP-07 共享 route resolution，不各自在前端映射 toolId。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T07、T06、T15，两个相同 role、不同 native ID、child idle 重新运行、父/子审批、关联证据不足、过期重启、Windows reparse 与隐私。获得真机 child 事件后升等级。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 身份解析、只读 adapter、child timeline 组件、关联证据与无数据降级测试。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关 child feature 或对未知版本禁用 reader，保留已有脱敏记录及通用工具。

报告写入 `handoffs/NP-05-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
