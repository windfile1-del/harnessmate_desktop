# NP-14 · Plan、Artifact Review 与 Browser Agent

把 AGY 的计划、原生产物、diff、审阅和浏览器角色清晰地接入安全工作台。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G2（05/06/07、03b），与 NP-10/11 联合验证各自 Artifact。现有只读 UI 可先复用。 |
| 契约 | Opaque artifact resource、scope/redaction、revision 与 verified action keys；权限与实际评论/批准的 wire 形状先录后声明。 |
| Git | `codex/agy-np-14-review-browser`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-14` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/artifacts/**`、`agy-artifacts.ts`、`packages/web/src/components/agy/native/review/**`、`AgyArtifactReviewPanel.tsx`、专属 tests。 |
| 潜在冲突 | NP-05 child identity、07 approvals，02 API、03 shell。Teamwork 与 workflow 只各自管理业务关联，Artifact reader 由 14 唯一维护。 |
| 范围排除 | 无 AGY 内嵌浏览器控制复刻、协议 UI 未证的评论或批准、任意 HTML/任意 Native path、发布私有产物。 |

## 工作内容与前端

复用路径白名单与只读 API，验证实际产物类型/上下文、parent/child 归属及安全内容渲染。将标准 Plan/diff 与 AGY review 分开。若真实支持评论/批准，按经证的 wire schema 幂等交付。Browser Agent 仅呈现真实角色/日志/截图；区分 App 内嵌与 CLI/企业 Chrome MCP。用官方指引补完整 App-only 操作。

Artifact & Review Workspace 有列表/过滤、Markdown/text/diff、行号与来源。只读/需官方端明确。禁止加载未审查的未知链接。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/agy/agy-artifacts.ts](../../../packages/daemon/src/harnesses/agy/agy-artifacts.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyArtifactReviewPanel.tsx](../../../packages/web/src/components/agy/AgyArtifactReviewPanel.tsx)
- [packages/web/src/components/DiffInspectorPanel.tsx](../../../packages/web/src/components/DiffInspectorPanel.tsx)
- [docs/plugin-browser-preview.md](../../../docs/plugin-browser-preview.md)

[antigravity.google · artifact-review](https://antigravity.google/docs/artifact-review/) · [antigravity.google · artifacts](https://antigravity.google/docs/cli/artifacts/) · [antigravity.google · browser](https://antigravity.google/docs/browser/) · [antigravity.google · browser-recordings](https://antigravity.google/docs/ide/browser-recordings/)

## 测试、交付及合并

T12/T13/T16：真实文件与路径边界，恶意内容与 XSS 防御，回放真实审批和拒绝。含历史读、viewport、授权后的 app/cli 对照。

安全内容 reader、计划/review/Browser 组件、供应商支持和截图/录像证据。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。保持旧只读面板，控制和媒体 gate 独立关停。

报告写入 `handoffs/NP-14-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-14-review-browser.md)
