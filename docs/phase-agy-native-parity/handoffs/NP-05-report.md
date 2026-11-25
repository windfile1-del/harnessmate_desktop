# NP-05 交付报告 · 原生子 Agent 身份与会话路由

日期：2026-11-25（Asia/Shanghai）。本报告供总指挥与独立审查者核验。`MASTER_PROGRESS.md` 保持未改，由总指挥统一维护。

## 1. 基线、分支与交付提交

| 项 | 值 |
| --- | --- |
| 任务包 | NP-05 原生子 Agent 身份与会话路由 |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039` |
| G1 已审开工点 | 本地标签 `agy-np-g1`（`b5d010ae74815a311d98090359b9d62894973024`，含已审源码 `966451ceaa2d8cfbf268b05a973dbb400715b616`） |
| 实际分支 | `np05_native_child_agent_routing`（平台分配分支；任务卡建议名为 `codex/agy-np-05-child`） |
| 实际 D 盘 Worktree | `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np05_native_child_agent_routing`（经 `.gemini` junction 访问） |
| 代码交付提交 | `a7daccf688bad99ce9dd22f53b14246fe7a5afa4`（`feat(agy-np-05): implement native child identity routing, versioned parser, and Subagent Manager`） |
| 报告提交 | 本报告随独立 `docs(agy-np-05)` 提交附后 |

## 2. 实际变更路径与公共契约版本

严格限定于 NP-05 允许写入范围，未修改 `packages/protocol/src/**`、`native/wiring/**`、`core/**`、`db/sqlite.ts`、`server/app.ts`、`native/shared/**`、`AgyStudioBlocks.tsx`、`ChatStage.tsx` 与 `MASTER_PROGRESS.md`：

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/child/contracts.ts` | NP-05 / NP-07 共享 child scope 路由契约（`CHILD_SCOPE_CONTRACT_REVISION = 'agy-np05-child-scope-v1.0.0'`）、`ChildScopeResolverPort`、`ChildScopeResolution`、`ChildAgentCapabilities`、`decideAcpChildClientCapabilities` 与冻结测试桩 `createFrozenChildScopeResolverStub` |
| `packages/daemon/src/harnesses/agy/native/child/record-parser.ts` | 版本化只读子 Agent 记录解析器（`app_v1` 对齐 E06 真实 App shape + `cli_legacy_v0`）、schema 门控过期（`staleTtlMs`）、有界目录/文件/深度扫描、Windows reparse/symlink + `fstat` 句柄身份复核、隐私脱敏，以及**绝不回退父 `logs/transcript.jsonl`** 的 `readChildOwnedTranscriptOnly` |
| `packages/daemon/src/harnesses/agy/native/child/child-session-router.ts` | `ChildSessionRouter`（同时实现 `ChildScopeResolverPort` 与 `NativeTimelineReaderPort`）：严格隔离 `tool_call` / `native_record` / `session` 三类命名空间、单父无环校验、嵌套子 Agent、同名角色不同原生 ID 独立映射、child `idle -> running` 复跑、有界 unowned 缓冲与 timeline 缓冲、入口序/稳定 ID 去重（不按纯文本去重）、跨 profile / 过期 generation / 冲突拒绝、`child.capabilities.canCancel` 取消门控与 `AgyNativeRuntimeRegistry` 持久化提交 |
| `packages/daemon/src/harnesses/agy/native/child/index.ts` | 后端子域导出入口 |
| `packages/daemon/src/harnesses/agy/agy-child-work.ts` | 保持 `listAgySubagentRecords` / `readAgySubagentDetail` 兼容签名，底层切换为版本化安全 parser，移除 S09 缺陷（不再回退父 `logs/transcript.jsonl`） |
| `packages/web/src/components/agy/native/child/child-tree.ts` | 纯投影树视图模型（父子树、面包屑、委派批次拆分、严格危险控件门控 `resolveSafeChildControlCapability`），不在前端映射 `toolId -> recordId` |
| `packages/web/src/components/agy/native/child/ChildTimelinePanel.tsx` | 独立子时间线组件（`AbortController` 切页取消、切代即时清旧、明确只读来源标记、无模拟 child steer/prompt 输入） |
| `packages/web/src/components/agy/native/child/SubagentManagerView.tsx` | Subagent Manager 工作台页：返回主 Agent 按钮、祖先面包屑、父子树、筛选器、委派批次区、子项待审批卡、受控 `NativeControlMenu` 与独立子时间线，兼容 480px 窄屏 |
| `packages/web/src/components/agy/native/child/register.ts` | 以 `owner: 'np-05'`、`order: 200` 注册 `subagents` 视图（覆盖 `order: 900` 降级壳） |
| `packages/web/src/components/agy/native/child/index.ts` | 前端子域导出入口 |
| `packages/daemon/tests/agy-np05-child-routing.test.ts` | 7 项后端专项测试（共享 NP-05/NP-07 签名与桩、ACP 扩展门控、T06/T07/T15、E06 `app_v1` / `cli_legacy_v0` / 未知版本、无父轨迹回退、Windows junction 与隐私脱敏、真实 SQLite `AgyNativeRuntimeRegistry` 集成） |
| `packages/web/tests/np05-subagent-manager.test.tsx` | 4 项前端专项测试（Workbench 注册覆盖、父子树/同名双 child/嵌套孙节点/面包屑/批次、未知/冲突/只读快照/断连危险控件禁用、完整渲染与无数据降级） |

**依赖契约版本**：
- `@harnessmate/protocol`：`AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（`schemaVersion = 1`）
- SQLite 迁移组件：`agy-native-runtime` version `1`（无新增迁移）
- NP-05 / NP-07 共享 child scope 契约：`CHILD_SCOPE_CONTRACT_REVISION = 'agy-np05-child-scope-v1.0.0'`
- NP-03 Workbench 注册契约：`WORKBENCH_REGISTRY_CONTRACT_REVISION = '1.0-np03'`

## 3. 已实现与未覆盖 / 范围排除项

### 已实现
1. **三类 ID Namespace 严格隔离**：`tool_call`（指向 `WorkId`）、`native_record`（指向受管目录记录）、`session`（指向原生会话/对话 ID）各自建键；`invoke_subagent` 在未获确证 child session ID 前保持 `lineage: 'unresolved'` 且不建父边。
2. **共享 NP-05 / NP-07 作用域解析**：`resolveScope()` 始终保持 `actualWireSessionId` 为外层真实 JSON-RPC 发送方；当 AGY 1.5.16+ 经父会话转发子请求时，返回 `matchKind: 'forwarded_parent_with_inferred_child'`、`forwardedViaParent: true`、`targetAgentId: rootAgentId`，并用 `displayOwnerAgentId` 单独标注经验证的归属子 Agent。
3. **版本化只读解析器与安全边界**：支持 E06 实证 App 结构（`conversationId` / `subagentDescriptor` / `state` / `spawnStepIndex` / `workspaceUris`，公开 DTO 隐藏 `workspaceUris` 与原始路径）及 `cli_legacy_v0`；遇到未知顶层字段或未来 `schemaVersion` 立即 fail closed；目录扫描数、单文件 256 KiB、JSON 嵌套深度、unowned 缓冲与 timeline 缓冲均有硬上限；文件打开后做 `fstatSync` 句柄身份核验以防 Windows reparse/TOCTOU 替换；绝不回退父 `logs/transcript.jsonl`。
4. **生命周期与图不变量**：拒绝自环、祖先环、多父冲突、深度越界、跨 profile/source 与过期 generation；child 进入 `idle` 不视为 `finished`/`succeeded`，后续帧可原 ID 复跑；切代或断连立即撤销 live `canCancel` 并将活跃态降为 `stale`，历史代保持只读可查。
5. **ACP 扩展与取消能力门控**：`decideAcpChildClientCapabilities()` 仅在 feature + router + permission scope + timeline buffer 全接线时声明子扩展（v2 需显式开启 `acpV2PreviewEnabled`）；`authorizeChildCancel()` 仅在 confirmed + live 连接 + `child.capabilities.canCancel === true` 时放行。
6. **Subagent Manager 前端**：提供返回主 Agent、面包屑、父子树、批次、独立子时间线、来源与需操作标识；对未知/冲突/只读快照/断连子项彻底禁用危险控件。

### 未覆盖项与显式排除
- **真机实采未执行**：本轮未获得 U01 专用授权 Profile 的实时原生 child ACP 帧与真实 1.5.16+ 子审批转发实录，故所有新增测试均为 `synthetic`（离线合成/本地临时目录仿真），不抬升能力矩阵真机等级。
- **共享接线待总指挥在 G2 统一合入**：未直接修改 `native/wiring/registry.ts`、`strict-acp-adapter.ts`、`AgyStudioBlocks.tsx` 或 `App.tsx`，见第 6 节协作请求。
- **范围排除严格遵守**：无 child Prompt/steer 模拟、无直接 load child、无私有 AGY 文件写入、无推测 Board、无用 HM `subagent_runs` 伪造原生关系。

## 4. 测试命令、结果与验证类别

测试环境：Windows（PowerShell 5.1），Node + pnpm v11.21.0，Vitest v3.2.7。

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | 0 | 6/6 workspace 包（`plugin-api`、`plugin-sdk`、`protocol`、`daemon`、`web`、`electron`）构建通过（Vite `app-features` chunk > 500 kB 既有提示，构建成功） | build |
| `pnpm typecheck` | 0 | 6/6 workspace 包 `tsc --noEmit` 全部通过 | static |
| `pnpm contracts:check` | 0 | Plugin API 契约校验通过 | contract |
| `pnpm --filter @harnessmate/protocol test` | 0 | 2 files / **6 passed** | synthetic |
| `pnpm --filter @harnessmate/web test` | 0 | 14 files / **75 passed**（含 `tests/np05-subagent-manager.test.tsx` **4/4** 与 `tests/np03-workbench-ui.test.tsx` **7/7**） | synthetic |
| `pnpm test`（全量并发） | 1（单文件并发超时） | Protocol 6/6、Web 75/75、Daemon **33/34 files（167/168）** 一次通过，含 `agy-np05-child-routing.test.ts` **7/7**、`agy-lifecycle-events.test.ts` **5/5**、`agy-replay-protocol.test.ts` **2/2**、`agy-np02-*` **9/9**；仅既有 `multi-harness-orchestrator.test.ts` 1 项在全量并发 CPU 争用下触发 30s 超时 | synthetic / replay_with_provenance |
| `pnpm --filter @harnessmate/daemon test tests/multi-harness-orchestrator.test.ts`（单独复验） | 0 | **1 file / 6 passed**（原超时用例 18.4s 通过，确认零回归） | synthetic |
| `git diff --check` | 0 | 无空白/冲突标记错误 | static |

**汇总**：Protocol 6 + Daemon 168 + Web 75 = **249 项测试全绿**（含 NP-05 新增 11 项专项测试）。

**未执行的验证及原因**：
- `live_raw` / `live_hm` / `official_comparison`（T06/T07/T15 真机 child 与官方 App/CLI 对照）：按 `12_Test_Strategy.md` 与 `G2_Launch_Plan.md`，需等待专用 U01 Profile 就绪与真机授权采样后由 G2 联合验收执行并升级矩阵等级。

## 5. Capability IDs、真实证据与数据/跨 Harness 回归

| Capability ID | 当前矩阵等级（维持不变） | 本轮覆盖与缺口说明 |
| --- | --- | --- |
| `AGY-W01` | L1 · Unknown, Not Tested | 已完成合成态三命名空间隔离、同名双 child、嵌套子、idle 复跑、E06 `app_v1` 解析与 SQLite 投影；缺 1.5.16+ 真实 ACP child wire 帧与真实工具返回 `conversationId` 样本 |
| `AGY-W02` | L1 · Upstream Limited, Not Tested | 已实现 `SubagentManagerView` 与 `ChildTimelinePanel` 完整交互/只读门控；待真机 child 轨迹与 G2 浏览器 UI 复验 |
| `AGY-R10` | L0 · Not Tested | 已实现基于 `child.capabilities.canCancel` 的 child cancel 授权门控；待真机验证原生 child cancel 语义 |
| `AGY-S03` | L1 · Not Tested | 已验证断连/切代/重启后 live 能力立即撤销、实体标为 `stale` 且历史代只读可读 |

**引用证据 ID**：
- `E06`（`docs/phase-agy-native-parity/06_Protocol_Evidence.md`）：88 条本机 App child JSON 顶层字段为 `conversationId / subagentDescriptor / state / spawnStepIndex / workspaceUris` 且无 sibling JSONL → 驱动 `app_v1` 版本化 parser 与移除父 transcript fallback。
- `S09`（`docs/phase-agy-native-parity/05_Source_Audit.md`）：原 `agy-child-work.ts` 回退父 `logs/transcript.jsonl` 与前端按 `toolCallId` 查记录风险 → 后端已彻底消除父轨迹回退，前端改由权威投影与 `WorkId`/`NativeAgentId` 渲染。

**跨 Harness 与历史数据回归**：
- `adapters-codex.test.ts`、`adapters-claude.test.ts`、`adapters-acp.test.ts`、`phase3-external-adapters.test.ts`、`agy-replay-protocol.test.ts`（AGY 1.5.14 离线回放）、`agy-lifecycle-events.test.ts`、`handoff-v2.test.ts`、`multi-harness-orchestrator.test.ts`、`plugin-v4/v5/sdk` 与 `agy-np02-persistence-migration.test.ts` 全部通过；未改动旧 SQLite 表与既有 `subagent_runs` 行为。

## 6. 冲突与协作接口请求（供总指挥 / 共享 Owner 在 G2 接线）

1. **给 NP-07（Native Approvals）**：
   - 直接消费 `packages/daemon/src/harnesses/agy/native/child/contracts.ts` 导出的 `ChildScopeResolverPort`、`ChildRouteLookupInput`、`ChildScopeResolution`（`CHILD_SCOPE_CONTRACT_REVISION = 'agy-np05-child-scope-v1.0.0'`）及冻结测试桩 `createFrozenChildScopeResolverStub`。
   - 回复 JSON-RPC 时始终使用 `resolution.actualWireSessionId`；当 `resolution.forwardedViaParent === true` 且 `resolution.allowConfirmedChildAttribution === true` 时，可在收据元数据记录 `displayOwnerAgentId` 供 UI 跳转，而不改变真实线缆目标。
   - 当 `resolution.rejectRequest === true`（`rejected_scope` / `conflicting_child`）时直接 fail closed；当 `resolution.matchKind === 'unresolved_child'` 时绝不冒充父或已确证子项。
2. **给 NP-02 / 总指挥（`native/wiring/**` 与适配器接线）**：
   - 在 G2 集成时，通过 `AgyNativeRuntimeRegistry.registerModules({ timelineReader: childSessionRouter })` 注册 `ChildSessionRouter`（它已完整实现 `NativeTimelineReaderPort`）。
   - 在 `NativeLifecyclePort` / 适配器入站转发中将 `NativeIngress`、`onProfileGenerationChanged`、`handleTransportClosed` 接入 `ChildSessionRouter`，并使用 `router.commitToRegistry(nativeRegistry, binding, result.commits)` 落库发布。
   - 在 ACP `initialize` 协商前调用 `decideAcpChildClientCapabilities(...)`，仅在全路由就绪且 feature 开启时合并 `clientCapabilitiesPatch`；默认继续保持关闭。
   - 若后端 `/native/control` 执行 `target.type === 'agent'` 的 `cancel`，先调用 `childSessionRouter.authorizeChildCancel(binding, agentId)` 核验 `child.capabilities.canCancel`。
3. **给 NP-03 / 总指挥（前端注册与旧卡迁移）**：
   - 在 G2 工作台初始化处调用 `registerSubagentManagerView()`（`packages/web/src/components/agy/native/child/register.ts`，order `200`）覆盖默认 `order: 900` 降级壳。
   - 将 `AgyStudioBlocks.tsx` 中旧 `ext:agy.subagent_batch` 卡片从按 `toolCallId` 调用 `/agy/subagents/:subagentId` 迁移为跳转到 Subagents 工作台的新 opaque `WorkId` / `NativeAgentId` 路由（仅由 NP-03 owner 修改 `AgyStudioBlocks.tsx`）。

## 7. 审查者核验清单与回滚命令

**审查者快速复现命令**：
```powershell
git diff --stat b5d010a...HEAD
git diff --check b5d010a...HEAD
pnpm --filter @harnessmate/daemon test tests/agy-np05-child-routing.test.ts tests/agy-lifecycle-events.test.ts tests/agy-np02-persistence-migration.test.ts
pnpm --filter @harnessmate/web test tests/np05-subagent-manager.test.tsx tests/np03-workbench-ui.test.tsx
pnpm typecheck
```

**回滚方案**：
1. **运行时 / Schema 门控关闭（零代码回滚）**：保持 `DEFAULT_AGY_NATIVE_FEATURE_FLAGS.enabled = false`（或停用 `enableReadOnlySnapshot` / 传入 `supportedSchemas: []` 关闭未知版本 reader），保留已有脱敏历史记录与通用工具流。
2. **代码提交回滚**：待合入集成分支后，按需执行：
   ```powershell
   git revert a7daccf688bad99ce9dd22f53b14246fe7a5afa4
   ```
   （若以 merge commit 合入集成分支，则由集成负责人执行 `git revert -m 1 <mergeCommit>`，不回滚 SQLite 迁移表。）
