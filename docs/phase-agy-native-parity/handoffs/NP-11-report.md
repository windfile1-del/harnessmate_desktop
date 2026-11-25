# NP-11 交付报告 · Dynamic Workflows 与执行轨迹

## 1. 基线、Worktree 与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-11`（Dynamic Workflows 与执行轨迹） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| G2 源码修复提交 | `f895bf44ad5e850109ab8641fbfb81522214390f`（`fix(agy-np): close G2 runtime, command and approval integration blockers`） |
| Reviewed Base（G3 统一开工基线） | `fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c`（标签 `agy-np-g2`，`docs(agy-np): freeze G2 validation and prepare G3 work packages`） |
| 实际工作分支 / Worktree | `np11_dynamic_workflows` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np11_dynamic_workflows`（平台分配于 D 盘，经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np11_dynamic_workflows`） |
| **代码交付提交 SHA** | **`4529d6b829047d4bcab41dafcc32d07573a47835`**（`feat(agy-np-11): implement dynamic workflow observer, studio UI, fixtures and tests`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零改动） |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零改动） |
| `MASTER_PROGRESS.md` | 未修改（由总指挥统一维护） |

## 2. 实际变更路径与文件所有权核对

全部代码、夹具与测试严格限定在 NP-11 允许写入范围内（`packages/daemon/src/harnesses/agy/native/workflows/dynamic/**`、`packages/web/src/components/agy/native/workflow/**`、独立 fixtures/tests 与本报告）。`packages/protocol/**`、`packages/plugin-api/**`、`packages/daemon/src/harnesses/agy/native/wiring/**`、`runtime/**`、`child/**`、`commands/**`、`requests/**`、`packages/daemon/src/core/**`、`packages/daemon/src/db/**`、`packages/web/src/App.tsx`、`ChatStage.tsx`、`AgyStudioBlocks.tsx`、`shared/**`、`docs/phase-agy-native-parity/MASTER_PROGRESS.md` 及其他 Harness 适配器均零修改。

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/workflows/dynamic/types.ts` | NP-11 领域类型、生命周期阶段、版本化线字段矩阵 `DYNAMIC_WORKFLOW_WIRE_FIELD_VERSIONS`、结构化输出摘要、日志/产物/时间线 DTO 与严格脱敏边界类型 |
| `packages/daemon/src/harnesses/agy/native/workflows/dynamic/ports.ts` | 冻结的 NP-14 安全 Artifact 只读接口 `DynamicWorkflowArtifactReaderPort`、`FrozenDynamicWorkflowArtifactReaderStub`（按 `(runtimeId, generation, workflowId)` 白名单拒绝非不透明路径如 `C:\...` / `..` / `file://`，分页读取脚本预览与结构化 JSON 数组）及 NP-06 目录贡献 `DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION`（`AGY-W08`） |
| `packages/daemon/src/harnesses/agy/native/workflows/dynamic/codec.ts` | `decodeDynamicWorkflowIngress`：识别 `/run-workflow` / `run_workflow`、`Script` 文本预览与 `ScriptPath` 脱敏、`after` 显式依赖边、安全 `JSON.parse` 结构化结果、非零退出/失败与 `session/request_permission`（含脚本审批与 AGY 1.5.16 转发 `interaction_*` 问题）；绝不解析 Python 或读盘 |
| `packages/daemon/src/harnesses/agy/native/workflows/dynamic/observer.ts` | `DynamicWorkflowObserver`（实现 `NativeWorkflowResourceReaderPort`）：按 `(runtimeId, generation)` 隔离状态、入站去重、held activity `listRetentionReasons`、脚本拒绝转 `cancelled`、NP-07 `resolveRequestTarget` 归属（含 `forwardedToParentSession`）、分页资源（`phases` / `logs` / `artifacts`、`board` 诚实不可用）、断连转 `stale`、门控关闭保留已观测工具与产物 |
| `packages/daemon/src/harnesses/agy/native/workflows/dynamic/fixtures.ts` | NDJSON 夹具加载器与 `replayDynamicWorkflowNdjson` 回放器 |
| `packages/daemon/src/harnesses/agy/native/workflows/dynamic/index.ts` | 后端领域模块统一导出入口 |
| `packages/web/src/components/agy/native/workflow/types.ts` | Studio props、DAG 层分析、可排序时间线项、脚本/结果预览视图类型 |
| `packages/web/src/components/agy/native/workflow/view-model.ts` | `selectDynamicWorkflows`、`analyzeDynamicDag`（Kahn 拓扑与环检测，缺 `after` 边返回 `hasVerifiedDag=false`）、`deriveDynamicWorkflowBanner`、`buildSortableWorkflowTimeline`、`formatSafeStructuredPreview` |
| `packages/web/src/components/agy/native/workflow/DynamicWorkflowScriptReview.tsx` | 只读 Python 脚本文本审阅面板（标明不在客户端执行 Python、分页加载预览、状态标签与 provenance） |
| `packages/web/src/components/agy/native/workflow/DynamicWorkflowGraphOrTimeline.tsx` | 已证实 DAG 分层视图（并发分支 vs 串行阶段）与缺边/环路时的可排序时间线降级、节点详情、失败错误、已证实 child 跳转 |
| `packages/web/src/components/agy/native/workflow/DynamicWorkflowResultsAndLogs.tsx` | 受控产物与执行日志双标签页分页浏览器（纯文本/JSON 展示，拒绝信任内嵌 HTML，`AbortController` 作用域隔离） |
| `packages/web/src/components/agy/native/workflow/DynamicWorkflowStudio.tsx` | NP-11 主工作台组件，整合状态横幅、NP-07 工作流审批与 1.5.16 转发问题队列、脚本审阅、DAG/时间线、结果与日志及 `NativeControlMenu`，适配 `480px` 窄屏 |
| `packages/web/src/components/agy/native/workflow/fixtures.ts` | 前端离线夹具（T13 并发+串行对照、脚本被拒、缺边部分失败、1.5.16 转发问题） |
| `packages/web/src/components/agy/native/workflow/index.ts` | 前端组件导出与 `registerDynamicWorkflowStudioView`（`surface: 'dynamic'`, `order: 110`） |
| `packages/daemon/tests/fixtures/agy-np11/README.md` | NP-11 专属离线夹具目录与来源说明 |
| `packages/daemon/tests/fixtures/agy-np11/t13-parallel-serial-comparison.ndjson` | T13 两项无修改只读任务并发 Phase 1 + 串行 Phase 2 对照纯串行工作流夹具 |
| `packages/daemon/tests/fixtures/agy-np11/t13-denied-partial-and-missing-fields.ndjson` | 脚本被拒、节点部分失败留结果、缺 `after` 边与局部省略补丁夹具 |
| `packages/daemon/tests/fixtures/agy-np11/t13-1516-question-forwarding.ndjson` | AGY 1.5.16 经父会话转发的工作流 `interaction_*` 结构化问题夹具（含数值/字符串 `RpcId`） |
| `packages/daemon/tests/agy-np11-dynamic-workflow.test.ts` | Daemon 专项集成测试（T13 并发/串行、被拒、部分失败、缺字段、1.5.16 问题转发独立断言、NP-07 CAS 联测、Artifact 越权拦截、分页、断连 `stale`、门控关闭保留观测） |
| `packages/web/tests/agy-np11-dynamic-workflow-studio.test.tsx` | Web Studio 组件与 View-Model 测试（Workbench 注册覆盖、T13 DAG、缺边与环降级、脚本被拒、1.5.16 转发问题、480px 窄屏、XSS/HTML 转义安全） |

## 3. 原生字段适用版本清单

以下版本清单记录在 `DYNAMIC_WORKFLOW_WIRE_FIELD_VERSIONS` 中：

| 协议/字段位置 | 适用 CLI 版本 | 证据类别 | 缺失或变更时的降级行为 |
| --- | --- | --- | --- |
| `session/update`（`tool_call` / `tool_call_update`：含 `toolCallId`, `title`, `status`, `rawInput`, `rawOutput`） | `1.5.14+` | `acp_v1_standard`（E02, E05） | 局部 `tool_call_update` 省略字段保留已有节点状态；`status: null` 记为 `unknown`。 |
| `rawInput.Script` / `rawInput.ScriptPath` / `rawInput.Task` | `1.5.15+` | `candidate_pending_live_t13`（E01, 官方文档） | `ScriptPath` 仅记录已脱敏标记 `rawPathRedacted=true`，绝不读取宿主机文件；仅展示协议提供或 NP-14 核准的文本预览。 |
| `update.steps` / `rawOutput.steps` / `phases` / `after` / `dependsOn` / `upstreamStepIds` | `1.5.15+` | `candidate_pending_live_t13`（E01, 08_Shared_Contracts） | 缺 `after` 或存在环路时 `hasVerifiedDag=false`，Studio 强制展示可排序时间线，绝不解析 Python 脚本内容推断 DAG。 |
| `rawOutput.structuredOutput` / `result` / `exitCode` / `ok` / `isError` | `1.5.15+` | `acp_v1_standard`（E05, 08_Shared_Contracts） | `status=completed` 但未报告 `exitCode===0` 或 `ok===true` 时，工作流/节点记为 `finished` + `outcome: unknown`；非零退出记为 `failed`。 |
| `session/prompt` 延长有限阻塞与后台唤醒 | `1.5.15+` | `acp_v1_standard`（CLI 1.5.15, E08, T02） | 阻塞态节点与待处理审批通过 `listRetentionReasons` 持有活动租约，防止主轮次过早结束。 |
| `session/request_permission`（`toolCallId: interaction_*` + `_meta.workflowId` / `_meta.antigravity`） | `1.5.16+` | `candidate_pending_live_t13`（CLI 1.5.16, E05） | 保留外层 `actualNativeSessionId`（父会话）与 `forwardedToParentSession=true`，固定选项拒绝自由文本，数值/字符串 `RpcId` 原类型写回；`accept-edits` 下绝不自动授权。 |

## 4. 已实现与未覆盖事项

### 4.1 已实现核心能力

1. **离线工作流观察器（`DynamicWorkflowObserver`）与协议编解码（`codec.ts`）**：
   - 支持原生触发识别、脚本预览生成、脚本批准与拒绝（拒绝即转 `cancelled` / `script_denied` 并释放租约）、串行与并发步骤（`steps`）解析、`NativeWork`（`kind: 'workflow_step'`）及 `NativeWorkflow`（`detail.kind: 'dynamic'`）投影。
   - 严格区分运行终态 `finished` 与结果 `outcome`（`succeeded` / `failed` / `cancelled` / `unknown`），节点部分失败时保留已完成节点的 `resultArtifactIds` 与结构化摘要。
   - `history_replay` 通道严格使用 `replay` 证据，不触发实时审批或活动租约。
2. **安全边界与受限访问（`ports.ts`）**：
   - 定义 `DynamicWorkflowArtifactReaderPort`（NP-14 接口契约）及 `FrozenDynamicWorkflowArtifactReaderStub`，强制校验不透明 `artifactId` 与 `(runtimeId, generation, workflowId)` 作用域白名单，拦截宿主机路径（`C:\...`、`D:\...`、`..`、`file://`）。
   - 不执行 Python、不解释 Python 脚本生成 `steps`/`after`、不信任产物内嵌 HTML、不调用多 Harness Orchestrator。
3. **Dynamic Workflow Studio 前端工作台（`workflow/**`）**：
   - 实现脚本审阅面板（只读文本 + 分页加载）、DAG/可排序时间线切换（缺边自动禁用 DAG 并附诚实降级说明）、节点详情与已证实 Child 跳转、分页日志与结构化 JSON 结果浏览器、工作流作用域审批队列（含 1.5.16 问题转发）及 `480px` 窄屏适配。
4. **独立测试与回放夹具**：
   - 完成 T13 并发/串行对比、脚本拒绝、节点失败/部分结果、缺字段、1.5.16 问题转发的 NDJSON 夹具与前后端测试。

### 4.2 明确未覆盖事项与真机缺口

- **真机 Windows AGY 1.5.16 授权 T13 实录（`live_raw` / `live_hm` / `official_comparison`）尚未运行**：遵循 `G3_Launch_Plan.md` 与 `12_Test_Strategy.md`，真机测试需等待 U01 专用 Profile 授权及总指挥串行调度；因此本报告**不自行抬升任何 `AGY-W08` 等能力的 L2–L5 真实等级**。
- **未修改共享文件**：未将 `DynamicWorkflowObserver` 接入 `wiring/composition.ts`、未在 `App.tsx` / `AgyWorkbenchShell` 调用 `registerDynamicWorkflowStudioView()`、未修改 `commands/descriptors.ts`（第 7 节给出精确接线提议）。
- **NP-14 真实文件系统只读实现**：当前通过冻结的 `DynamicWorkflowArtifactReaderPort` 桩实现安全作用域校验与分页，等待 NP-14 交付真实安全读取器后替换注入。

## 5. 测试验证、证据分类与 Capability ID

### 5.1 已执行验证命令与实测结果

运行环境：Windows，Node.js，pnpm `11.21.0`，均在代码交付提交 `4529d6b829047d4bcab41dafcc32d07573a47835` 对应源码上执行通过：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | 6/6 workspace 包构建通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（构建） |
| `pnpm typecheck` | `0` | 6/6 workspace 包零类型错误 | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过 | `synthetic`（插件契约） |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np11-dynamic-workflow.test.ts` | `0` | **1 file, 4/4 passed**（T13 并发 vs 串行、脚本拒绝、部分失败/缺边/省略补丁、1.5.16 问题转发独立断言、Artifact 路径拦截与分页、断连 `stale`、门控关闭保留观测） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/web test -- tests/agy-np11-dynamic-workflow-studio.test.tsx` | `0` | **1 file, 5/5 passed**（Workbench 注册覆盖、T13 DAG 与脚本审阅、缺边与环降级时间线排序、脚本被拒、1.5.16 转发问题、480px 窄屏与 HTML 转义安全） | `synthetic` |
| `pnpm --filter @harnessmate/protocol test` | `0` | **2 files, 6/6 passed** | `synthetic` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1` | `0` | **18 files, 90/90 passed** | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1` | `0` | **38 files, 203/203 passed** | `synthetic` + `replay_with_provenance` |
| `git diff --check agy-np-g2` | `0` | 无空白符或冲突标记问题 | 静态检查 |

总计全量回归：**299/299**（`protocol` 6/6、`web` 90/90、`daemon` 203/203）全部通过。

### 5.2 未执行的检查与原因

- **Windows 真机授权 T13 运行（`live_raw` / `live_hm` / `official_comparison`）**：待用户/总指挥按 U01 测试 Profile 授权单次动态工作流任务后，由 `probe-acp.mjs` 采集真实 `run_workflow` 线字段形状并核对 `DYNAMIC_WORKFLOW_WIRE_FIELD_VERSIONS`。
- **NP-14 真实 Artifact 读取联测**：NP-14 在第二批启动，本轮通过 `FrozenDynamicWorkflowArtifactReaderStub` 验证 `DynamicWorkflowArtifactReaderPort` 契约与越权阻断。

### 5.3 证据 ID、测试场景与 Capability ID

- **关联 Capability ID**：`AGY-W08`（Dynamic Workflows 主要能力）、`AGY-R08`、`AGY-R09`、`AGY-W01`、`AGY-W14`。
- **证据与设计来源**：`E01`、`E02`、`E03`、`E05`、`E08`、`S06`、`S08`、`S20`、`S21`、`T13`。
- **风险缓解**：`R-04`、`R-06`、`R-09`、`R-10`、`R-11`。

## 6. 数据与跨 Harness 回归结论

- **数据与现有 AGY**：`agy-np02-persistence-migration.test.ts`、`agy-np02-wiring-provenance.test.ts`、`agy-np04-reactive-runtime.test.ts`（10/10）、`agy-np05-child-routing.test.ts`（7/7）、`agy-np06-command-router.test.ts`（9/9）、`agy-np07-native-requests.test.ts`（12/12）、`agy-replay-protocol.test.ts`（2/2）与 `agy-lifecycle-events.test.ts`（5/5）全通；关闭开关后已观察到的原生工具与已读产物继续可读。
- **跨 Harness 与生态**：`adapters-codex.test.ts`（5/5）、`adapters-claude.test.ts`（4/4）、`adapters-acp.test.ts`、`phase3-external-adapters.test.ts`（5/5）、`handoff-v2.test.ts`（12/12）、`multi-harness-orchestrator.test.ts`（6/6）、`plugin-v4.test.ts`（6/6）、`plugin-v5.test.ts`（6/6）全通，零回归。

## 7. 冲突声明与给共享 Owner 的协作变更提议

当前 **零文件冲突**。G3 集成阶段向共享模块 Owner 提交以下接线提议（均附已有测试或可验证用例）：

1. **给 NP-02（`packages/daemon/src/harnesses/agy/native/wiring/composition.ts`）**：
   - 在 `wireAgyNativeRuntime` 实例化 `const dynamicWorkflow = new DynamicWorkflowObserver()`（可接入 NP-14 的 `DynamicWorkflowArtifactReaderPort`）。
   - 在 `connection.attach` 注册 `dynamicWorkflow.registerRootSession(binding, rootNativeSessionId)`；在 `connection.ingest` 中对 `session/update` 调用 `const dwRes = dynamicWorkflow.acceptFrame(envelope, { rootNativeSessionId: scope.rootNativeSessionId })` 并 `dynamicWorkflow.commitToRegistry(registry, scope.binding, dwRes.commits)`。
   - 在 `connection.close` 调用 `dynamicWorkflow.handleTransportClosed(binding, connectionId)` 并提交变更；在 `lifecycle.listRetentionReasons` 合并 `dynamicWorkflow.listRetentionReasons(binding)`。
   - 在 `permissions` 的 `targetResolver.resolveTarget` 中优先检查 `dynamicWorkflow.resolveRequestTarget(input)`（确保 1.5.16 工作流转发问题正确归属到 `confirmed_workflow`），并在 `onIncomingRequest` / `onRequestSettled` 同步调用 `dynamicWorkflow.onWorkflowRequestObserved` 与 `onWorkflowRequestResolved`。
   - 在 `registry.registerModules` 注册 `workflowResourceReader: dynamicWorkflow`（或按 `workflow.detail.kind` 多路分派给 Swarm/Boost/Teamwork/Dynamic）。
2. **给 NP-03（`packages/web/src/components/agy/native/shared/` / Workbench 启动入口）**：
   - 在初始化 AGY Workbench 时调用 `registerDynamicWorkflowStudioView()`（`packages/web/src/components/agy/native/workflow/index.ts`），使 `surface: 'dynamic'` 由 `order: 110` 接管默认 `order: 900` 降级壳。
3. **给 NP-06（`packages/daemon/src/harnesses/agy/native/commands/catalog.ts`）**：
   - 注册 `DYNAMIC_WORKFLOW_DESCRIPTOR_CONTRIBUTION`；在未获得真实 Windows T13 `/run-workflow` ACP 实录前，`launch` 门控保持 `not_tested`（或随 `available_commands_update` 广播按真实权限门控解锁）。
4. **给 NP-14（Artifact / Browser）**：
   - 实现 `DynamicWorkflowArtifactReaderPort`（`packages/daemon/src/harnesses/agy/native/workflows/dynamic/ports.ts`）并在 `composition.ts` 注入 `DynamicWorkflowObserver`，替换 `FrozenDynamicWorkflowArtifactReaderStub`，对接真实只读脚本/结果产物读取。

## 8. 独立审查者复验命令与回滚方案

### 8.1 独立审查者复验命令

```powershell
git status --short --branch
git diff --name-status agy-np-g2...HEAD
git diff --check agy-np-g2...HEAD
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/daemon test -- tests/agy-np11-dynamic-workflow.test.ts tests/agy-np07-native-requests.test.ts tests/agy-replay-protocol.test.ts
pnpm --filter @harnessmate/web test -- tests/agy-np11-dynamic-workflow-studio.test.tsx tests/np03-workbench-ui.test.tsx
pnpm --filter @harnessmate/protocol test
pnpm --filter @harnessmate/web test -- --maxWorkers=1
pnpm --filter @harnessmate/daemon test -- --maxWorkers=1
```

### 8.2 回滚方案与命令

1. **优先功能开关禁用（无损、保留已观察原生工具与已读产物）**：
   - 后端调用 `dynamicWorkflowObserver.setEnabled(false)` 或保持 `AgyNativeFeatureFlags.enabled = false`；观察器停止写入新动态工作流事件，同时已观察到的原生工具、步骤快照与已批准产物保留可读。
2. **代码提交回滚**：
   - 独立分支回滚代码提交：
     ```powershell
     git revert --no-edit 4529d6b829047d4bcab41dafcc32d07573a47835
     ```
   - 若合入集成分支后产生 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
