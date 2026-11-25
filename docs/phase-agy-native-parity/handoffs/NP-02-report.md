# NP-02 交付报告 · 共享契约、持久化和核心接入（G1 契约冻结）

## 1. 基线、分支与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-02`（共享契约、持久化和核心接入） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| Reviewed Base（G0 Checkpoint） | `a01280176348974a0ddc00fd491afddc1d985c9e`（`docs(agy-np): record G0 worktree and verification setup`） |
| 当前工作分支 / Worktree | `np02_shared_contracts_persistence` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np02_shared_contracts_persistence`（经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np02_shared_contracts_persistence`） |
| 契约冻结代码提交（Frozen Contract SHA） | `a701cf780665e13d20cbc20600e650a924780811`（`feat(agy-np-02): freeze AGY native v1 contracts, additive SQLite migration, and core wiring seams`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'` |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（additive、`BEGIN IMMEDIATE`、可重试） |
| Plugin SDK 版本变更 | 无变更（遵循决策 `U06`，第一方先消费，`packages/plugin-api` 零修改） |
| `MASTER_PROGRESS.md` | 未修改（按约定由总指挥统一更新） |

## 2. 实际变更路径与所有权核对

全部变更严格落在 NP-02 允许写入范围内（`packages/plugin-api/**`、`packages/web/**`、其他 Harness Adapter 逻辑均零改动）：

| 路径 | 类别 | 说明 |
| --- | --- | --- |
| `packages/protocol/src/agy-native-v1.ts` | 新增 | Zod 单一事实来源：branded scopes、Evidence/PublicEvidenceDto allowlist、`Observed<T>`、Activity/Work/Agent/Relation/Workflow、CapabilityDescriptor、PendingNativeRequest/ReceiptState、9 类 `NativeCanonicalEvent`、REST/WS v1 请求响应与错误码、`NativeCaptureMetadataSchema`、Known Empty 与 NP-03 样本工厂 |
| `packages/protocol/src/index.ts` | 增量导出 | `export * from './agy-native-v1.js'` |
| `packages/daemon/src/db/sqlite.ts` | 增量迁移 | 新增 `component_schema_migrations` 与 6 张 `native_runtime_*` 独立表（`BEGIN IMMEDIATE` 原子迁移、向前版本探测 `getNativeRuntimeSchemaStatus()`、`runInImmediateTransaction()`） |
| `packages/daemon/src/harnesses/agy/native/wiring/types.ts` | 新增 | `AgyNativeFeatureFlags`（默认全关）、`PromptContext`、`TurnSettlement`、`NativeIngress`、`NativeObservation`、Transport Observatory Tap 接口与 NP-04/05/06/07/15 领域 Port 定义 |
| `packages/daemon/src/harnesses/agy/native/wiring/provenance.ts` | 新增 | 不可伪造的 `Symbol + WeakSet` 密封 `AgyDispatchProvenance` 与集中式消费级 AGY 来源控制策略（`evaluateAgyConsumerProvenance` / `assertAgyConsumerProvenance`） |
| `packages/daemon/src/harnesses/agy/native/wiring/persistence.ts` | 新增 | `NativeRuntimeStore`：单事务 `commitSnapshotAndEvent`（snapshot + event 原子提交/回滚、`mutationKey` 去重）、单父无环关系不变量、cursor 编解码与 `RESYNC_REQUIRED` 校验、SHA-256 幂等收据冲突检查、审批 CAS claim 与断连失效（`connection_lost` / `delivery_unknown`） |
| `packages/daemon/src/harnesses/agy/native/wiring/registry.ts` | 新增 | `AgyNativeRuntimeRegistry`：模块注册表、默认 feature-off 惰性骨架、单写者提交并发布、订阅隔离、adapter DI hooks、turn settlement/warm pool/cancel/profile generation/reconnect hooks |
| `packages/daemon/src/harnesses/agy/native/wiring/routes.ts` | 新增 | `/api/v1/sessions/:id/native/*` 全部 REST 路由注册、本机写边界校验（loopback-only）、schema 新版本门控（`503 NATIVE_SCHEMA_NEWER_THAN_READER`）、Zod 严格校验与错误映射 |
| `packages/daemon/src/harnesses/agy/native/wiring/ws-feed.ts` | 新增 | 独立版本化 WS 命名空间 `/api/v1/sessions/:id/native/ws`（复用 `RemoteAuthService` + `isLocalBrowserRequest`、补缺回放 + 实时流 + `native_resync_required`），保持旧 `/api/v1/ws` 100% 兼容 |
| `packages/daemon/src/harnesses/agy/native/wiring/index.ts` | 新增 | NP-02 wiring 模块统一导出入口 |
| `packages/daemon/src/harnesses/jsonrpc.ts` | 增量接线 | `connectionId`、单调 `ingressOrdinal` / `egressOrdinal`、按类型区分的 `rpcPendingKey`（数字/字符串 RPC ID 不串型）、可选 `onTransportFrame` 观测挂载点、`requestWithMeta`、`respond`/`respondError` 返回写入布尔结果 |
| `packages/daemon/src/harnesses/types.ts` | 增量接线 | `AdapterSessionConfig.nativeRuntimeHooks`、`AdapterSessionHandle.listRetentionReasons` / `getConnectionId`（均可选，非 AGY 零影响） |
| `packages/daemon/src/harnesses/acp/strict-acp-adapter.ts` | 增量接线 | 捕获每轮 `PromptContext` 防止取消后旧响应污染新轮次；转发 `NativeIngress`（区分 `live` / `history_replay`）；接入可选 `onIncomingServerRequest` / `onPromptStarted` / `onPromptSettled` / `onTransportClosed`（默认关闭时完全走旧路径） |
| `packages/daemon/src/harnesses/agy/agy-protocol.ts` | 增量接线 | `AGY_DEFAULT_ACP_PROTOCOL_VERSION = 1`、`resolveAgyRequestedProtocolVersion`（默认 v1，关闭 v2 Preview）、`extractAgyOriginSessionId` |
| `packages/daemon/src/harnesses/agy/agy-driver.ts` | 增量接线 | `evaluatePermissionPolicy` 支持 `{ nativePermissionsActive }` 开关（关闭时保持原有取消行为，NP-07 启用后可下放给原生审批路由） |
| `packages/daemon/src/core/session-manager.ts` | 增量接线 | 可选注入 `AgyNativeRuntimeRegistry`；AGY live handle 绑定/generation 换代与 reconnect 通知；warm pool `listRetentionReasons` / `checkWarmPoolEvict` 保活检查；cancel hook；`turn.completed` 单次结算门控；可选 `dispatchProvenance` 不可伪造来源校验；启动时原生 binding 标记 reconciling |
| `packages/daemon/src/core/orchestrator-service.ts` | 仅来源控制 | `delegateTask()` 拦截向个人 OAuth AGY 自动委派子任务（`E_CONSUMER_PROVENANCE_BLOCKED`）；`drainPendingWakeups()` 拦截向个人 OAuth AGY 自动注入编排汇总唤醒 |
| `packages/daemon/src/core/failover-service.ts` | 仅来源控制 | `recommendFailover()` 扩展至任意来源→个人 OAuth AGY 的自动故障转移降级为手动一键切换（保留非消费级 API Key/Enterprise 与手动切换） |
| `packages/daemon/src/server/app.ts` | 增量接线 | 实例化默认 feature-off 的 `AgyNativeRuntimeRegistry` 与 `NativeWsFeedGateway`；注册 `/api/v1/sessions/:id/native/*` 与 WS upgrade 路由；`POST /turns` 签发 `human_direct` 来源证明；隔离插件 `setNativeCommandRunner` 接入 `plugin_automated` 来源校验 |
| `packages/protocol/tests/agy-native-v1.test.ts` | 新增测试 | Zod 契约、branded scopes、DTO allowlist 脱敏、权限输入校验、Known Empty 与 NP-03 样本测试 |
| `packages/daemon/tests/agy-np02-persistence-migration.test.ts` | 新增测试 | 旧 DB / 新 DB / 重复迁移 / 新版本 reader 关闭 / 事务崩溃回滚 / mutationKey 去重 / 关系单父无环 / cursor resync / idempotency 冲突 / 审批 CAS 与断连失效 |
| `packages/daemon/tests/agy-np02-wiring-provenance.test.ts` | 新增测试 | 不可伪造来源策略、Orchestrator/Failover/SessionManager 来源拦截、捕获 `PromptContext` 防旧响应污染、Transport Tap、REST/WS 路由与默认 feature-off 集成测试 |

## 3. 契约冻结摘要与可消费端点

### 3.1 包导出路径与主要符号

- `@harnessmate/protocol`（`packages/protocol/src/agy-native-v1.ts`）：
  - 版本常量：`AGY_NATIVE_CONTRACT_VERSION`（`1`）、`AGY_NATIVE_CONTRACT_REVISION`（`'agy-native-v1.0.0'`）、`AGY_NATIVE_MIGRATION_COMPONENT`（`'agy-native-runtime'`）、`AGY_NATIVE_MIGRATION_VERSION`（`1`）
  - Branded Scopes：`RuntimeIdSchema`、`ActivityIdSchema`、`WorkIdSchema`、`NativeAgentIdSchema`、`WorkflowIdSchema`、`BindingGenerationSchema`、`RpcIdSchema`
  - 投影与脱敏：`NativeRuntimeProjectionSchema`、`PublicEvidenceDtoSchema`、`toPublicEvidenceDto`、`sanitizeNativeWorkForPublic`、`sanitizeAgentIdentityForPublic`、`sanitizeNativeRelationshipForPublic`、`sanitizeNativeWorkflowForPublic`
  - 事件与流：`NativeCanonicalEventSchema`（9 类）、`NativeWsClientFrameSchema`、`NativeWsServerFrameSchema`、`NativeCaptureMetadataSchema`
  - Fixture 工厂：`createKnownEmptyNativeProjection`、`createSampleNativeProjectionFixture`、`createDefaultAgyCapabilityDescriptors`
- 后端接线入口（`packages/daemon/src/harnesses/agy/native/wiring/index.ts`）：
  - `AgyNativeRuntimeRegistry`、`NativeRuntimeStore`、`registerAgyNativeRoutes`、`NativeWsFeedGateway`
  - `mintAgyDispatchProvenance`、`evaluateAgyConsumerProvenance`、`assertAgyConsumerProvenance`
  - 领域 Port 接口：`NativeLifecyclePort`、`NativePermissionPort`、`NativeCommandRouterPort`、`NativeTimelineReaderPort`、`NativeWorkflowResourceReaderPort`、`NativeTransportObserver`

### 3.2 REST 与 WS 端点（前缀 `/api/v1/sessions/:id/native`，`schemaVersion = 1`）

| 端点 | 默认 feature-off 行为 | 校验与边界 |
| --- | --- | --- |
| `GET /snapshot` | `200` 返回 Known Empty（`enabled: false`, `asOfSeq: 0`） | 仅白名单 DTO，不含 `connectionId` / `NativeAlias` / raw payload / 私有路径 |
| `GET /capabilities` | `200` 返回默认 `not_tested` descriptor 列表 | 按 `capabilitiesRevision` 标识版本 |
| `GET /events?after=&limit=&cursor=&generation=` | `200` 空页或已有持久化页 | 游标无效/换代/超前/被裁剪返回 `410 RESYNC_REQUIRED` |
| `GET /activity/:activityId/timeline` · `GET /agents/:agentId/timeline` | `200` 空分页 | 有界条目与 `pageToken` |
| `GET /workflows/:workflowId/:resource` | `200` `available: false` | 资源白名单 `board \| phases \| logs \| artifacts` |
| `POST /commands` | `503 NATIVE_RUNTIME_DISABLED` | 仅 loopback 本机可写；校验 `bindingGeneration`、`catalogRevision`、`idempotencyKey` + SHA-256 摘要、`human_direct` 来源；区分 `409 STALE_BINDING/IDEMPOTENCY_CONFLICT`、`422 UNSUPPORTED_ACTION`、`403 FORBIDDEN` |
| `POST /control` | `503 NATIVE_RUNTIME_DISABLED` | 仅 loopback 本机可写；校验 `generation`、opaque `target`、`expectedRevision`、`idempotencyKey` |
| `POST /requests/:approvalId/resolve` | `503 NATIVE_RUNTIME_DISABLED` | 仅 loopback 本机可写；严格校验 `outcome`/`optionId`/`formPayload`、核对 `allowedOptionIds` 与 `generation`、CAS 冲突返回 `409` |
| `WS /api/v1/sessions/:id/native/ws` | 连接返回 `native_hello (enabled: false)` | 复用 `RemoteAuthService` + `isLocalBrowserRequest`；支持 `subscribe_native`/`unsubscribe_native`/`ping`、补缺回放、实时推送与 `native_resync_required` |

最小响应样本（Known Empty `GET /api/v1/sessions/:id/native/snapshot`）：

```json
{
  "schemaVersion": 1,
  "contractRevision": "agy-native-v1.0.0",
  "enabled": false,
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
```

## 4. 已完成事项与范围外/未覆盖事项

- **已完成**：
  - 冻结 `agy-native-v1.0.0` Zod 单一事实来源类型、DTO allowlist、9 类原生事件、REST/WS 协议、NP-01 采集元数据对齐及 NP-03 Known Empty/Sample Fixture。
  - SQLite `agy-native-runtime` v1 独立增量迁移（`BEGIN IMMEDIATE`）、前向版本保护（旧 reader 对新 DB 安全关闭 native 路由且保留旧表可读）、6 张专用表与单事务 snapshot+event 原子提交。
  - 不可伪造消费级 AGY 来源策略并接入 `OrchestratorService`、`FailoverCoordinator`、`SessionManager`、`POST /turns` 及隔离插件命令入口。
  - `StdioJsonRpcClient`、`AcpSessionHandle`、`AgyAdapter`、`SessionManager` 与 `server/app.ts` 全部依赖注入接入缝与默认 feature-off 惰性注册表。
- **按 G1 范围明确未实现（留交后续领域 owner）**：
  - Reactive 后台任务追踪与 quiescence 逻辑（NP-04）。
  - Child Agent 身份解析与父子关系推断（NP-05）。
  - 动态命令目录发现与路由执行器实现（NP-06）。
  - 原生审批/提问/Elicitation 路由实现与旧审批中心融合（NP-07）。
  - Swarm / Boost / Teamwork / Dynamic / Goal / Schedule 业务观察器与恢复扫描器（NP-08–NP-15）。
  - ACP v2 Preview 分支（按决策 D01/E03 保持关闭，默认 v1）。
  - 第三方插件只读 `nativeRuntime.read` 权限与 Plugin SDK 新版本（按 U06 暂不开放）。

## 5. 测试验证与证据分级

### 5.1 执行命令与结果

运行环境：Windows，Node.js（`node:sqlite`），pnpm 11.21.0（依赖来自 `D:\HarnessMate\agy-np-pnpm-store`），所有检查均在代码冻结提交 `a701cf780665e13d20cbc20600e650a924780811` 上通过：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm typecheck` | `0` | 6/6 workspace 包零错误（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（静态类型） |
| `pnpm build` | `0` | 6/6 workspace 包构建成功（含 `web` Vite 产物） | `synthetic`（构建） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过，Plugin SDK 契约无破坏 | `synthetic`（契约） |
| `pnpm test`（总计） | `0` | **197/197 tests passed**（`protocol` 5/5、`daemon` 142/142、`web` 50/50、`electron` 0/0） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/protocol test` | `0` | `protocol.test.ts` (1) + `agy-native-v1.test.ts` (4) 全部通过 | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np02-persistence-migration.test.ts tests/agy-np02-wiring-provenance.test.ts` | `0` | 8/8 NP-02 专项测试全部通过（迁移/回滚/前向版本/去重/单父无环/cursor/幂等/CAS/来源控制/PromptContext/REST/WS） | `synthetic` |
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

## 6. 跨任务协作接口与审阅指引

- **给 NP-01（Observatory）**：
  - 使用 `@harnessmate/protocol` 中的 `NativeCaptureMetadataSchema` 与 `wiring/types.ts` 中的 `NativeTransportObserver` / `NativeTransportFrame`。
  - 通过 `daemon.nativeRegistry.addTransportObserver(obs)` 并开启 `observatoryTap: true` 即可零侵入接收 `StdioJsonRpcClient` 的全量入/出站帧（含 `connectionId`、单调 `ordinal`、`monotonicMs`、`rpcId`）。
- **给 NP-03（Frontend）**：
  - 联审 `NativeRuntimeProjectionSchema`、`NativeCapabilitiesResponseSchema`、`NativeRequestSummaryDtoSchema`、REST `/api/v1/sessions/:id/native/*` 与 WS `/api/v1/sessions/:id/native/ws` 的 `cursor` / `410 RESYNC_REQUIRED` 契约。
  - 可直接导入 `createKnownEmptyNativeProjection` 与 `createSampleNativeProjectionFixture` 用于 03a 离线预览与 03b 联调。
- **给 NP-04 / NP-05 / NP-06 / NP-07 / NP-15**：
  - 零跨改共享核心文件，直接实现 `NativeLifecyclePort`、`NativePermissionPort`、`NativeCommandRouterPort`、`NativeTimelineReaderPort`、`NativeWorkflowResourceReaderPort`，并通过 `nativeRegistry.registerModules(...)` 挂载。
  - 如需追加字段或新迁移版本（v2+），请附用例提交变更提议由 NP-02 单一 owner 统一编号与落地。
- **冲突声明**：当前零文件冲突；后续合入集成分支时按 `10_Task_Dependency_Graph.md` 经独立评审进入 G1 检查点。

## 7. 给独立审查者的复验命令与回滚方案

### 7.1 审查者快速复验

```powershell
git diff --stat a01280176348974a0ddc00fd491afddc1d985c9e..a701cf780665e13d20cbc20600e650a924780811
git diff --check a01280176348974a0ddc00fd491afddc1d985c9e..a701cf780665e13d20cbc20600e650a924780811
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
   - 如需回滚代码冻结提交：
     ```powershell
     git revert --no-edit a701cf780665e13d20cbc20600e650a924780811
     ```
   - 如合入集成分支后产生 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
   - 数据库中已创建的 `component_schema_migrations` 与 `native_runtime_*` 表为纯增量表，回滚代码后旧版 `HarnessMateStore` 可继续正常打开并读写所有原有业务表。
