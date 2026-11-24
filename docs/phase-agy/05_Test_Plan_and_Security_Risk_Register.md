# 05 · 分层测试计划与独立安全风险登记册

---

## Part A — 分层测试计划

### A.1 单元测试矩阵（纯逻辑与边界防护）

| 测试文件 | 覆盖目标 | 关键断言 |
| --- | --- | --- |
| `agy-launch-context.test.ts` | 环境剥离与参数隔离 | 验证 18+ 宿主凭据变量（`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GEMINI_HOME` 等）均被清除；`buildCliArgs` 绝不生成 `--app-data-dir`/`--gemini-dir`；仅 `profile_isolated` + `oauth-personal` 注入 `SSH_CONNECTION`；`oauth-business` 绝不注入 `SSH_CONNECTION`。 |
| `agy-auth-usage.test.ts` | OAuth 校验与官方用量解析 | 校验只接受 `https://accounts.google.com/o/oauth2/auth` + `https://antigravity.google/oauth-callback`；拦截恶意 redirect/state/换行注入；验证未登录 Profile 调用 `/usage` 立即返回 `loggedIn: false` 不挂起；验证 `FailoverCoordinator` 对同驱动 AGY 实例强制 `canAutoFailover = false`。 |
| `agy-config-scope.test.ts` | 三层作用域与动态确认 | Account < Session < Turn 覆盖优先级；Turn 结束后临时模型/思考恢复至 Session 值；切模型后 `thought_level` 列表刷新；未广告 `auto` 时诚实降级为 `default` + `client_guard`。 |
| `agy-lifecycle-events.test.ts` | 协议投影与只读防御 | `usage_update`、`session_info_update`、`Run update_steps`、`interaction_*` -> `user_question`、`agy.security.warning`、`invoke_subagent`、`postSettleContinuation`、`ERROR_STEP_TYPE(17)` 诊断；验证对 symlink / `..` 路径穿越拒绝读取（fail-closed）。 |
| `phase-agy-ui.test.tsx` | V5 插槽与 UI 交互 | `harness.settings` 多账号切换与登出二次确认弹窗；Composer 运行中锁定模型/权限与 Steering 标示；Artifact 行级评论汇总回注；Usage Center 多账户额度展示。 |

### A.2 真实 AGY 协议录制回放测试（Phase AGY-6）

- **录制原则**：直接采自真实 `agy.exe 1.5.14` 进程，统一脱敏会话 ID、用户名、邮箱与 token 字符；
- **必覆场景**：
  1. `initialize` + `session/new`（含 27 变体 / Orchestrator / `thought_level` / `_meta.antigravity.tier` / `available_commands_update` / `usage_update`）；
  2. `session/set_config_option` 模型切换引发的 `config_option_update` 思考档位动态变化；
  3. `session/request_permission`（含 `agy.security.warning` 与 `toolCallId: interaction_*`）；
  4. `Run update_steps` 工具调用转 `ext:agy.plan`；
  5. Mid-turn Steering（`running` 态连发第二条 `session/prompt`）；
  6. 后台命令唤醒与 `session/cancel` 中断恢复；
  7. `-32000 Authentication required` 与 `QUOTA_EXHAUSTED` 故障还原。

### A.3 Windows 端到端与多账号隔离真机验证方案（需真机人工交互 OAuth）

1. **前置条件**：本机存在 `agy.exe 1.5.14+` 及两个不同的测试 Google 账号（Account A 与 Account B）。
2. **验证步骤与通过判据**：
   - **Step 1**：创建 `agy-a`（`profile_isolated`）与 `agy-b`（`profile_isolated`），确认在 `~/.harnessmate-desktop/agy-profiles/` 下生成两个独立的 SHA-256 目录，通过 `icacls` 核实仅当前用户拥有权限；
   - **Step 2**：分别对 `agy-a` 与 `agy-b` 触发 `auth/start`，完成官方 Google 登录，验证各自 `<profile>/antigravity-cli/antigravity-oauth-token`（或 ACP 落盘文件）独立生成且互不覆盖；
   - **Step 3**：核实本机原有 `official_default`（系统 Credential Manager `gemini:antigravity`）未被改写或退出；
   - **Step 4**：在 `agy-a` 与 `agy-b` 各自发起会话并调用 `/usage`（及对比 `agy -p /usage` 与 `agy acp` 跨子命令 token 共用兼容性 `[待真机验证]`），验证账号各自返回独立额度或诚实状态；
   - **Step 5**：执行 `agy-b` 登出（ACP `logout`），验证 `agy-a` 仍可正常执行 Turn 且 `official_default` 未受影响；
   - **Step 6**：在同一 HarnessMate 会话中从 `agy-a` 手动一键切换至 `agy-b`，验证通过 Context Handoff V2 增量同步上下文，且未复制任何凭据。

### A.4 全量回归测试门禁（每阶段必跑）

每阶段提交前必须执行并通过：
- `pnpm build`
- `pnpm typecheck`
- `pnpm contracts:check`
- 全量测试 `pnpm -r test`（涵盖 Codex、Claude、Strict ACP、DeepSeek、OpenCode、Context Handoff V2、Git Checkpoints、Session Explorer、Approval Center、Multi-Harness Orchestrator、Context Compression、Terminal Workspace、Triage Inbox、Plugin SDK V5）。

### A.5 验收诚实性标记规范

交付报告中每一项能力必须显式标注唯一结论等级：
- `[自动化验证通过 — Mock/回放]`：通过 Vitest 单元/回放测试，不代表真机实连通过；
- `[已真机验证 — Windows agy 1.5.14]`：附带真实命令、日志摘要与退出码；
- `[未真机验证 / 受上游阻塞]`：未在真实双 Google 账号环境下实连验证，禁止宣称生产可用。

---

## Part B — 安全与合规风险登记册（含 T3 Code 兼容方案独立评估）

| 编号 | 风险描述 | 严重度 | 根因分析 | 缓解措施与技术护栏 | 残余风险 / 监控 |
| --- | --- | --- | --- | --- | --- |
| **R-01** | `SSH_CONNECTION` 兼容变量向 Agent 子 Shell 传播副作用 | **中** | 为绕过 `agy 1.5.x` 单一全局 keyring（#1610），`profile_isolated` 需注入 `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0`。`agy` 会将该变量继承给其启动的终端命令，可能影响依赖检测 SSH 环境的工具（如编辑器拉起、浏览器跳转、某些 git credential helper）。 | 1. 默认 `official_default` 实例**不注入** `SSH_CONNECTION`；<br>2. 仅对显式开启 `profile_isolated` 的 `oauth-personal` 注入；<br>3. UI 在 Profile 卡片公开说明该兼容机制；<br>4. 一旦上游 #1610 提供官方 `--credential-store=file` 或按目录隔离的 keyring，立即切换并移除 `SSH_CONNECTION`。 | 仅影响隔离 Profile 的子终端环境检测；不涉及凭据泄露。 |
| **R-02** | Profile 目录明文/本地文件 Token 暴露风险 | **高** | `SSH_CONNECTION` 文件存储模式下，OAuth token 落盘于 `<profile>/<appDataDir>/antigravity-oauth-token`。若目录权限宽松或被 Handoff/Bundle/日志扫描，可能造成凭据泄漏。 | 1. Windows 创建 Profile 目录后立即通过 `icacls <dir> /inheritance:r /grant:r "<USER>:(OI)(CI)F"` 锁定仅当前 Windows 用户可读写（POSIX 设 `0o700`）；<br>2. 扩展 `handoff-redactor.ts` 与日志脱敏正则，禁止在事件、诊断日志、Bundle 导出及压缩上下文中出现 token 路径内容或 Google OAuth code/access_token/refresh_token。 | 同一 Windows 账户下的其他本机高权限进程仍可访问用户文件（OS 本机账户模型固有限制）。 |
| **R-03** | 企业账号（`oauth-business`）暂无法隔离多账号 | **中** | 官方 `agy acp --login` 仅支持 Google 个人账户；`oauth-business` 仍依赖浏览器回调写入全局 keyring。 | 1. 对 `oauth-business` 严禁注入 `SSH_CONNECTION`；<br>2. UI 对 `oauth-business` 实例显式提示“受限于上游 CLI，企业账户当前共享系统凭据库，不支持并发多企业账号隔离”。 | 依赖 `google-antigravity/antigravity-cli#1610` 上游修复。 |
| **R-04** | `agy mcp list` 忽略 `GEMINI_HOME` 造成误以为 MCP 已隔离 | **中** | Windows `agy 1.5.14` 实测证明，`agy mcp list` 在隔离 `GEMINI_HOME` 下依然读取主目录全局 `mcp_config.json`。 | 在生态面板与文档中将原生 `agy mcp` 显式标记为“全局作用域”，会话专属 MCP 仅通过 HarnessMate `pluginMcp`（ACP `mcpServers`）按会话隔离注入。 | 零误导；配置边界透明。 |
| **R-05** | `agy acp` 与 `agy -p /usage` 跨子命令 Token 文件互通性待核验 | **中** | `agy acp` 接收 `--app-data-dir`，而顶层 `agy` 不接收该参数且默认读取 `GEMINI_HOME/antigravity-cli/`。若两者在登录后实际存放 token 的子目录不一致，会导致 `agy -p /usage` 误报未登录。 | 将 `appDataDirName` 默认统一为 `'antigravity-cli'` 并在 Phase AGY-1/2 双账号实登后立即实测 `agy -p /usage`；若存在目录差异，绝不私自复制 token 文件跨目录迁移，而是如实上报并在 UI 显示“ACP 会话可用，CLI `/usage` 受上游目录限制暂不可读”。 | Phase AGY-2 真机验证关闭此未知项。 |
| **R-06** | 只读读取 `conversations/<id>.db` 与 `brain/<id>/` 的安全风险 | **中** | 读取工作区/Profile 下方 SQLite 或 JSONL/Markdown 可能遭遇恶意符号链接、junction 指向系统文件、超大文件 OOM 或 SQLite 写锁竞争。 | 1. 复刻 T3 `AntigravityProfilePaths.ts` 模式，每级目录与文件执行 `lstat` 拒绝 symlink/Windows junction 并校验 `realpath` 前缀；<br>2. 严格限制单文件与扫描总字节上限（`MAX_STEP_BYTES = 1MB`、`MAX_SCAN_BYTES = 8MB`）；<br>3. SQLite 强制 `{ readOnly: true }` + `PRAGMA busy_timeout = 300`。 | 即使内部文件损坏也 fail-closed 降级为空，不影响主对话。 |
| **R-07** | 上游 `agy` CLI 升级导致内部格式/proto 字段变化 | **中** | `conversations/<id>.db` 的 `steps` protobuf 字段号（如 17、127、143）及 `transcript.jsonl` 属非公开内部格式。 | 1. 启动握手核对 `agentInfo.version`；<br>2. 所有只读解码均包在 `try/catch` + Zod/边界校验中，格式变更时优雅降级为纯 ACP 事件流，绝不阻塞核心聊天与审批。 | 降级仅影响附加可观测性（子 Agent 轨迹/静默错误细化）。 |
| **R-08** | 违反平台使用规范与项目红线（合规核查） | **高** | 多账号容易诱发自动额度轮换、反向代理或自建 OAuth client 等违规实现。 | **硬编码守卫**：<br>1. `FailoverCoordinator` 明确禁止同 `driverId === 'agy'` 实例间自动切换；<br>2. 仅允许调用本机官方 `agy.exe` 与官方 `accounts.google.com` 登录链接；<br>3. 单元测试包含禁止自动轮换与禁止跨 Profile 复制 token 文件的反向断言。 | 零合规违例。 |
