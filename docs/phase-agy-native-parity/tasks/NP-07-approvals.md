# NP-07 · 原生审批、Elicitation 和问题路由

原生审批与提问在原轮次、轮次外、已知 child 和 Workflow 均能显示并可靠回应同一条请求。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G1（NP-01/02），可先用 NP-05 child resolver stub。G2 起在 04/05/03b 上联测真实归属与延迟。 |
| 契约 | PendingNativeRequest、ReceiptState、规范响应和延时失效；继续复用 approval center 业务和安全范围。固定选项只回原生 id。 |
| Git | `codex/agy-np-07-approvals`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-07` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/requests/**`、`packages/web/src/components/agy/native/requests/**` 与专属 API/approval tests。通用 ApprovalCenter 只作选择器接入建议。 |
| 潜在冲突 | NP-02 拥有 routes/SessionManager adapter 共享；03 管 Approval Center link，05 提供 target/lineage，04 提供保活。联测使用共同测试报告。 |
| 范围排除 | 不修改通用权限规则或风险分数，不自动授权，不拿对端请求当作用户新任务，不做审批之外的 Workflow 实现。 |

## 工作内容与前端

跟踪 session/child/binding/connection id/occurrence。把 detached request 与可归属的 activity 关联。CAS 防多次回复和过期。检查 wire 和填表 schema。未知方法返回标准错误，未知 child 若路由无法确证则拒绝或保留限时，不能扩大允许。只接受证实的 free-text/elicitation，不隐式映射首个选项。连接失效或 write 不确定写进 receipt，不重放。

读清源所属、scope、安全说明与真实选项，高亮 pending，提交动作显示写入收据与重连失效。不能回答或不支持方式应清楚展示。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/core/approval-center-service.ts](../../../packages/daemon/src/core/approval-center-service.ts)
- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/ApprovalCenter.tsx](../../../packages/web/src/components/ApprovalCenter.tsx)
- [packages/daemon/tests/session-explorer-approval.test.ts](../../../packages/daemon/tests/session-explorer-approval.test.ts)

[agentclientprotocol.com · tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls) · [agentclientprotocol.com · elicitation](https://agentclientprotocol.com/protocol/v1/elicitation) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 测试、交付及合并

T06/T07/T14，用已证实的转发场景对照 1.5.16 default/accept-edits；重复、拒绝、过期、Stop 同时、epoch switch 或无法编码自由文本，不扩大授权。

Request router/DTO glue、前端 request 组件、审批回执 tests，列出实测可用 forms 与受限选项。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。只关闭新的 native request 路径，已有 legacy approval 行为与审计记录保留。

报告写入 `handoffs/NP-07-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-07-approvals.md)
