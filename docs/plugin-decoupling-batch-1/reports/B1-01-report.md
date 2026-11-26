# B1-01 交付报告 · 实例装配与公共契约

## 1. 基线与交付分支

- **共同基线**：`b1/baseline`（`4eed4537f15d48e4e99d2cd033fe2e15d578083f`）
- **交付分支**：`b1/b1-01-plugin-host`
- **仅修改本任务拥有文件**：
  - `packages/plugin-api/src/manifest.ts`、`packages/plugin-api/src/context.ts`
  - `packages/plugin-sdk/src/index.ts`、`packages/plugin-sdk/src/testing.ts`
  - `docs/plugin-api/*`（通过 `pnpm contracts:generate` 生成）
  - `packages/daemon/src/plugin-host/composition/harnessmate-core.json`、`profile.ts`、`bindings.ts`、`resolve-route.ts`
  - `packages/daemon/src/plugin-host/runtime/lifecycle.ts`
  - `packages/daemon/src/plugin-host/isolation/isolated-manager.ts`、`isolated-process.ts`、`rpc-router.ts`、`runner-bootstrap.ts`
  - `packages/daemon/src/plugins/plugin-manager.ts`
  - `packages/daemon/tests/b1-01-service-resolution.test.ts`
  - `docs/plugin-decoupling-batch-1/reports/B1-01-report.md`

---

## 2. 公共契约、版本与导出清单

### 2.1 平级契约与服务版本（`@harnessmate/plugin-api`）

- `PEER_CONTRACTS` / `PEER_CONTRACT_NAMES` 新增：
  - `historySource`: `'history.source.v1'`（`HISTORY_SOURCE_CONTRACT_VERSION = '1.0.0'`）
  - `historyImport`: `'history.import.v1'`（`HISTORY_IMPORT_CONTRACT_VERSION = '1.0.0'`）
  - `sessionSearch`: `'session.search.v1'`（`SESSION_SEARCH_CONTRACT_VERSION = '1.0.0'`）
- `PEER_CONTRACT_VERSIONS` 汇总 `browser.v1`、`filePreview.v1`、`approval.policy.v1`、`history.source.v1`、`history.import.v1`、`session.search.v1`。
- 业务 DTO 与错误类型：
  - `ServiceMethodResult<T>`、`PeerServiceError`、`PeerServiceErrorCode`（`'invalid_request' | 'source_unreadable' | 'not_importable' | 'cancelled' | 'conflict'`）
  - `history.source.v1`：`HistoryRef`、`HistoryWorkspaceHint`、`HistorySummary`、`HistoryItem`、`HistorySourceDiscoverRequest/Result`、`HistorySourceReadRequest/Result`、`HistorySourceCancelRequest/Result`、`HistorySourceStatusResult`、`HistorySourceServiceV1`
  - `history.import.v1`：`PublicPortableSessionBundleV2`、`ImportInput`、`HistoryImportPreviewRequest/Result`、`HistoryImportRequest/Result`、`HistoryImportCancelRequest/Result`、`HistoryImportServiceV1`
  - `session.search.v1`：`PublicSessionSearchHighlight`、`PublicSessionSearchHit`、`SessionSearchQueryRequest/Result`、`SessionSearchReindexRequest/Result`、`SessionSearchCancelReindexRequest/Result`、`SessionSearchStatusResult`、`SessionSearchServiceV1`

### 2.2 实例解析契约与 SDK / 宿主触点

- 解析类型（`packages/plugin-api/src/context.ts`）：
  - `SelectionSource`：`'explicit' | 'session' | 'workspace' | 'dependency' | 'composition' | 'single' | 'none'`
  - `ServiceCandidate`：`{ instanceId: string; pluginId: string; version: string }`
  - `ServiceResolutionV1` & `ResolveServiceSelectionOptions` & `ServiceCallOptions` & `serviceResolutionErrorCode(status)`
- 隔离上下文与 SDK（`packages/plugin-api` / `packages/plugin-sdk`）：
  - `ctx.services.resolve(contract, options?)` -> `Promise<ServiceResolutionV1>`
  - `ctx.services.call(contract, method, args?, options?)`：传 `versionRange` / `sessionId` / `workspaceId` / `explicitInstanceId` / `allowSingleCandidate` 时走新解析与版本检查，错误映射 `selection_required`/`conflict` -> `E_CONFLICT`、`incompatible` -> `E_NOT_SUPPORTED`、`unconfigured`/`disabled`/`unavailable` -> `E_SERVICE_UNAVAILABLE`、运行换代 -> `E_STALE_RUN`；不传新解析选项时保留旧兼容语义。
  - `ctx.routes.unregister(path)` 已补齐测试与运行时清理（向宿主发送规范化 `{ path, pathPrefix }`）。
  - `createMockPluginHost` 新增 `serviceResolutions` 与 `services.resolve` 支持。
- 宿主解析触点（`packages/daemon/src/plugins/plugin-manager.ts`）：
  - `PluginManager.resolveServiceSelection(contract, options?)`
  - `PluginManager.invokeServiceSelection(contract, method, args?, options?)`
- HTTP 解析路由助手（`packages/daemon/src/plugin-host/composition/resolve-route.ts`）：
  - `registerServiceResolutionRoute(app, pluginManager)` 注册 `GET /api/v1/plugins/services/resolve`，支持 query 参数 `contract`、`versionRange`、`sessionId`、`workspaceId`、`callerInstanceId`、`explicitInstanceId`、`allowSingleCandidate`（待 B1-06 在 `server/app.ts` 挂载）。

---

## 3. 宿主实现与关键修复

1. **统一实例解析与作用域优先级**（`packages/daemon/src/plugin-host/composition/bindings.ts`）：
   - 严格按 `explicit` -> `session` -> `workspace` -> `dependency` -> `composition` -> `single` -> `none` 顺序解析。
   - 会话未显式传入 `workspaceId` 时自动从 `store.getSession(sessionId)` 派生工作区；工作区作用域仅读取目标工作区绑定；`dependency` 仅在调用方实例 `dependencies` 中声明该目标时生效（不要求目标已运行即可报告 `disabled` / `unavailable` / `incompatible`）。
   - `candidates` 按 `instanceId` 字典序稳定排列，同包多实例分别列出；零候选未配置返回 `unconfigured`，多候选或单候选且未显式允许 `allowSingleCandidate: true` 返回 `selection_required`；已选实例保留原 ID 并精确映射 `disabled` / `incompatible` / `unavailable`。
2. **依赖语义版本与注册清理**（`lifecycle.ts`、`rpc-router.ts`、`isolated-manager.ts`）：
   - `PluginHost` 在 `missing()`、`stopDependents()`、`resolveRecord()` 与 `prepareDefinitions()` 变更比对中支持依赖声明的 `semver` 版本范围校验。
   - 修复隔离插件 `service.unprovide`：传递 `meta.instanceId` 而非 `meta.pluginId`，并在 `isolated-manager.ts` 的 `onDynamicUnregister('service')` 中调用对应的 `serviceDisposers` 以确保同包另一实例不受影响。
3. **发行组合数据迁移与旧解析兼容**（`harnessmate-core.json`、`profile.ts`、`bindings.ts`）：
   - 移除 `bindings.ts` 源码内硬编码的 `DEFAULT_BUNDLED_PROVIDERS`，迁移至发行组合数据 `packages/daemon/src/plugin-host/composition/harnessmate-core.json`（包含 `bindings`、`optionalDisabled`、`stableIds`）。
   - `PluginComposition` 加载发行层数据时同时支持额外目录、`HARNESSMATE_BUNDLES_DIR`、`process.resourcesPath/{bundles,daemon}`、模块目录与仓库目录；保留旧 `profile.json` 的 `bindings` 优先于 `extensions.filePreviewProvider`、旧 `resolveCapabilityBinding`（发行层默认映射为 `source: 'default'` 且校验启用条目）及 `bundles: []` 空组合恢复语义。
4. **隔离历史插件环境变量按需透传**（`packages/daemon/src/plugin-host/isolation/isolated-process.ts`）：
   - 对齐 B1-02 需求：`buildIsolatedChildEnv({ declaredPermissions })` 仅在插件声明 `fs:cli_histories:read` 权限时按需透传 `CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`HOME`、`USERPROFILE`，其余插件与敏感宿主机环境变量继续保持剥离。

---

## 4. 旧解析调用方清单与下游/集成交接（B1-02 ~ B1-06）

### 4.1 仍使用旧解析的调用方清单

| 入口/符号 | 实际位置 | 当前行为与建议 |
| --- | --- | --- |
| `resolveCapabilityBinding` | `packages/daemon/src/plugins/plugin-manager.ts` (`resolveCapabilityBinding`, `renderPeerFilePreview`)、`packages/daemon/src/plugins/plugin-capabilities.ts` (`invokeTool`)、`packages/daemon/src/server/app.ts`（L1173-1175, L1192, L1207-1209, L1227, L1909） | 读取 session -> workspace -> `profileBindings` -> `layerBindings`（需条目启用）。旧端点及现有 browser/viewer/approval 用例继续兼容。 |
| `filePreviewProvider` / `filePreviewProviderId` | `packages/daemon/src/plugin-host/compat/legacy-compat.ts:13`、`packages/daemon/src/plugins/plugin-manager.ts:420,508,574,631`、`packages/daemon/src/server/app.ts:314,725,1859`、`packages/web/src/components/StudioModals.tsx:868` | 保留旧 `extensions.filePreviewProvider` 读写与优先级（`profile.bindings['filePreview.v1']` 优先）。 |
| `PluginHost.resolveRecord` / `get` | `packages/daemon/src/plugin-host/runtime/lifecycle.ts`、`rpc-router.ts`、`builtin/services.ts`、`server/app.ts`、`core/session-manager.ts` | 无新选择参数的 `ctx.get` / `ctx.services.call` 保留旧注册首项回落；新功能与 B1-05/B1-06 应使用 `resolveServiceSelection` 或带选择参数的 `ctx.services.call`。 |

### 4.2 需 B1-06 集成配合项

1. **挂载分辨率端点**：在 `packages/daemon/src/server/app.ts` 调用 `registerServiceResolutionRoute(app, pluginManager)` 暴露 `GET /api/v1/plugins/services/resolve`。
2. **打包发行组合数据**：在 `packages/electron/scripts/stage-bundle.mjs` 将 `packages/daemon/src/plugin-host/composition/harnessmate-core.json` 复制到 `resources/daemon/harnessmate-core.json`（或 `resources/bundles/harnessmate-core.json`），确保便携包/Electron 启动可读取默认提供方与可停用清单。
3. **预装来源插件信任**：按 B1-02 交付说明在 `packages/daemon/src/plugin-host/builtin/manifests.ts` 将 4 个 `hm.plugin.history-source-*` 加入 `BUNDLED_PLUGIN_IDS` / `BUNDLED_TRUSTED_LOCAL_IDS`，并挂载 `history.import.v1` 与 `session.search.v1` 旧路由兼容适配器及默认组合。

---

## 5. 自测与验证结果（最终编辑后实测）

测试环境：`$env:TEMP = "D:\HarnessMate\b1-tmp\b1-01"; $env:TMP = $env:TEMP`

| 检查命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm contracts:check` | `0` | 公共契约构建与快照校验通过 |
| `pnpm typecheck` | `0` | 全工作区 6 个包全部通过 |
| `pnpm --filter @harnessmate/daemon test tests/b1-01-service-resolution.test.ts tests/plugin-peer-assembly.test.ts tests/plugin-v5.test.ts tests/plugin-file-preview.test.ts tests/plugin-v4.test.ts --maxWorkers=1 --testTimeout=60000` | `0` | **5/5 文件、24/24 用例通过**（`b1-01-service-resolution.test.ts` 4/4、`plugin-peer-assembly.test.ts` 4/4、`plugin-v5.test.ts` 6/6、`plugin-file-preview.test.ts` 1/1、`plugin-v4.test.ts` 9/9） |
| `pnpm --filter @harnessmate/web test tests/peer-plugins.test.tsx` | `0` | **1/1 文件、3/3 用例通过** |
| `git diff --check` | `0` | 无空白符与格式错误（仅有 Git autocrlf LF->CRLF 提示） |

### 复现重跑步骤

```powershell
$env:TEMP = "D:\HarnessMate\b1-tmp\b1-01"
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force $env:TEMP | Out-Null
pnpm --filter @harnessmate/protocol --filter @harnessmate/plugin-api --filter @harnessmate/plugin-sdk build
pnpm contracts:check
pnpm typecheck
pnpm --filter @harnessmate/daemon test tests/b1-01-service-resolution.test.ts tests/plugin-peer-assembly.test.ts tests/plugin-v5.test.ts tests/plugin-file-preview.test.ts tests/plugin-v4.test.ts --maxWorkers=1 --testTimeout=60000
pnpm --filter @harnessmate/web test tests/peer-plugins.test.tsx
git diff --check
```

### 未跑项与限制

- 未运行全仓 `pnpm -r test` 全量无过滤测试（B1-02/03/04/05 各自独立分支测试及 Electron 打包由 B1-06 集成阶段统一联调验收）。
- `packages/daemon/src/server/app.ts` 未在 B1-01 修改，`GET /api/v1/plugins/services/resolve` 已在 `b1-01-service-resolution.test.ts` 通过 Fastify 注入测通，待 B1-06 挂入 `app.ts` 后联调。
