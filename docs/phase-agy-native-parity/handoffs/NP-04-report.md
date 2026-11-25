# NP-04 独立开发交付报告 · Reactive Runtime 与后台保活

> 本报告按 `docs/phase-agy-native-parity/tasks/NP-04-reactive.md`、`handoffs/G2_Launch_Plan.md` 与 `12_Test_Strategy.md` 编写，供总指挥与独立审查者核验。`MASTER_PROGRESS.md` 未作修改，由总指挥统一更新。

## 1. 基线、分支与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-04`（Reactive Runtime 与后台保活） |
| 源码审计基线 | `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039` |
| G1 已审源码提交 | `966451ceaa2d8cfbf268b05a973dbb400715b616`（`fix(agy-np): close G1 wake, runtime and shared feed blockers`） |
| Reviewed Base（G1 开工标签） | `agy-np-g1` -> `b5d010ae74815a311d98090359b9d62894973024`（`docs(agy-np): freeze G1 and prepare G2 work packages`） |
| 实际工作分支 | `np04_reactive_runtime`（对应建议分支 `codex/agy-np-04-reactive`，可由总指挥集成） |
| 实际 Worktree 路径 | `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np04_reactive_runtime`（经 junction 挂载于 `C:/Users/windfile/.gemini/antigravity/worktrees/harnessmate_desktop/np04_reactive_runtime`） |
| **代码交付提交 SHA** | **`b0ffe2826f7355cb6296eb382c99e89f26a70149`**（`feat(agy-np-04): implement AGY reactive runtime controller, per-ID work tracker, and Runtime Center UI`） |
| 报告提交 SHA | 本报告所在最新 `HEAD`（`docs(agy-np-04): add NP-04 reactive runtime handoff report`） |
| 共享契约 Revision | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'` · `WORKBENCH_REGISTRY_CONTRACT_REVISION = '1.0-np03'` · `AGY_NP04_RUNTIME_VERSION = '1.0.0-np04'` |
| 特性门控默认值 | 保持全关（`DEFAULT_AGY_NATIVE_FEATURE_FLAGS.enabled = false`、`nativeLifecycle = false`、`agyNativeWorkbenchEnabled = false`），G2 联调前不改变生产默认路径 |

## 2. 变更路径与所有权核对

全部变更严格落在 NP-04 允许写入范围（`packages/daemon/src/harnesses/agy/native/runtime/**`、`packages/web/src/components/agy/native/runtime/**`、专属 lifecycle tests 与 `handoffs/NP-04-report.md`）。

**零越权改动确认**：`packages/daemon/src/harnesses/agy/native/wiring/**`、`packages/daemon/src/core/session-manager.ts`、`packages/daemon/src/harnesses/acp/strict-acp-adapter.ts`、`packages/daemon/src/harnesses/agy/agy-protocol.ts`、`packages/daemon/src/harnesses/agy/agy-driver.ts`、`packages/daemon/src/db/sqlite.ts`、`packages/protocol/src/**`、`packages/plugin-api/**`、`packages/web/src/components/ChatStage.tsx`、`packages/web/src/stores/app-store.ts`、`packages/web/src/components/agy/native/shared/**` 及 `docs/phase-agy-native-parity/MASTER_PROGRESS.md` 均 **0 修改**。

| 路径 | 类别 | 职责说明 |
| --- | --- | --- |
| `packages/daemon/src/harnesses/agy/native/runtime/types.ts` | 后端新增 | 运行时配置与热重载契约、可注入时钟/定时器调度器、Captured RPC Scope / `(runtimeId, generation, turnId)` 结算键、Cancel 目标/宽限状态、版本化 Codec 描述符、NP-05/NP-07 契约桩与四层归因诊断 DTO |
| `packages/daemon/src/harnesses/agy/native/runtime/codec.ts` | 后端新增 | 6 条带 trace 溯源的版本化 ACP v1 Codec 规则（`AGY_REACTIVE_CODEC_RULES`，引用 `E02`/`E05`/`E08`/`S06`/NP-01 `t02`–`t06`）、`PatchField<T>` 显式区分 omitted vs explicit `null`、`strictMode` 开关、数字/字符串 RPC ID 保真、`finished` 与 `outcome` 解耦（无明确 wire 凭据不伪造 `succeeded`） |
| `packages/daemon/src/harnesses/agy/native/runtime/work-tracker.ts` | 后端新增 | `ReactiveWorkTracker`：per-ID `NativeWork` 合并与别名索引（`tool_call`/`task`）、重复终态幂等抑制、独立有限阻塞集合 vs `daemon`/`schedule` 分离集合、进程保活原因计算（`finite_work:*` / `daemon_observe:*`）、断连 `stale` / 超时 `unknown` 转换与有界终态回收 |
| `packages/daemon/src/harnesses/agy/native/runtime/diagnostics.ts` | 后端新增 | 纯函数 `buildReactiveRunDiagnosis`：区分上游缺口（`reactive_not_observed`、`upstream_early_prompt_response`、`observation_timeout_unknown`、`cancel_grace_expired_unknown`、`transport_disconnected_while_active`）与 HM 运行时防护（`hm_stale_rpc_pollution_blocked`、`hm_duplicate_terminal_patch_ignored`、`hm_missing_tool_call_id`、`hm_history_replay_isolated`、`hm_generation_fenced`、`hm_usage_only_no_reopen`） |
| `packages/daemon/src/harnesses/agy/native/runtime/controller.ts` | 后端新增 | `AgyReactiveRuntimeController`：完整实现 `NativeLifecyclePort` 与 `NativeTimelineReaderPort`，对接 `NativeTurnSettlementSink` 与 `AgyNativeRuntimeRegistry.commitAndPublish`，落实早 Prompt 持有、并行有限任务独立保活、晚 tool update vs 原生 wake segment 区分、`turnId: null` native-only activity、captured RPC scope 防污染、cancel grace、transport exit、代际栅栏、warm-pool 驱逐校验、配置热重载 `reloadConfig` 与有界分页时间线 |
| `packages/daemon/src/harnesses/agy/native/runtime/index.ts` | 后端新增 | NP-04 后端运行域统一导出入口 |
| `packages/web/src/components/agy/native/runtime/runtime-view-model.ts` | 前端新增 | 顶部运行态聚合（`waiting_background` / `requires_action` / `reconnecting` / `disconnected` / `cancelling` / `running` / `quiescent`）、Stop 目标/等待/结果三段状态机、诚实结果格式化 `formatHonestWorkOutcome`（杜绝渲染未证实成功） |
| `packages/web/src/components/agy/native/runtime/RuntimeStatusBanner.tsx` | 前端新增 | Native Runtime 顶部状态栏：等待有限后台 / 需要用户处理 / 重新连接校准 / 连接断开提示、独立有限阻塞 vs 常驻 Daemon 计数卡、分类保活标签 |
| `packages/web/src/components/agy/native/runtime/RuntimeStopPanel.tsx` | 前端新增 | 专属 Stop 面板：明确展示 1. 停止目标（Runtime / 有限命令 / Daemon / Activity + revision + generation）、2. 等待原生确认（宽限期）、3. 原生确认结果（`confirmed_cancelled` vs `unconfirmed_unknown` vs `disconnected` vs `error`），严格按能力门控禁用未授权动作 |
| `packages/web/src/components/agy/native/runtime/AgyNativeRuntimeCenter.tsx` | 前端新增 | 专属 Runtime Center 视图：融合顶部状态栏、待处理原生请求与只读收据、有限命令/常驻 Daemon/定时/未知工作项独立标识与过滤、`EvidenceDetails`、Stop 面板、用户轮次 vs `native-only` 唤醒活动切换与作用域隔离分页时间线 |
| `packages/web/src/components/agy/native/runtime/index.ts` | 前端新增 | `registerAgyNativeRuntimeView`（以 `order: 100`、`owner: 'np-04.runtime-center'` 注册至冻结的 `agyWorkbenchRegistry`，无侵入覆盖 NP-03 默认 `order: 900` 降级视图） |
| `packages/daemon/tests/agy-np04-reactive-runtime.test.ts` | 专属测试 | 10 项全覆盖测试：版本化 Codec & 补丁语义、T02（含 `reactive_not_observed` 缺口）、T03（合成 15min+ 超时与非零退出）、T04（并行 A/B 逆序 + Daemon D 不阻塞）、T05（双唤醒 + 晚工具更新 + `usage_update` 不重开 + `history_replay` 隔离）、T06（脱离轮次数字/字符串 RPC 权限 + NP-05/07 桩）、T08（Stop->next turn 旧响应隔离 + 并行 Steering + Cancel 确认与宽限超时 + `strictMode` 热重载）、T14（断连 `stale`/单次 `disconnected` 结算 + 换代栅栏）、旧 `agy-1.5.14` 兼容回放、真实 Daemon + `SessionManager` + `AgyNativeRuntimeRegistry` + Mock ACP 端到端集成 |
| `packages/web/tests/np04-runtime-center.test.tsx` | 专属测试 | 4 项前端专项测试：Workbench Registry `order=100` 覆盖与回收、顶部四种核心状态（等待/需用户/重连/断开）、不渲染未证实成功（`finished` 无 `outcome` 与 `unknown` 均不显示成功）、Stop 目标/等待/结果与能力门控边界 |

## 3. 已实现能力与未覆盖事项

### 3.1 已完成实现
1. **Per-ID Work 补丁与保活分离**：对 `finite_command`、`daemon`、`schedule`、`subagent`、`unknown` 建立按 `(originSession, toolCallId / backgroundTaskId)` 归并的状态机。`tool_call_update` 省略字段保留原值，显式 `null` 仅清理已知可空字段（`observedLabel`），重复终态幂等忽略，缺 `toolCallId` 记诊断不崩。`blocking: 'confirmed_blocking'` 与进程保活（`finite_work:*` / `daemon_observe:*` / `pending_request:*` / `cancel_grace:*`）独立计算；并行有限任务 B 先于 A 结束绝不释放 A 或提前结算轮次；常驻 Daemon 与定时任务绝不阻塞用户轮次。
2. **早 Prompt Response 持有与单次结算**：在 `onPromptSettled` 检测到活跃有限阻塞任务或待决请求时返回 `held(reasonIds)`；通过 `(runtimeId, generation, turnId)` 全局单次结算约束，在静默边界到期、取消确认、观测超时或传输断开时通过 `NativeTurnSettlementSink` 至多结算一次。
3. **晚帧归属与 `reactive_not_observed` 诚实保留**：
   - 仅真实 `channel === 'live'` 原生事件可开启活动；`history_replay` 完全隔离。
   - 纯晚 `tool_call_update` 仅更新既有工作项，不重开已结束用户轮次，也不误建新活动。
   - 有限任务结束后进入可验证的 `quiescenceWindowMs` 边界：收到新原生唤醒帧（新 `tool_call` / `agent_message_chunk` / `agent_thought_chunk` / `server_request`）归属同一 held turn；边界到期仍无唤醒则明确记录 `reactive_not_observed` 诊断缺口后再结算，绝不伪造唤醒。
   - 主轮次已结束后的真实原生唤醒开启 `turnId: null` 的 `native_continuation` / `native_task` 活动并链接 `priorActivityId`；单独的 `usage_update` 绝不重开会话或建新活动。
4. **Captured RPC Scope、Cancel Grace、断连、Warm LRU、Strict 与热重载**：
   - 按 `runtimeId|generation|connectionId|requestOrdinal|typedRpcId` 捕获每次 Prompt 上下文，阻断 Stop→Next Turn 旧响应污染，支持并行 Mid-turn Steering。
   - Stop 追踪目标与 `cancelGraceMs` 宽限期：宽限内收到原生 `cancelled` 确认终止；超时则标 `grace_expired_unknown` 并将未确认工作项降级为 `stale`，绝不伪造取消成功。
   - `handleTransportClosed` 幂等处理：仅确认观测结束，活跃工作项标 `stale`，待决审批标 `connection_lost`/`delivery_unknown`，held turn 单次结算为 `disconnected`。
   - `onWarmPoolEvictCheck` 拒绝驱逐持有活跃保活的句柄；`reloadConfig` 支持运行时热更新 `cancelGraceMs`、`quiescenceWindowMs`、`observationTimeoutMs`、`strictMode` 与 `retainWarmPoolForDetachedDaemons`。
5. **专属 Runtime Center 前端**：通过 NP-03 `agyWorkbenchRegistry` 以 `order=100` 注册，完整呈现顶部等待/需用户/重连状态、有限/Daemon 独立徽标、Stop 的目标/等待/结果与能力门控，绝不渲染模型/协议未证实的成功。

### 3.2 明确未覆盖事项（范围外或等待 G2 联调/授权）
- **真机 U01 20s 授权实采（`live_raw` / `live_hm` / `official_comparison`）**：按 `G0_Test_Profile.md`、`G1-final-966451c.md` 与 `G2_Launch_Plan.md`，U01 需用户在交互 PowerShell 中完成 `D:\HarnessMate\agy-np-test-profile\gemini` 的官方 OAuth 登录、确认实际广告的 Gemini 3.8 Flash 模型 ID 并手工键入 `YES` 及逐项审批；本自主开发会话遵守 U01 授权边界与零绕过原则，未越权执行交互登录或非授权 Prompt。
- **NP-05 真实 Child 身份与 NP-07 真实权限路由接线**：当前通过 `ReactiveChildIdentityStub`（默认保持 `unresolved`）与 `ReactivePendingRequestStub` / `createPermissionPortRequestStub` 契约桩解耦，待 G2 联合验收时由总指挥集中接入 `AgyNativeRuntimeRegistry.registerModules`。
- **共享 `wiring/**`、`app.ts` 与 Web 启动注册**：遵循文件所有权约定，不在 NP-04 分支修改共享入口，已将最小接线方案写入第 7 节协作请求。
- **Swarm / Boost / Teamwork / Dynamic / Goal 具体工作流状态与恢复扫描器**：归属 NP-08 至 NP-15。

## 4. 测试命令与结果

运行环境：Windows (`win32`)，临时目录固定在 D 盘（`$env:TEMP='D:\HarnessMate\np04-temp'`），依赖从 `D:\HarnessMate\agy-np-pnpm-store` 离线安装。所有检查均在代码提交 **`b0ffe2826f7355cb6296eb382c99e89f26a70149`** 上通过：

| 检查项 | 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- | --- |
| 全仓构建 | `pnpm build` | `0` | 6/6 workspace 包通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | build |
| 全仓类型检查 | `pnpm typecheck` | `0` | 6/6 workspace 包零错误 | static |
| 插件契约校验 | `pnpm contracts:check` | `0` | Plugin API 4.0.0 公开契约无漂移 | contract |
| Protocol 全量测试 | `pnpm --filter @harnessmate/protocol test` | `0` | **2 files / 6 tests passed** | `synthetic` |
| Web 全量测试（含 NP-04 Runtime Center 4 项） | `pnpm --filter @harnessmate/web test` | `0` | **14 files / 75 tests passed**（含 `np04-runtime-center.test.tsx` 4/4、`np03-workbench-ui.test.tsx` 7/7、`np03-native-client.test.ts` 14/14、`phase-agy-ui.test.tsx` 5/5） | `synthetic` |
| Daemon 全量测试（含 NP-04 10 项、AGY 1.5.14 回放与全套跨 Harness 回归） | `pnpm --filter @harnessmate/daemon exec vitest run --maxWorkers=2` | `0` | **34 files / 171 tests passed**（含 `agy-np04-reactive-runtime.test.ts` 10/10、`agy-lifecycle-events.test.ts` 5/5、`agy-replay-protocol.test.ts` 2/2、`agy-np-observatory.test.ts` 18/18、`agy-np02-*.test.ts` 9/9 及全套跨 Harness/插件/Handoff/Orchestrator 回归） | `synthetic` + `replay_with_provenance` |
| 空白与格式检查 | `git diff --check b5d010a..b0ffe28` | `0` | 0 空白符或冲突标记错误 | hygiene |

**总计：50 个测试文件 / 252 项自动化测试全部通过，0 失败。**

### 未执行的检查与原因
- **真机 U01 `--discover-confirmed` 与 `--reactive-confirmed`（20s 有限后台任务）**：未在本会话执行，原因：专用测试 Profile 需用户本人在交互式 PowerShell 终端完成官方登录、确认实际广告的 Gemini 3.8 Flash 模型 ID、键入 `YES` 并逐项检视原生审批权限（见 `docs/phase-agy-native-parity/handoffs/G0_Test_Profile.md` 与 `G2_Launch_Plan.md` 第 3 步）。

## 5. 验证类别、Capability ID 与真实证据/缺口

> **能力等级诚实声明**：本轮交付的全部新增验证属于 `synthetic` 与 `replay_with_provenance`，**不抬升 `02_Capability_Matrix.md` 中任何能力的真机等级**（`AGY-R03`–`AGY-R06`、`AGY-R10`、`AGY-S03`、`AGY-W11` 的真机等级仍维持 G1/G0 现状，待 G2 授权实机采样后由总指挥评定）。

| 证据 ID | 来源类别 | 关联 Capability ID | 路径 / 锚点 | 验证结论与边界 |
| --- | --- | --- | --- | --- |
| `NP04-E01` | `synthetic` | `AGY-R02`, `AGY-R04`, `AGY-R05` | `packages/daemon/tests/agy-np04-reactive-runtime.test.ts`（Codec & Patch 用例） | 验证 6 条版本化 Codec 规则溯源、status-only 补丁保留原分类/阻塞性、`null` 清空可空字段、重复终态幂等、缺 `toolCallId` 诊断、未知状态转 `unknown`、`strictMode` 禁用启发式及无 `exitCode` 不伪造 `succeeded` |
| `NP04-E02` | `synthetic`（基于 NP-01 场景夹具） | `AGY-R03`, `AGY-R04` | `agy-np04-reactive-runtime.test.ts`（T02 用例） + `fixtures/agy-np/t02-reactive-20s-wake.ndjson` | 验证早 Prompt 响应持有、20s 有限任务完成 + 原生只读工具 + 最终文本唤醒、单次 `NativeTurnSettlementSink` 结算、时间线可读；并验证无唤醒分支显式保留 `reactive_not_observed` 缺口 |
| `NP04-E03` | `synthetic` | `AGY-R03`, `AGY-R04`, `AGY-S03` | `agy-np04-reactive-runtime.test.ts`（T03 用例） | 虚拟时钟确定性验证 15min+ 观测超时转 `unknown`（不伪造完成）及非零退出（137）保留失败态 |
| `NP04-E04` | `synthetic`（基于 NP-01 场景夹具 + 真实 Daemon E2E） | `AGY-R03`, `AGY-R04`, `AGY-R05`, `AGY-W11` | `agy-np04-reactive-runtime.test.ts`（T04 + Live Daemon E2E 用例） + `fixtures/agy-np/t04-parallel-finite-and-daemon.ndjson` | 验证并行有限任务 A/B 逆序完成（B 不释放 A）、常驻 Daemon D 绝不阻塞轮次且独立保活、真实 `SessionManager` + SQLite + HTTP `/timeline` 闭环仅发 1 次 `turn.completed` |
| `NP04-E05` | `synthetic`（基于 NP-01 场景夹具） | `AGY-R03`, `AGY-R04` | `agy-np04-reactive-runtime.test.ts`（T05 / T06 用例） + `fixtures/agy-np/{t05,t06}-*.ndjson` | 验证双唤醒生成独立 `turnId: null` 活动并链 `priorActivityId`、纯晚 tool update 不开新活动、`usage_update` 不重开会话、`history_replay` 零污染、脱离轮次数字/字符串 RPC 权限保留与释放 |
| `NP04-E06` | `synthetic` | `AGY-R06`, `AGY-R10`, `AGY-S03` | `agy-np04-reactive-runtime.test.ts`（T08 / T14 用例） | 验证 Stop→Next Turn 旧 RPC 响应阻断、并行 Steering 不早结算、Cancel 宽限内确认 vs 超时转 `stale`/`unknown`、断连标 `stale` 且单次 `disconnected` 结算、换代栅栏与 `reloadConfig` 热调参 |
| `NP04-E07` | `replay_with_provenance` | `AGY-R02`, `AGY-R08`, `AGY-R09`, `AGY-W10` | `agy-np04-reactive-runtime.test.ts`（1.5.14 回放） + `fixtures/agy-1.5.14/session-full.ndjson` + `agy-replay-protocol.test.ts` | 验证既有 AGY 1.5.14 夹具在原生运行时与传统回放路径均 100% 兼容，无任何回归 |
| `NP04-E08` | `synthetic` | `AGY-R03`, `AGY-R04`, `AGY-R05`, `AGY-R10`, `AGY-W11` | `packages/web/tests/np04-runtime-center.test.tsx` | 验证前端 `order=100` 覆盖注册、顶部等待/需用户/重连/断开状态、有限 vs Daemon 独立标识、不展示未证实成功、Stop 目标/等待/结果与能力门控 |

### 真实证据缺口与层级归因摘要
- **已知 HM 基线故障点（已由 NP-04 模块在领域层修复，待 G2 共享接线启用）**：
  1. `S04` / `E08` 早 Prompt 响应直接结算 -> 由 `onPromptSettled` 阻塞集合判定 + `NativeTurnSettlementSink` 单次结算闭环修复。
  2. `S05` 晚帧流入 `turn_bg`/`turn_unknown` -> 由 held turn 唤醒归属 + `turnId: null` native-only activity 分段修复。
  3. `S06` 单布尔后台保活（A/B 互清、Daemon 刷新 TTL、status-only 漏识别）-> 由 `ReactiveWorkTracker` per-ID 合并与阻塞/保活分离修复。
  4. `S04` Stop→Next Turn 旧响应串台 -> 由 captured RPC scope (`buildPromptScopeKey`) + `isCurrentTurn` 栅栏修复。
- **仍待真机确认的上游缺口**：真实 Windows AGY `1.5.16`/`1.5.17` 在 Gemini 3.8 Flash 下执行 20s 有限后台命令时，ACP raw 流是否稳定发出 `tool_call_update` 与后续 wake 帧，还是存在上游 `reactive_not_observed`。待用户在交互终端完成 U01 登录后按 `G0_Test_Profile.md` 单次采样核实。

## 6. 数据与其他 Harness 回归结论

- **数据隔离与兼容性**：未新增或修改 SQLite 迁移（沿用 NP-02 组件版本 `agy-native-runtime = 1`），`enabled: false` 下零原生写入；旧会话、旧 `sessions.last_seq` 与 Context Handoff 水位均未受影响；所有临时测试文件均位于 D 盘 `D:\HarnessMate\np04-temp`。
- **跨 Harness 与核心回归**：全量 252 项测试中，Codex (`adapters-codex.test.ts` 5/5)、Claude (`adapters-claude.test.ts` 4/4)、Strict ACP (`adapters-acp.test.ts` 4/4)、DeepSeek & OpenCode (`phase3-external-adapters.test.ts` 5/5)、Context Handoff V2 (`handoff-v2.test.ts` 12/12)、Multi-Harness Orchestrator (`multi-harness-orchestrator.test.ts` 6/6)、Usage Failover (`usage-failover.test.ts` 3/3)、Git Checkpoints、Terminal Workspace、Approval Center 与 Plugin SDK V4/V5 全部 **0 回归**。

## 7. 冲突声明与协作 / 接线请求（G2 联合集成）

当前 **零文件冲突**。按 `G2_Launch_Plan.md` 与 `13_Git_Collaboration.md` 所有权边界，向各 owner 提交如下精确接线建议：

1. **致 NP-02 / 总指挥（共享接线 `server/app.ts` 与 `SessionManager.interruptSession`）**：
   - 在 `createDaemon`（`packages/daemon/src/server/app.ts`）中实例化 `AgyReactiveRuntimeController`（传入 `publisher: nativeRegistry`，待 NP-07 合入后传入 `pendingRequestStub: createPermissionPortRequestStub(permissionPort)`）并调用 `nativeRegistry.registerModules({ lifecycle: reactiveController, timelineReader: reactiveController })`，保持 `DEFAULT_AGY_NATIVE_FEATURE_FLAGS` 默认关闭直到 G2 门禁通过。
   - **可选改进提案（附验证路径）**：当前 `SessionManager.interruptSession` 在调用 `notifyCancelRequested` 后立即调用 `handle.interrupt()` 并同步写入 `turn.cancelled` 与删除 `activeTurnMeta`。在 G2 开启 `nativeLifecycle` 时，建议对存在 held turn 的会话支持优先通过 `onCancelRequested` + `cancelGraceMs` 等待原生取消确认，超时后再经 `NativeTurnSettlementSink` 结算（避免在宽限期内过早将旧会话状态切回 `idle`）。
2. **致 NP-03b / 总指挥（前端工作台注册）**：
   - 在开启 `agyNativeWorkbenchEnabled` 的工作台初始化入口调用 `registerAgyNativeRuntimeView()`（导出自 `packages/web/src/components/agy/native/runtime`），即可自动以 `order: 100` 替换默认 `order: 900` 视图。
3. **致 NP-05（Child Identity）**：
   - G2 联调时，将 NP-05 的权威 child 解析函数注入 `AgyReactiveRuntimeControllerOptions.childIdentityStub`，替换默认的 `DEFAULT_UNRESOLVED_CHILD_STUB`，实现 `NativeWork.ownerAgentId` 与 `NativeRequestSummaryDto.agentId` 的确证归属。
4. **致 NP-06（Native Command Router）**：
   - 在 `POST /api/v1/sessions/:id/native/control` 处理 `action: 'cancel' | 'stop'` 时，对已证实可控目标转发 `session/cancel` 并调用 `nativeRegistry.notifyCancelRequested(binding, request.target)`，与 NP-04 `RuntimeStopPanel` 的 `target / waiting / result` 展示完全闭环。
5. **致 NP-07（Native Approvals）**：
   - G2 联调时将 `NativePermissionPort` 通过 `createPermissionPortRequestStub(permissionPort)` 注入 NP-04，并在审批状态流转时推送 `NativeObservation`（`kind: 'request_changed'`），确保脱离轮次的审批与有限后台任务共享一致的保活与 `requires_action` 状态。
6. **致 NP-15（Recovery）**：
   - 重连或恢复扫描完成时调用 `onReconnect(binding, mode)` 并可通过 `acceptNativeObservation({ kind: 'work_upsert', ... })` 灌入经验证的快照状态；断连产生的 `stale` 与 `uncertainEntityIds` 已通过 `native.recovery.changed` 落盘供恢复模块消费。

## 8. 审查者快速核验入口与回滚命令

### 8.1 审查者快速核验命令
```powershell
$env:TEMP = 'D:\HarnessMate\np04-temp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP

git diff --name-status b5d010ae74815a311d98090359b9d62894973024..b0ffe2826f7355cb6296eb382c99e89f26a70149
git diff --check b5d010ae74815a311d98090359b9d62894973024..b0ffe2826f7355cb6296eb382c99e89f26a70149
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np04-reactive-runtime.test.ts tests/agy-lifecycle-events.test.ts tests/agy-replay-protocol.test.ts
pnpm --filter @harnessmate/web exec vitest run tests/np04-runtime-center.test.tsx tests/np03-workbench-ui.test.tsx
```

### 8.2 回滚方案与命令
1. **优先功能门控无损回退（保留原生历史只读）**：
   - 后端保持或切回 `DEFAULT_AGY_NATIVE_FEATURE_FLAGS`（`enabled: false`, `nativeLifecycle: false`）；
   - 前端保持或切回 `agyNativeWorkbenchEnabled = false`（清除 `localStorage['hm_agy_native_ui']`）或调用 `registerAgyNativeRuntimeView()` 返回的 `dispose()` 退回默认视图。
   - 既有 SQLite 原生历史表不受影响，仍可只读访问；共享接线回滚由 NP-02 统一管理。
2. **代码提交回滚**：
   ```powershell
   git revert --no-edit b0ffe2826f7355cb6296eb382c99e89f26a70149
   ```
   若已通过 merge commit `<mergeSha>` 合入集成分支：
   ```powershell
   git revert -m 1 <mergeSha>
   ```
