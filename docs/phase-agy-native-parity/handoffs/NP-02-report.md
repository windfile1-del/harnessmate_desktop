# NP-02 交付报告 · 共享契约、持久化和核心接入（R1–R6 修复后 G1 候选）

## 1. 基线、分支与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-02`（共享契约、持久化和核心接入） |
| 当前状态 | **G1 候选修订 v2**（已关闭独立评审 `NP-02-review-e58948f.md` 全部 R1–R6 事项，待独立复验与 NP-01 / NP-03 联审冻结） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| Reviewed Base（G0 Checkpoint） | `a01280176348974a0ddc00fd491afddc1d985c9e`（`docs(agy-np): record G0 worktree and verification setup`） |
| 当前工作分支 / Worktree | `np02_shared_contracts_persistence` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np02_shared_contracts_persistence`（经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np02_shared_contracts_persistence`） |
| 初版 G1 候选代码提交 | `a701cf780665e13d20cbc20600e650a924780811`（`feat(agy-np-02): freeze AGY native v1 contracts, additive SQLite migration, and core wiring seams`） |
| 初版报告提交（对应独立评审） | `e58948f7e55cb152cd8cbd44392fef5302936b4e`（`docs(agy-np-02): add NP-02 G1 handoff report`） |
| **最新候选代码提交（R1–R6 修复）** | **`4cde14eefa23c1e3339c4b849a57ab4e3f5723ed`**（`fix(agy-np-02): close R1-R6 review blockers on generation fencing, concurrent idempotency, WS replay, feature-off, and contract alignment`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'` |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（additive、`BEGIN IMMEDIATE`、可重试） |
| Plugin SDK 版本变更 | 无变更（遵循决策 `U06`，第一方先消费，`packages/plugin-api` 零修改） |
| `MASTER_PROGRESS.md` | 未修改（按约定由总指挥统一更新） |

## 2. 独立评审阻塞与复验项（R1–R6）修复对照

针对独立评审 `docs/phase-agy-native-parity/reviews/NP-02-review-e58948f.md` 中的 R1–R6 全部事项，已在 `4cde14eefa23c1e3339c4b849a57ab4e3f5723ed` 完整闭环并补齐回归测试：

| 评审编号 | 原始问题 | 修复实现与强制不变量 | 涉及文件 | 复验用例 |
| --- | --- | --- | --- | --- |
| **R1**（阻塞） | 换代隔离失守：旧事件可将 `native_runtime_bindings.current_generation` 写回旧代；换代后旧代审批仍可被 CAS 认领；新句柄未强制换代 | `commitSnapshotAndEvent` 在 `BEGIN IMMEDIATE` 内先校验 `session_id`、`instance_id` 和 `current_generation`（早于 `mutationKey` 与写操作），不匹配抛 `NativePersistenceError('STALE_BINDING')` 且绝不回写 `current_generation`；`advanceGeneration` 与 `ensureBinding(advanceIfExisting: true)` 原子将旧代 `pending` 审批置为 `connection_lost`、`claimed` 置为 `delivery_unknown` 并清空 `retention_reasons_json`；`claimApprovalReceiptCas` 校验当前 `current_generation`，对旧代拒绝并标记 `staleGeneration: true`；`readProjection` 将旧代实体降级为 `stale`（`reasonCode: 'prior_generation_snapshot'`）且仅返回当前代 `requestIds`/`relations`；`readCapabilitySnapshot` 强制 `row.generation === current_generation`；`SessionManager.ensureLiveHandle` 每次重建 AGY live handle 传入 `advanceGeneration: true`，`registry.getActiveBinding` 以 DB 为权威来源 | `persistence.ts`, `registry.ts`, `session-manager.ts` | `agy-np02-persistence-migration.test.ts`（换代写栅栏、旧代 CAS 拒绝、旧代实体降级、能力快照代际校验）；`agy-np02-wiring-provenance.test.ts`（重连/新 handle 自动换代） |
| **R2**（阻塞） | 并发同键双执行 & 控制/审批未闭环授权：两个同键并发请求同时进入执行桩；控制能力未开放或目标不存在仍抵达执行桩；审批绕过 pending 校对或后置 CAS | `claimIdempotentReceipt` 在 `BEGIN IMMEDIATE` 内验证当前代；仅 `replayed === false` 允许调用领域 Port；并发同键命中 `state === 'claimed'` 直接返回 `409 BUSY`（零重复执行）；Port 抛错时收据原子转入 `delivery_unknown`（`500 DELIVERY_UNKNOWN`），同键重试返回 `409 DELIVERY_UNKNOWN` 不重发。`POST /control` 在 claim 与派发前校验当前代能力目录授权（`422 UNSUPPORTED_ACTION`）、目标实体存在且属当前代（`404 NOT_FOUND`）、`expectedRevision` 一致（`409 STALE_BINDING`）。`POST /requests/:approvalId/resolve` 校验 pending 请求存在于 `(runtimeId, generation)`（否则 `404` 或 `409 ALREADY_RESOLVED`）、校验 `allowedOptionIds` 与 free-form 规则、**先获取 DB CAS 再派发 `resolveNativeRequest`**，并与旧 `SessionManager.resolveRuntimeRequest` 共享同一审批 CAS | `persistence.ts`, `routes.ts`, `session-manager.ts` | `agy-np02-wiring-provenance.test.ts`（并发同键 `409 BUSY` 单次执行、异常 `delivery_unknown`、`POST /control` 未授权/无目标/修订冲突拦截、`POST /requests/:id/resolve` 前置 CAS 与旧入口互斥） |
| **R3**（阻塞） | WS 补缺截断 & 换代静默丢弃：积压 >500 条事件时只回放首 500 条即报完成；跨 `runtimeId` / `generation` 事件静默丢弃 | `ws-feed.ts` 的 `subscribe_native` 持续分页回放（每页 `500`，上限 `DEFAULT_MAX_REPLAY_EVENTS = 10_000`）直到 `!page.hasMore` 才发送 `native_replay_complete`；超出回放上限或 `liveBuffer`（>2048）/ `ws.bufferedAmount`（>4 MiB）溢出时发送 `native_resync_required`；实时流遇到 `runtimeId` 或 `generation` 变化立即下发 `native_resync_required`（`runtime_changed` / `generation_changed`）并自动退订，不再静默丢弃；`handleUpgrade` 捕获非法 `decodeURIComponent`（`400`）并限制仅 AGY 会话（`422`）；`listEvents` 严格按 `WHERE runtime_id = ? AND generation = ? AND seq > ?` 过滤并返回 `binding` 与 `asOfSeq` | `ws-feed.ts`, `persistence.ts`, `routes.ts` | `agy-np02-wiring-provenance.test.ts`（501 条积压多页完整回放 + 实时第 502 条无缝衔接、超限 `native_resync_required`、`runtime_changed`/`generation_changed` 主动通知、畸形 sessionId 400） |
| **R4**（高） | Feature-Off 纯度、公有 DTO 白名单与来源边界：`enabled: false` 仍可能写库或回显旧态；`workflow` 资源与 `command` 返回存在宽泛 `Record<string, unknown>`；插件 native 路径 provenance 边界 | `!flags.enabled` 时 `SessionManager.ensureLiveHandle` 零原生 DB 写入、不挂运行时钩子（仅 `observatoryTap: true` 挂轻量 `createObservatoryOnlyHooks`）；开启态原生接入包裹异常保护不拖垮旧 AGY 启动；`GET /snapshot` 始终返回 Known Empty（`enabled: false`, `status: 'disconnected'`, `asOfSeq: 0`）、`GET /capabilities` 始终返回 `not_tested`、timeline/workflow 路由绝不调用 reader Port（`sourceUnavailableReason: 'native_runtime_disabled'`）；`NativeWorkflowResourceResponseSchema.items` 收紧为 4 类白名单判别联合 `NativeWorkflowResourceItemDtoSchema`（`board_post`/`phase`/`log_entry`/`artifact_ref`），`NativeCommandResponse.data` 收紧为标量字典 `summaryFields` 并在持久化/响应前做 Zod 校验；`runPluginAction` 对 `kind: 'native'` 统一走 `plugin_automated` provenance 校验 | `session-manager.ts`, `registry.ts`, `routes.ts`, `agy-native-v1.ts` | `agy-native-v1.test.ts`（白名单拒绝私有字段/任意对象）；`agy-np02-wiring-provenance.test.ts`（Feature-Off 零写入与 Known Empty 纯度、插件 `plugin_automated` 来源校验） |
| **R5**（中） | 延迟结算退出路径、Hook 异常隔离与回放审批隔离：hold 后无标准退出入口；`onPromptSettled` 抛错触发二次失败回调；history_replay 收到 server request | 新增 `NativeTurnSettlementSink`（`settleTurn({ binding, turnId, settlement })`）与 `NativeLifecyclePort.attachSettlementSink?`，`SessionManager` 构造期注入 `settleHeldNativeTurn`，校验活动 turn 与 binding generation、调用 `handle.releaseHeldTurn?.(turnId)` 并执行唯一一次旧版 `turn.completed` 结算（重复调用幂等返回 `{ settled: false }`）；`strict-acp-adapter.ts` 的 `runPrompt()` 改为双参数 `.then(onFulfilled, onRejected)` 并对 `onPromptSettled` 做 `try/catch` 隔离（异常绝不触发重复失败结算），且传入 `isCurrentTurn`；`onIncomingServerRequest` 增加 `channel: 'live' \| 'history_replay'`，`history_replay` 阶段的服务端请求直接以 `-32601` 拒绝且绝不进入实时审批队列 | `types.ts`, `registry.ts`, `session-manager.ts`, `strict-acp-adapter.ts`, `harnesses/types.ts` | `agy-np02-wiring-provenance.test.ts`（延迟 hold -> `settleTurn` 唯一一次 `turn.completed`、重复调用幂等、`onPromptSettled` 异常不触发双结算、`history_replay` 请求拒绝） |
| **R6**（中） | NP-01 采集格式与 NP-03 前端 DTO 对齐缺口 | 对照 NP-01 `capture-v1.schema.json` 与 `windows-1.5.16-clean-v1.ndjson`（9 条样本），将 `NativeCaptureRecordV1Schema`（别名 `NativeCaptureMetadataSchema`）1:1 对齐（`layer`、`provenance`、`correlation`、整数/null `protocol`、16 种 `messageKind`、5 种 `direction`）；对照 NP-03 `packages/web/src/lib/native-client.ts`，统一 `GET /snapshot` 包裹 `{ schemaVersion: 1, contractRevision, enabled, projection }`、`GET /events` 返回 `binding`+`asOfSeq`+`nextSeq`+`nextCursor`、`GET /timeline` 返回 `binding`+`scopeKind`+`sourceUnavailableReason`，并补齐可选字段 `Activity.summary`/`evidence`、`WorkflowDetail.objective`、`CapabilityActionDescriptor.label`、`NativeRequestSummaryDto.allowsFreeText`/`receiptId`/`evidence` | `agy-native-v1.ts`, `routes.ts`, `registry.ts` | `agy-native-v1.test.ts`（实采格式 NDJSON 校验、NP-03 信封与样本 DTO 校验） |

## 3. 实际变更路径与所有权核对

全部变更严格落在 NP-02 允许写入范围内（`packages/plugin-api/**`、`packages/web/**`、`MASTER_PROGRESS.md`、其他 Harness Adapter 逻辑均零改动）：

| 路径 | 类别 | 说明 |
| --- | --- | --- |
| `packages/protocol/src/agy-native-v1.ts` | 新增（R4/R6 更新） | Zod 单一事实来源：branded scopes、Evidence/PublicEvidenceDto allowlist、`Observed<T>`、Activity/Work/Agent/Relation/Workflow、严格白名单 `NativeWorkflowResourceItemDtoSchema`、scalar-only `summaryFields`、CapabilityDescriptor、PendingNativeRequest/ReceiptState、9 类 `NativeCanonicalEvent`、对齐 NP-03 的 REST/WS v1 信封、1:1 对齐 NP-01 的 `NativeCaptureRecordV1Schema`、Known Empty 与 NP-03 样本工厂 |
| `packages/protocol/src/index.ts` | 增量导出 | `export * from './agy-native-v1.js'` |
| `packages/daemon/src/db/sqlite.ts` | 增量迁移 | 新增 `component_schema_migrations` 与 6 张 `native_runtime_*` 独立表（`BEGIN IMMEDIATE` 原子迁移、前向版本探测 `getNativeRuntimeSchemaStatus()`、`runInImmediateTransaction()`） |
| `packages/daemon/src/harnesses/agy/native/wiring/types.ts` | 新增（R5 更新） | `AgyNativeFeatureFlags`（默认全关）、`PromptContext`、`TurnSettlement`、`NativeTurnSettlementSink`、`NativeIngress`、`NativeObservation`、Transport Observatory Tap 接口与 NP-04/05/06/07/15 领域 Port 定义 |
| `packages/daemon/src/harnesses/agy/native/wiring/provenance.ts` | 新增 | 不可伪造的 `Symbol + WeakSet` 密封 `AgyDispatchProvenance` 与集中式消费级 AGY 来源控制策略 |
| `packages/daemon/src/harnesses/agy/native/wiring/persistence.ts` | 新增（R1/R2/R3 更新） | `NativeRuntimeStore`：单事务 `commitSnapshotAndEvent`（含严格代际栅栏与 `mutationKey` 去重）、换代原子作废旧审批、单父无环关系不变量、同代 `listEvents` 与 cursor `RESYNC_REQUIRED`、SHA-256 幂等收据与并发 `claimed`/`delivery_unknown` 状态机、代际感知的审批 CAS |
| `packages/daemon/src/harnesses/agy/native/wiring/registry.ts` | 新增（R1/R4/R5 更新） | `AgyNativeRuntimeRegistry`：模块注册表、Feature-Off 纯净惰性骨架、DB 权威 binding 读取与 `advanceRuntimeGeneration`、`NativeTurnSettlementSink` 注入、订阅隔离、adapter DI hooks |
| `packages/daemon/src/harnesses/agy/native/wiring/routes.ts` | 新增（R2/R4/R6 更新） | `/api/v1/sessions/:id/native/*` 全部 REST 路由、loopback-only 本机写边界、前向 schema 门控、并发同键 `409 BUSY` / `delivery_unknown`、`/control` 能力与目标前置校验、`/requests/:id/resolve` 前置 pending 与 CAS 闭环、Zod 出参校验 |
| `packages/daemon/src/harnesses/agy/native/wiring/ws-feed.ts` | 新增（R3 更新） | 独立版本化 WS 命名空间 `/api/v1/sessions/:id/native/ws`：多页有界完整回放、`liveBuffer`/背压溢出保护、跨 `runtimeId`/`generation` 主动 `native_resync_required`、畸形 URL 400 与非 AGY 会话 422 |
| `packages/daemon/src/harnesses/agy/native/wiring/index.ts` | 新增 | NP-02 wiring 模块统一导出入口 |
| `packages/daemon/src/harnesses/jsonrpc.ts` | 增量接线 | `connectionId`、单调 `ingressOrdinal` / `egressOrdinal`、按类型区分 `rpcPendingKey`、可选 `onTransportFrame` 观测挂载点、`requestWithMeta`、`respond`/`respondError` 写入状态返回 |
| `packages/daemon/src/harnesses/types.ts` | 增量接线（R5 更新） | `AdapterSessionConfig.nativeRuntimeHooks`、`AdapterSessionHandle.listRetentionReasons` / `getConnectionId` / `releaseHeldTurn`（均可选，非 AGY 零影响） |
| `packages/daemon/src/harnesses/acp/strict-acp-adapter.ts` | 增量接线（R5 更新） | 捕获每轮 `PromptContext`、`releaseHeldTurn`、双参数 `.then` + `onPromptSettled` 异常隔离与 `isCurrentTurn`、转发 `NativeIngress`（区分 `live` / `history_replay`）、拒绝 `history_replay` 期间服务端请求 |
| `packages/daemon/src/harnesses/agy/agy-protocol.ts` | 增量接线 | `AGY_DEFAULT_ACP_PROTOCOL_VERSION = 1`、`resolveAgyRequestedProtocolVersion`（默认 v1，关闭 v2 Preview）、`extractAgyOriginSessionId` |
| `packages/daemon/src/harnesses/agy/agy-driver.ts` | 增量接线 | `evaluatePermissionPolicy` 支持 `{ nativePermissionsActive }` 开关 |
| `packages/daemon/src/core/session-manager.ts` | 增量接线（R1/R2/R4/R5 更新） | Feature-Off 零写入与轻量 Observatory 挂载、新 live handle 自动 `advanceGeneration: true`、延迟结算 `settleHeldNativeTurn` 单次结算闭环、旧 `resolveRuntimeRequest` 共享审批 CAS、warm pool 保活、cancel/reconnect hooks、不可伪造来源校验 |
| `packages/daemon/src/core/orchestrator-service.ts` | 仅来源控制 | `delegateTask()` 与 `drainPendingWakeups()` 拦截个人 OAuth AGY 自动委派/唤醒 |
| `packages/daemon/src/core/failover-service.ts` | 仅来源控制 | `recommendFailover()` 将任意来源→个人 OAuth AGY 自动故障转移降级为手动一键切换 |
| `packages/daemon/src/server/app.ts` | 增量接线 | 实例化默认 feature-off 的 `AgyNativeRuntimeRegistry` 与 `NativeWsFeedGateway`；注册 REST 与 WS 路由；`POST /turns` 签发 `human_direct` 来源证明；隔离插件命令入口接入 `plugin_automated` 来源校验 |
| `packages/protocol/tests/agy-native-v1.test.ts` | 新增测试（R4/R6 扩充） | 5 项测试：branded scopes、DTO allowlist 与 strict workflow 资源、权限校验、NP-01 实采格式校验、NP-03 信封与样本 |
| `packages/daemon/tests/agy-np02-persistence-migration.test.ts` | 新增测试（R1 扩充） | 5 项测试：迁移/重复迁移/前向版本、事务回滚/去重/单父无环、换代隔离栅栏/旧代 CAS 拒绝/实体降级/能力代际校验、同代 cursor resync、幂等收据与断连失效 |
| `packages/daemon/tests/agy-np02-wiring-provenance.test.ts` | 新增测试（R2/R3/R4/R5 扩充） | 4 项测试：不可伪造来源与 Orchestrator/Failover/SessionManager/插件拦截、PromptContext + 延迟结算退出 + Hook 异常隔离 + replay 权限拒绝 + Transport Tap、Feature-Off 纯度与 REST/WS 路由、501 条多页 WS 回放 + 跨代 resync + 并发同键 409 BUSY + `delivery_unknown` + `/control` 与审批前置闭环 |

## 4. 契约摘要与 NP-01 / NP-03 联审对齐清单

### 4.1 最小响应样本（Known Empty `GET /api/v1/sessions/:id/native/snapshot`）

```json
{
  "schemaVersion": 1,
  "contractRevision": "agy-native-v1.0.0",
  "enabled": false,
  "projection": {
    "binding": {
      "runtimeId": "nrt_sess_example",
      "sessionId": "sess_example",
      "instanceId": "agy",
      "generation": "gen_0"
    },
    "asOfSeq": 0,
    "status": "disconnected",
    "capabilitiesRevision": 0,
    "retentionReasons": [],
    "activities": [],
    "work": [],
    "agents": [],
    "relations": [],
    "workflows": [],
    "requestIds": [],
    "requests": []
  }
}
```

### 4.2 NP-01 / NP-03 候选契约对齐清单

- **NP-01（Protocol Observatory）— 已 1:1 对齐**：
  - `@harnessmate/protocol` 导出 `NativeCaptureRecordV1Schema`（向后兼容别名 `NativeCaptureMetadataSchema`），逐字段对齐 NP-01 `scripts/agy-np/observatory/schema/capture-v1.schema.json`（已用 NP-01 `windows-1.5.16-clean-v1.ndjson` 结构样本通过单测）。
  - 后端零侵入挂载点：`daemon.nativeRegistry.addTransportObserver(obs)`，即使 `enabled: false`，只需 `observatoryTap: true` 即可通过 `createObservatoryOnlyHooks` 接收全量入/出站帧（`connectionId`、单调 `ordinal`、`monotonicMs`、`rpcId`）。
- **NP-03（AGY Workbench Frontend）— 联审差异与 03b 切换说明**：
  - **已统一为同一信封**：
    - `GET /snapshot` -> `{ schemaVersion: 1, contractRevision, enabled, projection }`
    - `GET /events` -> `{ schemaVersion: 1, binding, runtimeId, generation, asOfSeq, events, nextSeq, nextCursor, hasMore }`
    - `GET /activity/:id/timeline` 与 `GET /agents/:id/timeline` -> `{ schemaVersion: 1, binding, scopeKind, scopeId, revision, items, nextPageToken, hasMore, sourceUnavailableReason? }`
    - `GET /workflows/:id/:resource` -> `{ schemaVersion: 1, binding, workflowId, resource, revision, available, sourceUnavailableReason?, items, nextPageToken, hasMore }`（`items` 为严格 4 类白名单 DTO）
    - 可选 UI 展示字段已补齐：`Activity.summary` / `evidence`、`WorkflowDetail.objective`、`CapabilityActionDescriptor.label`、`NativeRequestSummaryDto.allowsFreeText` / `receiptId` / `evidence`。
  - **需 NP-03b 切换至冻结权威契约的 4 处桩字段差异（已在 `08_Shared_Contracts.md` 与 `agy-native-v1.ts` 明确）**：
    1. `NativeRuntimeProjection` 使用 `retentionReasons` 与 `requests?: NativeRequestSummaryDto[]`（NP-03a 离线桩为 `leaseReasons` 与 `receipts` map）。
    2. `PublicEvidenceDto.freshness` 为 `'live' | 'snapshot' | 'stale' | 'replay' | 'host'`（较 NP-03a 桩的 `'fresh' | 'stale' | 'unknown'` 更精细，避免混淆回放与实时）。
    3. WS 通道使用独立命名空间 `/api/v1/sessions/:id/native/ws` 与帧类型 `subscribe_native` / `unsubscribe_native` / `ping` -> `native_hello` / `native_event` / `native_replay_complete` / `native_resync_required` / `native_pong` / `native_error`，以保障旧 `/api/v1/ws` 100% 兼容。
    4. `POST /commands` 响应采用判别联合 `kind: 'inspect' | 'accepted'`（标量 `summaryFields`）；`POST /requests/:approvalId/resolve` 采用 `outcome: 'selected' | 'cancelled' | 'form_submitted'` + `optionId` / `formPayload`（NP-03a 桩为 `decision`）。

## 5. 测试验证与证据分级

### 5.1 执行命令与结果

运行环境：Windows，Node.js（`node:sqlite`），pnpm 11.21.0（离线 store `D:\HarnessMate\agy-np-pnpm-store`），所有检查均在最新候选代码提交 **`4cde14eefa23c1e3339c4b849a57ab4e3f5723ed`** 上通过：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm typecheck` | `0` | 6/6 workspace 包零错误（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（静态类型） |
| `pnpm build` | `0` | 6/6 workspace 包构建成功（含 `web` Vite 产物） | `synthetic`（构建） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过，Plugin SDK 契约无破坏 | `synthetic`（契约） |
| `pnpm test`（总计） | `0` | **199/199 tests passed**（`protocol` 6/6、`daemon` 143/143、`web` 50/50、`electron` 0/0） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/protocol test` | `0` | `protocol.test.ts` (1) + `agy-native-v1.test.ts` (5) 全部通过 | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np02-persistence-migration.test.ts tests/agy-np02-wiring-provenance.test.ts` | `0` | 9/9 NP-02 专项测试全部通过（覆盖全部 R1–R6 复现与边界场景） | `synthetic` |
| `agy-replay-protocol.test.ts`（含于 `pnpm test`） | `0` | 2/2（7 阶段 AGY 1.5.14 脱敏回放 + `-32000` auth-required）全部通过，v1 行为不变 | `replay_with_provenance`（E05） |
| `git diff --check` | `0` | 无空白符或冲突标记问题 | 静态检查 |

### 5.2 未执行的检查与原因

- **未执行真机授权模型的 live 采样（`live_raw` / `live_hm` / `official_comparison`）**：NP-02 属 G1 契约/持久化/核心接线任务，不消耗测试额度；按 `U01` 与 `12_Test_Strategy.md`，真机 Gemini 3.8 Flash 采样归属 NP-01 / NP-04 / G2 联调并在专用已登录 Profile 上执行。

### 5.3 覆盖的源码/证据与能力编号

- 源码审计对应：`S02`、`S03`、`S04`、`S05`、`S06`、`S07`、`S08`、`S13`、`S14`、`S15`、`S16`、`S17`、`S18`、`S21`、`S24`
- 协议/基线证据引用：`E02`、`E03`（v1 默认、关闭 v2 Preview）、`E05`（AGY 1.5.14 回放不回归）、`E08`（捕获 PromptContext 与原生权限开关设计依据）
- 风险缓解：`R-02`、`R-07`、`R-08`、`R-11`、`R-12`、`R-14`、`R-15`、`R-17`
- Capability 等级说明：本次 G1 仅交付契约与 feature-off 骨架，**不提升任何官方能力矩阵等级**（默认 descriptor 全部诚实标记为 `not_tested` / `verifiedLevel: null`）。

### 5.4 数据与其他 Harness 回归结论

- **旧 DB / 新 DB / 重复迁移**：验证 pre-NP-02 数据库升级后旧 `sessions`/`workspaces` 行与 `last_seq` 完整保留；原生事件写入绝不推进旧 `sessions.last_seq` 或 Context Handoff 水位。
- **跨 Harness 回归**：`adapters-codex.test.ts` (5)、`adapters-claude.test.ts` (4)、`adapters-acp.test.ts` (4)、`phase3-external-adapters.test.ts` (5，DeepSeek & OpenCode)、`unified-context-bridge.test.ts` (3)、`handoff-v2.test.ts` (12)、`multi-harness-orchestrator.test.ts` (6)、`usage-failover.test.ts` (3)、`daemon.test.ts` (6)、`session-explorer-approval.test.ts` (7)、`plugin-*` 全套测试及 `packages/web` 全套 50 项 UI 测试全部通过。

## 6. 范围外事项与后续协作请求

- **按 G1 范围明确未实现（留交后续领域 owner）**：
  - Reactive 后台任务追踪与 quiescence 逻辑（NP-04，通过 `NativeLifecyclePort` + `NativeTurnSettlementSink` 接入）。
  - Child Agent 身份解析与父子关系推断（NP-05）。
  - 动态命令目录发现与路由执行器实现（NP-06）。
  - 原生审批/提问/Elicitation 路由实现与旧审批中心融合（NP-07）。
  - Swarm / Boost / Teamwork / Dynamic / Goal / Schedule 业务观察器与恢复扫描器（NP-08–NP-15）。
  - ACP v2 Preview 分支（按决策 D01/E03 保持关闭，默认 v1）。
  - 第三方插件只读 `nativeRuntime.read` 权限与 Plugin SDK 新版本（按 U06 暂不开放）。
- **协作与冲突声明**：当前零文件冲突；请总指挥安排独立审查者基于 `4cde14eefa23c1e3339c4b849a57ab4e3f5723ed` 复验 R1–R6，并与 NP-01、NP-03 确认第 4.2 节对齐清单后冻结 G1。

## 7. 给独立审查者的复验命令与回滚方案

### 7.1 审查者快速复验

```powershell
git diff --stat a01280176348974a0ddc00fd491afddc1d985c9e..4cde14eefa23c1e3339c4b849a57ab4e3f5723ed
git diff --check a01280176348974a0ddc00fd491afddc1d985c9e..4cde14eefa23c1e3339c4b849a57ab4e3f5723ed
pnpm typecheck
pnpm build
pnpm contracts:check
pnpm --filter @harnessmate/protocol test
pnpm --filter @harnessmate/daemon test -- tests/agy-np02-persistence-migration.test.ts tests/agy-np02-wiring-provenance.test.ts tests/agy-replay-protocol.test.ts
pnpm test
```

### 7.2 回滚策略与命令

1. **优先功能门控回退（无损、保留新增表）**：保持/切回 `DEFAULT_AGY_NATIVE_FEATURE_FLAGS`（`enabled: false`, `nativeLifecycle: false`, `nativePermissions: false`, `nativeCommands: false`, `observatoryTap: false`, `acpV2Preview: false`），所有旧端点、旧 turn 结算与历史表立即恢复基线行为；**禁止 down-migrate 删除用户表**。
2. **代码提交回滚**：
   - 如仅回滚 R1–R6 修复提交：
     ```powershell
     git revert --no-edit 4cde14eefa23c1e3339c4b849a57ab4e3f5723ed
     ```
   - 如完整回滚 NP-02 全部代码提交至 G0 基线（逆序）：
     ```powershell
     git revert --no-edit 4cde14eefa23c1e3339c4b849a57ab4e3f5723ed a701cf780665e13d20cbc20600e650a924780811
     ```
   - 如合入集成分支后产生 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
   - 数据库中已创建的 `component_schema_migrations` 与 `native_runtime_*` 表为纯增量表，回滚代码后旧版 `HarnessMateStore` 可继续正常打开并读写所有原有业务表。
