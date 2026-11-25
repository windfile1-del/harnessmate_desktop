# NP-07 交付报告 · 原生审批、Elicitation 和问题路由

## 1. 基线、Worktree 与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-07`（原生审批、Elicitation 和问题路由） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| G1 已审源码点 | `966451ceaa2d8cfbf268b05a973dbb400715b616`（本地标签 `agy-np-g1`） |
| Reviewed Base（G2 开工基线） | `b5d010ae74815a311d98090359b9d62894973024`（`docs(agy-np): freeze G1 and prepare G2 work packages`，父提交为 `966451c`） |
| 实际工作分支 / Worktree | `native_approvals_elicitation_routing` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\native_approvals_elicitation_routing`（平台分配于 D 盘，经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\native_approvals_elicitation_routing`） |
| **代码交付提交 SHA** | **`0880a5e6588538dabf50f62447ffea18be3edfad`**（`feat(agy-np-07): implement native approval, elicitation, and question router with UI and tests`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零改动） |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零改动） |
| `MASTER_PROGRESS.md` | 未修改（由总指挥统一维护） |

## 2. 实际变更路径与文件所有权核对

全部代码与测试严格限定在 NP-07 允许写入范围（`packages/daemon/src/harnesses/agy/native/requests/**`、`packages/web/src/components/agy/native/requests/**`、专属测试及本报告）。`packages/protocol/**`、`packages/plugin-api/**`、`packages/daemon/src/harnesses/agy/native/wiring/**`、`packages/daemon/src/core/approval-center-service.ts`、`packages/daemon/src/core/session-manager.ts`、`packages/web/src/components/ApprovalCenter.tsx` 及其他 Harness 适配器均零修改。

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/requests/types.ts` | NP-07 领域类型、`NativeRequestOption`、`NativeElicitationFormSpec`、`NativeRequestTargetResolver`（NP-05/04 接入契约）、`NativeApprovalCenterBridge`（只读桥接）、白名单 `NativeRequestDetailDto` 与 `NativeRequestValidationError` |
| `packages/daemon/src/harnesses/agy/native/requests/wire-codec.ts` | ACP v1 `session/request_permission`（含 `toolCall` 与 `subject.toolCall` 两种形状、`interaction_*` 问题、`agy.security.warning` 提取）与 `elicitation/create` / `session/elicitation/create` 协议/填表 schema 严格校验、响应编码与未知方法 `-32601` / 非法参数 `-32602` 错误生成 |
| `packages/daemon/src/harnesses/agy/native/requests/target-resolver.ts` | `StubNativeRequestTargetResolver`（G2 并行期 NP-05 child / NP-04 detached activity / Workflow 归属解析桩，支持 AGY 1.5.16 父会话转发 child/workflow 归属、未知 child 与冲突亲缘） |
| `packages/daemon/src/harnesses/agy/native/requests/native-permission-router.ts` | `NativePermissionRouter` 实现 `NativePermissionPort`：跟踪 session/child/binding/generation/connectionId/原类型 `RpcId`（`number` / `string`）/单调 `occurrence`，共享 DB CAS（`claimApprovalReceiptCas` + `transitionApprovalReceiptState`）、单次 wire 写出保护、限时自动过期、`handleStopRequested`、`handleGenerationChanged`、`onConnectionClosed`、`resolveViaLegacyApprovalCenter` 安全兼容适配器与严格 DTO 脱敏 |
| `packages/daemon/src/harnesses/agy/native/requests/index.ts` | 后端领域模块统一导出入口 |
| `packages/web/src/components/agy/native/requests/types.ts` | 前端视图模型、可选安全展示元数据与解析回调类型 |
| `packages/web/src/components/agy/native/requests/selectors.ts` | 纯选择器胶水（供 `ApprovalCenter`、`GlobalAttentionStrip` 与 Workbench 消费）：generation 栅栏、pending/历史回执分栏、按 agent/workflow/activity 过滤、前端 elicitation 草稿校验及 `ResolveNativeRequestInput` 构造器 |
| `packages/web/src/components/agy/native/requests/NativeElicitationForm.tsx` | 平铺 schema Elicitation 表单组件；对未验证/不支持字段或 URL 模式诚实展示不可提交原因并仅保留拒绝/取消 |
| `packages/web/src/components/agy/native/requests/NativeRequestDetailCard.tsx` | 原生审批/提问/表单卡片：清晰展示源归属（主会话/脱离原轮次/已证实子 Agent 跳转/已证实 Workflow 跳转/来源未确认）、原生安全警告、只读风险标注、高危二次确认、真实原生选项 ID（不隐式代选、不对固定选项展示自由文本输入框）、提交回执与重连失效只读态 |
| `packages/web/src/components/agy/native/requests/NativeRequestQueuePanel.tsx` | 会话或实体级待处理与历史回执队列面板，支持 pending 高亮计数、筛选标签、断连/重连提示与 480px 窄屏布局 |
| `packages/web/src/components/agy/native/requests/index.ts` | 前端组件与选择器统一导出入口 |
| `packages/daemon/tests/agy-np07-native-requests.test.ts` | 8 项后端专项与 E2E 测试（含真实子进程 stdio JSON-RPC、Fastify REST + SQLite CAS、T06/T07/T14 竞态、1.5.16 转发、功能门控回退） |
| `packages/web/tests/agy-np07-native-requests.test.tsx` | 前端选择器、表单校验、全状态渲染与断连/旧代失效测试 |

## 3. 已实现事项、实测可用表单与受限选项矩阵

### 3.1 已实现核心能力

1. **完整归属与身份跟踪**：为每条入站原生请求记录 `runtimeId`、`sessionId`、`instanceId`、`generation`、`connectionId`、`ingressOrdinal`、原类型 `wireRequestId`（严格保留 `number` 与 `string`）、单调 `occurrence`、`actualNativeSessionId` 及经 `NativeRequestTargetResolver` 归属的 `agentId` / `activityId` / `workflowId`。
2. **轮次内、轮次外（detached）、已证实 Child 与 Workflow 统一路由**：脱离用户轮次的请求（`turnId: null`）归属到可追踪的 detached `activityId`，不再被旧 AGY 策略静默取消；AGY 1.5.16 在 `default` / `accept-edits` 下经父会话转发的 child / workflow 请求保留 `actualNativeSessionId` 并单独标注 `agentId` / `workflowId` / `forwardedToParentSession: true`，且绝不自动授权。
3. **原子单写与共享 CAS**：与共享路由（`routes.ts`）和旧 `SessionManager.resolveRuntimeRequest` 共享同一 SQLite `claimApprovalReceiptCas`；并发双击、过期定时、Stop 中断、旧/新入口竞争及换代切换均保证同一原生请求最多写出一次响应，且永远沿原连接以原类型 RPC ID 回复。
4. **严格边界与错误规范**：
   - `history_replay` 通道服务端请求直接返回 `-32601`，零 pending 创建。
   - 未知 JSON-RPC 方法直接返回 `-32601`。
   - 缺失 `sessionId`、重复 `optionId`、畸形 `requestedSchema` 等非法参数返回 `-32602`。
   - 连接断开（`onConnectionClosed`）或写出返回 `false` 记 `connection_lost`；写出抛错记 `delivery_unknown`；均立即销毁 responder 引用且永不重放。
   - 只读调用 `ApprovalCenterService.evaluateLocalRules` 补充风险标注，不修改任何通用权限规则或风险分数。

### 3.2 实测可用表单（Forms）与受限/屏蔽选项清单

| 请求类别 / 协议形态 | 实测可用能力与提交方式 | 受限选项 / 强制阻断规则 |
| --- | --- | --- |
| `session/request_permission`（标准工具权限，已证实 root / child / workflow） | 仅支持 `outcome: 'selected'` + wire 声明的精确原生 `optionId`，或 `outcome: 'cancelled'`。原样透传 `_meta['agy.security.warning']` 及只读风险标注；`critical` 风险在 UI 强制二次确认勾选。 | 禁止 `form_submitted` / 自由文本；禁止提交不在 `allowedOptionIds` 的选项；不自动放行（即便在 `accept_edits` 模式）。 |
| `session/request_permission`（AGY `interaction_*` 固定选项问题） | 支持 `outcome: 'selected'` + 精确原生 `optionId`，或 `outcome: 'cancelled'`。 | 严禁将自由文本隐式映射到 `options[0]`（Native 与 Legacy 兼容适配器双向阻断，返回 `FREE_TEXT_NOT_SUPPORTED`）。 |
| `session/request_permission`（AGY `interaction_*` 零选项问题） | 仅支持 `outcome: 'cancelled'`。 | 标记 `canAnswer: false`、`unsupportedReason: 'no_verified_free_text_wire_encoding'`，UI 明确说明不可用自由文本代填。 |
| `elicitation/create` / `session/elicitation/create`（`mode: 'form'`，平铺基础 schema） | 实测可用字段：`string`（含 `enum`/`enumNames`/`minLength`/`maxLength`/`format: email\|uri\|date\|date-time`）、`number`、`integer`（含 `minimum`/`maximum`）、`boolean`、`array` of `string`（含 `enum` 多选）。校验通过后编码 `{ action: 'accept', content }`；支持 `optionId: 'decline'`（`{ action: 'decline' }`）与 `outcome: 'cancelled'`（`{ action: 'cancel' }`）。 | `additionalProperties: false` 时拒绝未知字段；缺失必填项、类型不符、超界或非法格式均阻断写出（`FORM_SCHEMA_INVALID`）。 |
| `elicitation/create`（嵌套 `object` / 非字符串数组字段） | 仅支持拒绝或取消，禁止提交表单。 | 标记 `formSpec.supported: false`、`unsupportedReason: 'unsupported_elicitation_field:<name>:<type>'`，UI 清晰展示受限原因。 |
| `elicitation/create`（`mode: 'url'`） | 默认入站即返回 `-32601`（`rejectUrlElicitationMode: true`）；显式关闭即时拒绝时仅允许拒绝/取消，不可提交表单。 | 未经验证的带外 URL 跳转不在本模块静默放行。 |
| 未知外部 Child 会话 / 亲缘冲突（`unknown_child` / `conflicting`） | 默认 `hold_bounded_cancel_only`：独立短限时（默认 30s），仅保留明确 `reject_*`/`decline` 选项与取消，到期自动回复 `cancelled`；配置 `reject_immediately` 时入站直接回复 `cancelled`。 | **剥离全部 `allow_*` / `custom` 选项与表单提交**；尝试选择任意放行选项返回 `UNKNOWN_CHILD_WIDENING_BLOCKED` / `400 INVALID_REQUEST`，绝不扩大允许。 |
| 经父会话转发但子目标未确证（`root` + `targetLineage: 'unresolved'`） | 保留当前原生作用域，缩短限时，UI 显著标注「来源未确认（保留原生作用域）」。 | **自动屏蔽所有 `scopeWidening` 持久授权选项**（`allow_always` / `allow_session`），防止权限范围扩大。 |

### 3.3 明确未覆盖事项（范围外或等待 G2 联调）

- 未修改通用 `ApprovalCenter.tsx`、`SessionManager`、`routes.ts`、`persistence.ts` 及 `registry.ts`（遵循文件所有权边界；见第 6 节接线提案）。
- 未做真实 AGY 1.5.16 登录后真机 `session/request_permission` / `elicitation/create` 抓包（待 U01 专用 Profile 就绪后随 G2 联合验收采集）。
- 未在 NP-07 内实现审批之外的 Workflow 逻辑、未修改任何通用权限规则/风险分数、未新增自动授权路径。

## 4. 测试验证、证据分类与 Capability ID

### 4.1 已执行命令与结果

运行环境：Windows，Node.js（`node:sqlite`），pnpm 11.21.0，均在代码交付提交 `0880a5e6588538dabf50f62447ffea18be3edfad` 上验证通过：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | 6/6 workspace 包构建通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（构建） |
| `pnpm typecheck` | `0` | 6/6 workspace 包零类型错误 | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过，Plugin SDK 契约零破坏 | `synthetic`（契约） |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np07-native-requests.test.ts` | `0` | **8/8 passed**（wire/form 校验、T06 轮次外与 1.5.16 转发、T07 未知/冲突 child 防扩权、禁止自由文本映射首项、T14 Stop/断连/写失败/换代/共享 CAS、并发 `Promise.all` 双击与多 occurrence、门控回退、真实 stdio JSON-RPC 子进程 E2E） | `synthetic` + `replay_with_provenance`（E05 形状） |
| `pnpm --filter @harnessmate/web test -- tests/agy-np07-native-requests.test.tsx` | `0` | **2/2 passed**（选择器、generation 栅栏、草稿校验、确认子 Agent/Workflow/未知 child/安全警告/高危二次确认/固定选项无文本框/不支持表单/全回执只读态与断连提示） | `synthetic` |
| `pnpm test`（全量门禁） | `0` | **248/248 passed**（`protocol` 6/6、`daemon` 169/169、`web` 73/73、`electron` 0/0） | `synthetic` + `replay_with_provenance` |
| `git diff --check b5d010a..0880a5e` | `0` | 无空白符或冲突标记问题 | 静态检查 |

### 4.2 未执行的检查与原因

- **未执行真机授权运行（`live_raw` / `live_hm` / `official_comparison`）**：按 `G2_Launch_Plan.md` 与 `12_Test_Strategy.md`，真机 Windows AGY 1.5.16 授权采样（Gemini 3.8 Flash / U01 专用 Profile）统一在 G2 跨模块联合验收阶段由指定负责人执行；NP-07 本轮在合成与 E05 回放形状环境下完成模块实现、真实本机 stdio JSON-RPC 子进程测试与 Fastify + SQLite CAS 集成测试，产品门控默认保持关闭（`nativePermissions: false`）。

### 4.3 关联证据 ID、风险与 Capability ID

- **源码审计与证据引用**：`S08`、`S18`、`E02`、`E03`、`E05`（AGY 1.5.14 `session-full.ndjson` 权限与 `interaction_001` 形状）、`E08`（轮次外权限取消复现对比）。
- **测试场景覆盖**：`T06`（轮次外审批与表单）、`T07`（已证实/未知/冲突 child 审批归属）、`T14`（取消、断连、写失败、换代与不重放）。
- **风险缓解**：`R-02`、`R-04`、`R-12`。
- **关联 Capability ID**：`AGY-R08`、`AGY-R09`、`AGY-R10`、`AGY-S03`、`AGY-S13`、`AGY-W01`、`AGY-W02`、`AGY-W04`–`AGY-W08`、`AGY-W14`、`AGY-W15`、`AGY-W17`。
- **能力矩阵等级声明**：本轮仅提供合成与 E05 形状回放证据，**不自行抬升任何能力的真机 L2–L5 等级**，留待 G2 联合真机采集后由总指挥统一更新。

### 4.4 真实证据缺口

1. 真实 AGY 1.5.16 在 `default` / `accept-edits` 模式下转发 subagent / workflow `session/request_permission` 与 `interaction_*` 时 `_meta` 内携带 child/workflow 标识的确切字段名尚未在登录态真机抓包中确认（当前 `wire-codec.ts` 支持 `params._meta` / `toolCall._meta` / `antigravity` 常见候选键，并统一经 `NativeRequestTargetResolver` 验证，未确证时严格降级为 `unresolved` 且阻断扩权）。
2. AGY 1.5.16 是否在生产 ACP v1 会话中发出标准 `elicitation/create`（以及是否使用 `mode: 'form'` 之外的扩展）尚未有实采样本；待真机观测后再决定是否在能力目录中点亮 `elicitation` 对应动作。

## 5. 数据与其他 Harness 回归结论

- **旧审批中心与 SQLite 数据**：`session-explorer-approval.test.ts`（7/7）全通，旧 `/api/v1/approvals`、高危规则评估、私密凭据零落盘管道、`user_question` 及历史回执零回归；关闭 `nativePermissions` 门控后旧路径与审计记录完整保留。
- **跨 Harness 与生态回归**：`adapters-codex.test.ts`、`adapters-claude.test.ts`、`adapters-acp.test.ts`、`phase3-external-adapters.test.ts`（DeepSeek & OpenCode）、`agy-replay-protocol.test.ts`（2/2）、`agy-lifecycle-events.test.ts`（5/5）、`agy-np02-persistence-migration.test.ts`、`agy-np02-wiring-provenance.test.ts`、`handoff-v2.test.ts`、`multi-harness-orchestrator.test.ts` 及全部插件与 Web 测试（总计 248/248）均一次通过。

## 6. 冲突声明与给共享 Owner 的协作变更提议

当前 **零文件冲突**。在 G2 集成合入前，向相关共享 owner 提交以下最小接线提议（全部已在 NP-07 模块内备好方法与单测用例）：

1. **给 NP-02（`packages/daemon/src/harnesses/agy/native/wiring/routes.ts`、`registry.ts`、`persistence.ts`、`session-manager.ts`）**：
   - **提议 A（前置表单/问题校验防误烧 CAS）**：在 `routes.ts` 的 `POST /requests/:approvalId/resolve` 中，调用 `claimApprovalReceiptCas` 之前调用可选 `permissionPort.validateResolutionInput?.(binding, approvalId, parsed.data)`（或至少对 `kind === 'question' && !allowsFreeText` 与 elicitation schema 失败返回 `400 INVALID_REQUEST`），避免非法自由文本/表单草稿将 DB receipt 提前烧成 `delivery_unknown` 而阻断用户修正重填。
   - **提议 B（旧审批中心委托）**：在 `SessionManager.resolveRuntimeRequest` 抢占共享 DB CAS（`nativeClaimedReceiptId`）后，若目标 `approvalId` 属于 `NativePermissionPort`，直接委托给 `NativePermissionRouter.resolveViaLegacyApprovalCenter({ binding, approvalId, receiptId: nativeClaimedReceiptId, request: req, resolvedBy })`（同时补齐 `user_question` 分支的 `finalizeNativeReceipt` 调用），确保旧 UI 与新 UI 统一走同一原连接写回。
   - **提议 C（Stop 与换代联动）**：在 `AgyNativeRuntimeRegistry.notifyCancelRequested` 同步触发 `permissionPort.handleStopRequested?.(binding, target)`，在 `ensureRuntimeBinding` / `advanceRuntimeGeneration` 换代时同步触发 `permissionPort.handleGenerationChanged?.(prevBinding, nextBinding)`。
   - **提议 D（Snapshot 详情投影）**：在 `readProjection`（或新增只读 `GET /api/v1/sessions/:id/native/requests`）接入 `permissionPort.listRequestDetails?.(binding, { includeResolved: true })`，将 `allowedOptionIds`、`allowsFreeText`、`targetLineage`、`options`、`securityWarnings` 与 `formSpec` 完整透传给前端。
2. **给 NP-03（`packages/web/src/components/ApprovalCenter.tsx` / Workbench）**：
   - **通用 `ApprovalCenter` 选择器接入建议**：当 `agyNativeWorkbenchEnabled` 开启且存在 AGY `NativeRuntimeProjection` 时，使用 `selectPendingNativeRequests` / `selectNativeRequestsForSession`（位于 `packages/web/src/components/agy/native/requests/selectors.ts`）筛选并渲染 `NativeRequestDetailCard` / `NativeRequestQueuePanel`，统一调用 `transport.resolveNativeRequest`；默认门控关闭时零变更保持现有 `ComposerPendingRequestBar` 与 `GlobalAttentionStrip`。
3. **给 NP-05 / NP-04（Child Identity & Reactive Runtime）**：
   - 联合实现 `NativeRequestTargetResolver`（`resolveTarget`、`getRootNativeSessionId`），在 G2 联调时替换 `StubNativeRequestTargetResolver`，将真实 child lineage、detached activity ID 与 workflow 归属直接注入 `NativePermissionRouter`。

## 7. 独立审查者复验命令与回滚方案

### 7.1 独立审查者复验命令

```powershell
git status --short --branch
git diff --name-status b5d010ae74815a311d98090359b9d62894973024..0880a5e6588538dabf50f62447ffea18be3edfad
git diff --check b5d010ae74815a311d98090359b9d62894973024..0880a5e6588538dabf50f62447ffea18be3edfad
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/daemon test -- tests/agy-np07-native-requests.test.ts tests/session-explorer-approval.test.ts tests/agy-replay-protocol.test.ts
pnpm --filter @harnessmate/web test -- tests/agy-np07-native-requests.test.tsx tests/np03-workbench-ui.test.tsx
pnpm test
```

### 7.2 回滚方案与命令

1. **优先功能门控即时回滚（无损、保留历史数据与旧审批审计）**：将 `AgyNativeFeatureFlags.nativePermissions` 保持或置回 `false`（默认即关闭），新的 native request 路由立即关闭（`/native/requests/:id/resolve` 返回 `503 NATIVE_RUNTIME_DISABLED`），已有 legacy approval 中心、风险规则与数据库审计记录完全保留。
2. **代码提交回滚**：
   - 独立分支回滚代码提交：
     ```powershell
     git revert --no-edit 0880a5e6588538dabf50f62447ffea18be3edfad
     ```
   - 若合入集成分支后形成 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
