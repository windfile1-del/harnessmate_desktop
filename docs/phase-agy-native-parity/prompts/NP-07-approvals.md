# 独立开发提示词 · NP-07 原生审批、Elicitation 和问题路由

你负责 HarnessMate Desktop 的 **NP-07 原生审批、Elicitation 和问题路由**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

**已审 G1 开工点**　本地标签 `agy-np-g1`，源码验收提交 `966451ceaa2d8cfbf268b05a973dbb400715b616`。先读 [G2 开工安排](../handoffs/G2_Launch_Plan.md) 和 [G1 验收](../reviews/G1-final-966451c.md)。

使用 `NativePermissionPort`、`PendingNativeRequest`、`ResolveNativeRequestInputSchema` 及审批 CAS。共享路由把已领取的 `receiptId` 交给 port，使用原连接和原类型 RPC ID 回复。保持旧运行时审批中心可用。

原生审批与提问在原轮次、轮次外、已知 child 和 Workflow 均能显示并可靠回应同一条请求。

**依赖与可并行范围**　G1（NP-01/02），可先用 NP-05 child resolver stub。G2 起在 04/05/03b 上联测真实归属与延迟。

**接口契约**　PendingNativeRequest、ReceiptState、规范响应和延时失效；继续复用 approval center 业务和安全范围。固定选项只回原生 id。

使用建议分支 `codex/agy-np-07-approvals`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-07-approvals.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/core/approval-center-service.ts](../../../packages/daemon/src/core/approval-center-service.ts)
- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/ApprovalCenter.tsx](../../../packages/web/src/components/ApprovalCenter.tsx)
- [packages/daemon/tests/session-explorer-approval.test.ts](../../../packages/daemon/tests/session-explorer-approval.test.ts)

[agentclientprotocol.com · tool-calls](https://agentclientprotocol.com/protocol/v1/tool-calls) · [agentclientprotocol.com · elicitation](https://agentclientprotocol.com/protocol/v1/elicitation) · [google-antigravity/antigravity-cli releases tag 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/requests/**`、`packages/web/src/components/agy/native/requests/**` 与专属 API/approval tests。通用 ApprovalCenter 只作选择器接入建议。

**具体实现**　跟踪 session/child/binding/connection id/occurrence。把 detached request 与可归属的 activity 关联。CAS 防多次回复和过期。检查 wire 和填表 schema。未知方法返回标准错误，未知 child 若路由无法确证则拒绝或保留限时，不能扩大允许。只接受证实的 free-text/elicitation，不隐式映射首个选项。连接失效或 write 不确定写进 receipt，不重放。

**交互和前端**　读清源所属、scope、安全说明与真实选项，高亮 pending，提交动作显示写入收据与重连失效。不能回答或不支持方式应清楚展示。

**范围排除**　不修改通用权限规则或风险分数，不自动授权，不拿对端请求当作用户新任务，不做审批之外的 Workflow 实现。

**所有权和冲突处理**　NP-02 拥有 routes/SessionManager adapter 共享；03 管 Approval Center link，05 提供 target/lineage，04 提供保活。联测使用共同测试报告。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T06/T07/T14，用已证实的转发场景对照 1.5.16 default/accept-edits；重复、拒绝、过期、Stop 同时、epoch switch 或无法编码自由文本，不扩大授权。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. Request router/DTO glue、前端 request 组件、审批回执 tests，列出实测可用 forms 与受限选项。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。只关闭新的 native request 路径，已有 legacy approval 行为与审计记录保留。

报告写入 `handoffs/NP-07-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
