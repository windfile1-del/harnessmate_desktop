# NP-08 交付报告 · Swarm 与共享 Board

日期：2026-11-25（Asia/Shanghai）。本报告供总指挥与独立审查者核验。`MASTER_PROGRESS.md` 保持未改，由总指挥统一维护。

## 1. 基线、分支与交付提交

| 项 | 值 |
| --- | --- |
| 任务包 | NP-08 Swarm 与共享 Board |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039` |
| G2 已审开工点 | 本地标签 `agy-np-g2`（`fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c`，含 G2 源码修复提交 `f895bf44ad5e850109ab8641fbfb81522214390f`） |
| 实际分支 | `np08_swarm_shared_board`（平台分配分支；任务卡建议名为 `codex/agy-np-08-swarm`） |
| 实际 D 盘 Worktree | `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np08_swarm_shared_board`（经 `.gemini` junction 访问） |
| 代码交付提交 | `9f9ccdbf870660f4f28f687691948fb91b67fb46`（`feat(agy-np-08): implement Swarm typed observer, Board stable-ID pagination, and Swarm Studio UI`） |
| 报告提交 | 本报告随独立 `docs(agy-np-08)` 提交附后 |

## 2. 实际变更路径与公共契约版本

严格限定于 NP-08 允许写入范围（17 个新增代码/测试文件），未修改 `packages/protocol/src/**`、`native/wiring/**`、`core/**`、`db/sqlite.ts`、`server/app.ts`、`native/shared/**`、`AgyStudioBlocks.tsx`、`ChatStage.tsx`、`App.tsx` 与 `MASTER_PROGRESS.md`：

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/workflows/swarm/contracts.ts` | NP-08 冻结契约 `SWARM_OBSERVER_CONTRACT_REVISION = 'agy-np08-swarm-v1.0.0'`、独立回滚门控 `SwarmObserverGateConfig`（`swarmEnabled` / `boardFeedEnabled` / `localBoardSnapshotEnabled` / `liveLaunchEnabled` 默认全关）、Coordinator/Worker/Verifier/Board/Mention/LinkedApproval/Trace 类型定义 |
| `packages/daemon/src/harnesses/agy/native/workflows/swarm/descriptors.ts` | NP-06 间接能力注册 `buildSwarmDescriptorContributions` / `registerSwarmCapabilityDescriptors`（覆盖 `AGY-W04` / `agy.workflow.swarm` 与 `AGY-W05` / `swarm-board`），不建立独立命令执行器 |
| `packages/daemon/src/harnesses/agy/native/workflows/swarm/board-store.ts` | `SwarmBoardStore`：按稳定 `postId` / `entryId` 游标分页（追加帖子不漂移、无重复/漏项）、4000 字符截断、敏感凭据与宿主路径脱敏 `sanitizeSwarmPublicText`、输出严格经 `NativeWorkflowResourceItemDtoSchema` 白名单校验 |
| `packages/daemon/src/harnesses/agy/native/workflows/swarm/snapshot-reader.ts` | 版本化只读本地 Board 快照读取器 `readVersionedSwarmBoardSnapshot`：生产默认 `VERIFIED_LOCAL_BOARD_SCHEMAS = []`（全关闭 fail-closed）、无条件拒绝 `.db`/`.sqlite`/`.wal` 私有数据库、逐段拒绝 symlink/Windows reparse point 与路径穿越、`fstatSync` 句柄身份核验、强制 `nativeSessionId` + `profileRef` + `workflowId` 作用域匹配 |
| `packages/daemon/src/harnesses/agy/native/workflows/swarm/swarm-observer.ts` | `AgySwarmObserver`（实现 `NativeWorkflowResourceReaderPort`）：消费 `/swarm` 广告与启动回执、按同作用域原生 ID 分开投影 Coordinator / Worker / Verifier / Board / `@mention` 唤醒、严禁由工具标题伪造 Worker、Worker `idle` 绝不计为成功/完成、已确证 Worker 审批链接不移动原生上下文、关闭 Swarm 或 Board 门控时保留已捕获 Coordinator 轨迹、支持 `AgyNativeRuntimeRegistry` 原子持久化提交 |
| `packages/daemon/src/harnesses/agy/native/workflows/swarm/fixtures.ts` | 显式标注 `synthetic` 的 T10-A（完整结构化生命周期）与 T10-B（上游缺 Board feed + 工具标题防伪造）夹具 |
| `packages/daemon/src/harnesses/agy/native/workflows/swarm/index.ts` | 后端 Swarm 子域导出入口 |
| `packages/web/src/components/agy/native/swarm/swarm-view-model.ts` | 纯投影视图模型：`buildSwarmStudioViewModel`、Coordinator/Worker/Verifier/待确认分离、诚实计数（`idle` 不计入成功进度，禁止假进度条）、`resolveSafeSwarmControlCapability` 危险动作门控、`resolveSwarmBoardStatus`、稳定 `postId` 合并与线程分组 `groupBoardPostsIntoThreads`、按来源筛选 `filterEntriesBySource` |
| `packages/web/src/components/agy/native/swarm/SwarmBoardPanel.tsx` | 共享 Board 面板：按稳定 ID 分页加载帖子与展开线程、切工作流/切代 `AbortController` 取消并清旧、缺 feed 时显示「当前 ACP 未提供 Board」及官方 `/swarm board` / `Alt+S` 入口说明、严格只读（无发帖/自动 mention 输入） |
| `packages/web/src/components/agy/native/swarm/SwarmWorkersPanel.tsx` | Workers 与 Verifiers 面板：独立展示 Coordinator、已证实 Workers、已证实 Verifiers 与待确认成员，支持已确证成员的子审批卡片与独立时间线跳转，未确证/只读/上游受限时禁用控制 |
| `packages/web/src/components/agy/native/swarm/SwarmActivityPanel.tsx` | Activity 与 Coordinator 轨迹面板：按来源（Live ACP / 宿主观测 / 只读快照 / 回放）筛选原生活动与分页 Coordinator 日志（Board 缺源或关门控时仍可读） |
| `packages/web/src/components/agy/native/swarm/SwarmStudioView.tsx` | Swarm Studio 主视图：Overview / Workers / Board / Activity 四分区（支持键盘左右/Home/End 切签与 480px 窄屏）、空投影/空工作流诚实降级、无假进度条 |
| `packages/web/src/components/agy/native/swarm/register.ts` | 以 `owner: 'np-08'`、`order: 200` 注册 `swarm` 工作台视图（覆盖默认 `order: 900` 降级壳），角标仅计已确证待审批或活跃运行中成员 |
| `packages/web/src/components/agy/native/swarm/fixtures.ts` | 前端 `synthetic` 夹具（完整结构化 Swarm + 缺 Board 上游受限 Swarm） |
| `packages/web/src/components/agy/native/swarm/index.ts` | 前端 Swarm 子域导出入口 |
| `packages/daemon/tests/agy-np08-swarm.test.ts` | 6 项 T10 后端专项与 SQLite 集成测试（T10-A 至 T10-F） |
| `packages/web/tests/np08-swarm-studio.test.tsx` | 4 项前端专项测试（注册覆盖、视图模型与稳定 ID 线程合并、危险控件门控、四分区渲染与缺源降级） |

**依赖契约版本**：
- `@harnessmate/protocol`：`AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（`schemaVersion = 1`，消费 `WorkflowDetailSchema` / `WorkflowDetailDtoSchema` 的 `kind: 'swarm'` 分支与 `NativeWorkflowResourceItemDtoSchema` 的 `board_post` / `log_entry`）
- SQLite 迁移组件：`agy-native-runtime` version `1`（无新增迁移）
- NP-08 Swarm Observer 契约：`SWARM_OBSERVER_CONTRACT_REVISION = 'agy-np08-swarm-v1.0.0'`
- NP-05 / NP-07 共享 child scope 契约：`CHILD_SCOPE_CONTRACT_REVISION = 'agy-np05-child-scope-v1.0.0'`
- NP-03 Workbench 注册契约：`WORKBENCH_REGISTRY_CONTRACT_REVISION = '1.0-np03'`

## 3. 已实现与未覆盖 / 范围排除项

### 已实现（离线 Observer、工作台、降级与回放）
1. **真实 `/swarm` 广告、启动回执与 Coordinator 轨迹**：区分 `advertised: null`（未广播）、`true`（已广告）、`false`（空表撤销）；启动回执在未收到真实原生 Coordinator 帧前保持 `unknown`/`queued`，不伪造 `running`。
2. **Worker / Verifier 身份与 T10 生命周期**：严格校验同作用域原生 Worker ID（不从工具标题生成 Worker），区分 `worker` 与 `verifier`；Worker `idle` 仅记为 `waiting`、绝不计入成功进度；真实 `@mention` 后收到原生复跑帧时记录 `idleWakeCount` 与 `wakeObserved`；显式区分 Worker `requires_action`、`failed` 与 Coordinator `finished` 结算。
3. **Board 稳定 ID 分页与防泄露**：`SwarmBoardStore` 按稳定 `postId`（`afterId` 游标）分页，追加新帖不漂移、无重复、无漏项；所有输出经敏感词/路径脱敏与 Zod DTO 白名单校验；`history_replay` 与跨 Profile/过期 generation 严格隔离。
4. **已确证 Worker 子审批链接（不移动原生上下文）**：`linkWorkerApproval` 仅在 NP-07 `targetResolution` 为 `confirmed` 且 `agentId` 归属当前 Swarm 成员时建立链接并同步 `requires_action`；未知/未确证子请求被拒绝挂接（`unconfirmed_approval_not_linked`）。
5. **只读本地 Board 快照 fail-closed**：默认 `VERIFIED_LOCAL_BOARD_SCHEMAS = []` 全关闭；无条件阻断 `.db`/`.sqlite`/`.wal` 私有数据库、路径穿越与 symlink/reparse point。
6. **独立双门控回滚**：可单独关闭 `boardFeedEnabled` 或 `swarmEnabled`（默认均 `false`），同时完整保留已捕获的 Coordinator 轨迹（`resource: 'logs'` 持续可读）。
7. **Swarm Studio 前端**：提供 Overview、Workers、Board、Activity 四分区、来源标识、未知状态、缺 Board feed 时展示「当前 ACP 未提供 Board」及官方 `/swarm board` / `Alt+S` 入口说明、无假进度条、缺源/只读/未确证/断连时禁用全部控制动作。

### 未覆盖项与显式排除
- **真机实采未执行**：尚未在 U01 专用授权测试账号上执行真实 `/swarm <task>` 与单 worker 真机采样，亦未核实官方 AGY 1.5.16+ ACP 是否实际推送 worker/Board 结构化帧或稳定的只读本地 Board 格式；所有新增测试均为 `synthetic`，能力矩阵真机等级维持不变。
- **共享接线待总指挥在 G3 统一合入**：未直接改动 `wiring/composition.ts`、`App.tsx` 或 `AgyStudioBlocks.tsx`，接线提案与用例见第 6 节。
- **范围排除严格遵守**：无本地编排、无自动发送 `@mention`、无本地生成 Board 帖子、不读未验证私有 SQLite 数据库、不将多个 HM 子会话伪装为 Swarm、无修改 system prompt / 轮换账号 / 绕过权限。

## 4. 测试命令、结果与验证类别

测试环境：Windows（PowerShell 5.1），Node + pnpm v11.21.0，Vitest v3.2.7。

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | 0 | 6/6 workspace 包构建通过（Vite `app-features` chunk `603.91 kB` 为既有 >500 kB 提示，构建成功） | build |
| `pnpm typecheck` | 0 | 6/6 workspace 包 `tsc --noEmit` 全部通过 | static |
| `pnpm contracts:check` | 0 | Plugin API 契约校验通过 | contract |
| `pnpm --filter @harnessmate/protocol test -- --maxWorkers=1` | 0 | 2 files / **6 passed** | synthetic |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1` | 0 | 18 files / **89 passed**（含 `tests/np08-swarm-studio.test.tsx` **4/4** 与 `tests/np03-workbench-ui.test.tsx` **7/7**） | synthetic |
| `pnpm --filter @harnessmate/daemon test tests/agy-np08-swarm.test.ts` | 0 | 1 file / **6 passed**（T10-A 至 T10-F 全绿，耗时 396ms） | synthetic |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1`（全量回归，修复 T10-F 种子前） | 1 | 38 files 中 **34 files / 198 tests** 一次通过（含全部 `adapters-codex`、`adapters-claude`、`adapters-acp`、`phase3-external-adapters`、`agy-replay-protocol`、`agy-lifecycle-events`、`agy-np02-*`、`agy-np04`、`agy-np05`、`agy-np06`、`agy-np07`、`handoff-v2`、`plugin-v5`、`daemon.test.ts`）；仅 T10-F 因缺 workspace/session FK 种子失败（随后修复并 6/6 通过），另有 3 个既有文件因本机 Windows `git`/shell 子进程耗时偏高触发测试超时 | synthetic / replay_with_provenance |
| `pnpm --filter @harnessmate/daemon test tests/git-checkpoints.test.ts tests/multi-harness-orchestrator.test.ts tests/terminal-workspace.test.ts -- --maxWorkers=1`（复验 3 个超时文件） | 1 | `terminal-workspace.test.ts` **5/5 通过**；未触碰的 `git-checkpoints.test.ts`（`workspaceTruthDigest` 实测 2472ms > 2000ms 阈值及 20s 超时）与 `multi-harness-orchestrator.test.ts`（2 项真实 `git worktree` 子进程用例在 30s 超时）在本机高负载下仍受 Windows `git.exe` 启动延迟影响，与 NP-08 零代码交集 | environment_timing |
| `git diff --check agy-np-g2...HEAD` | 0 | 无空白/冲突标记错误 | static |

**未执行的验证及原因**：
- `live_raw` / `live_hm` / `official_comparison`（T10 授权真机单账号单 worker Swarm 采样、ACP 原始帧取证与官方 App/CLI `/swarm board` 对照）：按 `12_Test_Strategy.md` 与 `G3_Launch_Plan.md`，需等待 U01 专用测试 Profile 授权及总指挥串行真机取证，完成后再解锁 `liveLaunchEnabled` / 升级能力矩阵等级。

## 5. Capability IDs、真实证据与数据/跨 Harness 回归

| Capability ID | 当前矩阵等级（维持不变） | 本轮覆盖与缺口说明 |
| --- | --- | --- |
| `AGY-W04` | L0 · Upstream Limited, Not Tested | 已交付离线 `AgySwarmObserver`、`WorkflowDetail` (`kind: 'swarm'`) 持久化提交、`AGY-W04` 能力贡献与 `SwarmStudioView`；缺真实 1.5.16+ ACP `/swarm` 触发回执、实时 Coordinator/Worker wire 帧与官方 App/CLI 对照 |
| `AGY-W05` | L0 · Upstream Limited, Not Tested | 已交付 `SwarmBoardStore` 稳定 ID 分页、只读 `SwarmBoardPanel`、`VERIFIED_LOCAL_BOARD_SCHEMAS = []` fail-closed 保护与「当前 ACP 未提供 Board」官方入口降级；缺上游 ACP Board feed 或经验证的只读本地源实证 |
| `AGY-R10` | L0 · Not Tested | Swarm 控制菜单默认因 `upstream_limited` 保持只读，不暴露未验证的成员/工作流停止动作 |
| `AGY-S03` | L1 · Not Tested | 已验证断连与切代后工作流及成员立即标为 `stale`，历史代只读且 Coordinator 轨迹完整保留 |

**引用证据 ID**：
- `E01`（`docs/phase-agy-native-parity/06_Protocol_Evidence.md`）：官方 Windows AGY CLI 1.5.16 发现基线。
- `E06`（`docs/phase-agy-native-parity/06_Protocol_Evidence.md`）：本机目录普查未验证 Swarm Board 本地格式 → 驱动 `VERIFIED_LOCAL_BOARD_SCHEMAS = []` 与阻断私有 SQLite 数据库。
- `T10-OFFLINE-SYNTHETIC`（`packages/daemon/src/harnesses/agy/native/workflows/swarm/fixtures.ts`）：离线合成 T10 夹具，验证 worker idle、真实 mention 唤醒、权限链接、失败、Coordinator settle 及缺 Board feed 降级（不抬升真机等级）。

**数据与其他 Harness 回归**：
- 未修改 SQLite schema 与旧表，`agy-np02-persistence-migration.test.ts`（5/5）、`agy-np02-wiring-provenance.test.ts`（4/4）、`adapters-codex.test.ts`（5/5）、`adapters-claude.test.ts`、`adapters-acp.test.ts`、`phase3-external-adapters.test.ts`（5/5）、`agy-replay-protocol.test.ts`（AGY 1.5.14 离线回放）、`handoff-v2.test.ts`（12/12）、`unified-context-bridge.test.ts`（3/3）、`plugin-v5.test.ts`（6/6）与 Web 全部 89 项测试均通过；默认所有 NP-08 gate 为关闭状态。

## 6. 冲突与协作接线提议（供总指挥 / 共享 Owner 在 G3 串行集成）

无需修改 `@harnessmate/protocol` 公共协议或 SQLite 迁移序号（完全复用 `agy-native-v1.0.0` 与 migration `1`）。G3 集成时建议由总指挥按以下最小切口接入：

1. **给 NP-02 / 总指挥（`packages/daemon/src/harnesses/agy/native/wiring/composition.ts`）**：
   - 实例化 `const swarm = new AgySwarmObserver({ gates: DEFAULT_SWARM_OBSERVER_GATES })`（生产默认关闭，隔离环境可按独立环境变量启用 `swarmEnabled` / `boardFeedEnabled`）。
   - 在 `connection.attach` / `connection.close` 中同步调用 `swarm.registerBinding(...)` 与 `swarm.handleTransportClosed(...)`（并将返回的 `commits` 经 `swarm.commitToRegistry(...)` 提交）。
   - 在 `connection.ingest` 中将 `session/update` 转发至 `swarm.acceptFrame(envelope, scope)` 并提交 `result.commits`。
   - 在 `registry.registerModules(...)` 中挂载 `workflowResourceReader: swarm`（或当 NP-09/10/11 合并后通过 `workflow.detail.kind` 路由分发到各模式 `NativeWorkflowResourceReaderPort`）。
   - 在 `AgyNativeCommandCatalogService` 初始化时调用 `registerSwarmCapabilityDescriptors(catalog, swarm.getGates())`；在 `updateCatalog` 收到 `available_commands_update` 时同步调用 `swarm.onAvailableCommandsUpdate(binding, commands)`。
   - **附带回归用例**：`packages/daemon/tests/agy-np08-swarm.test.ts` 中 `T10-F` 已覆盖 `AgySwarmObserver` + `AgyNativeRuntimeRegistry` + `AgyNativeCommandCatalogService` 全链路集成。

2. **给 NP-07 / 总指挥（审批路由联动）**：
   - 在 `NativePermissionRouter` 解析出 `NativeRequestTargetResolution` 且请求状态变更（`pending` / `response_written` / `cancelled` / `expired` / `connection_lost`）时，调用 `swarm.linkWorkerApproval(binding, { approvalId, targetResolution, receiptState })` 并将返回的 `commits` 提交至 registry；不修改真实线缆 `actualWireSessionId`。

3. **给 NP-03 / 总指挥（Web 工作台壳注册）**：
   - 在 Web 工作台初始化位置调用 `registerSwarmStudioView()`（`packages/web/src/components/agy/native/swarm/register.ts`，`order: 200`），覆盖默认 `order: 900` 降级壳；无需改动 `AgyWorkbenchShell.tsx`、`ChatStage.tsx` 或 `App.tsx`。

## 7. 审查者核验清单与回滚命令

**审查者快速复现命令**：
```powershell
git diff --name-status agy-np-g2...HEAD
git diff --check agy-np-g2...HEAD
pnpm --filter @harnessmate/daemon test tests/agy-np08-swarm.test.ts
pnpm --filter @harnessmate/web test tests/np08-swarm-studio.test.tsx tests/np03-workbench-ui.test.tsx
pnpm typecheck
pnpm contracts:check
```

**回滚方案**：
1. **运行时 / Board 独立门控关闭（零代码回滚，保留已捕获 Coordinator 轨迹）**：
   - 关闭 Board 单独门控：`swarmObserver.setGates({ boardFeedEnabled: false, localBoardSnapshotEnabled: false })` → `resource: 'board'` 立即返回 `available: false` (`swarm_board_gate_disabled`)，Swarm Studio 展示官方 `/swarm board` 说明，已捕获 Coordinator 轨迹经 `resource: 'logs'` 完整保留。
   - 关闭 Swarm 总门控：`swarmObserver.setGates({ swarmEnabled: false, boardFeedEnabled: false, liveLaunchEnabled: false })` → 停止发布新 Swarm 工作流状态更新，已捕获 Coordinator 轨迹仍保留只读。
2. **代码提交回滚**：待合入集成分支后，按需执行：
   ```powershell
   git revert 9f9ccdbf870660f4f28f687691948fb91b67fb46
   ```
   （若以 merge commit 合入集成分支，则由集成负责人执行 `git revert -m 1 <mergeCommit>`，不改动已有 SQLite 迁移表。）
