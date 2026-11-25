# 08 · 公共接口与数据契约 v0.1 提案

工作包以本稿对齐。NP-02 接管实现时用 Zod 与 TypeScript 单一来源、版本化事件和 fixture 冻结 v1。以下代码为 HarnessMate 内部类型设计。与 Google/ACP wire 的映射和核验范围在 [协议证据](06_Protocol_Evidence.md) 中。旧 `SessionStatus` 和公共 Plugin API 基线另有契约。

## 身份、证据和状态

~~~ts
type OpaqueId<Name extends string> = string & { readonly idKind: Name }
type RuntimeId = OpaqueId<'Runtime'>
type ActivityId = OpaqueId<'Activity'>
type WorkId = OpaqueId<'Work'>
type NativeAgentId = OpaqueId<'NativeAgent'>
type WorkflowId = OpaqueId<'Workflow'>
type BindingGeneration = OpaqueId<'BindingGeneration'>
type RpcId = string | number

interface RuntimeBinding {
  runtimeId: RuntimeId
  sessionId: string // existing HM session ID
  instanceId: string
  generation: BindingGeneration
}

type Evidence =
  | { kind: 'live_protocol'; connectionId: string; ingressOrdinal: number; wireVariant: string; observedAt: number }
  | { kind: 'native_snapshot'; sourceId: string; schemaVersion: string; observedAt: number; staleAt: number }
  | { kind: 'host_observation'; observedAt: number; reasonCode: string }
  | { kind: 'replay'; captureId: string; ordinal: number; observedAt: number }

type Observed<T> =
  | { kind: 'known'; value: T; evidence: Evidence }
  | { kind: 'stale'; last?: T; evidence?: Evidence; reasonCode: string }
  | { kind: 'unknown'; reasonCode: string }

type AgentForeground = 'running' | 'requires_action' | 'idle' | 'unknown'
type WorkState =
  | 'queued' | 'running' | 'waiting' | 'requires_action' | 'finished'
  | 'failed' | 'cancelled' | 'unknown'
type Blocking = 'confirmed_blocking' | 'detached' | 'unknown'
type ActivityStatus =
  | 'starting' | 'running' | 'waiting_background' | 'requires_action' | 'quiescent'
  | 'cancelling' | 'reconciling' | 'finished' | 'failed' | 'cancelled' | 'unknown'

interface NativeAlias {
  namespace: 'session' | 'tool_call' | 'task' | 'native_record' | 'workflow'
  // Complete storage key also contains runtimeId, source/account binding and applicable generation.
  originSessionId?: string
  nativeValue: string // server only. Public APIs use opaque HM IDs.
  incarnation?: string
  evidence: Evidence
}

interface Activity {
  id: ActivityId
  turnId: string | null
  origin: 'user_turn' | 'native_continuation' | 'native_task' | 'recovery'
  priorActivityId?: ActivityId
  workId?: WorkId
  agentId?: NativeAgentId
  state: ActivityStatus
  updatedAt: number
}

interface NativeWork {
  id: WorkId
  kind: 'finite_command' | 'daemon' | 'subagent' | 'schedule' | 'workflow_step' | 'unknown'
  originActivityId?: ActivityId
  ownerAgentId?: NativeAgentId
  workflowId?: WorkflowId
  blocking: Blocking
  state: Observed<WorkState>
  outcome?: Observed<'succeeded' | 'failed' | 'cancelled'>
  observedLabel?: string
  revision: number
}

interface AgentIdentity {
  id: NativeAgentId
  role?: Observed<string>
  label?: Observed<string>
  foreground: Observed<AgentForeground>
  status?: Observed<WorkState>
  launchWorkIds: WorkId[]
  lineage: 'confirmed' | 'unresolved' | 'conflicting'
  revision: number
}

interface NativeRelationship {
  parentAgentId: NativeAgentId
  childAgentId: NativeAgentId
  confidence: 'protocol_confirmed' | 'snapshot_confirmed'
  launchWorkId?: WorkId
  evidence: Evidence
}
~~~

`replay` 或只读 snapshot 能解释历史内容。当前 epoch 的审批或控制只用 live evidence。可存低信度候选供诊断，不能创建确证父边、可执行控件或更新 confirmed progress。`finished` 是可观察运行终态，成功由 outcome 单列；普通 idle 与 finished 解耦。`blocking` 和进程保活分别计算。原生别名储存规则按 codec 声明，默认同 generation，只有通过持久 ID 证据才跨重连映射。RPC ID 数字和字符串保持类型，response 必须与原始类型一致。

~~~ts
type WorkflowKind = 'swarm' | 'boost' | 'teamwork' | 'dynamic' | 'goal' | 'schedule'
type NativeStage = {
  id: string
  label: string
  state: Observed<WorkState>
  after?: string[] // only when the source proves it
  agentIds?: NativeAgentId[]
}

type WorkflowDetail =
  | { kind: 'swarm'; coordinatorId?: NativeAgentId; workerIds: NativeAgentId[]; board: Observed<'available' | 'upstream_limited'> }
  | { kind: 'boost'; phases?: NativeStage[] }
  | { kind: 'teamwork'; scopingActivityId?: ActivityId; promptArtifactId?: string; projectLabel?: string; milestones?: NativeStage[] }
  | { kind: 'dynamic'; scriptArtifactId?: string; steps?: NativeStage[]; resultArtifactIds?: string[] }
  | { kind: 'goal'; objective?: string; verificationArtifactIds?: string[] }
  | { kind: 'schedule'; scheduleLabel?: string; nextAt?: Observed<number>; occurrenceWorkIds: WorkId[] }

interface NativeWorkflow {
  id: WorkflowId
  originActivityId: ActivityId
  state: Observed<WorkState>
  detail: WorkflowDetail
  revision: number
}

type GateState = 'available' | 'unknown' | 'unsupported' | 'upstream_limited' | 'not_tested'
type CommandLane = 'query' | 'config' | 'live_workflow' | 'manager'

interface CapabilityDescriptor {
  id: string // NP capability catalog ID
  snapshotRevision: number
  surfaces: Array<'desktop' | 'cli' | 'ide' | 'acp'>
  tierHint?: string
  versionNote?: string
  advertised: boolean | null
  launch: GateState
  observe: GateState
  control: GateState
  localRead: GateState
  actions: Array<{ key: string; lane: CommandLane; gate: GateState; reasonCode?: string }>
  evidenceRefs: string[]
  verifiedLevel: 0 | 1 | 2 | 3 | 4 | 5 | null
}
~~~

ID 与状态投影可使用 strict discriminated unions。Batch / call entity 与 workflow/child 不共用 ID。Board、Artifact 和 logs 是可分页资源，事件只携带引用及最小摘要。App 本地与 ACP 实录不同源，字段级 provenance 和 last observed 时刻必须可查。

## 适配器和生命周期接入缝

~~~ts
interface NativeIngress {
  binding: RuntimeBinding
  connectionId: string
  ingressOrdinal: number
  channel: 'live' | 'history_replay'
  originSession?: string // private native session ID
  wire: unknown
}

interface NativeLifecyclePort {
  acceptFrame(envelope: NativeIngress): void
  acceptNativeObservation(observation: NativeObservation): void
  handleTransportClosed(binding: RuntimeBinding, connectionId: string): void
  listRetentionReasons(binding: RuntimeBinding): string[]
  decideTurnSettlement(turnId: string, binding: RuntimeBinding): TurnSettlement
}
~~~

`NativeObservation` 按 registry 的 typed patch union 实现。Codecs 不越过 transport 直接存储或关 turn。用户 turn ingress 有独立 PromptContext，捕获真实 turnId、request ordinal、scope 与最初能力快照。`TurnSettlement` 为 `held(reasonIds)`、`eligible(outcome)`、`disconnected(reason)`，只有当前代的确定结算写旧 `turn.*`。对其他 Harness 走旧代码。Native 状态 detach 不复用 `activeTurnMeta` 宿主槽。Can-steer、Cancel、reload/evict 在同一 port 查 generation 和保活原因。

## Canonical Event 与前端投影

NativeCanonicalEvent 使用现有 canonical envelope 的概念和 ID 约定。`schemaVersion: 1`，`seq` 是本 native runtime feed 内递增序号，`turnId` 可为空，`hmAnchorSeq` 可关联真实旧序号。现有旧端 REST/WS 仅看原有 events；新版显式获取 native feed；如果未来需要合并 public union，单独做兼容评审。Native 写入不推进 Context Handoff 的旧 watermark。

| Event type | 最小 payload |
| --- | --- |
| `native.runtime.changed` | binding generation、connection state、可解释的 lease reason、revision |
| `native.activity.changed` | activity upsert、origin 与已证实的 work link，可合并文本 delta pages |
| `native.work.changed` | Work 投影、state/source、显式终态或 stale |
| `native.agent.changed` · `native.relation.changed` | agent upsert、父子边写入/撤销、证据状态 |
| `native.workflow.changed` | workflow view revision、已确认模式与 phase/Board/Artifact 资源 ID |
| `native.request.changed` | HM approval id、目标 opaque ID、状态与 receipt ID |
| `native.capabilities.changed` | revision、已变化的 descriptor IDs |
| `native.recovery.changed` | reconnect/reconcile 状态、失效的 generation 和不确定项 |

同连接先按 ingress ordinal 处理，再用稳定上游事件 ID/完成回执去重。有证据的同一 message/part seq 用作去重。无稳定 ID 的完整文本 chunk 不能按字符串去重，否则会误吞合法重复文本。API retry 以用户提交 idempotencyKey 与 payload 摘要去重，同 key 不同请求返回冲突。投影按 `runtimeId + generation + seq` 幂等，跨 generation 丢旧流。REST snapshot 带 `asOfSeq`，客户端缓存先获取快照、续接该水位、补缺再应用 live。cursor 失效返回 resync，日志滚动用分页而非全量清空视图。

~~~ts
interface NativeRuntimeProjection {
  schemaVersion: 1
  binding: RuntimeBinding
  asOfSeq: number
  status: 'attached' | 'reconciling' | 'disconnected'
  capabilitiesRevision: number
  activities: Activity[]
  work: NativeWork[]
  agents: AgentIdentity[]
  relations: NativeRelationship[]
  workflows: NativeWorkflow[]
  requestIds: string[]
}
~~~

对外 projection 不直接序列化内部 `Evidence.connectionId`、`NativeAlias`、raw payload 或未脱敏 path。发布使用 DTO Zod allowlist，`evidence` 转为只读 `sourceKind、freshness、observedAt、reasonCode`。旧 turn 卡只是一条关联链接和尚未迁移的历史记录。

## 审批路由

~~~ts
interface PendingNativeRequest {
  approvalId: string
  runtimeId: RuntimeId
  generation: BindingGeneration
  connectionId: string
  wireRequestId: RpcId
  occurrence: number
  actualNativeSessionId: string
  agentId?: NativeAgentId
  activityId?: ActivityId
  kind: 'permission' | 'question' | 'elicitation'
  allowedOptionIds: string[]
  deadline?: number
}
type NativeRequestReceiptState =
  | 'pending' | 'claimed' | 'response_written' | 'cancelled' | 'expired'
  | 'connection_lost' | 'delivery_unknown'
~~~

只保存批准中心现有内容和脱敏的 route/receipt metadata，RPC ID、当前选项及 encode 函数留内存。前端提交 HM approval ID、generation、所选原生 option ID 或经验证的 form payload，服务端重新校验 profile 与目标。数据库 CAS claim 防双点与自动过期竞态。写 response 成功仅记录 `response_written`，对端动作由后续帧确认；写入后进程崩溃会保留 `delivery_unknown`，重连不得重放旧授权。旧 /runtime-requests 可兼容展示绑定正确的 HM 请求，native 请求答复由同一 owner 做 scope/CAS。对仅转发到父 session 的请求保存原生实际 target，已验证的 child 归属另标。未知请求的 deadline 与用户可用动作独立，默认安全拒绝/取消或规范错误。

## API 与插件

新端点提案前缀 `/api/v1/sessions/:id/native`，`schemaVersion=1`，沿用现有 daemon 认证。由 02 注册路由和 validation，任务 owner 通过已定义 service 接入。

| Method / path | 内容 |
| --- | --- |
| GET `/snapshot` · `/capabilities` | session/instance 授权，返回 `asOfSeq` 或 capability revision，省略 private identifiers |
| GET `/events?after=<seq>&limit=...` | 纯读，限页，`nextCursor` 可验证 runtime/generation。`410 RESYNC_REQUIRED` 时重新取快照 |
| GET `/activity/:activityId/timeline` · `/agents/:agentId/timeline` | page token + revision，按 actor 分页，text/diffs 有界 |
| GET `/workflows/:workflowId/:resource` | 核实 mode 和 resource allowlist，board/phases/logs/artifacts 分页 |
| POST `/commands` | `{bindingGeneration, catalogRevision, capabilityId, actionKey, args, idempotencyKey}`。返回 inspect result 或 `202 {activityId, turnId?}`。`409 STALE_BINDING/BUSY`、`422 UNSUPPORTED_ACTION`、`403 FORBIDDEN` 明确区分 |
| POST `/control` | `{generation, target:{type,id}, action, expectedRevision, idempotencyKey}`。只给 descriptor 中当前可控目标。暂仅原生确证的 actions |
| POST `/requests/:approvalId/resolve` | scope 验证/CAS，回复写入状态。兼容旧审批端点调用相同服务 |
| WS native feed | 待 NP-02 选现有 WS 的显式版本化订阅或局部 namespace。使用与 GET /events 相同的序号及补缺协议 |

写操作保留本机直接交互边界，已有远端读授权只能接收白名单投影。控制输入使用已验证的 opaque ID 和 action keys。API errors 不带私有 path/token。插件一期由第一方 React hooks 消费 native client，继续使用 `composer.actions`、`inspector.tabs`、`harness.settings`、`chat.block`。若确有第三方只读需求，再评审 `nativeRuntime.read` 权限、session/workspace 作用域、限额分页、iframe bridge 与最小 capability 事件。保留 V4/V5 已有行为。审批、ACP wire、child 控制、Browser 和 raw logs 由宿主负责。新增能力生成公开 schema 与 contract report，经 NP-02 单一所有者审核后启用。

## SQLite 与迁移

现有数据库以 idempotent 初始化和列迁移为主。NP 独立组件版本：`component='agy-native-runtime'`，候选版本 1 由 NP-02 总表编号并实际验证。推荐同 SQLite DB 新表，不修改 AGY 目录，不复用 `subagent_runs`、session_turn_items 或 effect_outbox 执行 native work。

| 表（提案） | 约束与用途 |
| --- | --- |
| `native_runtime_bindings` | `runtimeId` PK，按 HM session+instance+bindingRevision 唯一。保存不可变 profile/source ref、当前 generation 和游标 |
| `native_runtime_entities` | `(runtimeId, entityKind, entityId)` PK，schemaVersion、rev、scope、JSON gated projection；按 session/rev 和 lineage 查询 |
| `native_runtime_aliases` · `native_runtime_relations` | alias namespace/target scope/generation unique、FK、单 child 祖先无环不变量。ambiguous observations 另记诊断 |
| `native_runtime_events` | `(runtimeId, seq)` PK，mutation key 可去重。durable event 与 snapshot 在一事务，成功后 publish |
| `native_runtime_receipts` | durable user idempotency 及审批 resolve receipt。无激活连接的 effect 永不 replay |

迁移用 `BEGIN IMMEDIATE`、可重试且防部分应用。旧 HM DB 首次加载按可选无数据处理，保留原 rows 和原 status。版本高于 reader 时关闭 native 路由并继续读旧内容。功能关闭与代码回滚保留新增表，不 down-migrate 删除用户记录。灾难恢复用用户可审查的 D 盘备份。快照和事件的保留、间隔与 quota 按 NP-16 验证并记录，明确当前读游标过期如何复位。

接口冻结条件由 NP-02 给出 package path、Zod 版本与 event/key examples，再更新 [进度](MASTER_PROGRESS.md)；本文是规划版本，不是现有生产导出的 API。
