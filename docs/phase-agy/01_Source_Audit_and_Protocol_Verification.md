# 01 · 源码审查、T3 Code 对标与官方协议验证报告

---

## Part A — HarnessMate Desktop Phase 0–4 现有源码审查

以下结论均逐行核实自 `d:\HarnessMate\harnessmate_desktop` 现行 `main` 分支（commit `ac84f37`）：

### A.1 `packages/daemon/src/plugin-host/builtin/services.ts` & `harnesses/registry.ts`

- **`services.ts` L122-126** `[HarnessMate 现状审计]`：
  ```ts
  adapterPlugin('agy', () => new AcpAdapter({
    id: 'agy', kind: 'agy', displayName: 'Antigravity CLI',
    description: 'Google Antigravity CLI via native Agent Client Protocol (ACP)',
    command: 'agy', args: ['acp', '--stdio'], binaryOverride: config.binaryOverrides.agy,
  }));
  ```
  仅静态注册了单个名为 `'agy'` 的 `AcpAdapter` 实例，既未调用 `registry.registerDriver('agy', factory)`，也未从 `config.harnessInstances`（`packages/daemon/src/config.ts` L14）实例化多账号 AGY Profile。
- **`registry.ts` L43-123** `[HarnessMate 现状审计]`：
  `HarnessRegistry` 本身已具备 `registerDriver`、`registerInstance`、`updateInstanceMetadata`、`listInstances` 与 `sanitizeInstanceEnv`（剥离 `HARNESSMATE_LOCAL_TOKEN`、`HARNESSMATE_SESSION_MCP_TOKEN`、`HARNESSMATE_DATA_DIR`）基础设施，且 `resolveContinuationKey`（L37-41）已支持 `${driverId}:home:${homeDir}`，但目前完全没有为 `agy` 启用。

### A.2 `packages/daemon/src/harnesses/acp-adapter.ts`（2,006 行）

- **通用 ACP 与 AGY 仍耦合在同一文件** `[HarnessMate 现状审计]`：
  `AntigravityAcpFlavorPolicy`（L247-357）、`probeAgyModelsCli`（L845-866）、`classifyAgyModelGroup`（L839-843）及 `AcpAdapter` / `AcpSessionHandle` 混处于同一模块，缺少统一的 `AgyLaunchContext` 与独立的 `AgyDriver` / `AgyAuth` / `AgyUsage` / `AgyProtocol` 层。
- **能力声明失真**（L438-451）`[HarnessMate 现状审计]`：
  `capabilitiesV2` 硬编码 `supportsActiveSteering: false`、`supportsUsageLimits: false`，未根据 `agy` 版本（`>= 1.5.0` 支持运行中 `session/prompt` Steering）及原生 `/usage` 探测能力动态声明。
- **`readUsageLimits()` 形同虚设**（L567-590）`[HarnessMate 现状审计]`：
  仅调用 `probeAcpSessionMetadata()`（会拉起 `session/new`），返回空 `rateLimits: []`，既不能输出 5h/weekly 配额窗口，也未采集用户账号指纹与真实额度。
- **`buildSpawnEnv()` 未清理宿主环境残余凭据**（L453-465）`[HarnessMate 现状审计]`：
  仅剥离 `DEFAULT_STRIP_ENV_KEYS`，未清理宿主环境中可能残留的 `GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`、`GOOGLE_CLOUD_LOCATION`、`GOOGLE_CLOUD_QUOTA_PROJECT`、`GOOGLE_GENAI_USE_VERTEXAI`、`GCLOUD_PROJECT`、`CLOUDSDK_CORE_PROJECT`、`AGY_ACP_CCPA_PROJECT`、`AGY_ACP_ENABLE_OAUTH`、`GEMINI_HOME`、`AGY_ACP_FORCE_FILE_STORAGE`、`BROWSER`、`CHROME_CRASHPAD_PIPE_NAME` 等变量；多账号环境下会导致静默串用环境变量凭据。
- **`applyRuntimeConfig()` 缺乏三层作用域与动态 `thought_level` 联动**（L1219-1367）`[HarnessMate 现状审计]`：
  仅在 `session/new` 之后按单一 `AdapterSessionConfig` 同步 model/effort/mode；无 Account 默认层、Session 持久层与 Turn 临时覆盖层之分，也未对每个模型独立探测/缓存可用的 `thought_level` 选项集合。
- **`evaluatePermissionPolicy()` 策略偏差**（L324-356）`[HarnessMate 现状审计]`：
  在 `permissionMode === 'auto'` 时由客户端直接对所有工具调用无条件回复 `allow_once`，未尊重 AGY 原生 `auto` 模式自身的沙箱/安全审查机制；且在 `handleServerRequest()`（L1702-1749）中：
  1. 未识别 AGY 原生结构化提问（`toolCall.toolCallId.startsWith('interaction_')`）；
  2. 未提取权限选项上的 `_meta['agy.security.warning']` 风险提示；
  3. 对客户端 `fs/read_text_file` 未提供可配的白名单只读路径支持。
- **`handleNotification()` 多项原生事件未投影或误投影**（L1751-1898）`[HarnessMate 现状审计]`：
  - `usage_update`：直接落入 `default: break;`，导致上下文窗口占用率（如 `size: 1048576`）完全丢失；
  - `session_info_update`：未处理，原生会话自动标题无法同步到 HarnessMate；
  - `available_commands_update`（L1846-1864）：直接发射为 `turn_block.ext`（`ext:acp.available_commands`），污染对话时间线；
  - `Run update_steps` 工具调用：未转为结构化 Plan/Task 更新；
  - `invoke_subagent` / `start_subagent`：未做批处理归类与子 Agent `brain/<id>` 只读进度追踪；
  - 后台命令与 `schedule`：未支持 `postSettleContinuation`，ACP `session/prompt` 返回后后续后台唤醒消息会被丢弃；
  - 静默 API 错误（上游错误被写入 `conversations/<id>.db` 但 ACP 返回 `end_turn`）：未检测，导致限额耗尽或思考签名损坏被误判为正常完成。

### A.3 `packages/daemon/src/harnesses/agy-commands.ts`（92 行）

- **已实证的破坏性 Bug**（L25-27、L55-57）`[HarnessMate 现状审计]` `[已真机验证 Windows agy 1.5.14]`：
  ```ts
  if (opts?.appDataDir?.trim()) {
    args.push('--app-data-dir', opts.appDataDir.trim());
  }
  ```
  `inspectAgyCommand()` 与 `runAgyCommand()` 调用的是顶层 `agy` 命令（如 `agy -p /usage`、`agy -p /skills`、`agy -p /compact`），但**顶层 `agy` CLI 根本没有 `--app-data-dir` 参数**！在 Windows `agy.exe 1.5.14` 实测会立即以 `exitCode = 2` 报错退出：`flags provided but not defined: -app-data-dir`。
- **未登录阻塞缺陷**：当在隔离 Profile 尚未登录时调用 `agy -p /usage --output-format json`，CLI 会向 stderr 输出登录 URL 并等待交互，直到 `--print-timeout` 超时被杀，缺少快速失败检测。

### A.4 `packages/daemon/src/core/harness-commands.ts`、`mcp-service.ts`、`history-scanner.ts`、`session-manager.ts`、`server/app.ts`

- **`harness-commands.ts`（L7-27, L36-88）**：硬编码 `'agy'` 单实例二进制查询；未按实例 `AgyLaunchContext` 注入隔离环境；命令列表为静态数组，未融合 ACP 动态上报的 `availableCommands`。
- **`mcp-service.ts`（L167-193）**：仅解析单一 `'agy'` 二进制，未体现 `agy mcp` 在当前上游 CLI 中仍作用于全局 `~/.gemini/config/mcp_config.json` 的真实边界。
- **`history-scanner.ts`（L75, L144, L509）**：`scanAgy()` 与 `readAgyIndexedHistory()` 硬编码 `os.homedir()/.gemini/{antigravity,antigravity-cli}`，无法扫描各个独立 AGY Profile 目录下的原生会话。
- **`session-manager.ts`**：
  - L1588：`if (session.status === 'running' || session.status === 'awaiting_approval') throw new Error(...)` 阻断了一切运行中发消息，导致无法承接 `agy >= 1.5.0` 的原生 mid-turn Steering；
  - L842：`adapter instanceof AcpAdapter` 硬编码判断；
  - L1960-2021：已建成完善的 `user_question` 审批与 `resolveQuestion()` 通道，可直接复用承接 AGY 的 `interaction_*` 原生提问，无需另起炉灶。
- **`server/app.ts`**：尚无管理多实例（CRUD）与账号登录/登出/状态订阅（`start`/`respond`/`cancel`/`logout`）的 HTTP/WS 路由。

---

## Part B — T3 Code `main` 分支深度源码审查（含 Issue `#37587`、PR `#39485` 与 CLI Issue `#1610`）

### B.1 多账号串号根因与隔离机制剖析

| 来源 | 核心事实与源码证据 |
| --- | --- |
| **`google-antigravity/antigravity-cli#1610`** `[T3 Code main 源码已核验]` `[已真机验证 Windows agy 1.5.14]` | `agy 1.5.x` 将 Google 登录凭据保存在单个系统 Keyring 条目中（Windows Credential Manager 为 `gemini:antigravity`；macOS Keychain 为 `service=gemini, account=antigravity`；Linux 为 Secret Service）。即使传入隔离的 `--gemini-dir` 和 `--app-data-dir`，`agy` 启动仍优先读取该全局 Keyring 条目；`AGY_ACP_FORCE_FILE_STORAGE=1` 在 1.5.x 中已被忽略。任一 Profile 登录或 `/logout` 都会覆盖或清除所有 Profile 的账号。 |
| **`pingdotgg/t3code` Issue `#37587`** `[T3 Code main 源码已核验]` | 最初暴露多个 Antigravity 实例共享账户问题（当时未传 `--app-data-dir` 且随后受 #1610 影响所有实例读写同一 Keyring）。 |
| **`pingdotgg/t3code` PR `#39485`** `[T3 Code main 源码已核验]` | 关键修复包含四部分：<br>1. `antigravityAuthSupport.ts`（L232-234）：当 `authMethod === "oauth-personal"` 时，在子进程环境中注入 `SSH_CONNECTION: baseEnv.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0"`，触发 `agy` 的 SSH 文件存储分支（token 落盘至 `<profile>/antigravity-acp/antigravity-oauth-token`，彻底绕过共享 Keyring）；<br>2. `AntigravityDriver.ts`（L424-494）：由于 SSH 模式下标准 ACP `authenticate` 会返回 `No browser is available here`，改用官方 `agy acp --gemini-dir ... --app-data-dir antigravity-acp --login`（去掉 `DISPLAY`/`WAYLAND_DISPLAY`），捕获 stdout 的 Google OAuth URL 并由用户在 UI 粘贴授权码/回调 URL 写入 stdin；<br>3. `AntigravityAuth.ts`：完整状态机（`starting` -> `waiting` -> `verifying` -> `succeeded`/`failed`/`cancelled`）+ `antigravityLoginResponse()` 严格校验 URL/state/code；<br>4. `antigravityUsageLimits.ts`（L365-367）：`oauth-personal` 仅读取 Profile 内的 `antigravity-oauth-token`，禁止回退读共享 Keyring；仅 `oauth-business`（因 `--login` 不支持企业登录）仍读取共享 Keyring，并在 UI 明确说明限制。 |

### B.2 T3 Code Antigravity 核心模块对比清单

| T3 Code 模块 | 核心机制 | HarnessMate 吸收 vs 规避策略 |
| --- | --- | --- |
| `antigravityAuthSupport.ts` | SHA-256 hash `instanceId` 作 Profile 目录；剥离 19 个环境键；`BROWSER` 节点脚本预检防弹浏览器；Windows 用 `junction` 链接 `~/.gemini/skills` 与 `~/.gemini/antigravity/skills`，拷贝 `AGENTS.md`/`GEMINI.md`/`config/skills.json` 并用 `.t3-rule-copies.json` 防覆盖本地修改；校验 Google OAuth URL (`https://accounts.google.com/o/oauth2/auth`, `redirect_uri=https://antigravity.google/oauth-callback`) | **吸收**：全部环境剥离、junction/规则同步、OAuth URL/code/state 严格校验与 Profile 隔离逻辑（使用 Node 原生模块，**不引入 Effect-TS**）；**增强**：增加 Windows `icacls` 目录私有 ACL 加固。 |
| `AntigravityDriver.ts` | 单例/多实例独立 Profile；非阻塞被动 `probe`（绝不拉起 `session/new`，注释指明 PyInstaller 单文件运行时每次解压约 1GB 耗时近 1 分钟）；切换模型时按需观测并缓存每模型专属 `thought_level`；`antigravityRuntimeModes` 记忆是否广告 `auto` | **吸收**：被动 probe、per-model `thought_level` 观察与缓存、`runtimeModes` 持久化；**增强**：收拢为统一 `AgyLaunchContext`。 |
| `antigravityUsageLimits.ts` | 通过 `ffi-rs`/`@napi-rs/keyring` 直读 `gemini:antigravity`，并用硬编码 `antigravity/hub/2.24.0` UA 请求 `v1internal:retrieveUserQuotaSummary` 与 `fetchAvailableModels` | **不照搬**：不直连未公开的 `v1internal` HTTP API、不引入 `ffi-rs` 读取系统凭据库；**优先采用官方 `agy -p /usage --output-format json`** 获取完全结构化的配额数据。 |
| `AntigravityAcpSupport.ts` | 按版本门控（`>=1.5.0` Steering、`>=1.5.1` 开放全部模型访问）；`_meta.antigravity.systemPrompt.append` 注入；`clientCapabilities.fs = { readTextFile: true, writeTextFile: false }`（保留 Agent diff 编辑）；`antigravitySessionMode` 把未知 mode 映射为 `default` | **吸收**：版本门控与模式映射、文件只读安全根白名单（拒绝越界与 symlink）。 |
| `AntigravityProtocol.ts` | `interaction_*` 转为结构化提问；提取 `_meta['agy.security.warning']`；拦截 `Run update_steps` 转为 `plan`；识别 `invoke_subagent`/`start_subagent` 并剥离 MCP `toolSummary`；修补子 Agent `client_view_file` 卡死状态；识别 `schedule`/非守护命令跨 Turn 存活；统一截断长文本防 V8 OOM | **全部吸收**：精确映射到 HarnessMate Canonical Event、`ApprovalCenter`（`user_question`）和 `TurnBlock V2`。 |
| `AntigravityChildWork.ts` & `AntigravityTurnOutcome.ts` | 只读遍历 `brain/<id>/.system_generated/{subagents,messages,logs/transcript.jsonl}` 追踪 1.5 分离式子 Agent 及未读高优唤醒消息；只读检查 `conversations/<id>.db` 中本轮新增 `ERROR_STEP_TYPE(17)` 识别静默 `QUOTA_EXHAUSTED` / `429` / `INVALID_THINKING_SIGNATURE`；`AntigravityProfilePaths.ts` 全路径 `lstat`+`realpath` 防 symlink | **吸收并加固**：严格遵循只读与 `realpath` 守卫（Windows 额外检测 reparse point/junction）。 |

---

## Part C — Google Antigravity 2.0 官方文档核验与 Windows `agy.exe 1.5.14` 真机实测

### C.1 CLI Flags 与子命令核验 `[已真机验证 Windows agy 1.5.14]` `[官方文档已核验]`

- **`agy.exe --version`**：`1.5.14`
- **顶层 `agy.exe` 支持的子命令**：`acp`, `agent`/`agents`, `changelog`, `help`, `install`, `mcp`, `mic-serve`, `models`, `plugin`/`plugins`, `remote-control`, `update`。
- **顶层 `agy.exe` 重要 Flags**：`--add-dir`, `--agent`, `-c/--continue`, `--conversation`, `--dangerously-skip-permissions`, `--disable-slash-commands`, `--effort`, `-i/--prompt-interactive`, `--input-format (text|stream-json)`, `--json-schema`, `--log-file`, `--mode (accept-edits|auto|plan)`, `--model`, `--new-project`, `--output-format (text|json|stream-json)`, `-p/--print/--prompt`, `--print-timeout`, `--project`, `--remote-agent`, `--remote-control`, `--sandbox`, `--settings`。**注意：顶层 `agy.exe` 不接受 `--app-data-dir` 与 `--gemini-dir`。**
- **`agy.exe acp` 专有 Flags**：`--add-dir`, `--agent`, `--app-data-dir`, `--cli_dir_name`, `--cli_log_file`, `--cloud_code_endpoint`, `--dangerously-skip-permissions`, `--disable-telemetry`, `--gemini-dir`, `--ide-mcp-port`, `--include-default-customizations`, `--log-file`, `--login`, `--process-per-session`, `--sandbox`, `--stdio`。

### C.2 Windows `agy.exe 1.5.14` 实测记录汇总 `[已真机验证 Windows agy 1.5.14]`

1. **Test 1（顶层参数缺陷复现）**：
   - `agy -p /usage --output-format json --app-data-dir antigravity-acp` → Exit Code `2`：`flags provided but not defined: -app-data-dir`；
   - `agy -p /usage --output-format json --gemini-dir <dir>` → Exit Code `2`：`flags provided but not defined: -gemini-dir`。
2. **Test 2（无 `SSH_CONNECTION` 复现 #1610）**：
   - 空目录 `prof-nossh` 执行 `agy acp --stdio --gemini-dir <prof-nossh> --app-data-dir antigravity-acp`（环境变量含 `GEMINI_HOME=<prof-nossh>`、`AGY_ACP_FORCE_FILE_STORAGE=1`）；
   - ACP 日志记录：`keyringAuth: loaded token ... expired=false` → `ChainedAuth: authenticated via keyring` → `OAuth: authenticated successfully as <redacted-email>`。**实证 #1610 在 Windows 1.5.14 稳定复现。**
3. **Test 3（`SSH_CONNECTION` 隔离验证）**：
   - 空目录 `prof-ssh` 在相同启动参数下附加 `SSH_CONNECTION=127.0.0.1 0 127.0.0.1 0`；
   - ACP 日志记录：`composite_token_storage.go:176] Using file-based token storage because SSH session detected` → `Silent sign-in failed; session requests fail with auth_required`；
   - `session/new` 返回：`{"code": -32000, "message": "Authentication required"}`。**实证 PR #39485 隔离机制在 Windows 1.5.14 有效。**
4. **Test 4（`agy acp --login` 实测）**：
   - 执行 `agy acp --gemini-dir <prof-login> --app-data-dir antigravity-acp --login`（带 `SSH_CONNECTION`，去除 `DISPLAY`）；
   - stdout 输出：
     ```text
     Open this link in a browser to log in with Google:
       https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=...&code_challenge_method=S256&prompt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=...&state=...
     Then paste the authorization code, or the full URL of the page you land on, and press Enter:
     ```
5. **Test 5（隔离 `GEMINI_HOME` + `SSH_CONNECTION` 下子命令行为）**：
   - `agy models` → Exit `1`：`Error: Please sign in to view available models.`（隔离生效）；
   - `agy -p /usage --output-format json --print-timeout 12s` → 未登录时在 stderr 输出 Google OAuth URL 并阻塞等待输入直至超时（隔离生效，但不可直接盲跑）；
   - `agy -p /skills --output-format json --print-timeout 12s` → 同上；
   - `agy agents` → Exit `0`；
   - `agy plugin list --json` → Exit `0` (`[]`)；
   - `agy mcp list` → Exit `0`，**但列出用户主目录全局已配置的 `airp`、`memcord`、`neuralmemory`，未受 `GEMINI_HOME` 隔离！**
6. **Test 6（完整 ACP `initialize` & `session/new` 响应结构）**：
   - `initialize` 返回：`agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" }`、`agentCapabilities.auth.logout: {}`、`promptCapabilities: { image: true, audio: false, embeddedContext: true }`、`sessionCapabilities: { resume: {}, close: {}, load: {}, list: {}, additionalDirectories: {} }`、`_meta.antigravity: { tier: true, systemPrompt: { append: true } }`、`authMethods`: `oauth-personal` / `oauth-business` / `gemini-api-key` / `agent-platform`；
   - `session/new` 返回：
     - 27 个变体模型与 11 个基础模型（`gemini-4-neon`, `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-pro-orchestrator-neon`, `gemini-pro-orchestrator`, `gemini-pro-orchestrator-argon`, `gemini-3.8-flash`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`）；
     - `configOptions` 含 `model`、`thought_level`（`low`/`medium`/`high`/`xhigh`）、`mode`（`default`/`accept-edits`/`plan`，因未传 `--sandbox` 故未提供 `auto`）；
     - `_meta.antigravity.tier`：`{ name: "Google AI Pro", id: "g1-pro-tier", upgradeUri: "https://antigravity.google/g1-upgrade" }`；
   - 紧随 `session/new` 收到两条 `session/update` 通知：
     - `available_commands_update`（含 `goal`, `compact`, `schedule`, `browser`, `plan`, `grill-me`, `teamwork`, `learn`, `boost`, `agy-customizations` 等全部可用命令及 `description`）；
     - `usage_update`（`{ sessionUpdate: "usage_update", used: 0, size: 1048576 }`）。

### C.3 官方能力来源四级归属清册

| 能力类别 | 暴露方式 | 具体接口/命令/路径 | 真实可用性结论 |
| --- | --- | --- | --- |
| **1. ACP JSON-RPC 原生能力** | `agy acp --stdio` | `initialize`, `authenticate`, `logout`, `session/new`, `session/load`, `session/resume`, `session/list`, `session/close`, `session/prompt` (含 mid-turn steering), `session/cancel`, `session/set_config_option`, `session/set_mode`, `session/set_model`, `session/request_permission` (`interaction_*` 提问、`agy.security.warning`), `session/update` (`agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `config_option_update`, `usage_update`, `session_info_update`), `_meta.antigravity.{tier, systemPrompt.append}`, `additionalDirectories` | **可完整使用** `[已真机验证 Windows agy 1.5.14]` |
| **2. 官方 CLI 可调用能力** | `agy.exe` 子命令 / `-p` | `agy --version`, `agy acp --login`, `agy models`, `agy agents`, `agy -p /usage --output-format json`, `agy -p /skills --output-format json`, `agy -p /compact --output-format json`, `agy mcp {list,add,remove,enable,disable}`, `agy plugin {list,install,uninstall,enable,disable,validate}` | **可使用，须遵守**：`--app-data-dir`/`--gemini-dir` 仅限 `acp` 子命令；`agy mcp` 全局生效；未登录不可跑 `-p` `[已真机验证 Windows agy 1.5.14]` |
| **3. Profile 磁盘只读观测** | `<profile>/<appDataDir>/` | `conversations/<id>.db`（错误步诊断）、`brain/<id>/.system_generated/{subagents,messages,logs/transcript.jsonl}`（子 Agent 轨迹与未读唤醒状态）、`brain/<id>/*.md`（Implementation Plan / Walkthrough Artifacts）、`conversation_summaries.db`（历史检索索引） | **可只读观测**，须做 `lstat`+`realpath` 防符号链接穿越及读取字节上限保护 `[T3 Code main 源码已核验]` |
| **4. 官方客户端独有能力** | 仅 Antigravity App 2.0 (`v2.35.0`) / IDE / TUI | 云端 Remote Agents 控制台 & Remote Control 守护端图形控制、App 内置 Browser 录制器 & Chrome Profile 管理、App 级 Voice Live 语音对话、App `Settings > Models > Orchestrator Settings` 自由混搭自定义 Executor（如 Claude Sonnet 5.5 — ACP/CLI 仅暴露预设 Orchestrator 组合）、App 内置 Conversation Management API、App/IDE 交互式 TUI AltScreen 编辑器与 Marketplace 一键插件登录 | **严禁伪造**：仅在 UI 中明确标注能力边界，不提供假按钮或模拟实现 `[官方文档已核验]` |
