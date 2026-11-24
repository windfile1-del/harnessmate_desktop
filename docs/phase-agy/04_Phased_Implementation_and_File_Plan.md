# 04 · 分阶段实施计划与修改文件清单

Phase AGY 拆分为 **6 个可独立编译、测试、提交的增量阶段**。每个阶段完成时必须满足：
1. `pnpm build` 通过；
2. `pnpm typecheck` 通过；
3. `pnpm contracts:check` 通过；
4. 该阶段对应单元测试与回归测试通过；
5. 严格标注 `[自动化验证]` 与 `[待真机验证]`，严禁将 Mock/回放通过混同于 Windows 真机验收。

---

## Phase AGY-1：`AgyLaunchContext`、Driver 拆分与 Profile 隔离基础底座

**目标**：将 AGY 专有逻辑从通用 `acp-adapter.ts` 拆出，建立统一的 `AgyLaunchContext` 与 `AgyProfileManager`，修复 `agy-commands.ts` 顶层 CLI 传 `--app-data-dir` 缺陷，打通 `HarnessRegistry.registerDriver('agy', ...)` 多实例持久化。

### 精确文件清单
| 操作 | 包 / 路径 | 职责与主要符号 |
| --- | --- | --- |
| 新增 | `packages/daemon/src/harnesses/acp/strict-acp-adapter.ts` | 纯严格标准 ACP 实现（零 AGY/vendor 分支），供 `acp` 与自定义 ACP 实例使用 |
| 保留兼容 | `packages/daemon/src/harnesses/acp-adapter.ts` | 薄兼容层（重导出 `AcpAdapter` / `parseAcpModelCatalog` / `mapAcpConfigOptionsToDescriptors` 等，确保现有引用与测试平滑过渡） |
| 新增 | `packages/daemon/src/harnesses/agy/agy-launch-context.ts` | `AgyLaunchContext`、18+ 环境变量剥离表、`SSH_CONNECTION` 受控注入、`buildAcpArgs` vs `buildCliArgs` 隔离 |
| 新增 | `packages/daemon/src/harnesses/agy/agy-profile-manager.ts` | Profile 目录 SHA-256 哈希分配、Windows `icacls` 私有 ACL 加固、Windows junction 共享全局 Skills、受控规则文件拷贝（`.hm-rule-copies.json`） |
| 新增 | `packages/daemon/src/harnesses/agy/agy-driver.ts` | `createAgyDriverFactory`、`AgyAdapter`（封装 ACP + AGY 策略，统一走 `AgyLaunchContext`） |
| 修改 | `packages/protocol/src/canonical.ts` | 增量新增 `AgyAuthMethodSchema`、`AgyIsolationModeSchema`、`AgyAccountDefaultsSchema`、`AgyAccountIdentitySchema`、`AgyProfileConfigSchema` |
| 修改 | `packages/daemon/src/config.ts` | `DaemonPersistedConfig` 增加 `agyProfiles?: AgyProfileConfig[]`（或沿用并规范 `harnessInstances` 持久化） |
| 修改 | `packages/daemon/src/harnesses/agy-commands.ts` | 移除顶层 `agy` 调用中的 `--app-data-dir` 非法参数；接入 `AgyLaunchContext`；增加未登录快速检测 |
| 修改 | `packages/daemon/src/harnesses/history-scanner.ts` | 支持按 `AgyProfileConfig[]` 扫描多个隔离 Profile 目录的会话索引与只读记录 |
| 修改 | `packages/daemon/src/plugin-host/builtin/services.ts` | 为 `'agy'` 注册 `registerDriver('agy', ...)` 并实例化默认及配置中的多个 AGY 实例 |
| 新增测试 | `packages/daemon/tests/agy-launch-context.test.ts` | 环境变量剥离、ACL/路径隔离、`buildCliArgs` 禁止 `--app-data-dir`、`StrictAcp` 零 vendor 逻辑校验 |

**独立提交**：`feat(agy-1): decouple AGY driver from strict ACP and introduce AgyLaunchContext & profile isolation`

---

## Phase AGY-2：多 Google 账户官方登录、身份校验、用量采集与手动切换 API

**目标**：实现官方 `agy acp --login`（code-paste）与 ACP `logout` 流程、Profile 身份指纹校验、官方 `agy -p /usage --output-format json` 用量接入，以及实例 CRUD 与手动一键切换 API（含禁止同驱动自动轮换守卫）。

### 精确文件清单
| 操作 | 包 / 路径 | 职责与主要符号 |
| --- | --- | --- |
| 新增 | `packages/daemon/src/harnesses/agy/agy-auth-service.ts` | `AgyAuthService` 登录/登出状态机、OAuth URL/state/code 严格解析校验、身份一致性核对、登出前停止实例会话 |
| 新增 | `packages/daemon/src/harnesses/agy/agy-usage.ts` | 基于 `AgyLaunchContext` 调用官方 `agy -p /usage --output-format json` 解析 5h/weekly 桶及 Tier；未登录快速返回不挂起 |
| 修改 | `packages/daemon/src/harnesses/agy/agy-driver.ts` | 实现 `readUsageLimits()` 委托 `agy-usage.ts`，暴露 `authService` 供 API 调用，支持会话初始化前后身份校验 |
| 修改 | `packages/daemon/src/core/failover-service.ts` | 强制护栏：当 `failedInstance` 与候选均为 `driverId === 'agy'` 时，`canAutoFailover = false`，`downgradedToManualReason` 提示“多 AGY 账号仅支持手动一键切换，禁止自动额度轮换” |
| 修改 | `packages/daemon/src/core/harness-commands.ts` | `getUsage()` / `listAgySkills()` 通过对应实例 `AgyLaunchContext` 执行 |
| 修改 | `packages/daemon/src/server/app.ts` & `ws.ts` | 新增实例管理与 AGY 认证路由（`POST/DELETE /api/v1/harnesses/agy/instances`、`POST .../auth/{start,respond,cancel,logout}`、WS 状态推送） |
| 修改 | `packages/protocol/src/canonical.ts` & `remote-v1.ts` | 增量定义实例增删、Auth 状态 DTO 与请求 Zod Schema |
| 新增测试 | `packages/daemon/tests/agy-auth-usage.test.ts` | `--login` URL 校验与恶意重定向拦截、未登录 `/usage` 不挂起、`FailoverCoordinator` 同驱动 AGY 自动轮换拦截测试 |

**独立提交**：`feat(agy-2): add multi-account AGY auth flow, official usage probe, and manual-only switch guard`

---

## Phase AGY-3：三层配置作用域、动态模型/思考强度/Orchestrator 与斜杠命令

**目标**：实现 Account / Session / Turn 三层配置作用域、per-model `thought_level` 动态观测与后端确认、Orchestrator 分组标识、权限模式诚实降级与 `agy.security.warning` 提取、动态 `available_commands_update` 融合。

### 精确文件清单
| 操作 | 包 / 路径 | 职责与主要符号 |
| --- | --- | --- |
| 新增 | `packages/daemon/src/harnesses/agy/agy-config-scope.ts` | Account/Session/Turn 三层配置合并与 Turn 结束回退解析器 |
| 修改 | `packages/daemon/src/harnesses/agy/agy-driver.ts` | 实现 per-model `thought_level` 观测与缓存、Orchestrator 分组归类（`Orchestrator`）、版本化 `clientInfo`、动态 `availableCommands` 状态同步、`agy.security.warning` 提取、真实 `auto` 模式检查与 `client_guard` 诚实标注 |
| 修改 | `packages/daemon/src/harnesses/types.ts` | 扩展 `AdapterSessionHandle` / `NormalizedAdapterEvent` 可选字段（如 `config.confirmed`、`commands.updated`、`session.title_updated`） |
| 修改 | `packages/daemon/src/core/session-manager.ts` | 支持三层配置应用、记录后端确认模型与思考档位、合并实例动态上报的 `availableCommands` 至 `getHarnessCommands()` |
| 修改 | `packages/protocol/src/canonical.ts` | 增量扩展 `CanonicalEventTypeSchema` / `SessionSchema` 可选确认配置与权限执行模式字段 |
| 新增测试 | `packages/daemon/tests/agy-config-scope.test.ts` | 三层作用域优先级与回退、切模型后 `thought_level` 刷新、未知/失效选项跳过、`auto` 模式缺失时降级测试 |

**独立提交**：`feat(agy-3): implement 3-tier AGY config scope, dynamic thinking levels, orchestrator metadata, and live commands`

---

## Phase AGY-4：原生事件投影、Steering、后台任务、子 Agent、结构化问题与中断恢复

**目标**：补齐 `usage_update`、`session_info_update`、`Run update_steps`、`interaction_*`、后台命令/`schedule` 跨 Turn 续流、Mid-turn Steering、原生子 Agent 与 `conversations/<id>.db` 静默错误只读诊断。

### 精确文件清单
| 操作 | 包 / 路径 | 职责与主要符号 |
| --- | --- | --- |
| 新增 | `packages/daemon/src/harnesses/agy/agy-protocol.ts` | `usage_update` / `session_info_update` / `update_steps` / `interaction_*` / `invoke_subagent` / `schedule` / `client_view_file` 修复 / 长文本裁剪 |
| 新增 | `packages/daemon/src/harnesses/agy/agy-child-work.ts` | 只读遍历 `brain/<id>/.system_generated/`（`lstat`+`realpath` 守卫）查询子 Agent 步骤与未读高优唤醒 |
| 新增 | `packages/daemon/src/harnesses/agy/agy-turn-outcome.ts` | 只读比对 `conversations/<id>.db` 错误步，捕获静默 `QUOTA_EXHAUSTED` / `429` / `INVALID_THINKING_SIGNATURE` |
| 修改 | `packages/daemon/src/harnesses/agy/agy-driver.ts` | 集成上述协议增强、版本门控 `supportsActiveSteering`（`agy >= 1.5.0`）、`postSettleContinuation`（30 分钟命令保活）及安全 `clientFileReads` |
| 修改 | `packages/daemon/src/core/session-manager.ts` | 允许 `supportsActiveSteering` 实例在 `running` 态下发 Steering；处理 `session_info_update` 标题同步；完善后台续流 Turn 归档与 `INVALID_THINKING_SIGNATURE` 重建恢复 |
| 修改 | `packages/daemon/src/server/app.ts` | 暴露只读 AGY 子 Agent 轨迹详情查询端点 `GET /api/v1/sessions/:id/agy/subagents/:toolCallId`（含严格路径验证） |
| 新增测试 | `packages/daemon/tests/agy-lifecycle-events.test.ts` | 覆盖 Steering、`interaction_*` -> `user_question`、后台续流、`update_steps`、子 Agent 只读轨迹与静默错误识别 |

**独立提交**：`feat(agy-4): add AGY native event projection, steering, child-work observation, and turn outcome recovery`

---

## Phase AGY-5：V5 UI 插槽体验（Composer / Studio / Artifact Review / Usage Center）与生态集成

**目标**：在不修改插件 SDK 核心契约的前提下，基于既有 V5 UI 插槽实现 Antigravity 2.0 级原生体验与生态边界清晰展示。

### 精确文件清单
| 操作 | 包 / 路径 | 职责与主要符号 |
| --- | --- | --- |
| 新增 | `packages/daemon/src/harnesses/agy/agy-artifacts.ts` | 只读扫描 `brain/<nativeSessionId>/` 产物文件（Markdown/Mermaid/Diff，含路径校验与大小上限） |
| 新增 | `packages/daemon/src/harnesses/agy/agy-ecosystem.ts` | 聚合 Projects (`additionalDirectories`)、Rules、Skills、Global MCP、AGY Hooks 与 `agy plugin list --json` 只读快照 |
| 修改 | `packages/daemon/src/server/app.ts` | 新增 `GET /api/v1/sessions/:id/agy/artifacts` 与 `GET /api/v1/sessions/:id/agy/ecosystem` |
| 修改 | `packages/web/src/api/client.ts` & `stores/app-store.ts` | 对接 AGY Profile 管理、登录流、Steering 发送状态、Artifact 与生态 API |
| 新增 | `packages/web/src/components/agy/AgySettingsSlot.tsx` | 挂载至 `harness.settings` (`key: 'agy'`)：多 Google 账号 Profile 管理、官方 `--login` 交互弹窗、隔离状态与登出警示 |
| 新增 | `packages/web/src/components/agy/AgyComposerControls.tsx` | 挂载至 `composer.traits` / `composer.actions`：账号切换胶囊、动态思考、Orchestrator 标签、运行中锁定提示、Steering 标示 |
| 新增 | `packages/web/src/components/agy/AgyStudioBlocks.tsx` | 挂载至 `chat.block`（`ext:agy.*`）：Plan 步骤卡、Subagent 折叠组、后台任务条、Artifact 快捷卡 |
| 新增 | `packages/web/src/components/agy/AgyArtifactReviewPanel.tsx` | 挂载至 `inspector.tabs`：产物浏览、行级评论草稿收集与回复回注、Approve/Reject 快捷操作 + 生态边界面板 |
| 修改 | `packages/web/src/components/UsageDashboardModal.tsx`（或对应组件）& `ChatStage.tsx` | 展示多 AGY Profile 5h/Weekly 配额与“手动切换账号”（禁用自动轮换开关提示）、运行中锁定与 Steering 交互 |
| 修改 | `packages/web/src/slots/slot-registry.ts`（或内置插件注册入口） | 注册第一方 AGY V5 插槽视图 |
| 新增测试 | `packages/web/tests/phase-agy-ui.test.tsx` | 覆盖 AGY Settings、Composer 三层配置/锁态、Studio 块渲染、Artifact 行级评论回注、Usage Center 禁自动轮换 |

**独立提交**：`feat(agy-5): build AGY Native Composer, Studio blocks, Artifact Review, Usage Center, and ecosystem view`

---

## Phase AGY-6：真实协议录制回放、Windows 端到端账户隔离验收与全量回归

**目标**：建立脱敏真实 `agy 1.5.14` 协议录制回放库、Windows 双 Google 账号真机隔离验收脚本及 Phase 0–4 全量回归测试矩阵，形成可审计的验收报告。

### 精确文件清单
| 操作 | 包 / 路径 | 职责与主要符号 |
| --- | --- | --- |
| 新增 | `packages/daemon/tests/fixtures/agy-1.5.14/*.ndjson` | 真实脱敏 `agy.exe 1.5.14` JSON-RPC 录制夹具（initialize / session/new / 思考切换 / 审批+warning / interaction_* / update_steps / usage_update / auth_required） |
| 新增 | `packages/daemon/tests/agy-replay-protocol.test.ts` | 离线确定性协议回放测试套件 |
| 新增 | `scripts/verify-agy-windows-isolation.mjs` | Windows 真机端到端多账号隔离验证脚手架（需人工完成 2 个 Google 账号 OAuth 登录后自动断言 token 隔离、配额独立、登出互不干扰、Handoff 切换） |
| 新增 | `docs/phase-agy/06_Acceptance_Report.md` | 最终验收报告（严格区分 `[自动化验证]` 与 `[已真机验证]`，任何未测项显式标红留痕） |

**独立提交**：`test(agy-6): add real AGY 1.5.14 replay suite, Windows isolation E2E script, and full regression report`
