# NP-10 · AGY Teamwork 对照文档、已证实体与无法获取字段清单

日期：2026-11-25（Asia/Shanghai）。本清单对应 **NP-10 Teamwork 访谈、项目与里程碑**（Capability ID: `AGY-W07` / alias `agy.workflow.teamwork`），基于 G2 固定基线 `agy-np-g2`（`fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c`）、源码审计基线 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`、官方研究 [03_Official_Research.md](../03_Official_Research.md) 与协议证据 [06_Protocol_Evidence.md](../06_Protocol_Evidence.md) 编制。

---

## 1. 官方表面与 HarnessMate 对照矩阵

> 说明：官方 App / CLI 行为以官方文档（[antigravity.google/docs/teamwork](https://antigravity.google/docs/teamwork/)、[artifact-review](https://antigravity.google/docs/artifact-review/)、[CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16)）为 `L0` 规范输入；本机未在登录付费账号下执行真实 `/teamwork` 采样，因此所有 `live_raw` / `live_hm` / `official_comparison` 均保持 `Not Tested`，不抬升能力矩阵真机等级。

| Teamwork 阶段 / 能力 | 官方 Desktop App / CLI 行为（L0 文档） | 当前 ACP v1 可观测状态（E02/E05/1.5.16） | HarnessMate NP-10 实现与降级行为 |
| --- | --- | --- | --- |
| 命令入口 `/teamwork <goal>` | 官方 App / CLI 付费计划下提供 `/teamwork <goal>`；不从旧 `/teamwork-preview` 推断支持 | 依赖登录后 `available_commands_update` 广告；空白握手（E02/E04）无命令目录 | `AgyTeamworkWorkflowObserver` 仅认规范命令名 `/teamwork`；遇到 `/teamwork-preview` 明确标记 `legacy_preview_unverified` 并拒绝发起（`LEGACY_PREVIEW_COMMAND_REJECTED`）；向 NP-06 贡献 `TEAMWORK_CAPABILITY_CONTRIBUTION` |
| 需求访谈（Scoping Questions） | 逐题收集项目目标、约束与验收口径，形成结构化问答进度 | ACP v1 标准含 `session/request_permission`（含 AGY `interaction_*`）与可选 `elicitation/create`，1.5.16 修复转发；真实 Teamwork 访谈帧待采 | 消费 NP-07 typed requests/receipts 与结构化 wire 信号，按 `dedupKey` / `approvalId` / `toolCallId` 幂等去重；重复投递与迟到 `pending` 均不覆盖已有终态回执；禁止用自由文本代填固定选项 |
| Prompt Artifact 审阅与批准关口 | 生成 Prompt Artifact，作为创建 Teamwork 项目的唯一正式批准关口；拒绝则不建项目 | ACP v1 尚无已证实的原生 Artifact 行级评论/批准 wire 协议；`agy-artifacts.ts` 仅为 `brain/<id>/` 只读列举；旧 `AgyArtifactReviewPanel.tsx` 通过发送聊天文本模拟批准 | **严禁通过自然语言聊天消息伪造批准**（`NATURAL_LANGUAGE_APPROVAL_FORBIDDEN`）；预留冻结 `TeamworkArtifactReviewPort` 给 NP-14，默认启用降级桩（`canApproveViaNativeProtocol: false`），UI 禁用原生批准按钮并指引官方 App/CLI；正式拒绝后强制保证零项目、零角色、零里程碑并阻断后续越界帧 |
| 原生项目目录与作用域 | 原生 Teamwork 创建并管理专属项目目录，与当前普通工作区可分离 | 尚无已实录的 ACP project directory 字段；HM session workspace 由 SessionManager 独立管理 | public DTO 严禁暴露原始主机路径（`containsRawHostPath === false`）；将 `HM Session Workspace` 与 `AGY 原生 Teamwork 项目目录` 分区展示；项目路径仅保存在服务端内部，必须经 `TeamworkPathAuthorizationPort`（根目录白名单 + `reparseCheckPassed` + 拦截 `..` 与 UNC）授权后方可只读打开；HM 绝不自行创建 Teamwork 项目目录 |
| 多角色协作（Sentinel / Project Orchestrator / Workers / Auditor） | Sentinel 守卫范围，Project Orchestrator 编排里程碑，Workers 执行，Auditor 审计交付 | ACP v1 `subagent_update` 为可选扩展，1.5.16 尚未在实机登录抓包证实 Teamwork 角色元数据字段 | 仅展示经 NP-05 亲缘确证（`lineage === 'confirmed'`）的角色并支持跳转 Subagent Manager；`unresolved` / `conflicting` 候选隔离在独立警告区且不挂入正式里程碑；绝不从普通 `agent_message_chunk` 文本中虚构角色 |
| 里程碑与审计门控（Milestones & Audit） | 多阶段里程碑推进、依赖关系与审计核验 | `WorkflowDetailSchema`（`kind: 'teamwork'`）已冻结 `milestones?: NativeStage[]`；原生实时里程碑帧待实录 | 无里程碑证据时在 DTO 与 UI 中隐藏里程碑进度图；有证实里程碑时通过 `WorkflowDetailDtoSchema` 与 `NativeWorkflowResourceReaderPort`（`phases` / `logs` / `artifacts`）分页呈现，`board` 诚实返回 `teamwork_board_not_applicable` |
| 断线、换代、重连与门控回滚 | 重连后需与服务端状态对齐，旧审批不重放 | ACP v1 `session/resume` 无历史重放，`session/load` 存在 replay 帧 | 断连将活跃工作流与里程碑标为 `stale`，待决问题/审批冻结为 `connection_lost`（永不重放）；换代拦截旧 generation/connectionId 帧；`history_replay` 通道严禁修改审批门控；关闭 `teamworkEnabled` 或 `reviewControlEnabled` 后已呈现历史保持只读 |

---

## 2. 已证实实体与可稳定投影字段清单

以下实体与字段均严格对应 `@harnessmate/protocol`（`agy-native-v1.0.0`）或 NP-10 私有 allowlist Zod schema（`agy-np10-teamwork-v1.0.0`），并已在离线合成/回放与 SQLite 持久化集成测试中验证：

| 实体 / 契约 | 标识与 Schema | 当前已验证字段 | 证据等级与来源 |
| --- | --- | --- | --- |
| `NativeWorkflow`（Teamwork 分支） | `WorkflowId`（opaque）· `WorkflowDetailSchema` / `WorkflowDetailDtoSchema` (`kind: 'teamwork'`) | `id`, `originActivityId`, `state: Observed<WorkState>`, `detail.scopingActivityId`, `detail.promptArtifactId`, `detail.projectLabel`, `detail.milestones?: NativeStage[]`, `revision` | `synthetic` + `agy-native-v1.0.0` 共享契约校验与 SQLite `AgyNativeRuntimeRegistry` 实测落库 |
| `TeamworkScopingQuestionDto` | `questionId`（opaque）· `dedupKey` · optional `approvalId` | `promptSummary`, `requestKind`, `receiptState`, `receiptId`, `selectedOptionLabel`, `occurrence`, `duplicateDeliveriesIgnored`, `evidence` | `synthetic`（对齐 E05 `interaction_*` 形状与 NP-07 `NativeRequestSummaryDto`） |
| `TeamworkPromptArtifactDto` | `artifactId`（opaque） | `title`, `revision`, `reviewGate`, `canApproveViaNativeProtocol`, `reviewControlEnabled`, `approvalRequestId`, `approvalReceiptId`, `approvalReceiptState`, `officialFallbackHint`, `previewExcerpt?`, `evidence` | `synthetic` + NP-14 冻结 `TeamworkArtifactReviewPort` 降级桩/注入桩双测 |
| `TeamworkProjectScopeDto` | `hmWorkspace` vs `nativeProject`（无原始路径） | `hmWorkspace.{workspaceId, label, isolatedFromNativeProject: true}`；`nativeProject.{created, projectScopeId, projectLabel, scopeRelationship, pathAccessGate, pathOpenAuthorized, authorizationReasonCode, evidence}` | `synthetic` + `containsRawHostPath` 零泄露断言 + `createStrictTeamworkPathAuthorizer` 边界测试 |
| `TeamworkRoleAttributionDto` | `agentId: NativeAgentId`（opaque） | `roleKind` (`sentinel` \| `project_orchestrator` \| `milestone_worker` \| `auditor` \| `unknown_role`), `displayLabel`, `lineage`, `foreground`, `milestoneIds`, `evidence` | `synthetic`（消费 NP-05 `AgentIdentity`，严格隔离 `confirmed` 与 `unresolved`/`conflicting`） |
| `TeamworkAuditGateDto` & `TeamworkArtifactRefDto` | `auditId` / `artifactId`（opaque） | `milestoneId`, `label`, `verdict`, `auditorAgentId`, `artifactId`, `category`, `artifactKind`, `revision`, `updatedAt`, `evidence` | `synthetic` + `NativeWorkflowResourceResponseSchema` 分页白名单校验 |
| `CapabilityDescriptor`（`AGY-W07`） | `TEAMWORK_CAPABILITY_CONTRIBUTION` | `slashName: 'teamwork'`, `tierHint: 'Pro/Ultra'`, `launch: 'not_tested'`, `observe: 'upstream_limited'`, `control: 'upstream_limited'`, `localRead: 'not_tested'` | `synthetic`（接入 NP-06 `AgyNativeCommandCatalogService.registerWorkflowDescriptor` 实测） |

---

## 3. 无法获取 / 尚未在真实 AGY 1.5.16+ ACP 证实的字段清单

以下字段在本阶段 **严禁猜测、严禁从自然语言推断、严禁默认开启对应控制**：

| 无法获取 / 待实证字段或能力 | 当前状态与原因 | 当前安全降级行为 | 解锁所需真实证据（T12 授权实测事项） |
| --- | --- | --- | --- |
| 真实 `/teamwork` 在登录态 ACP `available_commands_update` 的精确参数提示与计划资格字段 | 空白握手（E02/E04）返回 `-32000`，且 `/teamwork` 为付费计划功能，未获本轮商业额度授权 | 保持 `launch: 'not_tested'`，无广告或未登录时阻断发起，UI 展示官方说明 | 在用户明确授权的付费测试 Profile 上运行能力发现，脱敏记录 `available_commands_update` 与账号计划类别 |
| Teamwork 访谈逐题的真实 ACP wire 封装形态（`interaction_*` vs `elicitation/create` vs 自定义 `_meta`） | 1.5.16 仅官方声明修复转发，尚无实机抓包样本证明确切 `_meta` 键名 | `wire-codec.ts` 规则显式标注 `synthetic_candidate_pending_live_capture`；未携带结构化字段的帧一律不推断 | 在授权实测中采集 `/teamwork` 访谈 1–2 题的脱敏 ACP 帧，核验 `toolCallId` / `requestId` / `_meta` 字段 |
| Prompt Artifact 的原生 ACP 审阅/行级评论/正式批准 RPC 方法与返回码 | ACP v1 无标准 Artifact Review 写接口；NP-14 Artifact Control 属于 G3 第二批 | 默认关闭 `reviewControlEnabled` 并使用 NP-14 降级桩，禁用审批按钮并引导官方 App/CLI；绝不发送自然语言批准文本 | 待 NP-14 完成 Artifact 协议调研与实机抓取后，确认是否可通过 ACP RPC 正式批准或永久保留 App-only 降级 |
| Teamwork 原生项目目录路径字段及 App/CLI 本地只读项目元文件 schema | E06 普查仅见 `brain/` 与 `tasks/` 存在性，未证实 Teamwork 专属项目目录在 ACP 中的暴露字段 | 未收到授权/原生事件时 `nativeProject.created = false`；路径默认 `requires_explicit_authorization` 且禁止打开 | 实机记录 Prompt Artifact 批准后（以及拒绝后）ACP 帧与只读目录变化，验证批准前后目录是否创建及真实路径归属 |
| Sentinel / Project Orchestrator / Auditor 的真实 `subagent_update` 角色标识字段 | 1.5.16 空白握手未证明 ACP 发 `subagent_update`，历史 App child JSON 仅见 `subagentDescriptor:object` | 仅接收经 NP-05 确证的 `AgentIdentity`；无确证亲缘的角色一律留在 `unconfirmedRoleCandidates` | 实机对比官方 App/CLI 与 ACP 在首个里程碑启动时的子 Agent 列表、角色名与父子边证据 |
| 里程碑（Milestones）与 Audit Gate 的原生结构化推送事件（`sessionUpdate` 类型、依赖边 `after`、终态 `outcome`） | 当前无 1.5.16 Teamwork 实录证明是否存在专用 `teamwork_update` 或复用 `plan` / `tool_call` | 无结构化证据时省略 `milestones`，前端隐藏里程碑图表；不把 `finished` 自动当 `succeeded` | 在授权 T12 首里程碑实测中逐帧记录里程碑与审计事件，并对照官方 App 界面状态 |
| Teamwork 专属停止/暂停单里程碑控制接口 | 当前 G2 仅证实根会话 `session/cancel` | 不在 Teamwork Studio 暴露未验证的单里程碑/单角色停止按钮 | 确认上游是否提供工作流/子会话级取消控制后再按能力门控开放 |
