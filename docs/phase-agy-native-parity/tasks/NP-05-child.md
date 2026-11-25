# NP-05 · 原生子 Agent 身份与会话路由

将 native child、launch tool、batch、原生记录和权限目标在可验证时关联，提供真实独立子时间线。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G1（NP-01/02），NP-07 可依赖 ChildSessionRouter 契约先并行。G2 需要共同验收。 |
| 契约 | AgentIdentity、NativeRelationship、alias namespace、NativeIngress；可选 ACP v1/v2 child 契约、只读 schema gated staleness。 |
| Git | `codex/agy-np-05-child`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-05` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/child/**`、`harnesses/agy/agy-child-work.ts`、`packages/web/src/components/agy/native/child/**` 与专属测试。 |
| 潜在冲突 | NP-02 注册 reader API，NP-03 将旧 batch 卡接新 opaque IDs。NP-07 共享 route resolution，不各自在前端映射 toolId。 |
| 范围排除 | 无 child Prompt/steer 模拟、无直接 load child、无私有文件写入、无推测 Board 或用 HM subagent_runs 伪造原生关系。 |

## 工作内容与前端

保持 tool/record/conversation 三种 ID namespace，verified lineage 后建立 stable mapping。对 E06 的真实 App record shape 与 CLI 差异用版本化 parser，不把 parent transcript 作为 child。实现 capped bounded scans、buffer 与 dedup、未知/冲突/环/跨 profile 拒绝。ACP 子扩展只在完整路由时声明；支持原生 child cancel 的目标须来自 child.capabilities。请求外层真实发送方交给 07，记录转发 parent 与 inferred display owner 区别。

Subagent Manager 有主 Agent 回返、父树、批次、真实子 timeline、来源和需操作。只读来源明确，未知 child 禁危险控件。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-child-work.ts](../../../packages/daemon/src/harnesses/agy/agy-child-work.ts)
- [packages/daemon/src/harnesses/agy/agy-profile-manager.ts](../../../packages/daemon/src/harnesses/agy/agy-profile-manager.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)
- [docs/phase-agy-native-parity/06_Protocol_Evidence.md](../../../docs/phase-agy-native-parity/06_Protocol_Evidence.md)

[agentclientprotocol.com · subagents](https://agentclientprotocol.com/protocol/v1/subagents) · [antigravity.google · subagents](https://antigravity.google/docs/subagents/) · [antigravity.google · agents](https://antigravity.google/docs/cli/commands/agents/) · [pingdotgg/t3code discussions 39503](https://github.com/pingdotgg/t3code/discussions/39503)

## 测试、交付及合并

T07、T06、T15，两个相同 role、不同 native ID、child idle 重新运行、父/子审批、关联证据不足、过期重启、Windows reparse 与隐私。获得真机 child 事件后升等级。

身份解析、只读 adapter、child timeline 组件、关联证据与无数据降级测试。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关 child feature 或对未知版本禁用 reader，保留已有脱敏记录及通用工具。

报告写入 `handoffs/NP-05-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-05-child.md)
