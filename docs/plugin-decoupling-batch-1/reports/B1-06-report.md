# B1-06 · Batch 1 集成与 Windows 便携候选包交付报告

## 1. 基线、任务提交与集成分支

- **共同基线分支与提交**：`b1/baseline`（`4eed4537f15d48e4e99d2cd033fe2e15d578083f`，基于 `main` `9eee791`）
- **集成分支与代码/打包候选提交**：`b1/integration` 代码与 EXE 构建候选提交 `b4b360877b87eda950da9c951f7c043cc424bbaf`（`b4b3608`）
- **按序合并的 5 个任务提交**（均为 `--no-ff` 无冲突合并）：
  1. **B1-01** (`b1/b1-01-plugin-host`): `7eba5ec` (`e1f98c5` merge)
  2. **B1-02** (`b1/b1-02-history-sources`): `01604ce` (`64d1d5f` merge)
  3. **B1-03** (`b1/b1-03-history-import`): `b4fe766` (`c0b1a44` merge)
  4. **B1-04** (`b1/b1-04-session-search`): `09c15c4` (`c7094fb` merge)
  5. **B1-05** (`b1/b1-05-workspace-ui`): `d22d576` (`ba8d883` merge)
- **约束遵守情况**：未修改主目录 `D:\HarnessMate\harnessmate_desktop`、`main` 分支、生产数据目录 `%USERPROFILE%\.harnessmate-desktop` 及个人历史目录（仅只读探测）。

### 1.1 宿主挂载、发行组合与 Batch 1 暂时保留适配器清单

1. **Daemon 路由与宿主服务挂载**（`packages/daemon/src/server/app.ts`）：
   - 实例化 `SessionChangeFeedService` 与 `HistoryImportAdapter`，在 `createBuiltinPlugins(...)` 注册 `core.history-session-data`（提供 `hm.session-data.v1`）。
   - 使用 `registerHistoryImportCompatRoutes` 替换内联 `/api/v1/harnesses/discovered-sessions`、`/api/v1/harnesses/import-session`、`/api/v1/sessions/import-bundle`。
   - 使用 `registerSessionSearchCompatRoutes(..., { allowLegacyFallback: false })` 替换内联 `/api/v1/search/sessions`、`/api/v1/search/reindex`，并挂载 `/api/v1/search/status`、`/api/v1/search/reindex/cancel`、`/api/v1/search/reindex/resume`。
   - 挂载 `registerServiceResolutionRoute`（`GET /api/v1/plugins/services/resolve`），并在 `GET /api/v1/workspaces/:id/bindings` 的 `resolved` 中补齐 `history.import.v1` 与 `session.search.v1`。
2. **发行组合与预装清单**（`manifests.ts`、`harnessmate-core.json`、`stage-bundle.mjs`）：
   - `BUNDLED_PLUGIN_IDS` 新增：`hm.plugin.history-source-codex`、`hm.plugin.history-source-claude`、`hm.plugin.history-source-agy-cli`、`hm.plugin.history-source-agy-desktop`、`hm.plugin.history-import`、`hm.plugin.session-search-fts`（共 11 个 bundled 插件）。
   - `BUNDLED_TRUSTED_LOCAL_IDS` 新增上述 4 个 `hm.plugin.history-source-*`（以支持受控读取本机外部历史目录）。
   - `harnessmate-core.json` `bindings` 新增：`"history.import.v1": "hm.plugin.history-import"`、`"session.search.v1": "hm.plugin.session-search-fts"`、`"hm.session-data.v1": "core.history-session-data"`。
   - `packages/electron/scripts/stage-bundle.mjs` 同步打包 `harnessmate-core.json` 至 `resources/daemon/` 与 `resources/bundles/`。
3. **本批暂留适配器与后续批次接走范围**：
   - `packages/daemon/src/plugin-host/builtin/services.ts` 中 `hm.plugin.session-explorer` 已移除 `turn.completed` 实时索引监听与启动 `rebuildBacklogIndex` 定时器，`SessionManager.sendTurn` / `handleAdapterEvent` 已移除直接 `this.store.indexSearchItem(...)` 写入。
   - `hm.plugin.session-explorer` 仍保留 `ctx.provide('session-search', explorer)`，以及 `SessionManager` 保留 `getExplorerService()`、`searchSessions()`、`rebuildSearchIndex()`、`importExternalSession()`、`importSessionBundle()`，仅作为 Batch 1 期间供非本批能力（`forkSession`、`mergeBack`、`sendSideChat`、`promoteSideChatToFork`、`exportSession` 与既有内核单元测试）使用的临时适配器，待后续批次分别迁移为独立插件后统一移除。

---

## 2. Windows x64 便携候选包详情

- **适用构建提交**：`b4b360877b87eda950da9c951f7c043cc424bbaf` (`b1/integration`)
- **便携 EXE 完整路径**：`D:\HarnessMate\b1-acceptance\pack-staging\HarnessMate-Desktop-0.6.0-portable.exe`
- **版本 / 架构**：`0.6.0` / Windows x64 Portable (`electron@35.7.5`, `electron-builder@26.18.0`)
- **文件大小 / SHA-256**：`85304477` bytes / `7241A9812423CAF0058C33484B2B28E62048A7EE2627A14B14FA1C69BD1F707C`
- **数字签名状态**：`NotSigned`（`Get-AuthenticodeSignature` 验证未签名，仅用于本地验收）
- **实际打包命令与差异原因**：
  1. 在工作区执行 `pnpm pack:exe`（即 `node scripts/stage-bundle.mjs && electron-builder --win portable --x64`）时，`stage-bundle.mjs` 成功生成 `resources/daemon/{daemon.cjs,harnessmate-core.json,plugin-sdk-testing.mjs,ai-builder-context.md}`、`resources/web-dist/` 与 11 个 `resources/bundled-plugins/`；但在最后 NSIS `makensis.exe` 步骤因 worktree 下 `node_modules/.pnpm/app-builder-lib@26.18.0.../extractAppPackage.nsh` 路径超过 250 字符触发 32 位 `makensis.exe` `MAX_PATH` 无法打开文件而失败。
  2. 按照仓库既有 D 盘独立打包规避策略（`docs/plugin-extension-recovery-plan.md`），将完全一致的 staged `electron-builder.yml`、`dist/`、`build/`、`resources/` 复制至短路径 `D:\HarnessMate\b1-pack`（去除 `package.json` 的 `workspace:*` 依赖后通过 `pnpm install --prefer-offline --ignore-scripts --store-dir D:\HarnessMate\agy-np-pnpm-store` 安装同版本 `electron` 与 `electron-builder`），执行 `pnpm exec electron-builder --win portable --x64` 成功产出上述 EXE。
- **内含预装插件清单**（`resources/bundled-plugins/` 共 11 个）：
  - `hm.plugin.history-source-codex`、`hm.plugin.history-source-claude`、`hm.plugin.history-source-agy-cli`、`hm.plugin.history-source-agy-desktop`
  - `hm.plugin.history-import`、`hm.plugin.session-search-fts`
  - `hm.plugin.browser-desktop`、`hm.plugin.browser-headless`、`hm.plugin.file-preview-text`、`hm.plugin.file-preview-markdown`、`hm.plugin.approval-policy-default`
- **D 盘隔离启动参数与验收目录**：
  - 临时目录：`TEMP` / `TMP` = `D:\HarnessMate\b1-tmp\b1-06`
  - 旧版只读脱敏副本：`D:\HarnessMate\b1-acceptance\legacy-readonly-copy\`（8 个工作区、14 个会话、18,634 条事件、272 条 turnItems、5 条 `native_history_imports`）
  - 独立验收运行目录：`D:\HarnessMate\b1-acceptance\isolated-runs\exe-fresh-b1`（`HARNESSMATE_PORT=4891`）与 `exe-legacy-migration`（`HARNESSMATE_PORT=4892`），配合 `--user-data-dir=<D 盘独立 appdata>`、`HARNESSMATE_DATA_DIR=<D 盘数据目录>`。

---

## 3. A1–A6 集成自测结果与证据矩阵

| 门禁 | 结论 | 适用提交 / 包 | 实际执行命令、退出码与关键证据 |
| --- | --- | --- | --- |
| **A1** 可复现交付 | **PASS**（注记并发参数） | `b4b3608` | `pnpm contracts:check` (exit 0)、`pnpm build` (exit 0)、`pnpm typecheck` (exit 0)、`git diff --check` (exit 0)。`pnpm test` 并发跑时受 CPU 争用影响曾触发 `phase4-triage-inbox.test.tsx:150` 16ms 性能微基准波动（20.28ms）；串行各包并加 `--maxWorkers=2 --testTimeout=60000` 执行全量测试全部通过：`@harnessmate/protocol` **6/6**、`@harnessmate/web` **134/134**（28 文件）、`@harnessmate/daemon` **289/289**（54 文件，含新增 `tests/b1-06-integration.test.ts`），均 exit 0。 |
| **A2** 插件归属与可卸载性 | **PASS** | `b4b3608` / portable EXE | 自动化 `b1-06-integration.test.ts` + 实机 EXE `run-exe-acceptance.mjs` 验证默认组合 11 个 bundled 插件全为 `ACTIVE`，`services/resolve` 均返回 `ready`；停用搜索/导入插件后兼容路由严格返回 `503 E_SERVICE_UNAVAILABLE`，且能从本地目录安装第三方 `user.history-source-custom` 与 `hm.plugin.session-search-lite`。 |
| **A3** 冲突与选择模型 | **PASS** | `b4b3608` / portable EXE | 实机 EXE 同时激活 `user.history-source-custom` + `source.custom.alt` 两个自定义来源实例；同时在 `wsA`（`hm.plugin.session-search-fts`）与 `wsB`（`hm.plugin.session-search-lite`）并存双搜索引擎，停用 FTS 时 `wsA` 失败闭合 503 而 `wsB` 保持 `200` 正常检索；自动化 `b1-01`/`b1-02` 覆盖反转加载顺序一致。 |
| **A4** 导入可靠性与迁移 | **PASS** | `b4b3608` / portable EXE | 实机 EXE 验证 `user.history-source-custom` `attach` 导入幂等复用（`disposition: "reused"`），并在独立 `exe-legacy-migration` 运行中完整打开脱敏旧库 8 个工作区、14 个会话、5 条原导入身份（`1 agy_cli + 4 codex_desktop`）及事件流，支持 `json_bundle` v2 导出与二次导入；`b1-03` 覆盖并发去重、提交前取消、事务原子回滚及停用导入后旧会话仍可读可导出。 |
| **A5** 索引可恢复性 | **PASS** | `b4b3608` / portable EXE | 实机 EXE 在停用 `hm.plugin.session-search-fts` 期间导入中文会话 `停用期间离线入库`（`离线追平验证词条`），重新启用并执行增量重建后检索命中且包含 `sessionId`、`turnId` 与 `<mark>` 高亮摘要；`b1-04` 覆盖中断断点续跑与崩溃恢复。 |
| **A6** Windows 便携包与回归 | **PASS** | `b4b3608` / portable EXE | 实机启动 `HarnessMate-Desktop-0.6.0-portable.exe` 完成 A2–A6 全链路自测，验证空业务组合恢复后可 `builtin` 一键复原，验证 `filePreview.v1`（text & markdown）保持 `line=42` 与 `browser.v1` 就绪，并完成 headless Edge UI 渲染截图；证据见 `D:\HarnessMate\b1-acceptance\evidence\exe-acceptance-results.json`。 |

### 3.1 五类历史来源实测矩阵（严格只读）

| 来源类型 | 对应插件 | 实机 EXE 只读探测结果 | 样本类型与补充说明 |
| --- | --- | --- | --- |
| **Codex CLI** | `hm.plugin.history-source-codex` | 实际跑过（扫描本机只读目录，返回 `codex_desktop: 50` 条上限分页结果） | 真实机 Codex `CODEX_HOME` 为桌面端 rollout；CLI 形态已在 `b1-02-history-sources.test.ts` 合成夹具覆盖 |
| **Codex Desktop** | `hm.plugin.history-source-codex` | 实际跑过：`discoveredCount: 50`（含脱敏样本 `01a203f0-...`） | 本机真实只读样本 + `legacy-readonly-copy` 中 4 条 `codex_desktop` 导入记录迁移复验 |
| **Claude CLI** | `hm.plugin.history-source-claude` | 实际跑过：`discoveredCount: 11`（`claude_cli: 11`，如 `43a572a1-...`） | 本机真实只读 `~/.claude` 样本 + `b1-02` 合成夹具 |
| **AGY CLI** | `hm.plugin.history-source-agy-cli` | 实际跑过：`discoveredCount: 50`（`agy_cli: 50`，如 `736466e4-...`） | 本机真实只读样本 + `legacy-readonly-copy` 1 条 `agy_cli` 导入记录迁移复验 |
| **AGY Desktop** | `hm.plugin.history-source-agy-desktop` | 实际跑过：`discoveredCount: 50`（`agy_desktop: 50`，如 `96bbf5d1-...`） | 本机真实只读样本 + `b1-02` 合成夹具 |
| **第三方自定义来源（扩展）** | `user.history-source-custom` | 实际跑过：EXE 内安装两实例并发 discover + `attach` 导入 + 去重复用 | 包内自带 `samples/custom-session-001.jsonl` 等夹具 |

### 3.2 桌面实机界面截图证据

- **桌面 UI 截图（对话目录 & D 盘留存）**：
  - `C:\Users\windfile\.gemini\antigravity\brain\96bbf5d1-4202-4b64-ade7-0fb319d09b98\b1-06-exe-ui.png`
  - `D:\HarnessMate\b1-acceptance\evidence\b1-06-exe-ui.png`
  - 界面直接呈现便携 EXE 运行态下侧边栏插件工作页入口（桌面浏览器、无头浏览器、历史会话导入、会话搜索 FTS5/Lite）、`hm.plugin.session-search-fts (1.0.0)` 就绪选择器、`EXE WS A / B` 工作区与已导入/离线追平会话。

---

## 4. 已知限制与集成期问题记录

1. **`makensis.exe` 259 字符路径限制**：在长路径 worktree 下执行 `pnpm pack:exe` 会在最后一步 NSIS 打包因 `node_modules/.pnpm/app-builder-lib...` 路径过长失败，已通过同资源 D 盘短路径 `D:\HarnessMate\b1-pack` 完成便携 EXE 构建（不影响源码和运行产物）。
2. **`hm.plugin.session-search-lite` 示例插件中文连续词分词边界**：`plugins/examples/hm.plugin.session-search-lite/index.mjs` 对正文做 CJK 单字与二元切分，但查询侧若输入连续 4 字以上中文（无空格且原文无独立完整 token 匹配）会命中倒排全词查无结果导致返回 0 条（不影响预装 FTS5 默认引擎）。
3. **`pnpm test` 高并发争用**：默认 `pnpm -r test` 在本机并行启动大量 Vitest worker 与 11 个隔离插件子进程时，偶发 `phase4-triage-inbox.test.tsx` 16ms 性能门槛超时或子进程握手竞争；串行 workspace + `--maxWorkers=2 --testTimeout=60000` 稳定全绿。

---

## 5. 数据与配置回退步骤及验证结果

### 5.1 复现与回退步骤（总指挥可直接用同一包和副本复验）

1. **只读源副本**：`D:\HarnessMate\b1-acceptance\legacy-readonly-copy\` 始终保持只读，勿直接指向其启动 EXE。
2. **创建隔离副本与回退备份**：复制 `{config.json, harnessmate.db, profile.json, patch.yml, plugin-composition.previous.json}` 至新建隔离目录（将副本 `config.json` 的 `port` 改为独立端口如 `4892`），同时留存备份目录。
3. **以候选 EXE 验证并回退**：
   - 使用 `HARNESSMATE_DATA_DIR=<隔离目录>`、`HARNESSMATE_PORT=4892` 与 `--user-data-dir=<隔离 appdata>` 启动 `HarnessMate-Desktop-0.6.0-portable.exe`。
   - 关闭 EXE 后，将备份目录中的 `profile.json`、`patch.yml`、`plugin-composition.previous.json` 覆盖回隔离目录，并切回旧版包即可完成配置与版本回退；数据库新增的 `session_change_log` 与 `history_import_mappings` 表及 `native_history_imports` 保持向后兼容，旧表结构与既有行不被破坏。

### 5.2 回退后实测核验数据（`exe-legacy-migration`）

- **迁移前只读快照基线**：`workspaces=8`、`sessions=14`、`events=18634`、`turnItems=272`、`nativeHistoryImports=5`
- **迁移后（含 1 次 bundle v2 往返导入 + 全量 FTS 重建 `406` 条）及配置文件回退后只读核验 SQLite**：
  - `workspaces=8`、`sessions=15`（原有 14 条全部保留 + 1 条新导入副本）、`events=19142`、`turnItems=406`、`nativeHistoryImports=5`、`sessionChangeLog=135`
  - 原有工作区、会话、事件与导入去重映射完整可读，`originalSessionsIntact=true`。
