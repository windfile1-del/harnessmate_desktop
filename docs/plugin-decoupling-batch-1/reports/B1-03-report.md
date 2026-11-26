# B1-03 交付报告 · 导入插件、会话事务与变更读模型

## 1. 基线与交付物定位

- **共同基线**：`b1/baseline`（commit `4eed4537f15d48e4e99d2cd033fe2e15d578083f`）
- **交付分支**：`b1/b1-03-history-import`
- **交付文件清单**：
  - 导入插件：[harnessmate-plugin.json](../../../plugins/bundled/hm.plugin.history-import/harnessmate-plugin.json)、[index.mjs](../../../plugins/bundled/hm.plugin.history-import/index.mjs)、[panel.html](../../../plugins/bundled/hm.plugin.history-import/ui/panel.html)
  - 会话事务适配器：[history-import-adapter.ts](../../../packages/daemon/src/core/history-import-adapter.ts)
  - 已提交变更读模型与一致性快照：[session-change-feed.ts](../../../packages/daemon/src/core/session-change-feed.ts)
  - SQLite 最小增量迁移：[sqlite.ts](../../../packages/daemon/src/db/sqlite.ts)
  - 旧路由兼容适配模块：[history-import-compat.ts](../../../packages/daemon/src/server/routes/history-import-compat.ts)
  - 专项回归测试：[b1-03-history-import.test.ts](../../../packages/daemon/tests/b1-03-history-import.test.ts)

## 2. 实际契约与服务接口

### 2.1 `history.import.v1`（v`1.0.0`，提供方 `hm.plugin.history-import`）

- **服务方法**（均返回 `{ ok: true, value } | { ok: false, error: { code, message } }`，错误码为 `invalid_request` | `source_unreadable` | `not_importable` | `cancelled` | `conflict`）：
  - `preview({ input, workspaceId? })` -> `{ input, existingSessionId, targetWorkspaceId, targetWorkspacePath, importable, items, readStatus, warnings, title, harnessKind }`
  - `import({ input, workspaceId?, requestId, operationId? })` -> `{ sessionId, disposition: 'created' | 'reused', partial, warnings, lockWarning?, mode }`
  - `cancel({ operationId?, requestId? })` -> `{ cancelled, status: 'cancelled' | 'committing' | 'not_found' }`
- **工作页与实例路由**：
  - `workspace.pages` 插槽 ID：`history-import`（导航键 `<instanceId>:history-import`）
  - 实例路由（`/api/v1/plugin-instances/:instanceId/routes/*`）：`GET /status`、`GET /sources`、`GET /workspaces`、`POST /discover`、`POST /preview`、`POST /import`、`POST /cancel`
- **最小示例**（与 `B1-01-peer-contracts.json` 对齐）：
  - `preview` 请求：`{ "input": { "kind": "native", "ref": { "sourceInstanceId": "hm.plugin.history-source-codex", "sourceId": "codex:default", "nativeSessionId": "native-1" }, "mode": "attach" }, "workspaceId": "ws-sample" }`
  - `import` 请求：`{ "input": { "kind": "native", "ref": { "sourceInstanceId": "hm.plugin.history-source-codex", "sourceId": "codex:default", "nativeSessionId": "native-1" }, "mode": "attach" }, "workspaceId": "ws-sample", "requestId": "import-sample-1" }`
  - `import` 成功响应：`{ "ok": true, "value": { "sessionId": "sess_...", "disposition": "created", "partial": false, "warnings": [], "mode": "attach" } }`；同 `requestId` 重试返回 `disposition: "reused"`，同 `requestId` 不同载荷返回 `error.code = "conflict"`。

### 2.2 `hm.session-data.v1`（供 `hm.plugin.history-import` 与 `B1-04` 搜索插件消费）

由 `HistoryImportAdapter.createHostService()` 提供，面向 `B1-04` 暴露：

1. `readSearchSnapshot({ snapshotId?, cursor?, limit?, workspaceId? })` -> `{ snapshotId, watermarkSeq, items, nextCursor }`
   - 首页在单次 `BEGIN` 读事务中原子捕获 `watermarkSeq = COALESCE(MAX(change_seq), 0)` 与非 `secret_request` 的 `session_turn_items`（`JOIN sessions`），按 `(session_id, seq, item_id)` 确定性排序并支持游标分页，避免翻页期间并发写入导致幻读或漏读。
   - `items[]` 字段：`{ sessionId, sessionTitle, workspaceId, itemId, turnId, turnSeq, driverId, blockType, textBody, createdAt, updatedAt }`。
2. `readCommittedChanges({ afterSeq?, limit?, workspaceId? })` -> `{ changes, latestSeq, hasMore }`
   - 基于自增水位 `session_change_log.change_seq`（`INTEGER PRIMARY KEY AUTOINCREMENT`）严格单调递增返回已提交变更。
   - `changes[]` 字段：`{ changeSeq, kind: 'upsert_item' | 'upsert_session' | 'delete_session' | 'delete_item', sessionId, workspaceId, itemId, committedAt, item?, session? }`。
   - 覆盖 `createSession`、`updateSession`、`deleteSession`、`deleteWorkspace`（级联会话删除）、`upsertTurnItem`、`deleteTurnItem` 与导入事务提交。

## 3. 旧路由映射与 B1-06 挂载说明

[history-import-compat.ts](../../../packages/daemon/src/server/routes/history-import-compat.ts) 提供与原 `app.ts` 完全一致的请求校验、返回 DTO、导入模式和本机回环校验（`/api/v1/harnesses/import-session` 对非回环地址返回 `403`）：

| 旧路由 | 转发目标 | 停用后行为 |
| --- | --- | --- |
| `GET /api/v1/harnesses/discovered-sessions` | 枚举活跃 `history.source.v1` 实例调用 `discover` 并按 `history_import_mappings` / `native_history_imports` 填充 `alreadyImportedSessionId` | 单来源失败或停用隔离，其余来源继续返回 |
| `POST /api/v1/harnesses/import-session` | 解析 `history.import.v1` 实例，定位来源 `HistoryRef` 后调用 `import`（保留回环限制） | 导入插件停用/未就绪返回 `503` + `E_SERVICE_UNAVAILABLE` + `resolution` |
| `POST /api/v1/sessions/import-bundle` | 解析 `history.import.v1` 实例并调用 `import({ input: { kind: 'bundle', ... } })`，返回 `201 { session }` | 导入插件停用/未就绪返回 `503` + `E_SERVICE_UNAVAILABLE` + `resolution` |

**待 B1-06 在集成分支挂接的触点**（B1-03 按文件边界未修改下列文件）：

1. `packages/daemon/src/plugin-host/builtin/manifests.ts`：
   - 在 `BUNDLED_PLUGIN_IDS` 中加入 `'hm.plugin.history-import'`；
   - 在 `BUILTIN_PLUGINS` 中加入 `HISTORY_SESSION_DATA_MANIFEST`（从 `server/routes/history-import-compat.ts` 导入）。
2. `packages/daemon/src/plugin-host/builtin/services.ts`：
   - 构造 `SessionChangeFeedService` 与 `HistoryImportAdapter`（或由 `app.ts` 传入），在 `firstParty` 中注册 `HISTORY_SESSION_DATA_PLUGIN_ID -> createHistorySessionDataHostPlugin(importAdapter)`。
3. `packages/daemon/src/server/app.ts`：
   - 用 `registerHistoryImportCompatRoutes(app, { store, pluginManager, adapter: importAdapter })` 替换原有 3 个内联旧路由；
   - 在发行默认组合层（`harnessmate-core`）挂载 `<importInstanceId>:history-import` 与 `history.import.v1` 默认绑定。

## 4. 数据库迁移、所有权与回退可读性

- **最小增量表**（位于 `HarnessMateStore.migrate()`，`PRAGMA busy_timeout = 5000`）：
  - `history_import_mappings(source_id, native_session_id, session_id, legacy_source, source_instance_id, source_path, harness_kind, created_at)`：主键 `(source_id, native_session_id)`，解决跨独立账号/来源同 `nativeSessionId` 碰撞问题。
  - `history_import_receipts(request_id, request_hash, session_id, disposition, partial, warnings_json, created_at)`：与会话创建同一 `BEGIN IMMEDIATE` 事务落库，保障重试/提交后断线复用同一 `sessionId`，同 `requestId` 异载荷返回 `conflict`。
  - `session_change_log(change_seq INTEGER PRIMARY KEY AUTOINCREMENT, kind, session_id, workspace_id, item_id, payload_json, committed_at)`：向 B1-04 提供单调递增游标。
- **旧表兼容与去重规则**：
  - 保留 `workspaces`、`sessions`、`native_history_imports`、`session_events`、`session_turn_items`、`session_search_fts` 结构与数据零改动。
  - 默认来源映射：`codex:default` -> `['codex_cli', 'codex_desktop']`，`claude:default` -> `['claude_cli']`，`agy_cli:default` -> `['agy_cli']`，`agy_desktop:default` -> `['agy_desktop']`，`custom:default` -> `['custom']`；多账号隔离 `sourceId`（如 `codex:acct:<hash>`）不回查旧单账号表。默认来源新导入时同步 `INSERT OR IGNORE INTO native_history_imports`。
- **数据所有权**：
  - 本批仍由现有会话数据层（`HarnessMateStore` + `HistoryImportAdapter`）唯一写入会话、事件、TurnBlock 与原生映射；`hm.plugin.history-import` 通过 `hm.session-data.v1` 协调导入流程，停用后已归档会话仍可通过会话/导出/搜索路径正常读取、回放与导出。
- **版本回退可读性**：
  - 若降级回退至未包含 B1-03 迁移的旧版本二进制，旧表结构与行数据完全未变，旧版可直接忽略新增的三张表并正常打开历史工作区、会话、`native_history_imports` 映射、事件流与回放记录。

## 5. 事务边界测试清单与实测命令结果

### 5.1 事务与回归测试覆盖（[b1-03-history-import.test.ts](../../../packages/daemon/tests/b1-03-history-import.test.ts)）

1. 固定 `ref.sourceInstanceId` 预览与导入、独立 `sourceId` 同名 `nativeSessionId` 分别导入、`attach` 去重、`mirror` 镜像、`requestId` 重试复用与冲突 `conflict`。
2. 5 路并发异步导入仅创建 1 条会话（1 created + 4 reused）；读取阶段分页 `cancel` 转发并无残留；`source_unreadable` 隔离。
3. 预迁移旧库升级保留工作区/会话、命中旧 `native_history_imports`（`codex_cli`）并允许独立账号同名导入，验证降级只读旧表可读。
4. 事务内触发器模拟异常回滚（0 会话/0 变更日志残留）、`secret_request` 跳过、分页快照一致性与并发写入游标续读（`upsert_item` / `upsert_session` / `delete_item` / `delete_session`）。
5. 兼容 HTTP 路由（`/api/v1/harnesses/discovered-sessions`、`/api/v1/harnesses/import-session` 回环校验、`/api/v1/sessions/import-bundle` 归档包重复语义）与实例路由 `/preview`、`/import` 对齐；停用插件返回 `503`（区分 `unconfigured` 与已绑定 `disabled`）且已导入会话仍可打开/回放/导出，恢复后可继续使用。

### 5.2 脱敏旧版数据副本验证（`D:\HarnessMate\b1-tmp\b1-03\legacy-copy-test\harnessmate.db`）

从 `D:\HarnessMate\b1-acceptance\legacy-readonly-copy\harnessmate.db`（只读来源）复制到 D 盘临时目录执行实库升级校验：
- 迁移前：`workspaces=8, sessions=14, events=18634, items=272, native_history_imports=5 (agy_cli=1, codex_desktop=4)`
- 迁移后：`workspaces=8, sessions=14, events=18634, items=272`（零数据丢失）
- `SessionChangeFeedService.readSearchSnapshot({ limit: 500 })`：`snapshotItems=272, watermarkSeq=0`
- `HistoryImportAdapter.lookupNativeMapping` 对全部 5 条 `native_history_imports` 匹配命中率 `5/5`
- 迁移后以只读 `DatabaseSync` 按旧表查询全部可读。

### 5.3 实际命令与退出码（`$env:TEMP = "D:\HarnessMate\b1-tmp\b1-03"`）

| 命令 | 结果与退出码 |
| --- | --- |
| `pnpm --filter @harnessmate/protocol --filter @harnessmate/plugin-api --filter @harnessmate/plugin-sdk build` | 退出码 `0` |
| `pnpm --filter @harnessmate/daemon test tests/b1-03-history-import.test.ts tests/session-explorer-approval.test.ts --maxWorkers=1 --testTimeout=60000` | 退出码 `0`（`b1-03-history-import.test.ts` 5/5、`session-explorer-approval.test.ts` 7/7） |
| `pnpm --filter @harnessmate/daemon test tests/plugin-peer-assembly.test.ts --maxWorkers=1` | 退出码 `0`（4/4，首次三文件串行混跑时第 4 用例受并发负载影响超过内置 `25000ms` 超时，单独复跑全部通过） |
| `pnpm typecheck` | 退出码 `0`（6 个工作区包通过） |
| `pnpm contracts:check` | 退出码 `0` |
| `pnpm --filter @harnessmate/daemon build` + 脱敏副本校验脚本 | 退出码 `0` |
| `git diff --check -- packages/daemon/src/db/sqlite.ts packages/daemon/src/core/history-import-adapter.ts packages/daemon/src/core/session-change-feed.ts packages/daemon/src/server/routes/history-import-compat.ts packages/daemon/tests/b1-03-history-import.test.ts plugins/bundled/hm.plugin.history-import/` | 退出码 `0`（无空白错误） |
