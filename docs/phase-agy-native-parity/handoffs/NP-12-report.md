# NP-12 交付报告 · Goal、Schedule 与 Native Tasks

## 1. 基线、Worktree 与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-12`（Goal、Schedule 与 Native Tasks） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| 已复验 G3 第一批源码 | `5711a8266bdca72fd34a5dd07f59aedfb108a237` |
| Reviewed Base（G3 第二批统一开工基线） | `9826359a46d0518c88d12ca45318bb5cb891a73a`（标签 `agy-np-g3-wave1`，`docs(agy-np): freeze reviewed G3 wave-one and wave-two launch`） |
| 实际工作分支 / Worktree | `np12_goal_schedule_tasks` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np12_goal_schedule_tasks`（经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np12_goal_schedule_tasks`） |
| **代码交付提交 SHA** | **`fee67077412c1eeaa12ec20a25621ea28075764b`**（`feat(agy-np-12): implement goal, schedule, and native tasks observer, view, fixtures and tests`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零改动） |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零改动） |
| `MASTER_PROGRESS.md` | 未修改（由总指挥统一维护） |

## 2. 实际变更路径与文件所有权核对

全部代码、夹具、测试与报告严格限定在 NP-12 允许写入范围内（`packages/daemon/src/harnesses/agy/native/workflows/tasks/**`、`packages/web/src/components/agy/native/tasks/**`、专属 fixtures/tests 与本报告）。`packages/protocol/**`、`packages/plugin-api/**`、`packages/daemon/src/harnesses/agy/native/{wiring,runtime,child,commands,requests}/**`、`packages/daemon/src/harnesses/agy/agy-protocol.ts`、`packages/daemon/src/core/**`、`packages/daemon/src/db/**`、`packages/web/src/App.tsx`、`ChatStage.tsx`、`AgyStudioBlocks.tsx`、`packages/web/src/components/agy/native/shared/**`、`docs/phase-agy-native-parity/MASTER_PROGRESS.md` 及其他 Harness 适配器均零修改。

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/workflows/tasks/types.ts` | NP-12 领域契约、版本化线字段清单 `TASKS_WIRE_FIELD_VERSIONS`、`/tasks` 协议暴露评估 `TASKS_PROTOCOL_EXPOSURE_ASSESSMENT`、App-only 收口记录 `APP_AUTOMATIONS_CLOSURE_RECORD`（`AGY-W12`/`AGY-E08`）、Goal/Schedule/Occurrence/聚合 Center DTO |
| `packages/daemon/src/harnesses/agy/native/workflows/tasks/ports.ts` | NP-06 目录贡献（`GOAL_CAPABILITY_CONTRIBUTION`、`SCHEDULE_CAPABILITY_CONTRIBUTION`、`TASKS_MANAGER_CAPABILITY_CONTRIBUTION`、`APP_AUTOMATIONS_CAPABILITY_CONTRIBUTION`、`registerTasksCapabilityDescriptors`）、NP-15 恢复证据接口 `TasksRecoveryEvidencePort` 与 `FrozenTasksRecoveryEvidenceStub`、不透明产物 ID 校验 `isValidOpaqueArtifactId`、原生时区校验 `isValidNativeTimezone` |
| `packages/daemon/src/harnesses/agy/native/workflows/tasks/codec.ts` | `decodeTasksIngressFrame`：识别 Goal（启动、替换、验证、状态/结果、非不透明路径拦截）、Schedule（单次 `DurationSeconds` vs `CronExpression`、仅采信原生 `nextAt`/时区绝不本地猜测、`manage_task(kill)` 早取消）、Occurrence 触发、已结束轮次后的 Wake 信号、有限/Daemon 背景任务，以及 `/automation` & Sidecar 只读收口拦截 |
| `packages/daemon/src/harnesses/agy/native/workflows/tasks/observer.ts` | `GoalScheduleTasksObserver`（实现 `NativeWorkflowResourceReaderPort`）：Goal 启动/替换/停止/验证与 `superseded` 历史保留；Schedule 与 Occurrence `WorkId`/`wake ActivityId` 严格分离（绝不重开已结束用户轮次）；诚实 lease 评估（闲置 cron 与断连绝不持租）；断连 `stale` 与到期历史 `preserved_read_only`；NP-15 作用域校验与跨代 occurrence 去重；`setEnabled(false)` 停用写入后保留只读历史与分页资源；Runtime Center 聚合与 `commitToRegistry` |
| `packages/daemon/src/harnesses/agy/native/workflows/tasks/fixtures.ts` | NDJSON 夹具加载器与 `replayTasksNdjson` 回放器 |
| `packages/daemon/src/harnesses/agy/native/workflows/tasks/index.ts` | 后端领域模块统一导出入口 |
| `packages/web/src/components/agy/native/tasks/types.ts` | Native Tasks 视图 props、分类过滤、Goal/Schedule/Occurrence 视图模型类型 |
| `packages/web/src/components/agy/native/tasks/view-model.ts` | `formatNativeTime`（显式原生时区或 `原生时区未知` + UTC，绝不用宿主机/浏览器时区冒充）、`selectGoalCards`、`selectScheduleCards`、`buildCategorizedTasks`、`resolveTasksControlGate` |
| `packages/web/src/components/agy/native/tasks/GoalDetailPanel.tsx` | 独立 Goal 详情面板（目标、替换历史、`NativeControlMenu`、核验产物、起源活动跳转、`EvidenceDetails`） |
| `packages/web/src/components/agy/native/tasks/ScheduleDetailPanel.tsx` | 独立 Schedule 详情面板（单次/cron、原生 `nextAt` 与明确时区/未知、原生删除/暂停提示、Occurrence 列表与已观测 wake 跳转、日志分页加载） |
| `packages/web/src/components/agy/native/tasks/AppAutomationsClosureCard.tsx` | `AGY-W12`（App Automations）与 `AGY-E08`（Sidecars）只读证据收口卡片，明示不仿成 ACP、不建 HM 调度器、不重绑现有任务 |
| `packages/web/src/components/agy/native/tasks/NativeTasksView.tsx` | NP-12 主工作台视图（`surface: 'tasks'`）：分类过滤（`all`/`goal`/`schedule`/`finite_command`/`daemon`/`workflow_step`/`unknown`）、只读关闭模式横幅、断连/恢复校准横幅、独立 Goal/Schedule 面板、Runtime Center 聚合列表、`/tasks` 协议评估降级卡、`480px` 窄屏适配 |
| `packages/web/src/components/agy/native/tasks/register.ts` | `registerNativeTasksView`（`order: 120`，覆盖 NP-03 默认 `order: 900` 降级壳） |
| `packages/web/src/components/agy/native/tasks/fixtures.ts` | 前端离线夹具（Goal 替换、单次唤醒、模拟 cron 无时区/无 `nextAt`、断连只读历史保留） |
| `packages/web/src/components/agy/native/tasks/index.ts` | 前端模块导出入口 |
| `packages/daemon/tests/fixtures/agy-np12/README.md` | NP-12 离线夹具目录与来源说明（全部 `synthetic`，无长期挂起真实定时任务） |
| `packages/daemon/tests/fixtures/agy-np12/t09-oneshot-post-turn-wake.ndjson` | T09 单次定时 + 已结束用户轮次 + 晚唤醒归属夹具 |
| `packages/daemon/tests/fixtures/agy-np12/t09-early-cancel-and-goal-lifecycle.ndjson` | T09 早取消（`manage_task` kill）+ Goal 启动/核验/路径拦截/替换夹具 |
| `packages/daemon/tests/fixtures/agy-np12/t09-simulated-cron-multi-occurrence.ndjson` | T09 模拟 cron 多次触发 + 缺 `nextAt`/缺原生时区夹具 |
| `packages/daemon/tests/fixtures/agy-np12/t14-disconnect-restart-recovery.ndjson` | T14 断网 `stale` 与已到期 occurrence 只读保留夹具 |
| `packages/daemon/tests/agy-np12-goal-schedule-tasks.test.ts` | Daemon 专项集成测试（6/6 通过：T09 单次/post-turn wake/SQLite 注册提交、Goal 替换/停止/路径拒绝、早取消、模拟 cron 多 occurrence、Runtime Center 聚合与 App 收口、T14 恢复去重与跨作用域阻断、G3-04/05 栅栏与只读关闭回滚） |
| `packages/web/tests/agy-np12-tasks-view.test.tsx` | Web Native Tasks 视图测试（3/3 通过：Workbench 注册覆盖、Goal/Schedule 独立控制、原生时区 vs 未知、`nextAt` 不本地猜测、wake 跳转与未见 wake 保护、只读历史模式、`480px` 窄屏、空列表诚实语义） |

## 3. 原生字段版本清单、`/tasks` 暴露评估与 App-only 结案记录

### 3.1 领域内原生字段版本清单（`TASKS_WIRE_FIELD_VERSIONS`）

未更改共享 wall-clock 属性定义，所有版本差说明收口在本域 `types.ts` 中：

| 协议/字段位置 | 适用 CLI 版本 | 证据类别 | 缺失或变更时的降级行为 |
| --- | --- | --- | --- |
| `session/update`（`tool_call` / `tool_call_update`：`toolCallId`, `title`, `status`, `rawInput`, `rawOutput`） | `1.5.14+` | `acp_v1_standard`（`E02`, `E05`） | 局部补丁省略字段保留已有状态；`status: null` 记为 `unknown`。 |
| `schedule` 工具参数（`DurationSeconds`, `CronExpression`, `Prompt`, `IsDaemon`, `TimerCondition`, `MaxIterations`, `ExactTiming`） | `1.5.14+` | `acp_v1_standard`（`E05`, `S06`, 官方 `/schedule`） | 仅凭结构化字段区分 `one_shot` vs `cron`；均缺失时保持 `unknown`。 |
| `schedule` 权威定时（`nextAt`/`nextRunAt`/`fireAt`/`scheduledAt`, `timezone`/`timeZone`/`tz`） | `1.5.16+` | `candidate_pending_live_t09`（`E05`, `08_Shared_Contracts`） | **绝不**用 `Date.now() + DurationSeconds` 或本地 cron 推算 `nextAt`，**绝不**用浏览器/宿主机时区冒充原生时区；缺失保持 `Observed unknown`。 |
| `goal` 字段（`objective`, `verificationArtifactIds`, `replacesGoalId`/`supersedes`, `status`, `rawOutput`） | `1.5.14+` | `acp_v1_standard`（`E05`, `S12`, 官方 `/goal`） | 拦截宿主路径仅接受不透明 ID；缺失明确 `exitCode===0`/`ok===true` 时 `outcome` 保持 `unknown`。 |
| `manage_task` / 早取消（`Action: 'kill'`, `TaskId`, `timer_condition_cancelled`） | `1.5.16+` | `candidate_pending_live_t09`（官方 `/schedule`, `T09-synthetic`） | 早取消转 `cancelled` 并只读保留历史记录。 |
| 轮次后唤醒分段（`turnId: null`, `origin: 'native_task' \| 'native_continuation'`, 独立 `ActivityId`） | `1.5.15+` | `acp_v1_standard`（CLI `1.5.15`, `E08`, `T02`, `T09-synthetic`） | 为每次已观测 wake 建立独立 `ActivityId` 并关联 occurrence `WorkId`，不重开已结束的用户 turn。 |

### 3.2 `/tasks` 协议暴露评估（`TASKS_PROTOCOL_EXPOSURE_ASSESSMENT`）

- 当前 ACP v1（已观测 `1.5.14`–`1.5.16` 握手与回放）**未暴露**结构化 `/tasks` 列表查询 RPC、直接 task kill RPC 或向后台任务注入输入（`sendInput`）的 RPC。
- ACP 仅提供根会话 `session/cancel` 与实时 `tool_call`/`tool_call_update` 流；因此 Native Tasks 聚合视图仅使用 `live_acp_tool_stream` 与 `runtime_work_projection` 做只读聚合，并在控制受限时明确展示官方 `/tasks`（`Ctrl+T`）入口指引。真实已有计划的删除、暂停与编辑仍由用户经原生端完成。

### 3.3 App-only Automations 与 Sidecars 证据结案记录（`APP_AUTOMATIONS_CLOSURE_RECORD`）

- 对应能力：`AGY-W12`（App Automations `/automation`）与 `AGY-E08`（App Sidecars & `agentapi`），surface 限定 `desktop`（官方 App）。
- 边界结论：NP-12 对该两项仅做只读证据收口——不将 App Automations/Sidecars 仿成 ACP 工具流、不自建 HarnessMate 调度器或唤醒 prompt、不重绑用户现有任务。`APP_AUTOMATIONS_CAPABILITY_CONTRIBUTION` 将 `AGY-W12` 的 `launch`/`observe`/`control`/`localRead` 门控全部锁定为 `unsupported`。

## 4. 已实现与未覆盖事项

### 4.1 已实现核心能力

1. **Goal 生命周期与替换**：真实启动（经 `live_workflow` 或协议帧）、状态流转、替换旧目标为 `superseded`（保留历史）、验证记录与不透明验证产物（拒绝非不透明宿主路径）、停止请求（`requested`）与原生取消确认（`confirmed`）分离。
2. **Schedule 与 Occurrence 独立投影**：区分 `one_shot` 与 `cron`、已创建/计划/触发/早取消/到期；`WorkId`（occurrence）与 `wake ActivityId`（`turnId: null`, `origin: 'native_task'`）严格分离；已结束用户轮次后的多个模拟 cron 触发分别生成独立 `WorkId` 与 `ActivityId`；`nextAt` 与原生时区缺失时保持 `unknown`。
3. **诚实租约与 NP-15 恢复对齐**：仅在活跃 Goal、Goal stop 宽限期、正在运行的 triggered occurrence 或明确 `sessionBoundTimer` 单次计划且连接在线时持租；闲置 cron 绝不持租；断连将非终态转 `stale` 并保留到期/终态历史为 `preserved_read_only`；`TasksRecoveryEvidencePort` 拦截跨 Profile/Source/Workspace/Conversation 重绑并跨代去重。
4. **Native Tasks 前端视图**：按类别筛选（`goal` / `schedule` / `finite_command` / `daemon` / `workflow_step` / `unknown`），Goal 与 Schedule 面板、下一事件与操作完全独立，时间严格按原生时区或 `原生时区未知`（UTC）展示，仅对已观测 wake 开放跳转按钮，支持只读关闭回滚模式与 `480px` 窄屏。

### 4.2 明确未覆盖事项与真机缺口

- **Windows 真机授权 `AGY 1.5.16` U01 `T09`/`T14` 实录（`live_raw` / `live_hm` / `official_comparison`）尚未执行**：按 `G3_Wave2_Launch_Plan.md` 与 `12_Test_Strategy.md`，需等待专用测试 Profile 授权及总指挥集成后运行；本报告**不提升**能力矩阵 `L2`–`L5` 等级，未在探索中长期挂起真实 cron 任务。
- **未修改共享接线文件**：未修改 `wiring/composition.ts`、`App.tsx`、`commands/catalog.ts`、`runtime/controller.ts` 或 NP-15 模块本身；第 7 节给出精确协作接线提议。

## 5. 测试验证、证据分类与 Capability ID

### 5.1 已执行验证命令与实测结果

运行环境：Windows，Node.js `v24.18.0`，pnpm `11.21.0`，代码提交 `fee67077412c1eeaa12ec20a25621ea28075764b` 对应源码：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | 6/6 workspace 包构建通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（构建） |
| `pnpm typecheck` | `0` | 6/6 workspace 包零类型错误 | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过 | `synthetic`（插件契约） |
| `pnpm --filter @harnessmate/protocol test` | `0` | **2 files, 6/6 passed**（`protocol.test.ts` 1/1, `agy-native-v1.test.ts` 5/5） | `synthetic` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1` | `0` | **22 files, 109/109 passed**（含 `tests/agy-np12-tasks-view.test.tsx` **3/3 passed**） | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np12-goal-schedule-tasks.test.ts` | `0` | **1 file, 6/6 passed**（T09 单次/post-turn wake/SQLite 注册、Goal 生命周期、模拟 cron 多 occurrence、聚合与 `/automation` 收口、T14 恢复去重与跨作用域阻断、G3-04/05 栅栏与只读回滚） | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1` | `1`（超时） | **40/42 files passed, 225/229 tests passed**：`agy-np12`（6/6）与全部 AGY/适配器/插件/迁移测试均通过；仅两个高 I/O git worktree 既有测试在多 Worktree 并发 Windows 磁盘负载下出现超时/耗时抖动（`git-checkpoints.test.ts` 3 项、`multi-harness-orchestrator.test.ts` 第 6 项 `30056ms > 30000ms`） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 tests/git-checkpoints.test.ts tests/multi-harness-orchestrator.test.ts` | `1`（复跑） | `git-checkpoints.test.ts` **7/7 passed**（完整复验通过）；`multi-harness-orchestrator.test.ts` 第 6 项通过（`26205ms`），第 5 项（前一轮通过为 `26372ms`）在 Windows git worktree 并发负载下达 `30290ms` 超时（单跑 `multi-harness-orchestrator.test.ts` 亦为第 5/6 项 `30049ms`/`30322ms` > `30000ms` 超时） | `synthetic`（既有 git 耗时敏感项） |
| `git diff --check agy-np-g3-wave1` | `0` | 无空白符或冲突标记问题 | 静态检查 |

### 5.2 未执行的检查与原因

- **Windows 真机授权 T09 / T14 运行（`live_raw` / `live_hm` / `official_comparison`）**：等待专用测试 Profile 授权及总指挥在集成阶段通过 `probe-acp.mjs` 采集真实 `/goal`、`/schedule`、`/tasks` 线帧。
- **与 NP-15 实代码联测**：NP-15 正在同批并行开发，本轮通过冻结的 `TasksRecoveryEvidencePort` 与 `FrozenTasksRecoveryEvidenceStub` 完成断连/重启对齐及跨作用域阻断测试，集成阶段对接 NP-15 真实实现。

### 5.3 证据 ID、测试场景与 Capability ID

- **关联 Capability ID**：`AGY-W09`（Goal）、`AGY-W10`（Schedule）、`AGY-W11`（Native Tasks `/tasks`）、`AGY-W12`（App Automations 只读收口）、`AGY-E08`（Sidecars 只读收口）、`AGY-R04` / `AGY-R05`（有限 vs Daemon 聚合分类）。
- **证据与设计来源**：`E01`、`E02`、`E05`、`E06`、`S06`、`S12`、`T09`、`T14`。
- **风险缓解**：`R-02`、`R-03`、`R-07`、`R-08`、`R-11`、`R-15`、`R-16`、`R-17`。

## 6. 数据与跨 Harness 回归结论

- **数据与现有 AGY**：`agy-np02-persistence-migration.test.ts`（5/5）、`agy-np02-wiring-provenance.test.ts`（4/4）、`agy-np04-reactive-runtime.test.ts`（10/10）、`agy-np05-child-routing.test.ts`（7/7）、`agy-np06-command-router.test.ts`（9/9）、`agy-np08-swarm.test.ts`（6/6）、`agy-np09-boost.test.ts`（6/6）、`agy-np10-teamwork.test.ts`（6/6）、`agy-np11-dynamic-workflow.test.ts`（6/6）、`agy-np-observatory.test.ts`（18/18）、`agy-replay-protocol.test.ts`（2/2）、`agy-lifecycle-events.test.ts`（5/5）、`agy-auth-usage.test.ts`（7/7）、`agy-launch-context.test.ts`（6/6）、`agy-config-scope.test.ts`（4/4）全通；关闭开关后已观测历史仍保持只读。
- **跨 Harness 与生态**：`adapters-codex.test.ts`（5/5）、`adapters-claude.test.ts`（4/4）、`adapters-acp.test.ts`（4/4）、`phase3-external-adapters.test.ts`（5/5）、`handoff-v2.test.ts`（12/12）、`unified-context-bridge.test.ts`（3/3）、`plugin-v4.test.ts`（6/6）、`plugin-v5.test.ts`（6/6）、`plugin-p3-isolation.test.ts`（4/4）、`plugin-p4-ui-slots.test.ts`（2/2）、`plugin-p5-ecosystem.test.ts`（2/2）全通；`multi-harness-orchestrator.test.ts` 未被 NP-12 修改（6 项测试分别在不同轮次全部通过功能断言，仅第 5/6 项在当前宿主机并发负载下偶发超过 30s 默认单测超时）。

## 7. 冲突声明与给共享 Owner 的协作变更提议

当前 **零文件冲突**。集成阶段向共享模块 Owner 提交以下接线提议：

1. **给 NP-02（`packages/daemon/src/harnesses/agy/native/wiring/composition.ts`）**：
   - 在 `wireAgyNativeRuntime` 实例化 `const tasksObserver = new GoalScheduleTasksObserver()`（由总指挥门控控制 `enabled`）。
   - 在 `connection.attach` 调用 `tasksObserver.registerBinding(scope)`；在 `connection.ingest` 对 `session/update` 调用 `const res = tasksObserver.acceptFrame(envelope, { activeTurnId, activeTurnEnded, originActivityId })` 并执行 `tasksObserver.commitToRegistry(registry, scope.binding, res.commits)`。
   - 在 `connection.close` 调用 `tasksObserver.commitToRegistry(registry, binding, tasksObserver.handleTransportClosed(binding, connectionId))`。
   - 在 `workflowResourceReader` 中为 `kind === 'goal' || kind === 'schedule'` 分派到 `tasksObserver.readWorkflowResource(input)`。
2. **给 NP-03（`packages/web/src/App.tsx` / Workbench 启动入口）**：
   - 在 AGY Workbench 初始化时调用 `registerNativeTasksView()`（`packages/web/src/components/agy/native/tasks/index.ts`），以 `order: 120` 接管 `surface: 'tasks'`。
3. **给 NP-04 / NP-02（Lease 聚合）**：
   - 将 `tasksObserver.listRetentionReasons(binding)` 合入运行时保活原因列表（仅包含活跃 Goal、Goal Stop 宽限期或实证运行中的 occurrence，绝不替闲置 cron 持租）。
4. **给 NP-06（`packages/daemon/src/harnesses/agy/native/commands/catalog.ts` & `router.ts`）**：
   - 注册 `registerTasksCapabilityDescriptors(catalog)`（贡献 `AGY-W09`/`W10`/`W11`/`W12`）。
   - 当真实 `live_workflow` 路由接入 `/goal` 与 `/schedule` 时，调用 `tasksObserver.recordConfirmedGoalLaunch` / `recordConfirmedScheduleLaunch` 并返回与 `NativeCommandResponse` 一致的 receipt。
5. **给 NP-15（Recovery）**：
   - 实现 `TasksRecoveryEvidencePort`（`packages/daemon/src/harnesses/agy/native/workflows/tasks/ports.ts`）并在恢复对齐阶段调用 `tasksObserver.reconcileRecovery(...)` 验证 profile/source/workspace/conversation 作用域与跨代 occurrence 去重。

## 8. 独立审查者复验命令与回滚方案

### 8.1 独立审查者复验命令

```powershell
git status --short --branch
git diff --name-status agy-np-g3-wave1...HEAD
git diff --check agy-np-g3-wave1...HEAD
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/daemon test -- tests/agy-np12-goal-schedule-tasks.test.ts
pnpm --filter @harnessmate/web test -- tests/agy-np12-tasks-view.test.tsx
pnpm --filter @harnessmate/protocol test
pnpm --filter @harnessmate/web test -- --maxWorkers=1
pnpm --filter @harnessmate/daemon test -- --maxWorkers=1
```

### 8.2 回滚方案与命令

1. **优先功能开关禁用（无损、保留到期与历史 occurrence 只读可查）**：
   - 后端调用 `tasksObserver.setEnabled(false)` 或保持 `AgyNativeFeatureFlags.enabled = false` / `nativeWorkflowObservation = false`；观察器停止接收新的写入，已记录的 Goal/Schedule 及到期 occurrence 历史继续可通过 `readWorkflowResource` 与快照只读查看。
2. **代码提交回滚**：
   - 独立分支回滚代码提交：
     ```powershell
     git revert --no-edit fee67077412c1eeaa12ec20a25621ea28075764b
     ```
   - 若合入集成分支后产生 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
