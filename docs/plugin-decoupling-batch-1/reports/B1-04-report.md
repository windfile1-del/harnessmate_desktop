# B1-04 · 会话搜索与索引交付报告

## 1. 基线与交付分支

- **共同基线**：`b1/baseline`（commit `4eed4537f15d48e4e99d2cd033fe2e15d578083f`）
- **任务分支**：`b1/b1-04-session-search`
- **工作区与临时目录**：均隔离于 D 盘（`TEMP/TMP = D:\HarnessMate\b1-tmp\b1-04`，pnpm store `D:\HarnessMate\agy-np-pnpm-store`）；未修改主目录 `D:\HarnessMate\harnessmate_desktop`、`main` 分支，以及 `packages/plugin-api/*`、`packages/daemon/src/db/sqlite.ts`、`packages/daemon/src/server/app.ts`、`packages/web/*`。

## 2. 交付物清单

| 类别 | 路径 | 说明 |
| --- | --- | --- |
| 默认 FTS5 搜索插件 | `plugins/bundled/hm.plugin.session-search-fts/` | 实现 `session.search.v1` (`1.0.0`)、实例路由与 `workspace.pages` (`id: "session-search"`)；复用 FTS5 安全转义、中文 LIKE 降级、XSS 安全 `<mark>` 摘要与跳转身份。 |
| 替代搜索实现样例 | `plugins/examples/hm.plugin.session-search-lite/` | 纯 JS 轻量倒排 + 中文二元分词实现，无 SQLite 依赖，通过同一 `session.search.v1` (`1.0.0`) 契约独立安装、启用与切换。 |
| 投影与索引引擎 | `packages/daemon/src/core/session-search-engine.ts` | 提供 `SessionSearchEngineInstance`、`SessionSearchEngineManager`、`FixtureSessionSearchReadModel`、`StoreSessionSearchReadModel` 与 `createSessionSearchReadModelService`。各实例独立拥有 `.fts.sqlite` 文件与同步水位 `cursor_seq`。 |
| 旧路由兼容适配 | `packages/daemon/src/server/routes/session-search-compat.ts` | 提供 `registerSessionSearchCompatRoutes`、实例解析 `resolveSessionSearchInstance` 与 `LEGACY_DIRECT_SEARCH_INDEX_CALL_SITES` 清单，供 B1-06 在 `server/app.ts` 挂载。 |
| 自动化验证测试 | `packages/daemon/tests/b1-04-session-search.test.ts` | 覆盖旧检索结果对照、并发重建、暂停期间增删改恢复、取消与断点续跑、模拟崩溃恢复、删除重放幂等性、FTS/Lite 双实例按工作区并存，以及 FTS/Lite 分发入口直测（启用态实时导入删除、两阶段分块注错与篡改自愈、按工作区重建不跳别区变更、UI CSP/桥接约束）。 |
| 搜索插件面板 UI | `plugins/bundled/hm.plugin.session-search-fts/ui/` & `plugins/examples/hm.plugin.session-search-lite/ui/` | 对齐 `SandboxedPluginFrame`（`window.harnessMate.requestPluginRoute` / `onContext` / `navigateToSession`，零内联脚本与 `innerHTML`），支持工作区/驱动/时间范围筛选、分页、安全 `<mark>` 高亮及点击跳转；Lite 具备独立视觉主题用于第三方 UI 接管验收。 |

## 3. 默认与替代插件配置及安装示例

### 3.1 公共契约与实例接口对齐

- **契约**：`session.search.v1`，版本 `1.0.0`
- **服务方法**（均返回 `{ ok: true, value } | { ok: false, error: { code, message } }`）：
  - `query({ q, workspaceId?, driverId?, fromTs?, toTs?, limit?, offset?, forceLikeFallback? })` → `{ hits, nextOffset, fallbackUsed, tookMs }`
  - `reindex({ mode?: 'full' | 'incremental' | 'resume', jobId?, workspaceId? })` → `ReindexJobStatus`
  - `getStatus({})` → `SearchEngineStatus`
  - `cancelReindex({ jobId? })`
  - `resumeReindex({ jobId? })`
  - `sync({})`
- **实例路由**（`/api/v1/plugin-instances/:instanceId/routes/*`）：
  - `GET /status`、`POST /query`（兼容 `GET /query`）、`POST /reindex`、`POST /reindex/cancel`、`POST /reindex/resume`、`POST /sync`
- **工作页插槽**：`workspace.pages`，`id: "session-search"`（FTS 与 Lite 使用同一 slot ID，便于 `<instanceId>:session-search` 统一导航）

### 3.2 安装与多实例组合示例

1. **安装替代插件（`local_dir`）**：
   - `POST /api/v1/plugins/install`：`{ "mode": "local_dir", "dirPath": "<repo>/plugins/examples/hm.plugin.session-search-lite", "trustCode": true, ... }`
   - 授权：`session:read`、`events:turn`、`events:message`、`storage:plugin`
2. **双实例组合配置（`PUT /api/v1/plugins/composition/instances`）**：
   ```json
   { "id": "search.fts.a", "name": "hm.plugin.session-search-fts" }
   { "id": "search.lite.b", "name": "hm.plugin.session-search-lite" }
   ```
   若开启 `trustedLocal` 并希望 FTS 实例把索引落盘到指定目录，可配置：
   ```json
   {
     "id": "search.fts.a",
     "name": "hm.plugin.session-search-fts",
     "config": { "storageDir": "D:/HarnessMate/data/search-indexes" }
   }
   ```
   未配置磁盘可写目录或处于 `--permission` 沙箱时，`hm.plugin.session-search-fts` 自动使用 `node:sqlite` `:memory:` FTS5 并通过 `ctx.storage.plugin` 按 `instanceId` 分块持久化条目、游标与任务状态。
3. **按工作区绑定（`PUT /api/v1/workspaces/:workspaceId/bindings`）**：
   ```json
   { "contract": "session.search.v1", "instanceId": "search.fts.a" }
   ```
   ```json
   { "contract": "session.search.v1", "instanceId": "search.lite.b" }
   ```

## 4. 已提交变更读模型与一致性快照用法

1. **与 B1-03 对齐接口**：插件优先通过 `ctx.services.list()` 探测 `hm.session-data.v1`（并兼容 `session.readModel.v1` / `session.changes.v1`），缺失时回落到公共 `ctx.sessions.list` + `ctx.sessions.listItems`。
2. **全量快照、启用态实时同步与按工作区重建闭环**：
   - **启用态即时同步（A5 修复）**：监听 `turn.completed`、`message.user`、`message.assistant.completed`、`session.created` 事件并在启动时通过串行 `enqueueSync()` 自动追赶；同时在 `query()` 执行前自动等待一次轻量 `enqueueSync()`，确保外部导入（含 Bundle 导入）、会话改名与删除在启用态无需手动 `reindex` 即可立即命中/消除。
   - **两阶段持久化与完整性校验（A5 修复）**：沙箱 `:memory:` FTS 与 Lite 插件均采用两阶段代次提交（阶段 1 逐块写入 `fts:gen:<gen>:chunk:<i>` / `lite:gen:<gen>:chunk:<i>`；阶段 2 仅在全部分块成功后原子提交 `fts:meta` / `lite:meta` 含 `schemaVersion: 2`、`generation`、`cursorSeq`、`scopedSkips`、`totalBytes`、`sha256`；阶段 3 清理旧代分块）。写入异常绝不吞错，回滚新分块并恢复内存 `cursor_seq`；重启时校验分块数量、字节数与 SHA-256，受损时重置游标安全重建。
   - **按工作区重建隔离（A5 修复）**：全量 `reindex({ workspaceId: 'A' })` 仅清除并重扫目标工作区条目，**不推进全局 `cursor_seq`**，而是记录 `{ workspaceId: 'A', upToSeq: snapSeq }` 于 `scopedSkips`，后续增量追赶跳过 `A` 的 `<= snapSeq` 已快照变更而完整消费其他工作区（如 `B`）的未消费新增/更新/删除，直至全局水位跨越 `upToSeq` 后裁剪。
3. **代次隔离与取消/崩溃续跑**：
   - `generation` 令牌和 `disposed` 标志确保实例停用、重载或取消后旧任务立即停止提交。
   - 取消或崩溃重启后保留 `snapshot_id`、`snapshot_watermark`、`snapshot_cursor` 与 `cursor_seq`，`start()` 自动将残留 `running` 任务标记为可续跑，`resumeReindex()` 从断点继续。
4. **插件 UI 面板与 `SandboxedPluginFrame` 对齐（A2 修复）**：
   - `panel.js` 严格遵守沙箱 CSP（无 `fetch()`、无内联脚本/样式、无 `innerHTML`，高亮使用 `document.createElement('mark')` + `TextNode`），通过 `window.harnessMate.onContext` 同步工作区/驱动列表与 `initialQuery`，经 `requestPluginRoute`（回落 `sendToPlugin`）调用 `/status`、`/query`、`/sync`、`/reindex`、`/reindex/cancel`、`/reindex/resume`，点击命中卡片通过 `navigateToSession({ sessionId, turnId, itemId, workspaceId, closeWorkspace: true })` 跳转定位。

## 5. Legacy 直接索引调用点清单与 B1-06 挂载说明

B1-06 在整合分支挂载兼容路由并清理旧写入路径时，需处理以下调用点（详见 `LEGACY_DIRECT_SEARCH_INDEX_CALL_SITES`）：

1. **`packages/daemon/src/server/app.ts`（L661-689）**：
   - 替换内联 `GET /api/v1/search/sessions` 与 `POST /api/v1/search/reindex`，改为调用 `registerSessionSearchCompatRoutes(app, { pluginManager, sessionManager })`（来自 `packages/daemon/src/server/routes/session-search-compat.ts`）。
   - 在 `app.ts` 初始化阶段将 B1-03 的 `hm.session-data.v1` 注册到宿主服务（若 B1-03 尚未在 `services.ts` 暴露，可使用 `createSessionSearchReadModelService(new StoreSessionSearchReadModel(store))` 桥接）。
2. **`packages/daemon/src/plugin-host/builtin/manifests.ts`（L4-14）**：
   - 将 `'hm.plugin.session-search-fts'` 加入 `BUNDLED_PLUGIN_IDS`；若需由插件进程直接向 `dataDir/search-indexes/` 写入 `.fts.sqlite` 文件而非走 `ctx.storage.plugin` 持久化，一并加入 `BUNDLED_TRUSTED_LOCAL_IDS` 并传入 `storageDir`。
3. **`packages/daemon/src/core/session-manager.ts`（L535-566, L665-671, L1847-1854, L3128-3135）**：
   - `searchSessions` / `rebuildSearchIndex` 改为走 `querySessionSearchCompat` / `reindexSessionSearchCompat` 或经兼容路由转发；移除 `sendTurn` / `assistant_text` 落库处的直接 `this.store.indexSearchItem(...)` 调用。
4. **`packages/daemon/src/core/session-explorer-service.ts`（L199-315, L572-580, L730-738, L930-937, L1365-1373）**：
   - 移除 `importExternal`、`forkSession`、`mergeBack`、`importSessionBundle` 及 `rebuildBacklogIndex` 中的直接 `indexSearchItem` 调用，统一由 B1-03 事务写 `session_turn_items` + `session_change_log` 驱动异步投影。
5. **`packages/daemon/src/plugin-host/builtin/services.ts`（L358-378）**：
   - 取消 `hm.plugin.session-explorer` 对旧 `'session-search'` 服务的内核注册与启动 `rebuildBacklogIndex` 定时器（Fork / Side Chat / Export 等尚未迁移能力按任务单保留适配）。
6. **`packages/daemon/src/db/sqlite.ts`（L553-560, L1230-1234, L2786-3000）**：
   - `session_search_fts`、`indexSearchItem`、`deleteSessionSearchIndex`、`listUnindexedTurnItems`、`searchSessionFts*` 为旧索引表与直接读写接口；确认无旧回落需求后可停用或保留只读兼容。

## 6. 索引重建、恢复与双实例复验步骤

1. 构建共享契约包：
   ```powershell
   $env:TEMP = "D:\HarnessMate\b1-tmp\b1-04"; $env:TMP = $env:TEMP
   pnpm --filter @harnessmate/protocol --filter @harnessmate/plugin-api --filter @harnessmate/plugin-sdk build
   ```
2. 运行 B1-04 专项测试（涵盖：旧实现同夹具对照、并发写入重建、暂停后增删改再恢复、取消后 `resumeReindex`、模拟进程中断后重启恢复、删除重放幂等、FTS+Lite 双实例按工作区隔离与 `/api/v1/search/*` 兼容切换）：
   ```powershell
   pnpm --filter @harnessmate/daemon test tests/b1-04-session-search.test.ts --maxWorkers=1 --testTimeout=60000
   ```
3. 运行全仓契约检查、类型检查与 daemon 相关回归：
   ```powershell
   pnpm contracts:check
   pnpm typecheck
   pnpm --filter @harnessmate/daemon test tests/session-explorer-approval.test.ts --maxWorkers=1 --testTimeout=60000
   pnpm --filter @harnessmate/daemon test tests/plugin-peer-assembly.test.ts --maxWorkers=1 --testTimeout=60000
   ```

## 7. 实际测试命令、退出码与范围说明

| 命令 | 退出码 | 结果摘要 |
| --- | --- | --- |
| `pnpm --filter @harnessmate/protocol --filter @harnessmate/plugin-api --filter @harnessmate/plugin-sdk build` | `0` | 三包构建通过 |
| `pnpm contracts:check` | `0` | 公共契约快照校验通过 |
| `pnpm typecheck` | `0` | 6 个工作区包类型检查全部通过 |
| `pnpm --filter @harnessmate/daemon test tests/b1-04-session-search.test.ts --maxWorkers=1 --testTimeout=60000` | `0` | `10/10` 通过（旧实现对照 + 并发/断点恢复/删除重放 + 双工作区与兼容路由 + FTS/Lite 分发入口启用态实时同步、两阶段分块注错与 SHA-256 恢复、按工作区重建隔离与 UI CSP/桥接检验） |
| `pnpm --filter @harnessmate/daemon test tests/session-explorer-approval.test.ts tests/plugin-peer-assembly.test.ts --maxWorkers=1 --testTimeout=60000` | `0` | `11/11` 通过（`session-explorer-approval` `7/7` + `plugin-peer-assembly` `4/4`） |
| `git diff --check` | `0` | 提交前暂存区格式/空白符校验通过（见最新提交前检查） |

### 未覆盖范围与规模说明

- **未覆盖实机与前端交互**：本任务边界不包含 `packages/web/*` 与 Electron 便携打包（分别由 B1-05 与 B1-06 负责），因此页面端 React 工作页点击跳转与 Windows 便携包交互验收留待 B1-05 / B1-06 联调。
- **未直接联调 B1-03 源码表**：`b1-03-import` 分支尚未合并到当前 worktree，本任务通过与 B1-03 在看板确认的 `hm.session-data.v1` 同契约夹具与 HTTP 桥接插件验证了真实 `IsolatedPluginProcess` 跨进程投影与续读；`b1/integration` 合并时由 B1-06 接入真实的 `hm.session-data.v1` 服务实例。
- **测试规模**：自动化用例覆盖小规模夹具（单次 3–6 条会话记录、分页 `batchSize = 1..2`），尚未在数万条历史消息的大规模副本上执行吞吐基准测试（大规模脱敏副本验收由 B1-06 在 `D:\HarnessMate\b1-acceptance\` 执行）。
