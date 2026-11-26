# B1-05 交付报告 · 导入与搜索工作页前端解耦

- **交付人**：`b1-05-ui`
- **基线提交**：`4eed4537f15d48e4e99d2cd033fe2e15d578083f`（`b1/baseline`）
- **交付分支**：`b1/b1-05-workspace-ui`
- **运行环境与联调边界说明**：
  - 单元测试与组件回归基于 `B1-01-peer-contracts.json` 夹具、Mock `PeerWorkspaceTransport` 及真实 React 渲染/Store 验证。
  - 浏览器 E2E 实操验证基于本次构建产物 `packages/web/dist` + 本地真实 HTTP 模拟插件路由端点（完全对齐 B1-01/02/03/04 契约格式与 `B1-01-peer-contracts.json` 夹具），在无头 Chrome 1400×900 中完成交互操作与截图。尚未连接合并后的 `@harnessmate/daemon` 真实插件进程，待 `b1-06-integrator` 汇总 B1-01～B1-05 合入后进行端到端真后端联调。

---

## 一、工作页注册与导航 ID 清单（供 B1-06 集成挂载）

Web 端通过 `PluginSlotSync.tsx` 中的 `registerBatch1WorkspacePages()` 动态注册两类合约插件的工作页与导航 ID：

| 合约 (`contract`) | 工作页 Slot ID | 注册 Navigation ID 规则 | 默认组合示例 Instance ID / Nav ID | 宿主组件 |
| :--- | :--- | :--- | :--- | :--- |
| `history.import.v1` | `history-import` | `<importInstanceId>:history-import` | `hm.plugin.history-import:history-import` | `HistoryImportWorkspacePage` |
| `session.search.v1` | `session-search` | `<searchInstanceId>:session-search` | `hm.plugin.session-search-fts:session-search`<br/>`hm.plugin.session-search-alt:session-search`（双实例并存示例） | `SessionSearchWorkspacePage` |

### 原有入口与快捷键兼容策略

1. **Sidebar (`Sidebar.tsx`)**：
   - 保留搜索栏 `全文/导入` 按钮及各已启用插件工作页直达按钮（对应 `<instanceId>:session-search` 与 `<instanceId>:history-import`）。
   - 新增工作页状态与快捷切换控件（展示当前 `session.search.v1` / `history.import.v1` 解析状态并支持按实例打开工作页）；当插件实例停用或移除时，入口同步摘除或保留明确的 `disabled` / `unavailable` 状态横幅。
2. **CommandPalette (`CommandPalette.tsx`)**：
   - 保留 `? <query>` 与命令触发入口：在优先打开并跳转到当前解析的 `session-search` 工作页并带入搜索词的同时，保留 `openSessionExplorer` 兼容降级与既有快捷命令（新建会话、工作区切换、查看工作区、插件/MCP/账号等）。
   - `history.import.v1` 实例在命令面板中直接跳转到 `<importInstanceId>:history-import` 工作页，停用实例不再作为可触发可用入口出现。
3. **NewSessionModal (`Modals.tsx`) & SessionExplorerModal (`SessionExplorerModal.tsx`)**：
   - 保留新建会话与历史接管/JSON Bundle v2 导入既有入口，按 `ServiceResolutionV1` 识别目标导入实例与可选来源；既有会话打开、聊天发送、浏览器 (`browser.v1`) 与文件预览 (`filePreview.v1`) 入口行为保持不变。
4. **iframe 槽位避让 (`shouldSkipBatch1IframeSlot` in `PluginSlotSync.tsx`)**：
   - 避免宿主机为内置或第三方 Batch 1 `history-import` / `session-search` 挂载的原生 React 工作页重复创建空 iframe。

---

## 二、实例解析、错误隔离与竞态取消设计

1. **合约类型与客户端降级解析 (`packages/web/src/api/peer-contracts.ts`)**：
   - 对齐 `ServiceResolutionV1`，优先级遵循 `explicit > session > workspace > dependency > composition > single`，完整覆盖 6 种解析状态：`ready`、`disabled`、`unavailable`、`incompatible`、`unconfigured`、`selection_required`。
   - 解析器支持插件返回 `{ ok: true, value }` / `{ ok: false, error }` 封包以及旧端兼容降级（当 `/api/v1/plugins/services/resolve` 或实例路由返回 `404`/`501`/`405` 时由 `defaultPeerWorkspaceTransport` 回退）。
2. **状态横幅 (`packages/web/src/components/ServiceResolutionBanner.tsx`)**：
   - 统一渲染合约名、版本范围、解析状态徽标、来源徽标（显式/会话/工作区/依赖/组合/唯一候选）、不可用/禁用/不兼容原因提示及多实例切换 `<select>`。
3. **导入工作页与控制器 (`HistoryImportWorkspacePage.tsx`, `HistoryImportController`)**：
   - 多 `history.source.v1` 实例并发独立发现，单来源失败（如 `source_unreadable`）仅在该来源卡片局部标红提示，其余来源分页/刷新/预览不受影响。
   - 导入支持 **只读镜像 (`mirror`)**、**直接接管续跑 (`attach`)**、工作区选择、去重提示（检测到 `existingSessionId` 时提供「打开既有归档」按钮）与 `JSON Bundle v2` 导入页签。
   - `ImportRequestIdTracker` 在失败重试时自动复用同一 `requestId` 实现幂等重试；点击取消或切换实例/关闭页面/插件停用时立即递增 `epoch` 并 `AbortController.abort()` + 调用 `/cancel`，丢弃所有迟到响应。
4. **搜索工作页与控制器 (`SessionSearchWorkspacePage.tsx`, `SessionSearchController`)**：
   - 支持双 `session.search.v1` 实例并存（如 `hm.plugin.session-search-fts` 与 `hm.plugin.session-search-alt`），各自独立保存筛选条件、结果、分页偏移与错误状态（一实例失败不影响另一实例）。
   - 支持中文查询、工作区/驱动/起止时间筛选、分页（上一页/下一页）、索引状态检查、增量补建 (`incremental`) / 全量重建 (`full`)、取消 (`POST /reindex/cancel`)、续跑 (`POST /reindex/resume`) 轮询以及点击命中结果精准定位至 `sessionId` / `turnId` / `itemId`。
   - 实例切换、页面销毁或实例停用时递增 `epoch`、中止在途 HTTP 请求并清理轮询定时器，确保旧实例迟到响应永不覆盖当前实例状态。

---

## 三、交付文件清单（均限定在 Web 与 B1-05 报告范围内）

- 新增文件：
  - `packages/web/src/api/peer-contracts.ts`
  - `packages/web/src/api/peer-workspace-client.ts`
  - `packages/web/src/lib/peer-workspace-controllers.ts`
  - `packages/web/src/components/ServiceResolutionBanner.tsx`
  - `packages/web/src/components/HistoryImportWorkspacePage.tsx`
  - `packages/web/src/components/SessionSearchWorkspacePage.tsx`
  - `packages/web/tests/b1-05-workspace-ui.test.tsx`
  - `docs/plugin-decoupling-batch-1/reports/B1-05-report.md`
- 修改文件：
  - `packages/web/src/api/client.ts`
  - `packages/web/src/stores/app-store.ts`
  - `packages/web/src/slots/PluginSlotSync.tsx`
  - `packages/web/src/slots/PluginWorkspace.tsx`
  - `packages/web/src/components/Sidebar.tsx`
  - `packages/web/src/components/CommandPalette.tsx`
  - `packages/web/src/components/Modals.tsx`
  - `packages/web/src/components/SessionExplorerModal.tsx`
  - `packages/web/src/components/ChatStage.tsx`

---

## 四、使用真实插件联调步骤

1. 合并 B1-01（宿主服务解析与实例路由代理）、B1-02（来源插件）、B1-03（导入插件）、B1-04（搜索插件）与 B1-05（本分支）。
2. 在宿主 `builtin/manifests.ts` 与默认组合中注册默认实例：
   - 来源：`hm.plugin.history-source-codex`、`hm.plugin.history-source-claude`、`hm.plugin.history-source-agy-cli`、`hm.plugin.history-source-agy-desktop`
   - 导入：`hm.plugin.history-import`（挂载 `<instanceId>:history-import`）
   - 搜索：`hm.plugin.session-search-fts`（挂载 `<instanceId>:session-search`，可选并存 `hm.plugin.session-search-lite` / `hm.plugin.session-search-alt`）
3. 确保守护进程开放以下真实路由供前端调用：
   - `GET /api/v1/plugins/services/resolve?contract=...&workspaceId=...&sessionId=...&explicitInstanceId=...`
   - 来源实例路由：`POST /api/v1/plugin-instances/:id/routes/discover`、`POST /read`、`POST /cancel`、`GET /status`
   - 导入实例路由：`POST /api/v1/plugin-instances/:id/routes/preview`、`POST /import`、`POST /cancel`、`GET /status`、`GET /sources`
   - 搜索实例路由：`GET /api/v1/plugin-instances/:id/routes/status`、`POST /query`、`POST /reindex`、`POST /reindex/cancel`、`POST /reindex/resume`
4. 启动真实 Daemon + Web UI 后复测：
   - 停用/启用某个 `history.source.v1` 实例，验证其他来源仍可正常分页与预览；
   - 执行一次历史预览 → 取消 → 重新预览 → 导入（模拟超时后重试核对同一 `requestId` 不重复建会话）→ 打开既有归档；
   - 安装/启用双 `session.search.v1` 实例（FTS5 与 Lite），切换实例分别检索中文关键词与无结果查询，停用首选实例后恢复，并点击检索结果核对工作区、会话与 `#chat-turn-<turnId>` 定位。

---

## 五、自测与实跑结果

所有命令均在 `$env:TEMP = "D:\HarnessMate\b1-tmp\b1-05"; $env:TMP = $env:TEMP` 环境下执行：

1. **TypeScript 类型检查**：
   - 命令：`pnpm --filter @harnessmate/web typecheck`
   - 结果：退出码 `0`
2. **全量 Web 单元与组件回归测试**：
   - 命令：`pnpm --filter @harnessmate/web test`
   - 结果：退出码 `0`，**28/28 测试文件全部通过，134/134 用例全部通过**（含新增 `tests/b1-05-workspace-ui.test.tsx` 6/6 及已有 `tests/peer-plugins.test.tsx`、`tests/phase2-explorer-approval.test.tsx`、`tests/ui-slots.test.tsx`、`tests/phase4-triage-inbox.test.tsx` 等）。
3. **无头 Chrome 构建产物 E2E 实操验证**（基于 `packages/web/dist` + 本地契约夹具服务）：
   - 命令：`node "C:\Users\windfile\.gemini\antigravity\brain\c95df033-adbe-4061-bafe-3d65c04fb472\scratch\verify-ui-e2e.mjs"`
   - 结果：退出码 `0`（`E2E browser verification PASSED!`）。验证了历史导入页多源异常隔离、预览与镜像提交（命中 `sess-sample`），以及搜索页中文查询 `中文`、无结果空态 `无结果`、双实例切换（`hm.plugin.session-search-fts` <-> `hm.plugin.session-search-alt`）与点击命中跳转落地到 `#chat-turn-import_1`。
4. **空白与格式检查**：
   - 命令：`git diff --check`
   - 结果：退出码 `0`

### 验证截图

- 导入工作页预览与来源错误隔离：`C:\Users\windfile\.gemini\antigravity\brain\c95df033-adbe-4061-bafe-3d65c04fb472\b1-05-history-import.png`（副本已同步留存 `D:\HarnessMate\b1-acceptance\b1-05-history-import.png`）
- 搜索工作页中文检索与命中高亮：`C:\Users\windfile\.gemini\antigravity\brain\c95df033-adbe-4061-bafe-3d65c04fb472\b1-05-session-search.png`（副本已同步留存 `D:\HarnessMate\b1-acceptance\b1-05-session-search.png`）

---

## 六、待联调事项

- 候选包环境与真实 Daemon / SQLite FTS5 / 真实本机 CLI 历史目录插件端的全链路冒烟测试（由 `b1-06-integrator` 汇总合入与总指挥验收执行）。
- `POST /api/v1/workspaces/:id/bindings` 写入接口与前端“工作区绑定”快捷设置控件的真后端联调校验（当前已接入解析读取与前端状态显示）。
