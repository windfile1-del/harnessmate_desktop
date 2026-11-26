# B1-05 交付报告 · 导入与搜索工作页前端解耦（含退回返工修复）

- **交付人**：`b1-05-ui`
- **基线提交**：`4eed4537f15d48e4e99d2cd033fe2e15d578083f`（`b1/baseline`）
- **交付分支**：`b1/b1-05-workspace-ui`
- **运行环境与联调边界说明**：
  - 单元测试与组件回归基于 `B1-01-peer-contracts.json` 夹具、`SandboxedPluginFrame` 桥接执行器 (`executeSandboxedBridgeMethod`) 及真实 React/Zustand 验证。
  - 浏览器 E2E 实操验证基于本次构建产物 `packages/web/dist` + 本地真实 HTTP 契约端与沙箱 `/ui-doc` 服务，在无头 Chrome 1400×900 中挂载真实 `<iframe sandbox="allow-scripts">` OOPIF 完成预装插件 `ui/panel.html` 与第三方自定义插件 `ui/custom-search.html` 接管切换、跨域 `postMessage` RPC、来源错误隔离及跳转至 `#chat-turn-import_1` 实测并截图。

---

## 一、退回项修复（#48）与工作页挂载架构

1. **移除宿主覆盖，直接渲染插件自带 `ui/panel.html`**：
   - 彻底移除 `PluginSlotSync.tsx` 中的 `shouldSkipBatch1IframeSlot` 跳过逻辑。
   - `PluginSlotSync.tsx` 新增并复用 `registerPluginIframeSlots()`：所有处于活跃状态的预装或第三方 `history.import.v1` / `session.search.v1` 插件，只要声明了 `workspace.pages` 槽位（`history-import` / `session-search`，如 `ui/panel.html` 或自定义 `ui/custom-search.html`），一律直接注册为 `sourceKind: 'iframe'` 的 `SandboxedPluginFrame`，宿主不再以编译期 React 组件覆盖其标准工作页。
   - `registerBatch1WorkspacePages()` 仅在插件**未声明** `workspace.pages` UI 槽位（纯服务/旧版 `hm.plugin.session-explorer`）时提供兜底页面，支持同一契约的第三方自定义标准页面完全接管入口。
2. **`PluginWorkspaceStage` 薄壳与实例解析切换栏 (`packages/web/src/slots/PluginWorkspace.tsx`)**：
   - 在 `workspace.pages` 渲染容器外提供轻量宿主薄壳（返回按钮 + 标题 + `ServiceResolutionBanner`），展示当前 `history.import.v1` / `session.search.v1` 的 `ServiceResolutionV1` 6 种状态与来源（显式/会话/工作区/依赖/组合/唯一候选），支持直接下拉切换同类并存实例（同时更新工作区绑定并切换 `activePluginPage`）。
   - 当指向已停用/不可用/不兼容实例时，`PluginWorkspaceStage` 保留薄壳并展示原因提示与备选实例切换入口。
3. **`SandboxedPluginFrame` 宿主桥接协议 (`SandboxedPluginFrame.tsx` / `sandbox-iframe-utils.ts` / `sandbox-bridge-handler.ts`)**：
   - 考虑到沙箱 iframe 启用 `sandbox="allow-scripts"` 且 CSP 为 `connect-src 'none'`（禁止直接 `fetch()`），宿主持桥向 `window.harnessMate`（及 `hm:context` 事件）实时注入：
     - `pluginId`、`instanceId`、`runId`、`slotId`、`slot`、`theme`、`apiBase`、`workspaceId`、`cssVars`、`session`、`props`
     - `props` 含：`workspaces`、`harnesses`、`sessions`、`plugins`、`serviceResolution`、`sourceResolution`、`initialQuery`、`initialTab`
   - 暴露统一 `postMessage` RPC (`hm:rpc:request` / `hm:rpc:response`) 与 `hm:action` 动作桥接，并绑定生命周期 `AbortController`（实例切换、关闭页面或插件停用时立即 `abort()` 在途请求并丢弃迟到响应）：
     - `plugin.route` / `harnessMate.requestPluginRoute({ instanceId?, method?, path, query?, body? })`
     - `plugin.message` / `harnessMate.sendToPlugin(payload)`
     - `services.resolve` / `harnessMate.resolveService(...)`
     - `plugins.list` / `harnessMate.listPlugins()`
     - `import.bundle` / `harnessMate.importBundle(...)`
     - `navigateToSession` (`session.navigate`) / `harnessMate.navigateToSession({ sessionId, turnId?, itemId?, workspaceId?, closeWorkspace? })`
     - `refreshSessions` / `harnessMate.refreshSessions()`、`refreshWorkspaces` / `harnessMate.refreshWorkspaces()`、`switchInstance` / `harnessMate.switchInstance({ contract, instanceId })`

---

## 二、工作页注册与导航 ID 清单（供 B1-06 集成挂载）

| 合约 (`contract`) | 工作页 Slot ID | 注册 Navigation ID 规则 | 默认组合示例 Instance ID / Nav ID | 渲染模式 |
| :--- | :--- | :--- | :--- | :--- |
| `history.import.v1` | `history-import` | `<importInstanceId>:history-import` | `hm.plugin.history-import:history-import`（第三方接管如 `user.custom.import:history-import`） | `SandboxedPluginFrame` (`ui/panel.html` 等插件自有 HTML) |
| `session.search.v1` | `session-search` | `<searchInstanceId>:session-search` | `hm.plugin.session-search-fts:session-search`、`hm.plugin.session-search-lite:session-search`、`user.custom.search:session-search` | `SandboxedPluginFrame` (`ui/panel.html` 等插件自有 HTML) |

### 原有入口与兼容性

- **Sidebar (`Sidebar.tsx`)**：保留 `全文/导入` 按钮及各活跃 `workspace.pages` 入口，实例停用后同步移除对应导航项，同时保留解析状态选择器与 `browser.v1` 会话浏览器入口。
- **CommandPalette (`CommandPalette.tsx`)**：保留 `? <query>` 及快捷命令入口，打开搜索页时同步向 iframe `props.initialQuery` 注入关键词；停用实例不再出现。
- **聊天 / 已有会话 / 浏览器 (`browser.v1`) / 文件预览 (`filePreview.v1`)**：全部保留既有行为不变。

---

## 三、交付文件清单

- 新增文件：
  - `packages/web/src/api/peer-contracts.ts`
  - `packages/web/src/api/peer-workspace-client.ts`
  - `packages/web/src/lib/peer-workspace-controllers.ts`
  - `packages/web/src/components/ServiceResolutionBanner.tsx`
  - `packages/web/src/components/HistoryImportWorkspacePage.tsx`
  - `packages/web/src/components/SessionSearchWorkspacePage.tsx`
  - `packages/web/src/slots/sandbox-bridge-handler.ts`
  - `packages/web/tests/b1-05-workspace-ui.test.tsx`
  - `docs/plugin-decoupling-batch-1/reports/B1-05-report.md`
- 修改文件：
  - `packages/web/src/api/client.ts`
  - `packages/web/src/stores/app-store.ts`
  - `packages/web/src/slots/PluginSlotSync.tsx`
  - `packages/web/src/slots/PluginWorkspace.tsx`
  - `packages/web/src/slots/SandboxedPluginFrame.tsx`
  - `packages/web/src/slots/sandbox-iframe-utils.ts`
  - `packages/web/src/components/Sidebar.tsx`
  - `packages/web/src/components/CommandPalette.tsx`
  - `packages/web/src/components/Modals.tsx`
  - `packages/web/src/components/SessionExplorerModal.tsx`
  - `packages/web/src/components/ChatStage.tsx`

---

## 四、自测与实跑结果

所有命令均在 `$env:TEMP = "D:\HarnessMate\b1-tmp\b1-05"; $env:TMP = $env:TEMP` 下执行（均于最终代码编辑完成后实跑）：

1. **TypeScript 检查与生产构建**：
   - 命令：`pnpm --filter @harnessmate/web build`（执行 `tsc -p tsconfig.json --noEmit && vite build`）
   - 结果：退出码 `0`
2. **全量 Web 单元测试与回归测试**：
   - 命令：`pnpm --filter @harnessmate/web test`
   - 结果：退出码 `0`，**28/28 测试文件全部通过，135/135 用例全部通过**（含 `tests/b1-05-workspace-ui.test.tsx` 7/7，覆盖 `ServiceResolutionV1` 8 态、无覆盖 `ui/panel.html` 注册、第三方自定义标准页接管、停用移除、bridge RPC 代理、`AbortSignal` 取消迟到丢弃与 `peer-plugins.test.tsx` / `phase2-explorer-approval.test.tsx` / `ui-slots.test.tsx` / `phase4-triage-inbox.test.tsx` 等）。
3. **无头 Chrome 真实 `SandboxedPluginFrame` 沙箱 E2E 验证**：
   - 命令：`node "C:\Users\windfile\.gemini\antigravity\brain\c95df033-adbe-4061-bafe-3d65c04fb472\scratch\verify-ui-e2e.mjs"`
   - 结果：退出码 `0`（`E2E SandboxedPluginFrame + 3rd-party custom UI takeover verification PASSED!`）。验证了预装导入沙箱 iframe 并发发现与单源错误隔离、预览提交刷新、预装搜索与第三方自定义搜索 `ui/custom-search.html` 切换接管、以及跨沙箱 `navigateToSession` 跳转落地 `#chat-turn-import_1`。
4. **空白检查**：
   - 命令：`git diff --cached --check`
   - 结果：退出码 `0`

### 验证截图

- 沙箱 iframe 历史导入页与预览提交：`C:\Users\windfile\.gemini\antigravity\brain\c95df033-adbe-4061-bafe-3d65c04fb472\b1-05-history-import.png`（副本同步至 `D:\HarnessMate\b1-acceptance\b1-05-history-import.png`）
- 第三方自定义搜索沙箱 iframe 接管页：`C:\Users\windfile\.gemini\antigravity\brain\c95df033-adbe-4061-bafe-3d65c04fb472\b1-05-session-search.png`（副本同步至 `D:\HarnessMate\b1-acceptance\b1-05-session-search.png`）
