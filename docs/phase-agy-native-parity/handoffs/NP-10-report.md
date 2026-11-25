# NP-10 交付报告 · Teamwork 访谈、项目与里程碑

## 1. 基线、Worktree 与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-10`（Teamwork 访谈、项目与里程碑） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| G2 修复源码提交 | `f895bf44ad5e850109ab8641fbfb81522214390f` |
| Reviewed Base（G3 统一开工基线） | `fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c`（本地标签 `agy-np-g2`） |
| 实际工作分支 / Worktree | `np10_teamwork_workbench` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np10_teamwork_workbench`（平台分配于 D 盘，经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np10_teamwork_workbench`） |
| **代码交付提交 SHA** | **`14dcbd98eedb2133c362c6ecbcdd043ea9516743`**（`feat(agy-np-10): implement Teamwork observer, full-width studio UI, and T12 tests`） |
| 公共协议契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零改动） |
| 私有域 DTO 契约版本 | `TEAMWORK_OBSERVER_CONTRACT_REVISION = 'agy-np10-teamwork-v1.0.0'` |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零改动） |
| `MASTER_PROGRESS.md` | 未修改（由总指挥统一维护） |

## 2. 实际变更路径与文件所有权核对

全部变更严格限定在 NP-10 允许写入范围（`packages/daemon/src/harnesses/agy/native/workflows/teamwork/**`、`packages/web/src/components/agy/native/teamwork/**`、专属测试及 `docs/phase-agy-native-parity/handoffs/NP-10-*.md`）。`packages/protocol/**`、`packages/plugin-api/**`、`packages/daemon/src/harnesses/agy/native/wiring/**`、`packages/daemon/src/core/**`、`packages/daemon/src/server/**`、`packages/daemon/src/harnesses/agy/agy-artifacts.ts`、`packages/web/src/components/agy/AgyArtifactReviewPanel.tsx`、`packages/web/src/App.tsx`、`packages/web/src/components/agy/native/shared/**` 及其他 Harness 适配器均 **零修改**。

| 路径 | 职责 |
| --- | --- |
| `packages/daemon/src/harnesses/agy/native/workflows/teamwork/schemas.ts` | NP-10 私有 allowlist Zod DTO（`TeamworkWorkbenchProjectionDtoSchema`、访谈问题、Prompt Artifact、HM/原生项目作用域分离、角色归属、审计门控、产物引用、事件轨迹）与 `containsRawHostPath` 零路径泄露校验 |
| `packages/daemon/src/harnesses/agy/native/workflows/teamwork/ports.ts` | 冻结跨模块接入缝：`TeamworkArtifactReviewPort`（供 NP-14 接入）及默认降级桩、`TeamworkPathAuthorizationPort` 及 fail-closed 严格路径授权校验器、`TeamworkChildLineagePort`（供 NP-05 接入）、`TeamworkFeatureGateConfig` 与向 NP-06 贡献的 `TEAMWORK_CAPABILITY_CONTRIBUTION`（`AGY-W07`） |
| `packages/daemon/src/harnesses/agy/native/workflows/teamwork/wire-codec.ts` | 仅基于结构化 wire 字段的 Teamwork 信号解码器：识别 `/teamwork` 广告并区分旧 `/teamwork-preview`；严格忽略普通 `agent_message_chunk` / `agent_thought_chunk` 文本，不从自然语言推断批准、角色或里程碑 |
| `packages/daemon/src/harnesses/agy/native/workflows/teamwork/observer.ts` | `AgyTeamworkWorkflowObserver`：逐事件证据状态机、访谈问题幂等去重（消费 NP-07 typed receipt）、Prompt Artifact 审阅门控与自然语言批准反伪造拦截、拒绝后零项目/角色/里程碑不变量、HM/原生作用域分离、NP-05 确证角色归属、断连 `stale`/换代栅栏/`history_replay` 隔离、门控只读回退、`AgyNativeRuntimeRegistry.commitAndPublish`（严格对齐 `WorkflowDetailSchema` `kind: 'teamwork'`）与 `NativeWorkflowResourceReaderPort` 分页器（`phases`/`logs`/`artifacts`/`board`） |
| `packages/daemon/src/harnesses/agy/native/workflows/teamwork/fixtures.ts` | T12 离线合成回放夹具与回放驱动（`createT12RejectedScenario`、`createT12ApprovedMilestone1Scenario`、`replayTeamworkScenario`） |
| `packages/daemon/src/harnesses/agy/native/workflows/teamwork/index.ts` | 后端领域模块导出入口 |
| `packages/web/src/components/agy/native/teamwork/types.ts` | 前端视图模型与 NP-14 冻结审阅控制 props（默认安全禁用/只读） |
| `packages/web/src/components/agy/native/teamwork/teamwork-view-model.ts` | 纯选择器：Teamwork 工作流筛选、已证实角色 vs 未确证候选分离、NP-07 访谈请求筛选、审批门控推导、HM/原生作用域推导与 `loadWorkflowResource` 分页解析 |
| `packages/web/src/components/agy/native/teamwork/TeamworkPromptArtifactPanel.tsx` | Prompt Artifact 审阅与批准门控面板：禁止自然语言批准按钮；NP-14 未接通或门控关闭时禁用批准并指引官方 App/CLI；拒绝态明确确认未创建项目/角色/里程碑 |
| `packages/web/src/components/agy/native/teamwork/TeamworkStudioView.tsx` | 全宽 Teamwork 项目页（兼容 480px 窄屏与分区筛选）：包含项目头与 HM/原生作用域边界、访谈（NP-07 卡片 + `scopingActivityId` 时间线）、Prompt Artifact、里程碑与审计（无里程碑时隐藏图表）、已证实角色（Sentinel / Project Orchestrator / Auditor，可跳 Subagent Manager）与产物列表，并在断连或门控关闭时保留只读历史 |
| `packages/web/src/components/agy/native/teamwork/register.ts` | `registerTeamworkStudioView`（在 `agyWorkbenchRegistry` 以 `order: 200`、`preferredLayout: 'full'` 覆盖内置降级壳，支持无损注销回退） |
| `packages/web/src/components/agy/native/teamwork/fixtures.ts` | 前端离线测试夹具（访谈降级、拒绝态、批准首里程碑态、断连过期态） |
| `packages/web/src/components/agy/native/teamwork/index.ts` | 前端领域模块导出入口 |
| `packages/daemon/tests/agy-np10-teamwork.test.ts` | 6 组 T12 后端单测、回放与 SQLite `AgyNativeRuntimeRegistry` 集成测试 |
| `packages/web/tests/agy-np10-teamwork.test.tsx` | 6 组 Teamwork Studio UI、注册覆盖、降级、拒绝、首里程碑、只读回滚与窄屏测试 |
| `docs/phase-agy-native-parity/handoffs/NP-10-teamwork-comparison.md` | 官方 App/CLI 与 HarnessMate 对照文档、已证实实体与无法获取字段清单 |
| `docs/phase-agy-native-parity/handoffs/NP-10-report.md` | 本交付报告 |

## 3. 已实现事项与未覆盖事项

### 3.1 已实现核心能力

1. **规范命令 `/teamwork` 与旧名称边界**：仅追踪 `/teamwork` 广告与发起，明确识别并拒绝旧 `/teamwork-preview`（`LEGACY_PREVIEW_COMMAND_REJECTED`），并向 NP-06 提供 `TEAMWORK_CAPABILITY_CONTRIBUTION`（`AGY-W07`，保持诚实的 `not_tested` / `upstream_limited` 门控）。
2. **访谈问题幂等与 NP-07 回执消费**：按 `dedupKey` / `approvalId` / `toolCallId` 去重，重复投递仅递增 `duplicateDeliveriesIgnored`，迟到 `pending` 回执绝不回退已有终态（`response_written` / `cancelled` / `expired` / `connection_lost` / `delivery_unknown`）。
3. **Prompt Artifact 正式批准门控与拒绝不变量**：
   - `attemptNaturalLanguageApproval` 始终返回 `NATURAL_LANGUAGE_APPROVAL_FORBIDDEN`，前端不提供自然语言批准按钮。
   - 预留 NP-14 `TeamworkArtifactReviewPort` 冻结接口，默认启用降级桩并指引官方 Antigravity App/CLI。
   - 拒绝/取消/过期后强制保证零原生项目目录、零角色、零里程碑，并阻断后续越界帧（`post_rejection_mutation_blocked`）。
4. **HM 工作区与原生 Teamwork 项目目录隔离**：公有 DTO 经 `containsRawHostPath` 断言零原始主机路径泄露；前端清晰区分 `HM Scope` 与 `AGY 原生 Teamwork 项目目录`；服务端路径打开经 `createStrictTeamworkPathAuthorizer` 强制检验授权根目录、`reparseCheckPassed` 并阻断 `..` 与 UNC 路径；HM 绝不自行创建 Teamwork 目录。
5. **多角色确证轨迹、里程碑、审计与只读回滚**：仅展示经 NP-05 证实（`lineage === 'confirmed'`）的 Sentinel / Project Orchestrator / Milestone Worker / Auditor 角色，未确证候选隔离展示；无里程碑证据时省略 `milestones` 并隐藏图表；断连/换代/`history_replay` 严格栅栏，永不重放旧审批；关闭 `teamworkEnabled` 或仅关闭 `reviewControlEnabled` 时，已呈现历史保持只读。

### 3.2 明确未覆盖事项（范围外或等待 G3 集成 / 第二批联测）

- 未直接修改 `wiring/composition.ts`、`wiring/routes.ts`、`App.tsx` 或全局 workbench 引导文件（遵守 G3 文件所有权约定，见第 6 节接线提案）。
- 未实现 NP-14 真实 Artifact 文件读取器与原生行级评论/批准 RPC（由 NP-14 在 G3 第二批拥有并经 `TeamworkArtifactReviewPort` 联测）。
- 未在登录付费账号下执行真实 `/teamwork` 商业额度实测（遵守 `12_Test_Strategy.md` 授权范围；待实测字段详见 [NP-10-teamwork-comparison.md](NP-10-teamwork-comparison.md)）。

## 4. 测试验证、证据分类与 Capability ID

### 4.1 已执行命令与结果

运行环境：Windows，Node.js，pnpm 11.21.0，临时目录隔离至 D 盘（`D:\AppDataCache\np10-tmp`），均在代码交付提交 `14dcbd98eedb2133c362c6ecbcdd043ea9516743` 对应源码上执行：

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm build` | `0` | 6/6 workspace 包构建通过（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`；Vite 既有 `app-features` 603.91 kB 提示未增） | `synthetic`（构建） |
| `pnpm typecheck` | `0` | 6/6 workspace 包零类型错误 | `synthetic`（静态类型） |
| `pnpm contracts:check` | `0` | `scripts/plugin-contracts.mjs --check` 通过，Plugin SDK 契约零破坏 | `synthetic`（契约） |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 tests/agy-np10-teamwork.test.ts` | `0` | **6/6 passed**（T12-1 命令发现与 `/teamwork-preview` 拒绝、T12-2/3 访谈幂等与正式拒绝零创建、T12-4 反自然语言伪造与反文本推理、T12-5/6 首里程碑/多角色/SQLite Registry/Resource 分页/路径授权、T12-7 断连/换代/replay 隔离/恢复、T12-8/9 门控只读回滚与 NP-14 联测桩） | `synthetic` + `replay_with_provenance`（对齐 E05/v1 契约形状） |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1 tests/agy-np10-teamwork.test.tsx` | `0` | **6/6 passed**（Workbench `order: 200` / `full` 注册与注销、空态与 `/teamwork-preview` 警告、NP-14 禁用态与官方 App 指引、拒绝态无里程碑图、首里程碑/作用域隔离/零原始路径/已证实与未确证角色分栏、断连与门控关闭只读态及 480px 窄屏） | `synthetic` |
| `pnpm --filter @harnessmate/protocol test -- --maxWorkers=1` | `0` | **6/6 passed**（2/2 文件） | `synthetic` |
| `pnpm --filter @harnessmate/web test -- --maxWorkers=1` | `0` | **91/91 passed**（18/18 文件，含全部 NP-03..NP-10 与既有 UI 回归） | `synthetic` |
| `pnpm --filter @harnessmate/daemon test -- --maxWorkers=1`（全量串行 + 2 项既有 Git 定时用例独立复跑） | 首次 `1`（36/38 文件 202/205 通过），独立复跑均 `0` | 全量串行时 36/38 文件一次通过（含全部 AGY、NP-01..NP-10、Codex、Claude、Strict ACP、DeepSeek、OpenCode、Handoff、Approval、Plugin 回归）；两项既有 Git 重度测试在 Windows 磁盘负载下触及计时阈值（`git-checkpoints.test.ts` `2036ms < 2000ms`；`multi-harness-orchestrator.test.ts` 30s 单个 worktree 用例超时），随后独立复跑 `tests/git-checkpoints.test.ts`（**7/7 passed**）与 `tests/multi-harness-orchestrator.test.ts`（**6/6 passed**）均完整通过，总计 **205/205** 通过（跨三包共 **302/302**） | `synthetic` + `replay_with_provenance` |
| `git diff --cached --check` | `0` | 零空白符或冲突标记问题 | 静态检查 |

### 4.2 未执行的检查与原因

- **未执行真机授权运行（`live_raw` / `live_hm` / `official_comparison`）**：`/teamwork` 属于官方付费计划功能，本轮无独立商业额度测试授权，亦未启动 U01 专用 Profile 实机采样。全部 Teamwork 协议细字段保持 `synthetic_candidate_pending_live_capture` 与默认关闭门控，待总指挥按 `12_Test_Strategy.md` 获用户单独授权后进行真机 T12 与 App/CLI 对照。

### 4.3 关联证据 ID、风险与 Capability ID

- **源码审计与证据引用**：`S20`、`S21`、`E01`、`E02`、`E04`、`E05`、`E06`、`T12-synthetic`。
- **测试场景覆盖**：`T12`（Teamwork 访谈幂等、Prompt Artifact 拒绝/批准、首里程碑、多角色、作用域边界与断线恢复）。
- **风险缓解**：`R-05`、`R-06`、`R-09`、`R-10`、`R-11`、`R-15`。
- **关联 Capability ID**：主项 `AGY-W07`（Teamwork）；协同依赖 `AGY-W14`（Artifacts 审阅，NP-14）、`AGY-R08`/`AGY-R09`（原生审批与结构化问题，NP-07）、`AGY-W01`（子 Agent 亲缘，NP-05）、`AGY-S03`（断线恢复）、`AGY-S07`/`AGY-S08`（项目目录与额外授权根）。
- **能力矩阵等级声明**：本轮仅交付离线合成与回放证据，**不抬升 `AGY-W07` 的真实 L2–L5 等级**，留待总指挥在真机验收后统一维护。

### 4.4 真实证据缺口

完整字段级对照表与待实测事项见 [NP-10-teamwork-comparison.md](NP-10-teamwork-comparison.md)，核心缺口摘要：
1. 登录付费账号下 `available_commands_update` 对 `/teamwork` 的真实广告与参数提示形状。
2. Teamwork 访谈逐题在 ACP v1 中的真实 `_meta` 关联键（`interaction_*` vs `elicitation/create`）。
3. Prompt Artifact 是否有可供第三方 ACP 客户端调用的正式审阅/批准 RPC（由 NP-14 联测确认；若无则永久保持官方 App 引导）。
4. 批准后原生的 Teamwork 项目目录字段、Sentinel / Project Orchestrator / Auditor 的 `subagent_update` 角色标识、以及里程碑与 Audit Gate 的真实 `session/update` 推送结构。

## 5. 数据与其他 Harness 回归结论

- **旧数据与兼容契约**：未修改 `packages/protocol/src/agy-native-v1.ts` 或 SQLite 迁移（维持 `component='agy-native-runtime', version=1`）；Teamwork 实体严格通过冻结 `WorkflowDetailSchema`（`kind: 'teamwork'`）与 `AgyNativeRuntimeRegistry.commitAndPublish` 落库，关闭门控后原有会话、旧 `agy-artifacts.ts` 只读接口与历史数据零影响。
- **跨 Harness 与生态回归**：Codex、Claude、Strict ACP、DeepSeek、OpenCode、AGY 1.5.14 回放、NP-01..NP-07 全部测试、Context Handoff、Git Checkpoints（7/7）、Multi-Harness Orchestrator（6/6）、Plugin SDK 契约与 Web 全部 91 项测试均通过，零跨 Harness 回归。

## 6. 冲突声明与给共享 Owner 的协作变更提议

当前 **零文件冲突**。进入 G3 串行接线时，向各共享 owner 提交以下最小变更提议（全部接口与单测用例已在 NP-10 模块内完备）：

1. **给总指挥 / NP-02（`packages/daemon/src/harnesses/agy/native/wiring/composition.ts`）**：
   - 在 `wireAgyNativeRuntime` 中实例化 `AgyTeamworkWorkflowObserver`（默认 `featureGates: { teamworkEnabled: false, reviewControlEnabled: false }`），并：
     - 将 `TEAMWORK_CAPABILITY_CONTRIBUTION` 通过 `catalog.registerWorkflowDescriptor(TEAMWORK_CAPABILITY_CONTRIBUTION)` 注册至 NP-06 目录。
     - 将 `connection.ingest`、`connection.close` 与生成代次切换事件转发至 `teamworkObserver.acceptIngressFrame` / `handleTransportClosed` / `handleGenerationChanged`，并在变化时调用 `teamworkObserver.commitToRegistry(registry, binding)`。
     - 将 `teamworkObserver.createResourceReader()` 与其他工作流 reader 组合后注册到 `registry.registerModules({ workflowResourceReader })`（供 `GET /api/v1/sessions/:id/native/workflows/:workflowId/:resource` 路由复用，零新增 REST 端点）。
2. **给 NP-03（前端 Workbench 引导入口）**：
   - 在启用 AGY Native Workbench 的入口处调用 `registerTeamworkStudioView(agyWorkbenchRegistry, { teamworkFeatureEnabled, reviewControl })`，以 `order: 200`、`preferredLayout: 'full'` 激活 Teamwork 项目页；关闭门控时传入 `teamworkFeatureEnabled: false` 或注销注册即可无缝保留只读历史 / 回到内置降级壳。
3. **给 NP-14（Artifact & Review，G3 第二批联测）**：
   - 实现 `TeamworkArtifactReviewPort`（`getReviewCapability`、`readArtifactSummary`、以及经实录证实后的 `submitNativeArtifactApproval`）注入 `AgyTeamworkWorkflowObserver`，并在前端通过 `TeamworkStudioProps.reviewControl` 透传预览与原生审批回调。
4. **给 NP-05 / NP-07（Child Lineage & Native Permission Router）**：
   - 由 NP-05 `ChildSessionRouter` 提供 `TeamworkChildLineagePort`（仅透传 `lineage === 'confirmed'` 的 Sentinel / Project Orchestrator / Auditor），由 NP-07 `NativePermissionRouter` 将归属于 Teamwork `scopingActivityId` / Prompt Artifact 的 `NativeRequestSummaryDto` 回执转发至 `teamworkObserver.acceptRequestReceipt`。

## 7. 独立审查者复验命令与回滚方案

### 7.1 独立审查者复验命令

```powershell
git status --short --branch
git diff --name-status fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c..14dcbd98eedb2133c362c6ecbcdd043ea9516743
git diff --check fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c..14dcbd98eedb2133c362c6ecbcdd043ea9516743
pnpm build
pnpm typecheck
pnpm contracts:check
pnpm --filter @harnessmate/daemon test -- --maxWorkers=1 tests/agy-np10-teamwork.test.ts tests/agy-np02-persistence-migration.test.ts tests/agy-np06-command-router.test.ts tests/agy-np07-native-requests.test.ts
pnpm --filter @harnessmate/web test -- --maxWorkers=1 tests/agy-np10-teamwork.test.tsx tests/np03-workbench-ui.test.tsx
```

### 7.2 回滚方案与命令

1. **优先功能门控即时回滚（无损、已呈现历史保持只读）**：
   - 仅关闭 Prompt Artifact 审阅控制：`observer.configureGates({ reviewControlEnabled: false })` 且前端传 `reviewControl.reviewControlEnabled = false`（历史与观察继续只读可用）。
   - 关闭整个 Teamwork 功能：`observer.configureGates({ teamworkEnabled: false, reviewControlEnabled: false })` 且前端传 `teamworkFeatureEnabled={false}` 或执行 `registerTeamworkStudioView()` 返回的注销函数（已呈现历史保持只读，SQLite 数据无损保留）。
2. **代码提交回滚**：
   - 独立分支回滚代码提交：
     ```powershell
     git revert --no-edit 14dcbd98eedb2133c362c6ecbcdd043ea9516743
     ```
   - 若合入集成分支后形成 merge commit `<mergeSha>`：
     ```powershell
     git revert -m 1 <mergeSha>
     ```
