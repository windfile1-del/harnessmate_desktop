# NP-14 交付报告 · Plan、Artifact Review 与 Browser Agent

## 1. 基线、Worktree 与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-14`（Plan、Artifact Review 与 Browser Agent） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| G3 第一批已复验源码 | `5711a8266bdca72fd34a5dd07f59aedfb108a237` |
| Reviewed Base（G3 第二批统一开工基线） | `9826359a46d0518c88d12ca45318bb5cb891a73a`（本地标签 `agy-np-g3-wave1`，经 `git merge-base --is-ancestor` 验证包含 `5711a82`） |
| 实际工作分支 / Worktree | `np14_artifact_review_browser` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np14_artifact_review_browser`（同时经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np14_artifact_review_browser`；建议交付分支名 `codex/agy-np-14-review-browser`） |
| **代码交付提交 SHA** | **`2191ee002ab9d400713badacf37ed4f67f644e91`**（`feat(agy-np-14): implement safe artifact reader, review bridges, plan/diff separation, and browser agent view`） |
| 公共协议契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零改动） |
| 联合端口契约版本 | `DYNAMIC_ARTIFACT_PORT_REVISION = 'agy-np11-np14-artifact-port-v1.0.0'`（消费零改动）；`TeamworkArtifactReviewPort`（消费零改动） |
| NP-14 私有域 DTO 契约版本 | `AGY_ARTIFACT_SCHEMA_VERSION = 1` · `AGY_ARTIFACT_CONTRACT_REVISION = 'agy-np14-artifacts-v1.0.0'` |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零改动） |
| `MASTER_PROGRESS.md` | 未修改（由总指挥统一维护） |

## 2. 实际变更路径与文件所有权核对

全部代码、夹具与测试严格限定在 NP-14 允许写入范围内（`packages/daemon/src/harnesses/agy/agy-artifacts.ts`、`packages/daemon/src/harnesses/agy/native/artifacts/**`、`packages/web/src/components/agy/native/review/**`、`packages/web/src/components/agy/AgyArtifactReviewPanel.tsx`、专属测试夹具与 `docs/phase-agy-native-parity/handoffs/NP-14-report.md`）。`packages/protocol/**`、`packages/plugin-api/**`、`packages/daemon/src/harnesses/agy/native/wiring/**`、`workflows/**`、`child/**`、`commands/**`、`requests/**`、`packages/daemon/src/core/**`、`packages/daemon/src/db/**`、`packages/daemon/src/server/**`、`packages/web/src/App.tsx`、`ChatStage.tsx`、`DiffInspectorPanel.tsx`、`MarkdownView.tsx`、`slots/**`、`stores/**`、`components/agy/native/shared/**`、`packages/web/tests/phase-agy-ui.test.tsx` 及其他 Harness 适配器均 **零修改**。

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/agy-artifacts.ts` | 加固既有只读脑区文件接口：导出 `isSafeArtifactSegment`、`isAllowedArtifactExtension`，在 `listAgySessionArtifacts` 与 `readAgySessionArtifact` 均强制段校验与扩展名白名单（阻断 `.html`/`.svg`/`.db`/ADS/控制字符/尾点空格），并在 `readAgySessionArtifact` 增加 `fstatSync` dev/ino 文件句柄复核与 NUL 二进制拒读 |
| `packages/daemon/src/harnesses/agy/native/artifacts/contracts.ts` | 定义 NP-14 严格 Zod `.strict()` DTO 与契约（`OpaqueArtifactIdSchema`、来源/格式分类、`verifiedActionKeys`、`AgyPlanSnapshotDtoSchema`、`AgyToolDiffEntryDtoSchema`、`BrowserAgentObservationDtoSchema`）、三组独立门控 `DEFAULT_AGY_ARTIFACT_FEATURE_GATES`（默认全关闭）与 fail-closed `NativeArtifactReviewTransportPort` 桩 |
| `packages/daemon/src/harnesses/agy/native/artifacts/redaction.ts` | 实现宿主路径/UNC/`file://` 脱敏、OAuth/Bearer/PEM/Cookie 凭据脱敏、HTML/XSS 与未审查外链/外图检测拦截、相对显示路径裁剪、`verifyManagedTextArtifactSync`（非 reparse + 扩展名 + fstat + NUL 校验）与 `inspectManagedMediaReferenceSync`（PNG/JPEG/WEBP/WEBM/MP4 magic-header 校验，拒读 SVG/HTML） |
| `packages/daemon/src/harnesses/agy/native/artifacts/artifact-store.ts` | 实现 `AgyNativeArtifactService`：托管 brain 扫描与版本化、`registerObservedArtifact`（对接 NP-05 `ChildScopeResolverPort` 校验 parent/child 归属）、连接/代次/历史栅栏、分页只读读取、以及 `createTeamworkArtifactReviewPort()`（严格校验同绑定/同连接/同当前 Artifact 版本/同 `requestId`、幂等回执与 G3-03 异步竞态复核）与 `createDynamicWorkflowArtifactReaderPort()`（对接 NP-11） |
| `packages/daemon/src/harnesses/agy/native/artifacts/plan-diff-browser-observer.ts` | 实现 `AgyPlanDiffBrowserObserver`：分离标准 ACP `plan` 与 AGY `update_steps` 及 Plan 模式状态（`AGY-W13`）、分离 ACP 工具 Diff（`AGY-W15`）、观测 Browser Agent 通道区分 `app_embedded_browser` / `cli_chrome_mcp` / `enterprise_chrome_mcp`（`AGY-W16`，`controlSupported` 恒为 `false`，独立 `mediaArtifactsEnabled` 门控）、严格拦截 live 入口的 `history_replay` 帧（G3-05） |
| `packages/daemon/src/harnesses/agy/native/artifacts/descriptors.ts` | 导出 `NP14_CAPABILITY_CONTRIBUTIONS`（覆盖 `AGY-W13`、`AGY-W14`、`AGY-W15`、`AGY-W16`，与能力矩阵门控一致） |
| `packages/daemon/src/harnesses/agy/native/artifacts/fixtures.ts` | NP-14 离线回放加载器与合成验证评审传输桩（仅供测试/回放使用） |
| `packages/daemon/src/harnesses/agy/native/artifacts/index.ts` | 后端 NP-14 模块导出入口 |
| `packages/daemon/tests/fixtures/agy-np14/README.md` | 离线回放夹具来源与脱敏说明 |
| `packages/daemon/tests/fixtures/agy-np14/t16-plan-diff-browser.ndjson` | T16 合成回放夹具（Plan 进入/退出、ACP plan、`update_steps`、tool diff、App 内嵌浏览器与 Chrome MCP、`history_replay` 隔离） |
| `packages/daemon/tests/agy-np14-artifacts-review-browser.test.ts` | Daemon 4 大测试套件（5 个测试用例覆盖 T16 真实磁盘与 Windows junction 逃逸拦截、T12 Teamwork 联合审阅与 G3-03 异步竞态、T13 Dynamic Workflow 联合脚本/结果分页与越权拦截、T16 Plan/Diff 分离、Browser 通道与历史隔离） |
| `packages/web/src/components/agy/native/review/types.ts` | 前端工作台视图模型、门控与事件回调类型定义 |
| `packages/web/src/components/agy/native/review/safe-content.ts` | 纯文本 AST Markdown 解析与链接/XSS 净化器（零 `dangerouslySetInnerHTML`、零原始 HTML/SVG、阻断外部追踪图片与未审查外链、仅放行 `antigravity.google` / `agentclientprotocol.com` 文档链接）及行号 Diff 格式化器 |
| `packages/web/src/components/agy/native/review/SafeArtifactContentView.tsx` | 安全产物详情视图（Markdown/文本行号/Diff 切换、脱敏安全横幅、分页加载、基于能力门控的行级评论与原生批准/拒绝及官方 App/CLI 降级提示、`EvidenceDetails`） |
| `packages/web/src/components/agy/native/review/PlanAndDiffSeparationPanel.tsx` | Plan（`AGY-W13`）与 ACP 工具 Diff（`AGY-W15`）分离面板，明确区隔 Artifact Review 与工作区 Git Diff |
| `packages/web/src/components/agy/native/review/BrowserAgentPanel.tsx` | Browser Agent 观测面板（`AGY-W16`）：区分 App 内嵌（App-only，不复刻浏览器控制）与 CLI/企业 Chrome MCP、角色归属与跳转、脱敏日志、独立 `mediaArtifactsEnabled` 门控与官方 `browser`/`browser-recordings` 链接 |
| `packages/web/src/components/agy/native/review/AgyArtifactReviewWorkspace.tsx` | 主工作台（列表检索/来源与格式过滤、三分区 Tablist、480px 窄屏适配、独立三开关门控状态与关闭降级） |
| `packages/web/src/components/agy/native/review/fixtures.ts` | 前端只读/审阅/Plan/Diff/Browser 离线夹具 |
| `packages/web/src/components/agy/native/review/index.ts` | 前端 NP-14 模块导出入口 |
| `packages/web/src/components/agy/AgyArtifactReviewPanel.tsx` | 保留 `AgyEcosystemPanel` 完整导出与旧只读面板兼容；当显式传入启用 `nativeArtifactsEnabled` 的 `nativeWorkspace` 时渲染 `AgyArtifactReviewWorkspace`，旧模式移除自然语言 `sendTurn` 伪造批准并默认禁用未证实批准按钮 |
| `packages/web/tests/agy-np14-review-browser.test.tsx` | Web UI 测试套件（5 项测试覆盖 XSS/外链中和、门控开关与历史锁、Plan/Diff 分离、Browser App-only vs Chrome MCP 与媒体门控、480px 窄屏与旧面板兼容） |

## 3. 已实现事项与未覆盖事项

### 3.1 已实现核心能力

1. **受控文件边界与脱敏防御（`AGY-W14`）**：`agy-artifacts.ts` 与 `redaction.ts` 在真实目录读取链路校验 segment/扩展名白名单、拒绝 reparse/Windows junction 跨根逃逸、复核打开句柄 `dev`/`ino`、拒读含 NUL 二进制、并对凭据、宿主路径、HTML/XSS 标签及未审查外链实施脱敏与阻断。
2. **NP-10 Teamwork & NP-11 Dynamic Workflow 联合端口**：
   - `AgyNativeArtifactService.createTeamworkArtifactReviewPort()` 对接 `AgyTeamworkWorkflowObserver`，强制检验门控开关、verified wire schema、同 `RuntimeBinding`、同 `activeConnectionId`、同当前 Artifact `revision`、同 `requestId`、幂等键摘要防重放，以及异步返回后连接/版本二次复核（G3-03）。
   - `AgyNativeArtifactService.createDynamicWorkflowArtifactReaderPort()` 对接 `DynamicWorkflowObserver`，以 `(runtimeId, generation, workflowId, artifactId)` 作用域校验拦截原始 `ScriptPath` / 盘符 / 遍历路径并支持文本与结构化 JSON 分页脱敏读取。
3. **Plan / Diff / Artifact Review 清晰分离（`AGY-W13` / `AGY-W15`）**：独立区分标准 ACP `plan`、AGY `update_steps`、ACP 工具 Diff 与 AGY Artifact Review，避免与工作区 Git Diff 或原生评审状态混同。
4. **Browser Agent 真实角色/日志/媒体门控观测（`AGY-W16`）**：区分 `app_embedded_browser`（App-only，不复刻控制）、`cli_chrome_mcp` 与 `enterprise_chrome_mcp`，经独立 `mediaArtifactsEnabled` 门控仅展示 magic-header 校验通过的 PNG/JPEG/WEBP/WEBM/MP4 元数据（绝不读取/渲染 SVG 或任意 HTML），并附官方文档入口。
5. **安全前端工作台与旧版兼容**：`SafeArtifactContentView` 纯 React AST 渲染（零 `dangerouslySetInnerHTML`），支持 480px 窄屏、三层独立开关关闭降级与旧 `AgyArtifactReviewPanel` 只读兼容。

### 3.2 明确未覆盖事项（范围外或等待实机授权）

- **真实 Windows AGY 1.5.16+ 与官方 App / Chrome MCP 对照录制（`live_raw` / `live_hm` / `official_comparison`）尚未运行**：本轮无官方账号实时交互采样与截图/录像实测，原生评论/批准的 wire schema 与 Browser Agent 实际字段形状保持 `unverified_pending_live_capture` 门控与降级提示；**不抬升 `AGY-W13`..`AGY-W16` 的 L2–L5 能力等级**。
- **未修改共享接线文件**：遵守 G3 文件所有权，未直接改动 `wiring/composition.ts`、`wiring/routes.ts`、`PluginSlotSync.tsx`、`commands/catalog.ts` 或 `app-store.ts`（见第 6 节接线提案）。

## 4. 测试验证、证据分类与 Capability ID

### 4.1 已执行命令与结果

运行环境：Windows，Node.js，pnpm `11.21.0`，临时目录隔离至 D 盘（`D:\AppDataCache\np14-tmp`）。除第 4–6 行全量回归先于测试文件末尾未使用导入清理（`2191ee0` 中已包含的最终清理）运行外，其余构建、类型检查、契约校验、NP-14 专项与 `multi-harness-orchestrator.test.ts` 均在最终代码提交 `2191ee002ab9d400713badacf37ed4f67f644e91` 对应源码上执行并通过：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | 6/6 workspace 包构建通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`；Vite 既有 `app-features` 641.42 kB 提示未破坏构建） | `synthetic`（构建） |
| `pnpm typecheck` | `0` | 6/6 workspace 包零类型错误 | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过，Plugin SDK 契约零破坏 | `synthetic`（契约） |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 tests/agy-np14-artifacts-review-browser.test.ts` | `0` | **1 file, 5/5 passed**（T16 真实文件与 Windows junction 逃逸/二进制 NUL/脱敏、T12 Teamwork 联合审阅与 G3-03 竞态、T13 Dynamic 联合分页与路径拦截、T16 Plan/Diff/Browser 与 `history_replay` 隔离） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1 tests/agy-np14-review-browser.test.tsx` | `0` | **1 file, 5/5 passed**（XSS/外链中和、门控开关与历史只读、Plan/Diff 分离、Browser App-only vs 企业 Chrome MCP 与媒体门控、480px 窄屏与旧面板兼容） | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 tests/agy-np14-artifacts-review-browser.test.ts tests/agy-np10-teamwork.test.ts tests/agy-np11-dynamic-workflow.test.ts` | `0` | **3 files, 17/17 passed**（NP-14 5/5 + NP-10 6/6 + NP-11 6/6） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1 tests/agy-np14-review-browser.test.tsx tests/phase-agy-ui.test.tsx tests/agy-np10-teamwork.test.tsx tests/agy-np11-dynamic-workflow-studio.test.tsx` | `0` | **4 files, 21/21 passed**（NP-14 5/5 + AGY UI 5/5 + NP-10 6/6 + NP-11 5/5） | `synthetic` |
| `pnpm --filter @harnessmate/protocol test -- --maxWorkers=1` | `0` | **2 files, 6/6 passed** | `synthetic` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1` | `0` | **22 files, 111/111 passed** | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1`（全量串行） + `tests/multi-harness-orchestrator.test.ts --testTimeout=60000` | 全量 `1`（41/42 文件 `226/228`）；60s 复跑 `0`（`6/6`） | 全量串行时 41/42 文件通过；既有 `tests/multi-harness-orchestrator.test.ts` 的 2 项真实 Git worktree 重度用例（实测分别耗时 21.5s 与 24.2s）在默认 30s 超时下超时，随后在 `2191ee0` 最终源码上以 `--testTimeout=60000` 复跑 **6/6 passed** | `synthetic` + `replay_with_provenance` |
| `git diff --check 9826359a46d0518c88d12ca45318bb5cb891a73a` & `git diff --cached --check` | `0` | 零空白符或冲突标记问题 | 静态检查 |

### 4.2 未执行的检查与原因

- **Windows 真机授权测试与官方 App/CLI 对照（`live_raw` / `live_hm` / `official_comparison`）**：待总指挥按 U01 测试 Profile 授权执行后采集真实 `plan`、`artifact`、`review` 及 Browser/Chrome MCP 帧与截图证据，补充至对应 `reviews/` 或 `evidence/` 并决定是否解锁真机线格式及提升能力等级。

### 4.3 关联证据 ID、风险与 Capability ID

- **关联 Capability ID**：`AGY-W13`（Plan 与执行步骤）、`AGY-W14`（Artifacts、审阅与行级反馈）、`AGY-W15`（Diff 与变更审阅）、`AGY-W16`（Browser Agent），协同支撑 `AGY-W07`（Teamwork Prompt Artifact 门控）与 `AGY-W08`（Dynamic Workflow 脚本/结果只读读取）。
- **证据与设计来源**：`E01`、`E02`、`E04`、`E05`、`E06`、`S20`、`S21`、`T12`、`T13`、`T16`。
- **风险缓解**：`R-05`（非 reparse/junction 防护与只读降级）、`R-06`（凭据/宿主路径脱敏与外链/HTML 中和）、`R-09`（能力未证实前关闭交互批准与浏览器控制）、`R-11`（独立域契约与特征门控）、`R-15`（严格遵循目录所有权边界）。

## 5. 数据与其他 Harness 回归结论

- **旧数据与兼容契约**：未更改 `packages/protocol/src/agy-native-v1.ts` 与 SQLite 迁移（维持 `component='agy-native-runtime', version=1`）；既有的 `listAgySessionArtifacts` / `readAgySessionArtifact` 返回签名保持向后兼容，同时补齐扩展名与句柄验证。
- **跨 Harness 与生态回归**：Codex、Claude、Strict ACP、DeepSeek、OpenCode、AGY 1.5.14 回放（`agy-replay-protocol.test.ts` 2/2）、NP-01..NP-11 全部测试、Context Handoff、Git Checkpoints、Plugin SDK 契约（`contracts:check`）、`protocol`（6/6）与 `web`（111/111）全部通过；`multi-harness-orchestrator.test.ts` 在放宽 Windows Git I/O 超时至 60s 后 6/6 通过，零跨 Harness 功能回归。

## 6. 冲突声明与给共享 Owner 的协作变更提议

当前 **零文件冲突**。进入 G3 串行集成阶段向共享模块 Owner 提交以下最小变更提议（均附 NP-14 单元测试用例与接口签名）：

1. **给总指挥 / NP-02（`packages/daemon/src/harnesses/agy/native/wiring/composition.ts` 与 `routes.ts`）**：
   - 在 `wireAgyNativeRuntime` 实例化 `AgyNativeArtifactService`（默认门控全关闭：`DEFAULT_AGY_ARTIFACT_FEATURE_GATES`）与 `AgyPlanDiffBrowserObserver`：
     - 将 `NP14_CAPABILITY_CONTRIBUTIONS` 注册至 `AgyNativeCommandCatalogService`。
     - 将 `artifactService.createTeamworkArtifactReviewPort()` 注入 `AgyTeamworkWorkflowObserver({ artifactReviewPort })`，将 `artifactService.createDynamicWorkflowArtifactReaderPort()` 注入 `DynamicWorkflowObserver({ artifactReader })`。
     - 在 `connection.attach` / `ingest` / `close` 转发绑定与 `session/update` 帧至 `artifactService` 与 `planDiffBrowserObserver`，并将历史读路径隔离至 `ingestHistoricalReplay`。
     - 如需对外暴露 NP-14 REST 查询端点（`/api/v1/sessions/:id/native/artifacts`、`plan`、`diffs`、`browser`），由 NP-02 在 `routes.ts` 注册并沿用 `ArtifactResourceSummaryDtoSchema` / `ArtifactResourceContentDtoSchema` / `AgyPlanSnapshotDtoSchema` / `BrowserAgentObservationDtoSchema` 白名单校验。
2. **给 NP-03（`packages/web/src/slots/PluginSlotSync.tsx` 与原生 Store）**：
   - 在 `PluginSlotSync.tsx` 注册 `agy-artifacts` 插槽处，当 `agyNativeWorkbenchEnabled` 与 `nativeArtifactsEnabled` 启用时，向 `<AgyArtifactReviewPanel session={session} nativeWorkspace={...} />` 注入经原生投影/API 拉取的 `AgyArtifactReviewWorkspaceProps`；门控关闭时自动保留旧只读面板行为。
3. **给 NP-06（`packages/daemon/src/harnesses/agy/native/commands/catalog.ts`）**：
   - 若通过统一能力目录合并 `NP14_CAPABILITY_CONTRIBUTIONS`，保持 `AGY-W14` 审阅控制与 `AGY-W16` 浏览器控制的 `upstream_limited` / `unsupported` 门控直到真机采集完成。

## 7. 独立审查者复验命令与回滚方案

### 7.1 独立审查者复验命令

```powershell
$env:TEMP = 'D:\AppDataCache\np14-tmp'; $env:TMP = 'D:\AppDataCache\np14-tmp'; $env:TMPDIR = 'D:\AppDataCache\np14-tmp'
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
git status --short --branch
git diff --name-status 9826359a46d0518c88d12ca45318bb5cb891a73a..HEAD
git diff --check 9826359a46d0518c88d12ca45318bb5cb891a73a..HEAD
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 tests/agy-np14-artifacts-review-browser.test.ts tests/agy-np10-teamwork.test.ts tests/agy-np11-dynamic-workflow.test.ts
pnpm --filter @harnessmate/web test -- --maxWorkers=1 tests/agy-np14-review-browser.test.tsx tests/phase-agy-ui.test.tsx tests/agy-np10-teamwork.test.tsx tests/agy-np11-dynamic-workflow-studio.test.tsx
```

### 7.2 回滚方案与命令

1. **优先独立功能门控即时关停（无损、保留只读历史与旧面板）**：
   - 仅关闭原生审阅/批准控制：`artifactService.configureGates({ reviewControlEnabled: false })` 且前端传入 `featureGates.reviewControlEnabled = false`（立即恢复受控只读模式）。
   - 仅关闭 Browser 媒体参考：`artifactService.configureGates({ mediaArtifactsEnabled: false })` 且 `planDiffBrowserObserver.setMediaArtifactsEnabled(false)`（立即隐藏截图/录像参考）。
   - 整体关闭 NP-14 工作台：`featureGates.nativeArtifactsEnabled = false` 或移除 `nativeWorkspace` prop，自动回退至旧 `AgyArtifactReviewPanel` 只读预览。
2. **代码提交回滚**：
   - 回滚代码交付提交（及报告提交）：
     ```powershell
     git revert --no-edit HEAD
     git revert --no-edit 2191ee002ab9d400713badacf37ed4f67f644e91
     ```
   - 若合入集成分支后形成 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
