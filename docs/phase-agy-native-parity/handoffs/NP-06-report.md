# NP-06 交付报告 · 原生命令目录、路由与模型入口

## 1. 基线、分支与提交信息

| 项目 | 值 |
| --- | --- |
| Task ID | `NP-06`（原生命令目录、路由与模型入口） |
| 源码审计基线 | `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`（`main`） |
| Reviewed G1 源码验收提交 | `966451ceaa2d8cfbf268b05a973dbb400715b616` |
| Reviewed Base（`agy-np-g1` 开工点） | `b5d010ae74815a311d98090359b9d62894973024`（`docs(agy-np): freeze G1 and prepare G2 work packages`） |
| 当前工作分支 / Worktree | `np06_native_command_router` · `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np06_native_command_router`（经 junction 挂载于 `C:\Users\windfile\.gemini\antigravity\worktrees\harnessmate_desktop\np06_native_command_router`） |
| **代码与测试交付提交 SHA** | **`a977f52a3449e11b25897ee09ec3129f4742e0e9`**（`feat(agy-np-06): add native command catalog, live router, profile-scoped queries, and picker UI`） |
| 公共契约版本 | `AGY_NATIVE_CONTRACT_VERSION = 1` · `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`（零修改） |
| SQLite 组件迁移版本 | `component = 'agy-native-runtime'` · `version = 1`（零修改） |
| Plugin SDK / 旧 `/commands` enum | 零破坏性变更（旧 8 命令 enum 完整保留） |
| `MASTER_PROGRESS.md` | 未修改（按约定由总指挥统一更新） |

## 2. 实际变更路径与所有权核对

全部变更严格限制在 NP-06 允许写入范围内（`packages/protocol/**`、`packages/daemon/src/harnesses/agy/native/wiring/**`、`packages/daemon/src/core/session-manager.ts`、`packages/daemon/src/db/sqlite.ts`、`packages/web/src/components/agy/native/shared/**`、`packages/web/src/components/ChatStage.tsx`、`packages/web/src/stores/app-store.ts`、`packages/plugin-api/**` 及其他 Harness Adapter 均零改动）：

| 路径 | 类别 | 说明 |
| --- | --- | --- |
| `packages/daemon/src/harnesses/agy/native/commands/descriptors.ts` | 新增 | 官方能力目录定义（对齐 `02_Capability_Matrix.md` `AGY-*` 与 NP-02 `agy.*` 别名）、4 通道动作元数据、参数校验规范、`LIVE_ONLY_INTERACTIVE_WORKFLOW_COMMANDS` 及 NP-08–NP-12 贡献接口 `NativeWorkflowDescriptorContribution` |
| `packages/daemon/src/harnesses/agy/native/commands/catalog.ts` | 新增 | `AgyNativeCommandCatalogService`：每绑定隔离缓存键（`runtimeId/sessionId/instanceId/generation/profileRef/source/effectiveModel/effectivePermissionMode`）、运行时广告与撤销（含空表 `[]` 显式撤销）、版本号递增、实际 model/effort 提取、未知动态 slash 禁用运行 |
| `packages/daemon/src/harnesses/agy/native/commands/router.ts` | 新增 | `AgyNativeCommandRouter`（实现 `NativeCommandRouterPort`）：4 通道（`query`/`config`/`live_workflow`/`manager`）与 `executeControl`（Stop/Cancel），校验 generation、catalogRevision、用户直接来源（`assertAgyConsumerProvenance`）、Profile/Plan/Permission 与参数，交互工作流单次直走 live ACP 会话并保留 slash-first 附件顺序 |
| `packages/daemon/src/harnesses/agy/native/commands/fixtures.ts` | 新增 | `synthetic` 确定性测试夹具（明确标注 `NP06_SYNTHETIC_FIXTURE_SOURCE = 'synthetic'`） |
| `packages/daemon/src/harnesses/agy/native/commands/index.ts` | 新增 | 后端 NP-06 领域模块统一导出 |
| `packages/daemon/src/harnesses/agy-commands.ts` | 加固 | 新增 `AgyInteractiveWorkflowFallbackError` 与 `isInteractiveWorkflowSlashCommand`，阻止 `/swarm`、`/boost`、`/teamwork`、`/run-workflow`、`/schedule`、`/grill-me`（及开启 `blockGoalAuxiliaryFallback` 时的 `/goal`）落入 final-only `runAgyCommand` 辅助进程；加固 `inspectAgyCommand` 仅允许 `/usage` 与 `/skills` 且绝不传 `--conversation` |
| `packages/daemon/src/core/harness-commands.ts` | 修复/加固 | 修复 `resolveAgyLaunchContext` 在显式指定未注册 `harnessId` 时不再静默回落到默认 `'agy'`（消除多 Profile 泄漏）；新增 `listAgySkillsForSession(session)` 传递 `session.harnessId`；AGY `runPluginCommand` 隔离至当前 Profile `AgyLaunchContext`；保留 Codex/Claude 与旧 8 命令 enum 不变 |
| `packages/web/src/components/agy/native/commands/command-catalog.ts` | 新增 | 统一前端 descriptor 投影（`buildNativeCommandItems` / `buildNativeModeItems`）、`/` 检索与 lane 过滤、禁用原因文案及 `resolveActualModelEffortOptions`（严格取实际观测选项） |
| `packages/web/src/components/agy/native/commands/draft-submission.ts` | 新增 | `NativeCommandSubmissionController`：切换模式/刷新目录/409 冲突（`STALE_BINDING`/`BUSY`/`IDEMPOTENCY_CONFLICT`）保留草稿与附件顺序、重复提交复用 `idempotencyKey`、未观测模式证据时诚实显示「已发送，等待原生确认」 |
| `packages/web/src/components/agy/native/commands/AgyNativeCommandPalette.tsx` | 新增 | AGY 原生命令面板：同源 descriptor、`/` 搜索、通道筛选、参数提示、禁用原因、409 草稿保留横幅（选择仅填充草稿，绝不点击即执行或投递 shell） |
| `packages/web/src/components/agy/native/commands/AgyNativeModePicker.tsx` | 新增 | 与 `AgyNativeCommandPalette` 共用同源 descriptor 的 Mode Picker，展示计划提示、门控状态、禁用原因与官方入口 |
| `packages/web/src/components/agy/native/commands/AgyModelEffortPicker.tsx` | 新增 | 严格按实际观测选项展示模型分组与 `thought_level` 的选择器，未观测时诚实显示「未观测到思考强度选项」 |
| `packages/web/src/components/agy/native/commands/fixtures.ts` · `index.ts` | 新增 | 前端 `synthetic` 夹具与模块统一导出 |
| `packages/daemon/tests/agy-np06-command-router.test.ts` | 新增测试 | 8 项综合测试（覆盖 T01/T06/T08/T15、广告/撤销/空表、错版本/错代际、权限与计划门控、未知动态 slash、消费者来源负例、双账号隔离、`/usage` 与 `/skills` 无会话写入、重复幂等键、`runAgyCommand` 护栏、NP-08–12 贡献点及 Codex/Claude 回归） |
| `packages/web/tests/np06-native-commands-ui.test.tsx` | 新增测试 | 4 项前端专项测试（Command Palette 与 Mode Picker 同源一致性、撤销同步降级、搜索/参数提示/禁用原因、409 保留草稿与附件顺序、重复提交幂等键复用、实际 model/effort 渲染与未观测降级） |

## 3. 命令动作矩阵与已验证入口

| Capability ID | 命令 / 动作 Key | Lane | 默认状态（未广告/未验） | 运行条件与校验 | 真实执行路径与回执 |
| --- | --- | --- | --- | --- | --- |
| `AGY-S15` | `/usage` · `query_usage` | `query` | `not_tested`（需登录 Profile） | 当前绑定 `AgyLaunchContext`、无 `--conversation` | 独立只读 `inspectAgyCommand('/usage')` → `kind: 'inspect'`（`mutatedConversation: false`） |
| `AGY-E01` | `/skills` · `query_skills` | `query` | `not_tested`（非 `agy_desktop`） | 当前绑定 `session.harnessId` 隔离 Profile | 独立只读 `inspectAgyCommand('/skills')` → `kind: 'inspect'`（`mutatedConversation: false`） |
| `AGY-E01` | `/skill` · `invoke_skill` | `live_workflow` | `not_tested` | 技能存在性校验 + live 连接 + 附件有序 | 同一 live ACP 会话单次发送 → `kind: 'accepted'` |
| `AGY-S10` | `/model` · `inspect_models` / `set_model` | `config` | `inspect` 可用；`set_model` 需登录与选项校验 | 校验正则与当前绑定实际观测模型列表（不降级不换号） | `applySessionConfig('model')` → `kind: 'inspect'`（标注 `immediate/next_turn/read_only`） |
| `AGY-S12` | `/effort` · `set_effort` | `config` | `unknown`（未观测 `thought_level` 时关闭） | 严格匹配当前模型实际返回的 `availableEfforts` | `applySessionConfig('effort')` → `kind: 'inspect'` |
| `AGY-S13` | `/permissions` · `set_permission_mode` | `config` | `not_tested` → 登录后可用 | 按 `advertisedModes` 计算 `native` vs `client_guard`（绝不伪造原生 `auto`） | `applySessionConfig('permission_mode')` → `kind: 'inspect'` |
| `AGY-W13` | `/plan` · `set_plan_mode` | `config` | `not_tested` → 登录后可用 | `off` 退出；带任务时走 live 会话并保留附件顺序 | 无任务返回 `inspect`；带任务单次发往 live ACP 返回 `accepted` |
| `AGY-W04` | `/swarm` · `launch_swarm` | `live_workflow` | `unknown` / `not_tested` | 需当前绑定广播广告 + live 连接 + `task` 非空 + 用户直接来源 | 同一 live ACP 单次发送 `/swarm <task>` + 有序附件 → `kind: 'accepted'`（`modeEvidenceObserved: false`）；禁止落入 `runAgyCommand` |
| `AGY-W06` | `/boost` · `launch_boost` | `live_workflow` | `not_tested` | 需广告 + 计划资格（`Pro/Ultra/Enterprise/Business`）+ live 连接 | 同一 live ACP 单次发送 `/boost <task>` → `kind: 'accepted'`；禁止落入 `runAgyCommand` |
| `AGY-W07` | `/teamwork` · `launch_teamwork` | `live_workflow` | `not_tested` | 需广告 + 计划资格 + live 连接 | 同一 live ACP 单次发送 `/teamwork <goal>` → `kind: 'accepted'`；禁止落入 `runAgyCommand` |
| `AGY-W08` | `/run-workflow` · `launch_dynamic_workflow` | `live_workflow` | `not_tested` | 需广告 + live 连接 + `task` 非空 | 同一 live ACP 单次发送 `/run-workflow <task>` → `kind: 'accepted'`；禁止落入 `runAgyCommand` |
| `AGY-W09` | `/goal` · `launch_goal` | `live_workflow` | `unknown` | 需广告 + live 连接 + `objective` 非空 | 同一 live ACP 单次发送 `/goal <objective>` → `kind: 'accepted'`；新路由开启时不走 final-only 辅助进程 |
| `AGY-W10` | `/schedule` · `launch_schedule` | `live_workflow` | `unknown` | 需广告 + live 连接 + `when` & `task` 非空 | 同一 live ACP 单次发送 `/schedule <when> <task>` → `kind: 'accepted'`；禁止落入 `runAgyCommand` |
| `AGY-W17` | `/grill-me` · `launch_grill_me` | `live_workflow` | `unknown` | 需广告 + live 连接 | 同一 live ACP 单次发送 `/grill-me [topic]` → `kind: 'accepted'`；禁止落入 `runAgyCommand` |
| `AGY-S09` | `/compact` · `run_compact` | `live_workflow` | `unknown` | 需广告 + live 连接 + 非 `agy_desktop` | 同一 live ACP 发送 `/compact` → `kind: 'accepted'` |
| `AGY-W02/W05/W11/E05/S16` | `/agents` · `/swarm board` · `/tasks` · `/mcp` · `/credits` | `manager` | `available`（只读投影或官方指引） | 不另起竞争 CLI 进程打开原 `--conversation` | 返回投影/生态摘要 + 官方入口 → `kind: 'inspect'`（`upstreamLimited: true`, `mutatedConversation: false`） |
| `AGY-R01` / `AGY-R10` | `cancel`（`POST /native/control`） | `live_workflow` / control | `unknown` → live 连接就绪后根会话可用 | 仅对已验证的根 `runtime/activity/work` 发送取消；未证实 child `agent` 拒绝（`422`） | `dispatchNativeCancel` → `state: 'requested'`（绝不伪造 `applied`） |
| `AGY-DYN-*` | 未知动态广告 slash | `live_workflow` | `unsupported`（`unknown_dynamic_slash_disabled`） | 仅可检视，严格禁止运行与 shell 转发 | 任何执行请求均拒绝 `422 UNSUPPORTED_ACTION` |

## 4. 测试验证、验证类别与证据分级

### 4.1 执行命令与结果（均在 `a977f52a3449e11b25897ee09ec3129f4742e0e9` 源码上验证）

| 命令 | 退出码 | 结果摘要 | 验证类别 |
| --- | --- | --- | --- |
| `pnpm typecheck` | `0` | 6/6 workspace 包零错误（`plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web`, `electron`） | `synthetic`（静态类型） |
| `pnpm build` | `0` | 6/6 workspace 包构建成功（含 `web` Vite 产物） | `synthetic`（构建） |
| `pnpm contracts:check` | `0` | Plugin SDK 契约校验通过，零破坏 | `synthetic`（契约） |
| `pnpm --filter @harnessmate/daemon test -- tests/agy-np06-command-router.test.ts` | `0` | **8/8** NP-06 后端专项测试通过（T01/T06/T08/T15、广告/撤销/空表、双账号隔离、无会话写入、重复幂等键、负例） | `synthetic` |
| `pnpm --filter @harnessmate/web test -- tests/np06-native-commands-ui.test.tsx` | `0` | **4/4** NP-06 前端专项测试通过（同源 descriptor、搜索/禁用原因/参数提示、409 保留草稿、实际 model/effort） | `synthetic` |
| `pnpm test`（全量门禁） | 见注 | `protocol` **6/6**、`web` **75/75**（14/14 文件）、`daemon` 首次并发运行 **167/169**（32/34 文件，含 `agy-replay-protocol` 2/2、`adapters-codex` 5/5、`adapters-claude` 4/4、`adapters-acp` 4/4、`unified-context-bridge` 3/3、`daemon` 6/6、`agy-np02-*` 9/9、`agy-np-observatory` 18/18） | `synthetic` + `replay_with_provenance` |
| `pnpm --filter @harnessmate/daemon test -- tests/multi-harness-orchestrator.test.ts tests/phase3-external-adapters.test.ts` | `0` | 复跑并发高负载下超时的 2 个文件：**11/11**（6/6 + 5/5）全部通过，全仓合计 **250/250** 通过 | `synthetic` |
| `git diff --check` | `0` | 无空白符或冲突标记 | 静态检查 |

> 注：全量 `pnpm -r test` 并行执行时 Windows CPU 争用导致 `multi-harness-orchestrator.test.ts` 30s 超时与 `phase3-external-adapters.test.ts` Git checkpoint 竞态；单独复跑该 2 个文件 11/11 一次通过，且均未涉及 NP-06 改动路径。

### 4.2 未执行的检查与真机证据缺口

- **未执行真机授权模型的 `live_raw` / `live_hm` / `official_comparison` 采样**：按 `U01`、`G2_Launch_Plan.md` 与 `12_Test_Strategy.md`，Gemini 3.8 Flash 真机能力发现与 20 秒有限后台复现由统一授权通道在专用已登录 Profile 上集中执行，本独立工作包不消耗测试额度、不触碰用户生产账号与默认 Profile。
- **能力矩阵等级保持诚实**：本次验证类别为 `synthetic` 与 `replay_with_provenance`（`E05` 既有 AGY 1.5.14 回放不回归），**不抬升任何能力矩阵的实机等级**；所有真实运行能力仍以对应绑定实际观测到的 `available_commands_update` 与 `configOptions` 为准。

### 4.3 覆盖的 Capability ID、源码证据与风险项

- Capability ID：`AGY-R01`、`AGY-R06`、`AGY-R07`、`AGY-R10`、`AGY-W01`、`AGY-W02`、`AGY-W04`、`AGY-W05`、`AGY-W06`、`AGY-W07`、`AGY-W08`、`AGY-W09`、`AGY-W10`、`AGY-W11`、`AGY-W13`、`AGY-W17`、`AGY-S09`、`AGY-S10`、`AGY-S12`、`AGY-S13`、`AGY-S15`、`AGY-S16`、`AGY-E01`、`AGY-E05`
- 源码审计对应：`S12`、`S13`、`S20`、`S24`
- 风险缓解：`R-07`（消费者 OAuth 来源边界）、`R-08`（多 Profile 隔离，消除默认 `'agy'` 静默回落）、`R-10`（付费模式资格门控）、`R-11`（旧 `/commands` 与其他 Harness 零回归）、`R-14`（幂等与无双发送）、`R-15`（严格文件所有权隔离）

### 4.4 数据与其他 Harness 回归结论

- **旧 DB / 已记录 Runs**：未修改 SQLite schema，关闭 `nativeCommands` 门控时 `/native/commands` 返回 `503 NATIVE_RUNTIME_DISABLED`，旧 `/commands` 与既有 runs 零影响。
- **其他 Harness 回归**：`adapters-codex.test.ts` (5/5)、`adapters-claude.test.ts` (4/4)、`adapters-acp.test.ts` (4/4)、`phase3-external-adapters.test.ts` (5/5)、`unified-context-bridge.test.ts` (3/3)、`multi-harness-orchestrator.test.ts` (6/6)、`agy-replay-protocol.test.ts` (2/2) 及 `packages/web` 全套 75 项测试全部通过。

## 5. 共享接口协作与变更提议（G2 集中接线清单）

本工作包严格不越界修改共享文件，向对应 owner 提出以下 4 项最小变更提议：

1. **NP-02 / 总指挥（`packages/daemon/src/core/session-manager.ts:1589` — 多 Profile skills `harnessId` 传递）**
   - **现状**：`session-manager.ts:1589` 调用 `tools.listAgySkills(session.cwd)`，未传入 `session.harnessId`（见审计 `S13`）。
   - **提议**：改为 `await tools.listAgySkillsForSession(session)`（或 `await tools.listAgySkills(session.cwd, session.harnessId)`）。
   - **已附用例**：`packages/daemon/tests/agy-np06-command-router.test.ts` 中 `isolates /usage and /skills per profile harnessId without writing conversation and refuses silent fallback to default agy` 已验证 `HarnessCommandTools.listAgySkillsForSession` 与 `listAgySkills(cwd, harnessId)` 的双 Profile 严格隔离。
2. **NP-02 / 总指挥（`packages/daemon/src/harnesses/agy/native/wiring/routes.ts:120-154` — Capability ID 别名统一与控制鉴权）**
   - **现状**：`routes.ts` 中 `isControlAuthorizedByCatalog` 仅匹配 `agy.acp.v1` / `agy.reactive*` / `agy.subagents` / `agy.workflow.*`，而 `02_Capability_Matrix.md` 与 NP-03 `AgyAgentModePicker.tsx` 使用 `AGY-R01` / `AGY-R10` / `AGY-W01` / `AGY-W04`–`AGY-W10`。
   - **提议**：在 `isControlAuthorizedByCatalog` 中同步兼容 `AGY-R01`、`AGY-R03`、`AGY-R10`、`AGY-W01`、`AGY-W04`–`AGY-W10`（NP-06 后端与前端已内置双向别名映射），并在 `SessionManager`/启动接线中通过 `nativeRegistry.registerModules({ commandRouter })` 注册 `AgyNativeCommandRouter`，同时把 ACP `available_commands_update` / `configOptions` 观测回调喂入 `AgyNativeCommandCatalogService`。
3. **NP-03（Composer shell 接入）**
   - **提议**：在 `ChatStage.tsx` / `AgyComposerControls.tsx` 的 feature-gated 分支中挂载 `packages/web/src/components/agy/native/commands` 导出的 `AgyNativeCommandPalette`、`AgyNativeModePicker`、`AgyModelEffortPicker` 与 `NativeCommandSubmissionController`，使面板与模式选择器共用同一 `nativeSlice.capabilities` 与 `capabilitiesRevision`。
4. **NP-08–NP-12（Workflow Descriptor 贡献约定）**
   - **提议**：各模式工作包仅通过 `catalog.registerWorkflowDescriptor(contribution)` 贡献自身能力描述与实证门控，不单独创建全局命令执行器。

## 6. 审查者复验命令与回滚方案

### 6.1 独立审查者复验命令

```powershell
git status --short --branch
git diff --name-status b5d010ae74815a311d98090359b9d62894973024..a977f52a3449e11b25897ee09ec3129f4742e0e9
git diff --check b5d010ae74815a311d98090359b9d62894973024..a977f52a3449e11b25897ee09ec3129f4742e0e9
pnpm typecheck
pnpm build
pnpm contracts:check
pnpm --filter @harnessmate/daemon test -- tests/agy-np06-command-router.test.ts tests/agy-replay-protocol.test.ts tests/adapters-codex.test.ts tests/adapters-claude.test.ts tests/adapters-acp.test.ts
pnpm --filter @harnessmate/web test -- tests/np06-native-commands-ui.test.tsx tests/np03-workbench-ui.test.tsx tests/phase-agy-ui.test.tsx
```

### 6.2 回滚策略与命令

1. **优先功能门控回退（无损，保留所有已记录 runs 与旧 `/commands` 查询）**：
   - 将 `AgyNativeFeatureFlags.nativeCommands` 保持/切回 `false`（默认即 `false`），`POST /api/v1/sessions/:id/native/commands` 与 `/control` 立即返回 `503 NATIVE_RUNTIME_DISABLED`，旧 `/commands` 静态目录、`/usage`、`/skills` 与既有运行记录均不受影响。
2. **代码提交回滚**：
   - 仅回滚 NP-06 代码与测试提交：
     ```powershell
     git revert --no-edit a977f52a3449e11b25897ee09ec3129f4742e0e9
     ```
   - 如需连同本交付报告一起回滚，先逆序 `git revert` 报告提交再回滚 `a977f52a3449e11b25897ee09ec3129f4742e0e9`；若已通过 merge commit 合入集成分支，则使用：
     ```powershell
     git revert -m 1 <mergeCommitSha>
     ```
