# NP-15 交付报告 · 会话恢复与协议兼容

## 1. 基线、Worktree 与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-15`（会话恢复与协议兼容） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| G3 第一批已复验源码 | `5711a8266bdca72fd34a5dd07f59aedfb108a237`（`chore(agy-np): reconcile G3 integration with wave-one intake`） |
| Reviewed Base（第二批统一切分支点） | `9826359a46d0518c88d12ca45318bb5cb891a73a`（标签 `agy-np-g3-wave1`，`docs(agy-np): freeze reviewed G3 wave-one and wave-two launch`） |
| 实际工作分支 / Worktree | `np15_session_recovery_compatibility` · `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np15_session_recovery_compatibility`（经 Windows junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np15_session_recovery_compatibility`） |
| **代码交付提交 SHA** | **`f19b83f95864f36ef6cce23fac7898a1f1483724`**（`feat(agy-np-15): implement session recovery service, protocol compat adapter, and AGY history hardening`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零改动） |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零改动） |
| `MASTER_PROGRESS.md` | 未修改（由总指挥统一维护） |

## 2. 实际变更路径与文件所有权核对

全部实现、夹具、测试与文档严格限定在 NP-15 允许写入范围内（`packages/daemon/src/harnesses/agy/native/recovery/**`、`packages/daemon/src/harnesses/history-scanner.ts` 的 AGY 作用域、专属恢复测试与夹具、`handoffs/NP-15-*.md`）。`packages/protocol/**`、`packages/plugin-api/**`、`packages/daemon/src/core/**`、`packages/daemon/src/db/**`、`packages/daemon/src/harnesses/acp/**`、`packages/daemon/src/harnesses/agy/native/wiring/**`、`runtime/**`、`child/**`、`commands/**`、`requests/**`、`workflows/**`、`packages/web/**`、`docs/phase-agy-native-parity/MASTER_PROGRESS.md` 及 Codex/Claude/External 适配器均零修改。

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/recovery/types.ts` | NP-15 领域契约：`AgyNativeRecoveryConfig`（`activeReconcileEnabled: false`、`allowV2Preview: false`）、`RecoveryReasonCode`、握手能力解析与 attach 策略类型、绑定/作用域 guard 类型、冻结的 NP-12 调度恢复接口 `NativeScheduleRecoveryPort`、NP-03 对齐的 `RecoveryStatusSummaryDto`、CLI 版本兼容画像与崩溃/兼容审计记录类型。 |
| `packages/daemon/src/harnesses/agy/native/recovery/protocol-adapter.ts` | `buildInitializeRequest`（默认 v1）、`evaluateCliVersionCompatibility`（`<1.5.10`、`1.5.10–1.5.14`、`1.5.15`、`1.5.16+` 及 `quarantinedCliVersions` 坏版本降级）、`negotiateAcpProtocol`（兼容 `1.5.16`/`1.5.17` camelCase/snake_case 能力别名，v2→v1 在首条 Prompt 前降级，未知协议号拒绝）、`selectAttachStrategy`（分离 `v1_resume` 与 `v1_load_replay`）、`AcpV1ProtocolCodec`（拒收 v2 帧并保留数值/字符串 `RpcId` 类型）、`AcpV2PreviewProtocolCodec` 与受控工厂 `createAcpV2PreviewCodec`（双确认才实例化，跟踪 `replayFrom`→`replay_complete` 边界并拦截回放期服务端请求）。 |
| `packages/daemon/src/harnesses/agy/native/recovery/history-source.ts` | `AgyRecoveryHistorySource`：独立只读历史源，支持在 `activeReconcileEnabled = false` 或断连状态下只读查询持久化 `native_runtime_events` 与投影（新 schema 版本安全闭门、非终态实体诚实降级为 `reconciling`/`unknown`）；`sanitizeHistoryReplayFrames` 严格过滤 `history_replay` 通道并拦截 `session/request_permission` 与表单请求、不创建保活租约；`readLocalAgyIndexedHistory` 委派至安全版本地 AGY SQLite 读取器。 |
| `packages/daemon/src/harnesses/agy/native/recovery/process-tree.ts` | `AgyProcessTreeTeardownCoordinator` 与 `createDefaultNodeTeardownTransport`：按 `(runtimeId, generation, connectionId, pid)` 校验进程所有权（拒绝未归属 PID），按 CLI 版本与能力依次执行 `session/cancel`、`session/close` 及 Windows `taskkill /PID <pid> /T /F`（POSIX process-group）进程树清理。 |
| `packages/daemon/src/harnesses/agy/native/recovery/recovery-service.ts` | `AgyNativeRecoveryService`（实现 `NativeScheduleRecoveryPort`）：启动 `reconcileOnDaemonStartup`（受 `activeReconcileEnabled` 与 schema 兼容门控，幂等发送 `native.recovery.changed`，pending 审批→`connection_lost`、claimed→`delivery_unknown`）、`evaluateBindingGuard`（profile/source/revision/workspace/auth 校验，无授权绝不自动登录）、乱序 attach 丢弃、同代换连接退役旧连接与迟到 `handleTransportLost` 隔离、旧代次双层栅栏（含权威 DB binding 校验）、reconciling/replay 期间工作流控制门控、原生 job 可续性证据判定、`reconcileScheduleOccurrences` 跨代去重与 `stale_unverified` 降级、NP-03 `buildRecoveryStatusSummary`。 |
| `packages/daemon/src/harnesses/agy/native/recovery/index.ts` | NP-15 后端模块统一导出入口。 |
| `packages/daemon/src/harnesses/history-scanner.ts` | **仅限 AGY 作用域加固**：新增 `resolveSafeAgyPath`（顶层 `.gemini` junction 允许解析一次，逐层拒绝后代 symlink/Windows junction 逃逸）、`openAgyReadOnlySqlite`（在缺少 `-wal`/`-shm` 时使用 `?immutable=1` 只读打开，经 Node `v24.18.0` 实测零 `-wal`/`-shm` 磁盘副作用，且限制单库大小）、导出 `readAgyIndexedHistoryDetailedFromRoot`（限制消息条数与字节上限并验证 `conversation_id`）。Codex、Claude 与自定义 scanner 零改动。 |
| `packages/daemon/tests/fixtures/agy-np15/README.md` | NP-15 离线夹具来源与脱敏说明。 |
| `packages/daemon/tests/fixtures/agy-np15/v1-v2-negotiation-and-replay.ndjson` | 覆盖 Windows 1.5.16/1.5.17 握手形状、`v2→v1` 降级、受控 v2 Preview 回放与 `replay_complete` 转场、未知版本 `99`、v1 通道混入 v2 帧负例及 `-32000` 鉴权错误夹具。 |
| `packages/daemon/tests/fixtures/agy-np15/t09-t14-recovery-scenarios.ndjson` | T14 `session/load` 历史回放拦截审批夹具与 T09 计划 occurrence 恢复夹具。 |
| `packages/daemon/tests/agy-np15-recovery.test.ts` | 8 大专项测试套件（覆盖启动恢复/新旧 DB/只读回滚、绑定与 auth guard/零 WAL 副作用、同代换连接/旧代栅栏/乱序 attach/迟到帧、history_replay 隔离与 job 可续性、NP-12 T09 联测接口、ACP v1/v2 编解码与负例、分版本 cancel/close/Windows 进程树与坏版本降级、NP-03 摘要与 Context Handoff 水位回归）。 |
| `docs/phase-agy-native-parity/handoffs/NP-15-windows-compat-guide.md` | Windows CLI 版本适配矩阵、ACP v1/v2 分线、Windows 进程树清理、Junction/零 WAL 历史读取与崩溃/重启恢复运行指南。 |
| `docs/phase-agy-native-parity/handoffs/NP-15-report.md` | 本交付报告。 |

## 3. 已实现与未覆盖事项

### 3.1 已实现能力

1. **启动恢复与双层门控**：
   - `reconcileOnDaemonStartup()` 先校验 `agy-native-runtime` schema 兼容性（若 DB 版本高于 reader 则关闭原生恢复并记录 `CompatIncidentRecord`，保持旧 session list 可读）；随后仅在 `activeReconcileEnabled === true` 时将遗留 `attached` 绑定转标 `reconciling`、把 `pending` 审批标为 `connection_lost`、`claimed` 回执标为 `delivery_unknown` 并发布幂等 `native.recovery.changed`，不重放任何旧审批或用户 Prompt。
   - 关闭 `activeReconcileEnabled` 时停止主动恢复写入，同时保持既有 `native_runtime_events` 与只读历史投影可读。
2. **身份/作用域/代次与连接替换栅栏**：
   - `evaluateBindingGuard()` 严格校验 `sessionId`、`instanceId`、`profileRef`、`sourceRef`、`bindingRevision` 与规范化工作区路径（Windows 大小写不敏感）；`unauthenticated` 返回 `auth_required_manual_login` 且 `autoLoginTriggered = false`。
   - `beginAttach` / `completeAttach` 通过递增 `attemptOrdinal` 丢弃乱序完成；同代换连接（`conn_1 -> conn_2`）立即退役旧连接并使其迟到帧、`handleTransportLost` 归零不干扰新连接；`acceptLiveIngressCheck` 与 `isWorkflowControlAllowed` 同时校验权威 DB active binding，防止 `advanceRuntimeGeneration` 后旧代在 attach 完成前渗透；`reconciling` / `history_replay` 期间关闭工作流控制。
3. **独立只读历史与 Native Job 可续性诚实判定**：
   - `AgyRecoveryHistorySource.sanitizeHistoryReplayFrames()` 仅接受 `channel === 'history_replay'`，阻断所有 `session/request_permission` / `elicitation` 服务端请求，不创建保活租约；本地 `conversation_summaries.db` 读取在无 `-wal`/`-shm` 时通过 `?immutable=1` 实现零磁盘副作用，并阻断子目录 junction/symlink 逃逸。
   - `evaluateNativeJobContinuation()` 仅在新连接 `live_protocol` 或未过期 `native_snapshot` 证据存在时标 `confirmed_continuable`，否则保留 `stale_needs_evidence`，绝不无据宣称跨进程 daemon 存活。
4. **ACP v1 默认、受控 v2 Preview、分版本进程树清理与 NP-12 联测接口**：
   - 默认发起 v1 握手；请求 v2 而对端返回 `1` 时在首条用户 Prompt 前降级且拒绝实例化 `AcpV2PreviewProtocolCodec`；仅在 `allowV2Preview === true` 且服务端确认 `protocolVersion === 2` 与 `replayCursor/stateStream` 时允许实例化 v2 Preview 编解码器。
   - `AgyProcessTreeTeardownCoordinator` 校验 HM 进程所有权并按版本执行 `session/cancel`、`session/close` 及 Windows `taskkill /T /F` 树清理；坏版本自动降级为安全只读模式。
   - 实现冻结的 `NativeScheduleRecoveryPort`（NP-12 联测），支持跨代 occurrence 去重、独立 occurrence→workId 关联及缺证据诚实回退 `stale_unverified`。

### 3.2 明确未覆盖事项与真机证据缺口

- **Windows 实机授权 T09 / T14 / T15 长链路未执行（`live_raw` / `live_hm` / `official_comparison`）**：遵循 `G3_Wave2_Launch_Plan.md` 与 `12_Test_Strategy.md`，当前工作树未对带付费/个人授权的专用 D 盘 Profile 发起真实长任务唤醒、真实 `session/resume` / `session/load` 历史回放对比或真实 Windows 重启采样；仅使用了已登记的 Windows `1.5.16`/`1.5.17` 空白握手形状（`E02`、`E03`、场景文件）与合成/回放夹具。因此本交付**不自行抬升相关能力矩阵的 L2–L5 等级**。
- **共享文件未直接接线**：未修改 `wiring/composition.ts`、`core/session-manager.ts`、`harnesses/acp/strict-acp-adapter.ts` 与 Web `packages/web/**`；具体接入点见第 7 节协作提议。
- **已观察到的既存全量门禁环境约束**：`packages/daemon/tests/multi-harness-orchestrator.test.ts:265` 在套件层硬编码了 `{ timeout: 30_000 }`，本机 Windows Git worktree I/O 在第 5 个用例（真实多 worktree 创建与冲突合并）达到 `30061ms` 触发既有 30s 套件超时（详见第 5 节）。

## 4. 验证环境、命令结果与证据分类

### 4.1 实测命令与结果（均于最终代码提交 `f19b83f95864f36ef6cce23fac7898a1f1483724` 对应源码运行）

运行环境：Windows，Node `v24.18.0`，pnpm `11.21.0`，D 盘临时目录 `D:\HarnessMate\np15-tmp`（`TEMP`/`TMP`/`TMPDIR`），本机官方二进制 `C:\Users\windfile\AppData\Local\agy\bin\agy.exe`（`1.5.17`）。

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | 6/6 workspace 包构建通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（构建） |
| `pnpm typecheck` | `0` | 6/6 workspace 包零类型错误 | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过 | `synthetic`（插件契约） |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np15-recovery.test.ts` | `0` | **1 file, 8/8 passed**（Suite 1–8 全通） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/protocol test` | `0` | **2 files, 6/6 passed** | `synthetic` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1` | `0` | **21 files, 106/106 passed** | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 --testTimeout=60000` | `1` | **41/42 files passed, 230/231 tests passed**；唯一失败为 `tests/multi-harness-orchestrator.test.ts:512`（`30061ms` 触发该套件第 265 行硬编码的 `{ timeout: 30_000 }`），其余 41 个文件（含 `agy-np15-recovery.test.ts`、`handoff-v2.test.ts`、`agy-replay-protocol.test.ts`、`adapters-*`、`agy-np01..11`）全部通过。 | `synthetic` + `replay_with_provenance` |
| `node -e "...DatabaseSync(uri+'?immutable=1',{readOnly:true})..."` | `0` | Node `v24.18.0` 实测 WAL 库（无 `-wal`/`-shm`）只读打开前后目录文件完全一致，零 `-wal`/`-shm` 创建 | `synthetic`（SQLite 实测） |
| `git diff --check agy-np-g3-wave1` | `0` | 零空白符或冲突标记异常 | 静态检查 |

### 4.2 证据 ID、测试场景与 Capability ID

- **关联 Capability ID**：`AGY-R01`（协议协商与降级）、`AGY-R05`（daemon 存活判定边界）、`AGY-R10`（Stop/Cancel/Close 与进程树清理）、`AGY-S01`（会话列表与安全历史读取）、`AGY-S02`（`session/resume` 与 `session/load` 分离）、`AGY-S03`（崩溃/重启/断网恢复）、`AGY-S08`（工作区/目录作用域校验）、`AGY-S14`（无自动登录边界）、`AGY-W10`（Schedule/occurrence 跨代恢复去重）。
- **证据与设计来源**：`E01`、`E02`、`E03`、`E04`、`E05`、`E06`、`E08`、`S02`、`S03`、`S07`、`S08`、`S10`、`S15`、`S17`、`T09`、`T14`、`T15`、Windows `1.5.17` 握手记录（`windows-1.5.17-clean-v1.ndjson`、`windows-1.5.17-request-v2.ndjson`）。
- **风险缓解**：`R-03`、`R-05`、`R-08`、`R-11`、`R-14`、`R-15`、`R-17`。

## 5. 数据、跨 Harness 回归与既有超时说明

- **数据与既有 AGY 回归**：`agy-np02-persistence-migration.test.ts`（5/5）、`agy-np02-wiring-provenance.test.ts`（4/4）、`agy-np04-reactive-runtime.test.ts`（10/10）、`agy-np05-child-routing.test.ts`（7/7）、`agy-np06-command-router.test.ts`（9/9）、`agy-np07-native-requests.test.ts`（12/12）、`agy-np08-swarm.test.ts`（6/6）、`agy-np09-boost.test.ts`（6/6）、`agy-np10-teamwork.test.ts`（6/6）、`agy-np11-dynamic-workflow.test.ts`（6/6）、`agy-np-observatory.test.ts`（18/18）、`agy-replay-protocol.test.ts`（2/2）、`agy-lifecycle-events.test.ts`（5/5）、`agy-auth-usage.test.ts`（7/7）、`agy-config-scope.test.ts`（4/4）、`agy-launch-context.test.ts`（6/6）全部通过。
- **跨 Harness、Handoff 与插件回归**：`adapters-codex.test.ts`（5/5）、`adapters-claude.test.ts`（4/4）、`adapters-acp.test.ts`（4/4，含 AGY 隔离边界检查）、`phase3-external-adapters.test.ts`（5/5）、`handoff-v2.test.ts`（12/12）、`unified-context-bridge.test.ts`（3/3）、`plugin-v4.test.ts`（6/6）、`plugin-v5.test.ts`（6/6）、`plugin-p3-isolation.test.ts`（4/4）、`plugin-p4-ui-slots.test.ts`（2/2）、`plugin-p5-ecosystem.test.ts`（2/2）全部通过。Context Handoff `session_bindings.synced_up_to_seq` 与 `session_events` 零污染（`Suite 8` 专项验证）。
- **关于 `tests/multi-harness-orchestrator.test.ts`**：该文件未做任何改动，6 个测试中前 4 个及第 6 个（`29210ms`）在全量串行跑中通过；第 5 个（真实多 Git Worktree 隔离与冲突合并）于本机 Windows I/O 下耗时 `30061ms`，超出其套件第 265 行硬编码的 `{ timeout: 30_000 }` 61ms（单独复跑亦在 `30040ms` / `30198ms` 触及该 30s 边界）。此超时与 NP-15 无关，未修改该非 NP-15 文件。

## 6. 冲突声明与给共享 Owner 的协作变更提议

当前 **零文件冲突**。以下为集成阶段提交给各共享模块 Owner 的接入提议（均附带 NP-15 已有实现与单测契约）：

1. **给 NP-02（`packages/daemon/src/harnesses/agy/native/wiring/composition.ts`、`core/session-manager.ts`、`harnesses/acp/strict-acp-adapter.ts`）**：
   - 在 `SessionManager` 启动阶段或 `wireAgyNativeRuntime` 初始化 `const recovery = new AgyNativeRecoveryService({ registry, config: { activeReconcileEnabled: flags.enabled } })`；调用 `recovery.reconcileOnDaemonStartup({ sessionScopes })` 替代裸调 `markAttachedBindingsReconcilingOnStartup()`，以统一发射幂等 `native.recovery.changed` 并保留 `activeReconcileEnabled = false` 的无损只读回滚开关。
   - 在 `strict-acp-adapter.ts` `initialize()` 中接入 `buildInitializeRequest({ allowV2Preview: flags.acpV2Preview })` 与 `negotiateAcpProtocol()`：在发送首条 Prompt 前完成 `v2 -> v1` 降级与未知版本拒绝，仅当 `createAcpV2PreviewCodec()` 非空时启用 v2 Preview 编解码路径，并通过 `selectAttachStrategy()` 区分 `v1_resume` 与 `v1_load_replay`。
   - 在 `composition.ts` `connection.attach` / `ingest` / `close` 中接入 `recovery.beginAttach()`、`recovery.completeAttach()`、`recovery.acceptLiveIngressCheck()` 与 `recovery.handleTransportLost()`；在 `/native/control` 校验前检查 `recovery.isWorkflowControlAllowed()`，并用 `AgyProcessTreeTeardownCoordinator` 托管 HM 启动的 AGY 子进程生命周期与 Windows 进程树清理。
   - 失败语义与回滚：若 `activeReconcileEnabled` 为 `false` 或 DB component 版本高于 reader，所有恢复写入自动跳过，只读 `AgyRecoveryHistorySource` 保持历史可读。
2. **给 NP-03（`packages/web/src/components/agy/native/shared/`）**：
   - 复用 `AgyNativeRecoveryService.buildRecoveryStatusSummary()` 输出的 `RecoveryStatusSummaryDto`，通过现有 shared selectors 渲染「连接恢复中 (`reconciling`)」「最后见时间 (`lastSeenAt`)」「失效审批 (`invalidatedApprovalIds` / `deliveryUnknownReceiptIds`)」「可恢复 / 需手工接入」及正常历史读取路径，且 `autoLoginTriggered` 恒为 `false`。
3. **给 NP-12（`packages/daemon/src/harnesses/agy/native/workflows/tasks/**`）**：
   - 在调度/任务模块注入 `NativeScheduleRecoveryPort`（`recoveryService.reconcileScheduleOccurrences(...)`），用于关闭再重开后对持久化 `occurrence` 执行跨代去重、保持独立 `occurrence -> workId` 关联，并在缺少新证据时保持 `stale_unverified`（不接入 HM 自身调度器）。
4. **给 NP-13（`packages/daemon/src/harnesses/agy/native/ecosystem/**`）**：
   - 在校验跨 Profile / 账号上下文时向 `RecoveryBindingGuardInput` 传入确认后的 `profileRef`、`sourceRef` 与 `authState`（`authenticated` / `unauthenticated` / `unknown`），确保未授权 Profile 严格触发手工官方登录提示而非自动登录或跨源误绑。

## 7. 独立审查者复验命令与回滚方案

### 7.1 独立审查者复验命令

```powershell
git status --short --branch
git diff --name-status agy-np-g3-wave1...HEAD
git diff --check agy-np-g3-wave1...HEAD
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/daemon test -- tests/agy-np15-recovery.test.ts tests/agy-replay-protocol.test.ts tests/handoff-v2.test.ts tests/adapters-acp.test.ts tests/agy-np02-persistence-migration.test.ts
pnpm --filter @harnessmate/protocol test
pnpm --filter @harnessmate/web test -- --maxWorkers=1
pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 --testTimeout=60000
```

### 7.2 回滚方案与命令

1. **优先功能开关无损回滚（保留只读历史与新增表）**：
   - 调用 `recoveryService.setActiveReconcileEnabled(false)` 或保持 `AgyNativeFeatureFlags.enabled = false`、`acpV2Preview = false`；主动恢复与状态写回立即停止，已有 `native_runtime_*` 历史与旧会话列表继续只读保留（不删表、旧版本可正常启动）。
2. **代码提交回滚**：
   - 独立分支回滚代码提交：
     ```powershell
     git revert --no-edit f19b83f95864f36ef6cce23fac7898a1f1483724
     ```
   - 若合入集成分支后产生 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
