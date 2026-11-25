# NP-09 交付报告 · Boost 多段推理

## 1. 基线、Worktree 与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-09`（Boost 多段推理） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| G2 源码修复点 | `f895bf44ad5e850109ab8641fbfb81522214390f` |
| Reviewed Base（G3 统一开工标签） | `fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c`（`tag: agy-np-g2`，`docs(agy-np): freeze G2 validation and prepare G3 work packages`） |
| 实际工作分支 / Worktree | `np09_boost_multi_stage_inference` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np09_boost_multi_stage_inference`（经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np09_boost_multi_stage_inference`；建议集成目标分支 `codex/agy-np-09-boost`） |
| **代码交付提交 SHA** | **`5764a8660c0afe646c29dec85e9e79b2be686c48`**（`feat(agy-np-09): implement Boost eligibility resolver, typed observer, studio UI, and T11 tests`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零改动） |
| SQLite 组件迁移版本 | `AGY_NATIVE_MIGRATION_COMPONENT = 'agy-native-runtime'` · `AGY_NATIVE_MIGRATION_VERSION = 1`（零改动） |
| NP-03 Workbench 注册契约 | `WORKBENCH_REGISTRY_CONTRACT_REVISION = '1.0-np03'`（零改动） |
| NP-09 领域契约版本 | `BOOST_WORKFLOW_CONTRACT_REVISION = '1.0-np09'` · `BOOST_STUDIO_VIEW_REVISION = '1.0-np09'` |
| `MASTER_PROGRESS.md` | 未修改（由总指挥统一维护） |

## 2. 实际变更路径与文件所有权核对

全部代码与测试严格限定在 NP-09 允许写入范围（`packages/daemon/src/harnesses/agy/native/workflows/boost/**`、`packages/web/src/components/agy/native/boost/**`、专属测试 `packages/daemon/tests/agy-np09-boost.test.ts` 与 `packages/web/tests/agy-np09-boost.test.tsx`，以及本报告 `docs/phase-agy-native-parity/handoffs/NP-09-report.md`）。公共协议、`wiring/**`、`SessionManager`、`AcpSessionHandle`、`sqlite.ts`、共享 Store、其他 Harness 适配器及其他模式工作流均零修改。

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/workflows/boost/types.ts` | NP-09 Boost 领域类型：`BoostCanonicalPhaseKind`（`initial \| improvement \| verification`）、`BoostPhaseClassification`（显式正则匹配与 `observed_unknown` 保留）、`BoostEligibilityResolution` / `BoostEligibilityDto`、`BoostLaunchValidationInput` / `Result`、`BoostRoleObservation`、`BoostVerificationClue`、`BoostStopObservation`、`BoostStudioSnapshotDto`、`BoostPlanTierEvidenceEntry` |
| `packages/daemon/src/harnesses/agy/native/workflows/boost/resolver.ts` | `resolveBoostEligibility`（记录 model/tier 广告、检测未认证/Free 计划/未广告/Desktop 来源/断连/服务端拒绝，返回确定性提示、保留原模式意图与草稿且绝不自动升级付费模式）、`validateBoostLaunchIntent`（强制用户显式选用 `live_workflow`、阻止模型自发、阻止自动升级及辅助 CLI 替身）、`classifyBoostSignalLabel`、`detectBoostServerDenial`、`sanitizeBoostEligibilityForPublic`、`createBoostCapabilityContribution`（向 NP-06 贡献 `AGY-W06` / `agy.workflow.boost` 描述符） |
| `packages/daemon/src/harnesses/agy/native/workflows/boost/observer.ts` | `BoostWorkflowObserver` 实现只读帧观测与 `NativeWorkflowResourceReaderPort`：支持 `recordConfirmedLaunch`、`acceptFrame`、`recordServerDenial`、`handleStopRequested`、`handleTransportClosed`、`syncConfirmedAgent`（lineage 与 Boost 阶段分离，仅 `lineage === 'confirmed'` 可关联 `agentIds`）、`commitToRegistry`、`getStudioSnapshot`、`readWorkflowResource`（`phases` / `logs` / `artifacts` 分页与 `board` 诚实不可用）。无原生 phase 字段时严格省略 `detail.phases`，未知阶段/角色按 `observedLabel` 原样保留且不推断进度或轮数，隔离 `history_replay`、旧 generation、错连与重复帧 |
| `packages/daemon/src/harnesses/agy/native/workflows/boost/fixtures.ts` | `BOOST_PLAN_TIER_EVIDENCE_MATRIX`（Free / Pro / Ultra / Enterprise / Unknown 计划等级与证据等级）、`createT11BoostSyntheticFixtures`（覆盖 T11 正常三段阶段、未知阶段与重复帧、未知角色、服务端拒绝、根会话停止确认与模型自发拦截） |
| `packages/daemon/src/harnesses/agy/native/workflows/boost/index.ts` | 后端 Boost 模块统一导出入口 |
| `packages/daemon/tests/agy-np09-boost.test.ts` | 6 项 Daemon 专项测试（资格矩阵与防自动升级、显式 `live_workflow` 校验与 NP-06 路由集成、T11-A 阶段省略→标准阶段与 SQLite 持久化/资源分页/门控回滚、T11-B/C 未知阶段与角色保留及去重、T11-D 服务端拒绝、T11-E 根取消请求/确认/断连未知与模型自发/历史重放/旧代隔离） |
| `packages/web/src/components/agy/native/boost/types.ts` | 前端 Boost Studio 视图模型、资格横幅、阶段分类与验证线索/产物类型 |
| `packages/web/src/components/agy/native/boost/selectors.ts` | `deriveBoostEligibilityBanner`、`classifyBoostStageLabel`、`deriveBoostStudioViewModel`、`parseBoostResourceItems`（零进度条百分比推断、区分根取消与工作流级未验证控制、保留只读降级边界） |
| `packages/web/src/components/agy/native/boost/BoostEligibilityBanner.tsx` | 资格、计划/等级提示、运行时 `/boost` 广告状态、观察/控制门控、「默认不自动升级到付费模式」提示与证据折叠详情 |
| `packages/web/src/components/agy/native/boost/BoostStudioView.tsx` | Boost Studio 专属视图：已证实 `live_workflow` 启动概览、仅在有阶段证据时渲染的只读阶段区块（区分标准枚举与「已观测标签」）、缺阶段时的明确省略提示与可观察活动/工作项/验证线索/产物引用、关联审批复用 `NativeRequestCard`、证据门控停止面板（仅根 `session/cancel`）与断连/空状态诚实降级 |
| `packages/web/src/components/agy/native/boost/register.ts` | `registerBoostStudioView`（`id: 'boost'`、`owner: 'np-09.boost-studio'`、`order: 200`，无需修改 `AgyWorkbenchShell.tsx` / `ChatStage.tsx` 即可覆盖 `order: 900` 默认降级壳） |
| `packages/web/src/components/agy/native/boost/fixtures.ts` | 前端 T11 含阶段 / 无阶段 / 资格受限 UI 测试夹具 |
| `packages/web/src/components/agy/native/boost/index.ts` | 前端 Boost Studio 统一导出入口 |
| `packages/web/tests/agy-np09-boost.test.tsx` | 6 项 Web 组件与注册专项测试（Workbench 注册覆盖与 badge 计算、标准/未知标签分类、Free/未广告确定性引导与不自动升级、含阶段与已确证子代理跳转渲染且无伪造进度条、无阶段完全省略阶段区块、断连/空状态降级与资源解析） |

## 3. 已实现事项与明确未覆盖事项

### 3.1 已实现能力

1. **资格解析与防自动升级（Resolver）**：记录当前绑定的模型/计划等级广告（`modelObserved`、`tierObserved`）与 `available_commands_update` 对 `/boost` 的广播情况；在未登录、计划不符（如 Free）、未广告/撤销、Desktop 来源、无活跃连接或服务端拒绝时，返回确定性降级提示，完整保留用户原始模式意图与草稿，且强制 `autoUpgradeBlocked: true`。
2. **显式 `live_workflow` 触发门控**：通过 `validateBoostLaunchIntent` 与 NP-06 描述符贡献校验，仅允许用户在 `live_workflow` 车道显式选用 Boost 发起 `/boost <task>`；拒绝模型自发调用、拒绝自动升级到付费模式、拒绝另起独立辅助 CLI 替代同会话执行，也拒绝非人类直接来源（`hm_orchestrator` 等）。
3. **只读 Typed Observer（Observer）**：
   - 使用 `@harnessmate/protocol` 既有的 `WorkflowDetailSchema` / `WorkflowDetailDtoSchema`（`kind: 'boost'`、`phases?: NativeStage[]`）与 `NativeStageSchema`，**未观测到原生阶段字段时严格省略 `detail.phases`**，避免伪造进度。
   - 仅当协议载荷存在明确的 `initial` / `improvement` / `verification` 信号时归入标准内部枚举；未识别阶段或子 Agent 角色（如 `Adversarial Critic Audit`、`Domain Spec Auditor`）按 sanitized `observedLabel` 保留，不推断轮数或百分比。
   - 亲缘关系与 Boost 阶段严格分离：仅经 NP-05 确证（`lineage === 'confirmed'`）的 `agentId` 可关联到阶段或角色视图；未确证子项保持 `unlinked`。
   - 完整实现 `NativeWorkflowResourceReaderPort`（`phases` / `logs` / `artifacts` 分页与 `board` 不可用标识）、旧 generation / 错连 / `history_replay` / 重复帧隔离、服务端拒绝记录与根会话停止状态机（`requested` → `confirmed` / 断连转 `unknown`）。
4. **Boost Studio UI 与 Workbench 注册**：提供可查验证线索、只读阶段（或无 phase 时的省略说明与通用可观察活动/工作项/产物）、关联审批跳转及证据门控停止入口；支持 480px 窄屏与常规桌面布局。

### 3.2 明确未覆盖事项

1. **未修改共享接线文件**：遵循 G3 文件所有权约定，未改动 `packages/daemon/src/harnesses/agy/native/wiring/composition.ts`（其中 `isNativeWorkflowRoutingEnabled` 仍返回 `false`，未直接注册 Boost 描述符与 observer 到运行时主链路）与 `packages/web/src/components/agy/native/shared/AgyWorkbenchShell.tsx`（未调用 `registerBoostStudioView()`）。待总指挥按第 6 节接线提案统一合入。
2. **未执行真机付费 `/boost` 采样（`live_raw` / `live_hm` / `official_comparison`）**：依据任务前提「付费试验需用户确认账号资格和单场景预算」，本轮仅完成离线 observer、Studio、降级与 T11 合成回放；未向真实 Google 付费账号发起 `/boost` 请求，因此 `AGY-W06` 矩阵等级维持不自抬升（`verifiedLevel: null`）。

## 4. 验证命令、结果与证据分类

### 4.1 已执行检查汇总（均在最终代码/测试状态及提交 `5764a86` 对应内容上执行）

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | 6/6 workspace 包构建通过（`plugin-api`、`protocol`、`plugin-sdk`、`daemon`、`web`、`electron`）；注：该次在补正两处测试文件前运行，之后无任何源码修改 | `synthetic`（构建） |
| `pnpm typecheck` | `0` | 6/6 workspace 包零类型错误（在最终测试编辑后于 `task-115` 复跑通过） | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过，Plugin SDK 契约零破坏 | `synthetic`（契约） |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np09-boost.test.ts --maxWorkers=1` | `0` | **6/6 passed**（默认 TEMP 与 D 盘 TEMP `D:\HarnessMate\np09-tmp` 下均通过） | `synthetic` |
| `pnpm --filter @harnessmate/web test -- tests/agy-np09-boost.test.tsx --maxWorkers=1` | `0` | **6/6 passed** | `synthetic` |
| `pnpm --filter @harnessmate/protocol test -- --maxWorkers=1` | `0` | **2/2 文件、6/6 passed** | `synthetic` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1` | `0` | **18/18 文件、91/91 passed**（覆盖全部 NP-03/04/05/06/07/09 与原有 Web UI） | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1` | `1` | **37/38 文件 passed，203/205 tests passed**；全部 AGY 专项（NP-01/02/04/05/06/07/09、`agy-replay-protocol`、`agy-lifecycle-events`、`agy-auth-usage`、`agy-config-scope`、`agy-launch-context`）、Codex/Claude/ACP/OpenCode/DeepSeek、Handoff 与插件契约全过；仅既有 `tests/multi-harness-orchestrator.test.ts` 中 2 条真实 Git worktree 用例（独立复跑为 3 条）在并发主机磁盘负载下触发 Vitest 30000ms 超时 | `synthetic` + `replay_with_provenance`（E05） |
| `git diff --cached --check` | `0` | `5764a86` 提交前检查零空白错误或冲突标记 | 静态检查 |

### 4.2 未执行的检查与原因

- **T11 真机授权对端运行（App / CLI / ACP 小目标对比）**：未获得用户针对具体付费个人/企业测试 Profile 的 Boost 预算确认，且 U01 专用 Profile 尚未在本工作树环境中配置并开放真实 `/boost` 广告；因此 `live_raw`、`live_hm` 与 `official_comparison` 未运行。

### 4.3 证据 ID、风险与 Capability ID

- **引用证据 ID**：`E01`（`agy --help` / 官方 Boost 文档能力声明）、`E02` / `E04`（本机 Windows `1.5.16` 空白握手未开通 `session/new` 与无命令目录）、`E05`（AGY `1.5.14` 离线回放兼容性基线）、`S04` / `S12` / `S13` / `S20` / `S24`（源码审计基线）。
- **测试场景与风险**：`T11`（含无阶段、标准阶段、未知阶段与角色、重复帧、服务端拒绝、模型自发拦截与根会话停止）；缓解风险 `R-07`、`R-09`、`R-10`。
- **关联 Capability ID**：`AGY-W06`（`agy.workflow.boost`）、`AGY-R10`（根会话停止边界）。
- **真实证据缺口**：
  1. 真实 AGY `1.5.16+`（在 Pro/Ultra 付费账户下）通过 ACP v1 `session/update` 实际下发的 Boost 阶段/角色载荷字段名、是否发送 `phases` 或仅发送普通工具与 `invoke_subagent`，尚无 `live_raw` 实录；当前 `observer.ts` 仅在收到结构化字段时填充 `phases`，其余情况诚实省略。
  2. 真实付费账号因配额耗尽或计划受限拒绝 `/boost` 时的原生 JSON-RPC error `code`/`data` 形状尚待真机验证（当前 `detectBoostServerDenial` 覆盖常见错误码与拒绝更新形状）。
  3. `/boost` 运行期间是否支持除根会话 `session/cancel` 之外的细粒度中止控制尚无上游证据（当前 Studio 仅暴露根会话 `session/cancel`）。

## 5. 数据、持久化与跨 Harness 回归结论

- **SQLite 与历史数据**：`agy-np09-boost.test.ts` 已在真实 `HarnessMateStore`（`node:sqlite`）+ `AgyNativeRuntimeRegistry` 上验证 `WorkflowDetailDtoSchema` 写入与读取，以及关闭 `enabled` 门控后投影零泄漏、数据库行完整保留；`agy-np02-persistence-migration.test.ts` 随 Daemon 全量通过。
- **其他 Harness 与现有功能**：Codex、Claude、Strict ACP、OpenCode、DeepSeek 适配器测试、`handoff-v2.test.ts`、`agy-replay-protocol.test.ts`、`agy-lifecycle-events.test.ts` 与全部 Plugin SDK/V4 测试均通过，零回归。关于 `tests/multi-harness-orchestrator.test.ts` 的 30000ms 超时：该文件与 `orchestrator-service.ts` 在本工作树零修改，且单独重跑时出现与主机 I/O 速度相关的 2~3 条 Git worktree 用例超时（无断言失败），已如实记录。

## 6. 冲突声明、给共享 Owner 的接线提议与回滚命令

### 6.1 冲突与跨包协作请求

当前 **零文件冲突**。总指挥集成 G3 时，向共享 Owner（NP-02 / NP-03）提出如下最小接线提议（均无需修改 `packages/protocol`）：

1. **给 NP-02（`packages/daemon/src/harnesses/agy/native/wiring/composition.ts`）**：
   - 在 `AgyNativeCommandCatalogService` 初始化处注册 `catalog.registerWorkflowDescriptor(createBoostCapabilityContribution())`。
   - 创建 `const boostObserver = new BoostWorkflowObserver()`，在 `connection.attach` / `close`、入站 `session/update` 帧（仅 `live` 通道）、`dispatchNativeCancel`（调用 `boostObserver.handleStopRequested`）及 `child` 确认身份变更（调用 `boostObserver.syncConfirmedAgent`）处接入；并将 `boostObserver` 注册为 `workflowResourceReader`（或由多模式聚合 reader 按 workflow `detail.kind === 'boost'` 路由）。
   - 在 `dispatchLiveWorkflow` 中，针对 `capabilityId === 'AGY-W06'` / `actionKey === 'launch_boost'`，在用户已验证且显式授权时通过 `resolveBoostEligibility` + `validateBoostLaunchIntent` 校验后，沿同一 `handle` 单次调用 `sessions.sendTurn(..., { literalText: true, omitHandoff: true })` 并调用 `boostObserver.recordConfirmedLaunch(...)`（在未完成真机授权前维持 `isNativeWorkflowRoutingEnabled` 门控关闭）。
2. **给 NP-03（`packages/web/src/components/agy/native/shared/AgyWorkbenchShell.tsx` 或应用初始化入口）**：
   - 调用 `registerBoostStudioView()` 注册 `order: 200` 的 `BoostStudioView`，自动替换 `order: 900` 的默认降级壳；关闭 `hm_agy_native_ui` 或未注册时立即回退，保持通用原生 trace 不受影响。

### 6.2 给独立审查者的关键坐标与复现命令

- **代码提交 SHA**：`5764a8660c0afe646c29dec85e9e79b2be686c48`（相对基线 `fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c`）
- **关键审查路径**：
  - `packages/daemon/src/harnesses/agy/native/workflows/boost/{types,resolver,observer,fixtures,index}.ts`
  - `packages/web/src/components/agy/native/boost/{types,selectors,BoostEligibilityBanner,BoostStudioView,register,fixtures,index}.ts(x)`
  - `packages/daemon/tests/agy-np09-boost.test.ts` · `packages/web/tests/agy-np09-boost.test.tsx`
- **审查复验命令**：
  ```powershell
  git diff --name-status agy-np-g2..5764a8660c0afe646c29dec85e9e79b2be686c48
  git diff --check agy-np-g2..5764a8660c0afe646c29dec85e9e79b2be686c48
  pnpm typecheck
  pnpm contracts:check
  pnpm --filter @harnessmate/daemon test -- tests/agy-np09-boost.test.ts --maxWorkers=1
  pnpm --filter @harnessmate/web test -- tests/agy-np09-boost.test.tsx --maxWorkers=1
  ```

### 6.3 回滚方案

1. **运行期门控回滚（首选）**：保持 `HARNESSMATE_AGY_NATIVE_RUNTIME` 与 `isNativeWorkflowRoutingEnabled` 关闭，或取消 `registerBoostStudioView()` 注册即可关闭模式入口与专属 projection，通用原生 trace 与其他工作流完整保留。
2. **Git 提交回滚**：
   ```powershell
   git revert 5764a8660c0afe646c29dec85e9e79b2be686c48
   ```
   （本任务未新增 SQLite migration，无数据库降级风险。）
