# Phase AGY（Native Experience & Account Isolation）专项开发前置调研、架构设计与验收蓝图 — 总览索引

> **编写日期**：2026-11-25  
> **目标仓库**：`d:\HarnessMate\harnessmate_desktop`（基线版本 `0.6.0`，Git Commit `ac84f37`，Phase 0–4 已合入）  
> **参考上游**：
> - **T3 Code (`pingdotgg/t3code`) `main` 分支**（含 Issue `#37587`、PR `#39485`、`AntigravityDriver.ts`、`AntigravityAuth.ts`、`antigravityAuthSupport.ts`、`antigravityUsageLimits.ts`、`AntigravityAcpSupport.ts`、`AntigravityProtocol.ts`、`AntigravityChildWork.ts`、`AntigravityTurnOutcome.ts`、`AntigravityAdapterV2.ts`）
> - **Google Antigravity 2.0 官方文档 & Changelog**（`antigravity.google/docs/cli/reference.md`、`docs/cli/acp.md`、`docs/ide/extensions/acp.md`、`docs/install.md`、`docs/models.md`、`docs/projects.md`、`docs/artifact-review.md`、`docs/cli/artifacts.md`、`docs/changelog.md` 截至 Antigravity App `v2.35.0` & CLI `v1.5.12+`）
> - **Google Antigravity CLI Issue `#1610`**（`google-antigravity/antigravity-cli#1610`：1.5.x 单一全局 keyring 导致多 Profile 串号缺陷）
> - **Windows 本机实测基线**：`agy.exe` `1.5.14`（`C:\Users\windfile\AppData\Local\agy\bin\agy.exe`）

---

## 一、不可违背的架构与合规红线

Phase AGY 是基于 HarnessMate Desktop 现有 Phase 0–4 架构的**增量专项演进**，在全部设计与后续编码阶段必须严格遵守以下红线：

1. **增量演进、禁止推倒重写**：
   - 完整保留 **Plugin SDK V5**（`packages/plugin-api` / `packages/plugin-sdk` / 隔离进程运行时 / 5 个 V5 UI 插槽）、**Canonical Event**、**TurnBlock V2**（`turn_items` 物化投影 + `CommandOutputHub`）、**Context Handoff V2**（水位线增量同步、脱敏、不确定投递熔断）、**HarnessInstanceRegistry**（`instanceId` + `driverId` + `continuationKey`）、**Git Checkpoints**（隐藏 ref 原子回滚守卫）和 **Multi-Harness Orchestrator**（Scenario D 并行工作树编排）。
2. **协议诚实原则、禁止伪造原生能力**：
   - 严格区分 **ACP JSON-RPC 原生暴露**、**官方 CLI 可调用**、**Profile 磁盘只读观测** 与 **官方客户端独有能力**；
   - 客户端独有能力（如内置 Chrome Profile/Browser 录制器、Voice Live、云端 Remote Agents 管理控制台、App 自由搭配任意 Executor 模型的 Orchestrator 面板）**绝不伪造模拟**；
   - 未实际暴露于 ACP 的权限模式（如非沙箱环境下的 `auto`）必须诚实标注为 `client_guard` 或不提供，绝不欺骗上层。
3. **账号隔离与平台合规红线**：
   - **禁止** 反向代理、中转 API、劫持流量；
   - **禁止** 自动跨账号额度轮换（`FailoverCoordinator` 对同 `driverId === 'agy'` 的多 Google 账户强制降级为人工确认手动切换，绝不自动轮换）；
   - **禁止** 自行实现 Google OAuth 客户端或伪造 `client_id` / `client_secret` / 私有协议抓包；
   - **禁止** 跨账户复制、共享或复用 OAuth 凭据文件或系统 Keyring 条目。
4. **真实验收诚实原则**：
   - 每个阶段独立提交，且必须通过 `pnpm build`、`pnpm typecheck`、`pnpm contracts:check` 和相关自动化测试；
   - **未经真机环境验证的功能必须明确标记为 `[待真机验证]`**，绝不得将 Mock / 录制回放测试通过描述为 Windows 真实环境验收成功。

---

## 二、前置审查与 Windows `agy.exe 1.5.14` 真机实测核心发现

1. **Windows 1.5.14 复现 `antigravity-cli#1610` 与 PR `#39485` 隔离机制已实证** `[已真机验证 Windows agy 1.5.14]`：
   - 对空 Profile 目录执行 `agy.exe acp --stdio --gemini-dir <profileDir> --app-data-dir antigravity-acp` 并仅设置 `AGY_ACP_FORCE_FILE_STORAGE=1` 时，`agy 1.5.14` 仍调用 Windows Credential Manager（`keyring.go:64] keyringAuth: loaded token`），自动以全局已登录账户静默通过认证；
   - 在完全相同的空 Profile 注入 `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0` 后，日志确认 `composite_token_storage.go:176] Using file-based token storage because SSH session detected`，`session/new` 立即返回 `-32000 Authentication required`；
   - 执行 `agy.exe acp --gemini-dir <profileDir> --app-data-dir antigravity-acp --login` 时，进程在 stdout 输出官方 Google OAuth PKCE 链接（`redirect_uri=https://antigravity.google/oauth-callback`）并等待粘贴 code/URL，不弹出本机默认浏览器。
2. **发现现网破坏性 Bug：`agy-commands.ts` 向顶层 `agy` 传递非法参数** `[HarnessMate 现状审计]` `[已真机验证 Windows agy 1.5.14]`：
   - 现有 `packages/daemon/src/harnesses/agy-commands.ts`（L25-27、L55-57）在调用 `agy -p /usage`、`agy -p /skills` 与 `agy -p /compact` 时追加了 `--app-data-dir`；
   - 在 `agy.exe 1.5.14` 实测直接失败退出码 `2`：`flags provided but not defined: -app-data-dir`（`--gemini-dir` 同理）；仅 `agy acp` 子命令接收 `--gemini-dir` 与 `--app-data-dir`，顶层 `agy` CLI 必须通过 `GEMINI_HOME` 环境变量传递目录边界。
3. **发现 CLI 生态边界差异：`agy mcp list` 不受 `GEMINI_HOME` 隔离** `[已真机验证 Windows agy 1.5.14]`：
   - 在隔离 `GEMINI_HOME` + `SSH_CONNECTION` 环境下，`agy models`、`agy -p /usage`、`agy -p /skills` 均遵循隔离环境要求登录，但 `agy mcp list` 依然读取全局用户配置并列出本机全部 MCP 服务器；
   - 此外，未登录 Profile 调用 `agy -p /usage --output-format json` 时，CLI 会在 stderr 打印 OAuth 登录链接并阻塞等待 stdin 直到 `--print-timeout` 超时退出（`exit=null`），必须做非交互早退检测与前置登录检查。
4. **ACP 协议真实能力与现有 `acp-adapter.ts` 的显著缺口** `[HarnessMate 现状审计]` `[已真机验证 Windows agy 1.5.14]`：
   - `agy 1.5.14` 的 `initialize` 与 `session/new` 原生返回：`agentCapabilities.auth.logout`、`agentCapabilities._meta.antigravity.{tier,systemPrompt.append}`、`sessionCapabilities.{resume,close,load,list,additionalDirectories}`、11 个基础模型（含 3 个 Orchestrator：`gemini-pro-orchestrator-neon`、`gemini-pro-orchestrator`、`gemini-pro-orchestrator-argon`）、动态 `thought_level`（`low`/`medium`/`high`/`xhigh`）、`_meta.antigravity.tier`、`available_commands_update` 与 `usage_update`（`used`, `size: 1048576`）；
   - 现有 `acp-adapter.ts` 遗漏或错误处置了：`usage_update`、`session_info_update`、`available_commands_update`（误写为聊天时间线 `turn_block.ext`）、`Run update_steps`（未转为结构化 Plan）、`interaction_*` 结构化提问、`agy.security.warning`、`invoke_subagent` 批处理追踪、后台命令/定时唤醒（`postSettleContinuation`）、Mid-turn Steering（`agy >= 1.5.0`）、以及 `conversations/<id>.db` 静默错误检测。
5. **T3 Code 方案不可直接照搬的部分**：
   - T3 Code 的 `antigravityUsageLimits.ts` 通过 `ffi-rs` 直读 Windows Credential Manager 并以硬编码 `User-Agent` 调用 `v1internal:retrieveUserQuotaSummary` / `oauth2.googleapis.com/token`；
   - 为严格守住“禁止自行实现 OAuth 刷新与私有接口抓包、优先采用官方 CLI/协议能力”红线，HarnessMate Phase AGY **优先采用官方 `agy -p /usage --output-format json`** 获取模型配额分组、剩余比例与重置时间，并将“跨子命令共享 Profile Token 文件兼容性”列为 Phase AGY-1/2 首要真机验证项。

---

## 三、状态与置信度标签规范

全套文档严格使用以下六类标签区分已验证事实与待验证方案：

| 标签 | 含义 |
| --- | --- |
| **`[已真机验证 Windows agy 1.5.14]`** | 已在本机 Windows 环境通过 `agy.exe 1.5.14` 实测命令/JSON-RPC 抓包直接观察到输出与日志 |
| **`[官方文档已核验]`** | 已核对 `antigravity.google` 最新官方文档或 `changelog.md` 原文 |
| **`[T3 Code main 源码已核验]`** | 已在 `pingdotgg/t3code` `main` 分支源码及 Issue `#37587`/PR `#39485` 中逐行核验 |
| **`[HarnessMate 现状审计]`** | 已在 `d:\HarnessMate\harnessmate_desktop` 现行源码中逐行读取核实 |
| **`[待真机验证]`** | 依赖人工交互 OAuth 登录后方可在双账号真机上验证的闭环行为 |
| **`[官方客户端独有-禁止伪造]`** | 仅存在于 Antigravity App 2.0 / IDE / TUI 的能力，不在 HarnessMate 伪造 |

---

## 四、前置设计文档导航表

| 序号 | 文档 | 核心内容 |
| --- | --- | --- |
| 00 | [00_INDEX.md](./00_INDEX.md) | 总览索引、架构合规红线、实测核心发现、Decision Gate |
| 01 | [01_Source_Audit_and_Protocol_Verification.md](./01_Source_Audit_and_Protocol_Verification.md) | HarnessMate 源码逐行审查、T3 Code `main` + PR `#39485` + Issue `#37587`/`#1610` 深度剖析、Antigravity 2.0 文档核验与 Windows `agy 1.5.14` 实测证据、官方能力四级归属清册 |
| 02 | [02_Feature_Gap_Matrix.md](./02_Feature_Gap_Matrix.md) | 覆盖 7 大目标的 35+ 项细粒度功能差距矩阵（官方归属、体验对标、T3 Code 对比、HarnessMate 现状、Phase AGY 目标、阶段归属与验证状态） |
| 03 | [03_Architecture_and_Interface_Design.md](./03_Architecture_and_Interface_Design.md) | 增量架构图（Mermaid）、`AgyLaunchContext` 与 `AgyProfileConfig` 接口、官方 `--login`/登出/身份校验状态机、Driver 拆分、三层配置作用域、事件投影与生命周期、V5 UI 插槽映射、生态边界 |
| 04 | [04_Phased_Implementation_and_File_Plan.md](./04_Phased_Implementation_and_File_Plan.md) | Phase AGY-1 至 Phase AGY-6 分阶段实施路线、每阶段精确修改/新增文件清单、独立提交策略与构建测试门禁 |
| 05 | [05_Test_Plan_and_Security_Risk_Register.md](./05_Test_Plan_and_Security_Risk_Register.md) | 单元测试、真实 AGY 协议录制回放、Windows 双账号隔离端到端验收、全量回归矩阵，以及独立安全评估与 8 项风险登记册 |

---

## 五、启动 Phase AGY-1 前的 Decision Gate（请用户确认）

在进入代码实施阶段（Phase AGY-1）之前，以下 3 项关键设计决策请审阅确认：

1. **多账号隔离双模式默认策略**：
   - 默认内置的 `agy` 主实例保持 `isolationMode: 'official_default'`（不强制改变用户既有本机 `agy` / IDE 共享 Keyring 行为，零破坏性升级）；
   - 用户新增的第 2+ 个 AGY Google 账号实例（或用户显式点击“新建隔离账号 Profile”）使用 `isolationMode: 'profile_isolated'`（独立 `geminiDir` + Windows NTFS ACL 加固 + `SSH_CONNECTION` 文件存储隔离 + 官方 `--login` code-paste 流程）。
   - *待确认*：是否认可“默认主实例保留官方默认凭据模式，新增/显式切换为隔离 Profile 时启用 `profile_isolated`”的策略，避免升级后强制让原有单账号用户重新登录？
2. **用量/额度查询路径选择（合规优先）**：
   - 采用官方 CLI `agy -p /usage --output-format json` 作为首选额度探测器（而非仿照 T3 Code 直连 `v1internal:retrieveUserQuotaSummary` 与读取底层 keyring 二进制结构）；
   - *待真机闭环验证*：在双账号完成真实 `--login` 后，验证 `GEMINI_HOME=<profileDir>` + `appDataDir=antigravity-cli` 下 `agy -p /usage --output-format json` 是否直接读取该 Profile 的 `antigravity-oauth-token`（若受上游限制不读取，再于 Phase AGY-2 决策仅以本地账本 + ACP 会话状态展示，绝不私自调用未公开后端 API 或复制 token）。
3. **跨账号切换与 Context Handoff V2 联动**：
   - 当用户通过 Composer / Usage Center 一键手动切换 AGY 账号实例（`agy-work` → `agy-personal`）时，复用现有 `SessionManager.switchHarnessInternal` + Context Handoff V2 脱敏增量交接，并保持对同驱动多 AGY 实例**永久禁用自动额度轮换**。
