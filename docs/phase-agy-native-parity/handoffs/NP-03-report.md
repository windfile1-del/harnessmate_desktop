# NP-03 独立开发交接报告 · AGY 工作台与通用前端投影

> 本报告按 `docs/phase-agy-native-parity/tasks/NP-03-frontend.md`、`handoffs/README.md` 与 `12_Test_Strategy.md` 编写，供总指挥与独立审查者核验。`MASTER_PROGRESS.md` 未作修改，由总指挥统一更新。

## 1. 基线、分支与提交

| 项 | 值 |
| --- | --- |
| 任务 ID | NP-03（包含 **03a 完整实现** 与 **03b 前端客户端/Store/投影架构 + stub 接线**） |
| 阶段状态 | **Mock / Stub 阶段**（等待 NP-02 G1 后端路由与 `@harnessmate/protocol` 冻结导出后切入 Connected 阶段） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039` |
| Reviewed Base（G0 快照） | `a01280176348974a0ddc00fd491afddc1d985c9e` (`docs(agy-np): record G0 worktree and verification setup`) |
| 工作分支 | `np03_agy_workbench`（Worktree：`C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np03_agy_workbench`，可按总指挥集成策略 cherry-pick / fast-forward 至 `codex/agy-np-03-frontend`） |
| 核心代码提交 SHA | `fd855ee3af4e433650a447c5423bc015e4acc304`（初始实现）· `a662bcb78d52f60cafd9fe580ac2f60198e61444`（03a R4 独立修复）· `f012d66ddae1fd891582c5868eb34f13d41311e0`（03b R1/R2/R3/R5 独立修复） |
| 特性门控默认值 | `agyNativeWorkbenchEnabled = false`（通过 `localStorage['hm_agy_native_ui'] === '1'` 或 store action 显式开启；G2 前默认关闭，完整保留既有 AGY-5 组件与旧客户端体验） |

## 1.1 针对独立评审（`NP-03-review-fb91c9c.md`）的逐项修复

| 评审项 | 对应提交 | 修复要点与回归验证 |
| --- | --- | --- |
| **R4 · 03a 窄屏焦点、方向键选项卡与全宽焦点回返** | `a662bcb` | 新增 `focus-utils.ts`；窄屏 `role="dialog"` 打开后立即将焦点移入关闭按钮，监听 `Tab`/`Shift+Tab` 环绕与 `document` `focusin` 拦截，并在 `ChatStage` 背景聊天列设置 `inert` + `aria-hidden` 阻止背景控件获焦；`ArrowLeft`/`ArrowRight`/`Home`/`End` 同步切换选中态与实际 DOM `focus()`（经 `tabRefs` 与 `pendingTabFocusRef` 保障）；全宽→聊天通过 `pendingWorkbenchFocusRestoreRef` 在顶栏重挂载后回返触发按钮；`Escape` 跳过 IME、已消费事件、嵌套 `listbox/menu` 及外部顶层 modal。 |
| **R1 · 03b 事件同步、缺口与旧代绑定回退** | `f012d66` | `applyNativeEventBatch` 严格要求 `runtimeId + generation` 一致并按 `retiredGenerations` 拒绝旧代 `native.runtime.changed` 回退（如 seq 1 旧绑定帧直接丢弃）；`NativeFeedController` 新增 `requestEpoch` 防乱序覆盖、保留 `hydrate()` 前队列并在补缺后排空、以 `pendingAfterGap` 保留缺口后缀并在前缀补齐后重放；分页缺口、补缺空页或触达 `maxPages` 上限时进入 `phase: 'incomplete'`（展示「数据未完成同步」+ 重试入口），绝不误标 `'live'`。 |
| **R2 · 03b 作用域回执、意图幂等键与草稿/附件一致性** | `f012d66` | `submitNativeCommand` 仅在 `{sessionId, instanceId, runtimeId, generation, catalogRevision, capabilityId, actionKey, canonicalArgs}` 完整意图一致时复用幂等键，不同 prompt 分配不同 key；引入 `nativeScopeEpochBySession` 与 `nativeGlobalScopeEpoch`，清会话/切会话/切账号/登出/关门控后迟到回执被忽略且绝不重建 slice；`NativeControlMenu` 携带渲染时 `expectedBinding`，过期代次返回 `409 STALE_BINDING`；`ChatStage` 原生模式提交携带 `attachmentIds`/`terminalContextIds`，仅清理本次实际发出的草稿与附件，保留提交期间新增或编辑项。 |
| **R3 · 03b 时间线作用域隔离、Delta 合并与旧事件可见性** | `f012d66` | `AgyWorkbenchShell` 抽出 `useScopedNativeTimeline`（供 Runtime Center 与 Subagent Manager 共用，补齐子 Agent 分页），按 `runtimeId:generation:kind:id` 切项时立即清空旧条目并中止首屏与 `loadMore` 请求；`app-store` 提供 `loadNativeTimeline`/`loadNativeWorkflowResource` 统一走注入 transport，`ChatStage` 与 `PluginSlotSync` 用稳定回调引用；`coalesceTimelineEntries` 记录 `mergedEntryIds` 且校验 `actorKind + actorId`，杜绝重复 delta 追加成 `abb` 或跨 Agent 串并；`ChatStage` 仅在存在健康 `live` 原生投影时隔离 `turn_bg`/`turn_unknown`，并渲染可展开 `detached-native-fallback` 保障旧记录随时可读。 |
| **R5 · G1/G2 契约边界加固** | `f012d66` | `createHttpNativeTransport` 新增运行时响应结构校验（非法响应抛 `INVALID_RESPONSE`）；统一 `ChatStage` 全宽与分栏/窄屏两处 `AgyWorkbenchShell` 组装 props。真实协议冻结类型、WS 实时订阅闭环与原生控制放开仍严格保持 G1/G2 门控，不抬升真机能力等级。 |

## 2. 变更路径与写入范围核对

全部修改严格落在 NP-03 许可写入范围内，**未触碰** `packages/daemon/**`、`packages/protocol/**`、`packages/plugin-api/**`、`MASTER_PROGRESS.md` 或任何领域专属子目录（`swarm/`、`boost/`、`teamwork/`、`dynamic/`、`goal/`）。

### 新增文件
- `packages/web/src/lib/native-client.ts` — 前端 Native Runtime DTO 镜像、HTTP/Stub 传输层、`NativeFeedController`（快照 + 分页补缺 + `410 RESYNC_REQUIRED` + generation 栅栏 + seq gap 修复 + 批处理刷新）、`applyNativeEventBatch` 纯函数投影、`coalesceTimelineEntries` 文本 delta 合并与幂等 key 工具
- `packages/web/src/components/agy/native/shared/status-dictionary.ts` — 版本化状态字典（`STATUS_DICTIONARY_VERSION = 1`），显式区分 `idle`/`finished`/`succeeded`、`known`/`stale`/`unknown`、`confirmed_blocking`/`detached` 与空态文案（「尚未观察到活动」vs「该来源不提供」）
- `packages/web/src/components/agy/native/shared/workbench-registry.ts` — 冻结工作台注册表（`WORKBENCH_REGISTRY_CONTRACT_REVISION = '1.0-np03'`）、稳定 `NativeWorkbenchViewProps`、按 HM opaque ID 的 session-scoped route hash 序列化/解析
- `packages/web/src/components/agy/native/shared/EntityStatusBadge.tsx` — 无障碍状态徽标（图标 + 文本 + 辅助色，无高频 `aria-live` 抖动）
- `packages/web/src/components/agy/native/shared/EvidenceDetails.tsx` — 可折叠字段级 provenance 查看器（仅展示白名单 `sourceKind`/`freshness`/`observedAt`/`reasonCode`/`evidenceRefs`，绝不展示私有路径/token）
- `packages/web/src/components/agy/native/shared/CapabilityUnavailable.tsx` — 诚实降级与边界组件（`unknown`/`unsupported`/`upstream_limited`/`not_tested` + 刷新/只读回退/官方入口指引）
- `packages/web/src/components/agy/native/shared/NativeActivityLink.tsx` — 主聊天内嵌原生活动/续跑/后台任务锚点卡
- `packages/web/src/components/agy/native/shared/NativeTimeline.tsx` — 分页 + 虚拟窗口时间线（`computeVirtualWindow`，支持键盘 `ArrowUp`/`ArrowDown`/`Home`/`End` 与 10k 级条目有界 DOM 渲染）
- `packages/web/src/components/agy/native/shared/NativeControlMenu.tsx` — 证据门控原生控制菜单（仅在 `control === 'available'` 且动作 `gate === 'available'` 时开放）
- `packages/web/src/components/agy/native/shared/NativeRequestCard.tsx` — 共享 Approval 数据 + 原生收据/作用域卡片（确证 child 归属跳转、未确认来源明示、禁止代选或以自由文本填固定选项、断连/崩溃只读收据）
- `packages/web/src/components/agy/native/shared/AgyAgentModePicker.tsx` — 输入区单一工作模式选择器（未验证 Profile 可看说明不可运行、保留草稿与附件、选定不自动执行、仅点击发送走命令提交）
- `packages/web/src/components/agy/native/shared/AgyWorkbenchShell.tsx` — 统一工作台 Shell（分栏/全宽/480px 窄屏全宽 `role="dialog"` 抽屉 + 焦点进入/限制/回返 + 键盘 `ArrowLeft`/`ArrowRight`/`Home`/`End`/`Escape`、`useScopedNativeTimeline` 作用域隔离分页、内置 order=900 诚实降级视图）
- `packages/web/src/components/agy/native/shared/focus-utils.ts` — 03a 窄屏焦点环绕、背景焦点拦截、选项卡方向键索引与嵌套弹窗 Escape 判定纯函数工具
- `packages/web/src/components/agy/native/shared/fixtures.ts` — 脱敏合成测试夹具（Live Reactive、Unknown、Stale/Reconciling、Crashed/Disconnected、Unsupported/Upstream-Limited Studios、T18 100 child / 10k events / 20 pending 压测生成器及 `createStubNativeTransport`）
- `packages/web/src/components/agy/native/shared/index.ts` — 公共导出入口
- `packages/web/tests/np03-native-client.test.ts` — 客户端分页、`410 RESYNC_REQUIRED`、generation 栅栏、seq gap、delta 合并、409 草稿保留、账号切换清理、placeholder 隔离与 T18 压测
- `packages/web/tests/np03-workbench-ui.test.tsx` — 门控默认关闭回归、5 类夹具渲染、Studio 注册覆盖与回收、窄屏/无障碍/虚拟化 10k DOM 验证、模式/控制门控与 `ChatStage` 集成

### 修改文件（均在 NP-03 单一所有权内）
- `packages/web/src/lib/projector.ts` — 新增可选 `options?: { isolateNativePlaceholders?: boolean }`（默认 `false`），开启时将 `turn_bg`/`turn_unknown` 从聊天时间线隔离至 `detachedNativeEvents`
- `packages/web/src/stores/app-store.ts` — 新增 `agyNativeWorkbenchEnabled`（默认 `false`）、`nativeRuntimeBySession` 与全套 scoped actions；在 `selectSession` / `switchHarness` / `deleteSession` / `agy_auth_state` 登出时自动取消旧请求并清理旧状态
- `packages/web/src/components/ChatStage.tsx` — 门控开启时接入顶栏 Native Runtime 摘要触发器（含焦点回返 ref）、内嵌 `NativeActivityLink`、分栏/全宽/窄屏 `AgyWorkbenchShell`、忙碌草稿保留与命令提交反馈、placeholder 隔离
- `packages/web/src/App.tsx` — 门控开启且当前为 AGY 会话时增加 `Alt+Shift+A` / `Ctrl+Shift+G` 快捷键切换工作台（遵守 IME 组合与弹窗优先）
- `packages/web/src/components/agy/AgyComposerControls.tsx` — 保留既有 AGY-5 徽标与手动账号切换；门控开启时内嵌 `AgyAgentModePicker`
- `packages/web/src/components/agy/AgyStudioBlocks.tsx` — 保留全部 5 类 AGY-5 块；门控开启时增加工作台直达按钮
- `packages/web/src/slots/PluginSlotSync.tsx` — 保留全部既有插槽；门控开启时注册 `inspector.tabs` (`agy-native-runtime`) 与 `session.sidebar.badge` (`agy-native-runtime-badge`)

## 3. 冻结的前端契约版本与接入示例

- **Native DTO / Client 契约修订**：`NATIVE_FRONTEND_CONTRACT_REVISION = '0.1-np03-stub'`（对齐 `08_Shared_Contracts.md` v0.1，`schemaVersion: 1`）
- **Workbench Registry 契约修订**：`WORKBENCH_REGISTRY_CONTRACT_REVISION = '1.0-np03'`
- **Status Dictionary 版本**：`STATUS_DICTIONARY_VERSION = 1`

### 领域 Studio（NP-04/05/08/09/10/11/12）接入示例
```ts
import { agyWorkbenchRegistry } from '../shared';

const dispose = agyWorkbenchRegistry.registerView({
  id: 'swarm', // 'runtime' | 'subagents' | 'swarm' | 'boost' | 'teamwork' | 'dynamic' | 'tasks'
  owner: 'np-08.swarm-studio',
  title: 'Swarm Studio',
  shortTitle: 'Swarm',
  description: 'Verified Swarm coordinator, workers, and Board view',
  capabilityIds: ['AGY-W04', 'AGY-W05'],
  order: 100, // < 500 overrides the built-in order=900 degraded shell
  render: (props) => <SwarmStudioView {...props} />,
});
```

## 4. 验证类别、Capability ID 与测试结果

> **等级声明**：本轮全部新增测试属于 `synthetic`（合成夹具/桩传输）与既有 `replay_with_provenance`（离线 AGY 1.5.14 回放）。**不构成 L2/L3/L4/L5 实机证据，不抬升任何 Capability 矩阵等级。**

### 覆盖的能力视图与边界（UI/契约层）
`AGY-R03`、`AGY-R04`、`AGY-R05`、`AGY-R08`、`AGY-R09`、`AGY-R10`、`AGY-S03`、`AGY-W01`、`AGY-W02`、`AGY-W04`、`AGY-W05`、`AGY-W06`、`AGY-W07`、`AGY-W08`、`AGY-W09`、`AGY-W10`、`AGY-W11`

### 执行命令与结果
| 检查项 | 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- | --- |
| 全仓构建 / Web 生产构建 | `pnpm build`（首轮全仓）· `pnpm --filter @harnessmate/web build`（修复后复跑） | `0` | 6 个包及修复后 Vite 生产构建通过 | build |
| Web 类型检查 | `pnpm --filter @harnessmate/web typecheck` | `0` | 修复后零错误通过 | static |
| 插件契约校验 | `pnpm contracts:check` | `0` | Plugin API 4.0.0 公开插槽与 manifest 契约无漂移 | contract |
| Web 全量单测（含 NP-03 全部 R1–R4 回归） | `pnpm --filter @harnessmate/web test` | `0` | **13 files / 67 tests passed**（含 `np03-native-client.test.ts` 10 项、`np03-workbench-ui.test.tsx` 7 项、`phase-agy-ui.test.tsx` 5 项、`projector.test.ts` 3 项、`ui-slots.test.tsx` 4 项及全部 phase2/3/4 回归） | synthetic |
| Protocol 单测 | `pnpm --filter @harnessmate/protocol test` | `0` | **1 file / 1 test passed** | synthetic |
| Daemon 关键回归（含 AGY 1.5.14 回放与其他 Harness） | `pnpm --filter @harnessmate/daemon test -- --maxWorkers=2 tests/session-explorer-approval.test.ts tests/phase3-external-adapters.test.ts tests/agy-replay-protocol.test.ts` | `0` | **3 files / 14 tests passed**（Codex/Claude/DeepSeek/OpenCode/Session Explorer/Approval Center/AGY 1.5.14 回放全通） | replay_with_provenance + synthetic |
| 空白/格式与作用域核对 | `git diff --check` | `0` | 无尾随空白或冲突标记，全部变更均在 NP-03 范围 | hygiene |

### 未执行项与原因
1. **真机 AGY 1.5.16 Live / Browser 交互截图验收（L2–L5）**：NP-02 G1 后端 `/api/v1/sessions/:id/native/*` 路由尚未合入且 U01 专用测试 Profile 尚未完成官方登录，按要求保留 `agyNativeWorkbenchEnabled = false` 门控并仅提交脱敏夹具与 SSR/状态自动化证据。
2. **全量 `packages/daemon` 并发压跑**：在同时并发运行全部 workspace Vitest 时，`packages/daemon` 中 4 个高 IO/进程测试文件触发了 5s/8s 调度超时；以 `--maxWorkers=2` 独立复测 `session-explorer-approval.test.ts`、`phase3-external-adapters.test.ts` 与 `agy-replay-protocol.test.ts` 全部通过（NP-03 未修改任何 daemon 代码）。

## 5. 给 NP-02 与领域 Owner 的协作请求 / 变更提议

1. **致 NP-02（G1 契约冻结提案）**：
   - 建议 `@harnessmate/protocol` 导出 `NativeRuntimeProjection`、`NativeCanonicalEvent`、`CapabilityDescriptor`、`NativeRequestReceiptDto` 及 `NativeTimelinePageResponse` 时，保留 `NativeRuntimeProjection.receipts?: Record<string, NativeRequestReceiptDto>` 与 `NativeRequestReceiptDto.targetLineage: 'confirmed' | 'unconfirmed'` 字段，以便前端 `NativeRequestCard` 直接区分确证 child 归属与未确认作用域，无需二次猜解。
   - 建议 `/api/v1/sessions/:id/native/events` 在 cursor 失效时返回 HTTP `410` 且 body 带 `{ code: 'RESYNC_REQUIRED' }`，`/commands` 在绑定代际或状态冲突时返回 HTTP `409` 且 body 带 `{ code: 'STALE_BINDING' | 'BUSY' }`；前端 `native-client.ts` 已按此约定完成分类与自动恢复。
   - 建议 WS 协议在 `WsServerFrame` 中增加 `{ op: 'native_event', sessionId, event: NativeCanonicalEvent }`（或批量帧），合入后 NP-03b 仅需在 `app-store.ts` `onFrame` 中调用 `get().applyNativeEvents(frame.sessionId, [frame.event])` 即可打通实时推送。
2. **致 NP-04 / NP-05 / NP-07 / NP-08–NP-12**：
   - 请通过 `packages/web/src/components/agy/native/shared/workbench-registry.ts` 注册专属视图（`order < 500`），避免直接修改 `ChatStage.tsx` 或 `app-store.ts`。
   - 复用的状态徽标、证据展开、不可用降级卡片、虚拟时间线、控制菜单与审批卡均已从 `components/agy/native/shared/index.ts` 导出。
3. **致 NP-16**：
   - `createStressFixture({ agentCount: 100, eventCount: 10_000, pendingRequestCount: 20 })` 与 `np03-native-client.test.ts` / `np03-workbench-ui.test.tsx` 中的 T18 基准用例可直接并入 G4 性能回归门禁。

## 6. 审查者核验入口

- **证据 ID**：`SYNTH-NP03-REACTIVE`、`SYNTH-NP03-STOP`、`SYNTH-NP03-CHILD`、`SYNTH-NP03-SWARM`、`SYNTH-NP03-BOARD`、`SYNTH-NP03-BOOST`、`SYNTH-NP03-TEAMWORK`、`SYNTH-NP03-DYNAMIC`、`SYNTH-NP03-GOAL`、`SYNTH-NP03-SCHEDULE`、`SYNTH-T18-STRESS`（均位于 `packages/web/src/components/agy/native/shared/fixtures.ts`）
- **核验命令**：
  ```powershell
  git diff --name-status a01280176348974a0ddc00fd491afddc1d985c9e...HEAD
  git diff --check a01280176348974a0ddc00fd491afddc1d985c9e...HEAD
  pnpm --filter @harnessmate/web typecheck
  pnpm --filter @harnessmate/web test
  pnpm contracts:check
  ```

## 7. 回滚方案

1. **零代码回滚（特性门控）**：确保 `localStorage.removeItem('hm_agy_native_ui')`（默认即关闭），或调用 `useAppStore.getState().setAgyNativeWorkbenchEnabled(false)`，即可完全回到 AGY-5 既有组件与旧 projector 行为。
2. **Git 提交回滚**：
   ```powershell
   git revert f012d66ddae1fd891582c5868eb34f13d41311e0 a662bcb78d52f60cafd9fe580ac2f60198e61444 fd855ee3af4e433650a447c5423bc015e4acc304
   ```
   本次变更不涉及 SQLite 表迁移或数据结构变更，回滚零数据风险。
