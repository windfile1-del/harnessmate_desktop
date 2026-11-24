# Phase AGY 专项验收与全量回归报告（`AGY-0` ~ `AGY-6`）

> 严格执行 `05_Test_Plan_and_Security_Risk_Register.md` Section A.5 诚实性分级规范：
> - **`[自动化验证通过 — Mock/回放]`**：通过 Vitest 单元、集成或离线协议回放测试验证，**不得等同于真机双 Google 账号 OAuth 实连成功**；
> - **`[已真机验证 — Windows agy 1.5.16]`**：直接调用本机官方 `agy.exe` 执行并附带真实命令、日志与退出码（注：Pre-Dev 审计期间宿主机为 `1.5.14`，Phase AGY-6 真机复验时宿主机 `agy.exe` 已为 `1.5.16`）；
> - **`[未真机验证 / 受上游阻塞]`**：需真实双 Google 账号交互登录或受上游 CLI `#1610` 限制，明确保留人工真机验证项，禁止虚假宣称生产完成。

---

## 1. 阶段交付与独立提交汇总（Git `main` 分支）

| 阶段 | Git Commit | 核心交付内容 |
| --- | --- | --- |
| **AGY-0** | `088f27e` | Pre-Dev 源码审查、官方 `agy.exe` 协议探活验证、架构设计、分层文件清单、测试计划及安全风险登记册（`docs/phase-agy/00_INDEX.md` ~ `05_Test_Plan_and_Security_Risk_Register.md`）。 |
| **AGY-1** | `dffcf37` | 拆分 `AgyAdapter` 出通用 `StrictAcpAdapter`，引入 `AgyLaunchContext`、多 Profile 目录与 SHA-256 隔离（`agy-launch-context.ts`、`agy-profile-manager.ts`、`agy-paths.ts`、`agy-driver.ts`），清理宿主环境变量并对 `profile_isolated` + `oauth-personal` 启用 `SSH_CONNECTION` 隔离；同步修复 Windows `taskkill.exe` 终止与终端关闭竞态。 |
| **AGY-2** | `d3b3f87` | 官方 `agy acp --login` 交互状态机与 OAuth URL 白名单校验（`agy-auth-service.ts`）、基于 `LaunchContext` 的官方 `/usage` 探测（`agy-usage.ts`）、`FailoverCoordinator` 同驱动 `agy -> agy` 自动轮换硬禁用守卫、CRUD 与认证 REST/WS 路由及 `agy-auth-usage.test.ts`。 |
| **AGY-3** | `3da6545` | Account / Session / Turn 三层配置作用域与 Turn 后恢复（`agy-config-scope.ts`）、通用 `AcpFlavorPolicy` 扩展点与 `AntigravityAcpFlavorPolicy`（`client_guard` 诚实降级与 `agy.security.warning` 提取）、每模型动态 `thought_level` 缓存、实时 slash commands 同步与 `agy-config-scope.test.ts`。 |
| **AGY-4** | `b000222` | AGY 原生事件投影与 `usage_update` / `session_info_update` / `Run update_steps` -> `ext:agy.plan` / `interaction_*` -> `user_question`（`agy-protocol.ts`）、`>= 1.5.0` 运行中 Mid-turn Steering 门控、基于 `node:sqlite` 只读 `conversations/<id>.db` 与 symlink 防护的子 Agent 轨迹及静默 `ERROR_STEP_TYPE(17)` 诊断（`agy-child-work.ts`、`agy-turn-outcome.ts`）、`agy-lifecycle-events.test.ts`。 |
| **AGY-5** | `52251be` | AGY Artifact 只读审阅与 6 域生态边界快照接口（`agy-artifacts.ts`、`agy-ecosystem.ts`、`app.ts`）、Web V5 UI 插槽组件（`AgySettingsSlot`、`AgyComposerControls`、`AgyStudioBlockCard`、`AgyArtifactReviewPanel`、`AgyEcosystemPanel`）、`ChatStage` 运行中 Steering 发送态、`UsageDashboardModal` 手动单账号切换与禁轮换提示及 `phase-agy-ui.test.tsx`。 |
| **AGY-6** | 当前提交 | 加固 Windows `System32\icacls.exe` 绝对路径（`agy-profile-manager.ts`）、脱敏 `agy 1.5.14` 离线协议全生命周期回放夹具与套件（`session-full.ndjson`、`auth-required.ndjson`、`agy-replay-protocol.test.ts`）、Windows 隔离真机脚本（`scripts/verify-agy-windows-isolation.mjs`）及本验收报告。 |

---

## 2. 能力与验证结论矩阵（诚实分级）

| 能力域 | 结论等级 | 验证依据与说明 |
| --- | --- | --- |
| 环境剥离（18+ 宿主凭据变量清除）与 CLI 参数隔离（零 `--app-data-dir`/`--gemini-dir` 泄露给原生外层、`oauth-business` 禁注入 `SSH_CONNECTION`） | `[自动化验证通过 — Mock/回放]` | `agy-launch-context.test.ts` (6 tests) |
| 官方 `agy.exe` 二进制与双独立 Profile 目录 Windows `icacls` 隔离、`initialize` 握手、零宿主 keyring 串话（`-32000 Authentication required`）及 `-p /usage` 隔离 stderr 快速终止 | `[已真机验证 — Windows agy 1.5.16]` | `node scripts/verify-agy-windows-isolation.mjs --dry-run`（退出码 `0`，`"isolationVerified": true`，详见第 3 节实测日志） |
| 官方 OAuth URL 白名单校验、防回调注入、同驱动 AGY 禁自动 Failover 守卫 | `[自动化验证通过 — Mock/回放]` | `agy-auth-usage.test.ts` (7 tests) |
| **双真实 Google 账号（Account A + Account B）交互式 OAuth 登录并独立持久化 Token** | **`[未真机验证 / 受上游阻塞]`** | 需人工在浏览器完成两次 Google OAuth 授权并回填回调码；已提供 `node scripts/verify-agy-windows-isolation.mjs --interactive` 6 步人工验收手册 |
| **登录后跨子命令 `agy acp` 与 `agy -p /usage` Token 互通性验证（风险 R-05）** | **`[未真机验证 / 受上游阻塞]`** | 依赖真实双账号 OAuth 登录后在两个 Profile 下实测 `/usage` 与配额展示 |
| **Google Workspace / Enterprise (`oauth-business`) 并发多账号文件隔离（风险 R-03）** | **`[未真机验证 / 受上游阻塞]`** | 受上游 `google-antigravity/antigravity-cli#1610` 限制，代码与 UI 已强制禁止为其注入 `SSH_CONNECTION` 并显式提示共享系统凭据库 |
| Account < Session < Turn 三层配置与回退、`thought_level` 动态刷新、`auto -> default + client_guard` 诚实标记 | `[自动化验证通过 — Mock/回放]` | `agy-config-scope.test.ts` (4 tests) + `agy-replay-protocol.test.ts` |
| `usage_update`、`session_info_update`、`Run update_steps`、`invoke_subagent`、`schedule`、`agy.security.warning`、`interaction_*`、Mid-turn Steering、`session/cancel` 恢复、`QUOTA_EXHAUSTED`、`-32000` 及 SQLite `ERROR_STEP_TYPE(17)` / symlink 拦截 | `[自动化验证通过 — Mock/回放]` | `agy-lifecycle-events.test.ts` (5 tests) + `agy-replay-protocol.test.ts` (2 tests) |
| V5 插件槽位 UI（`harness.settings`、`composer.actions`、5 种 `ext:agy.*`、`inspector.tabs` Artifact 审阅与生态边界、Usage Center 防轮换警示与手动切换） | `[自动化验证通过 — Mock/回放]` | `phase-agy-ui.test.tsx` (5 tests) |

---

## 3. Windows 真机 `agy.exe` 隔离校验实测摘要（`--dry-run`）

执行命令：

```powershell
node scripts/verify-agy-windows-isolation.mjs --dry-run
```

退出码：`0`，完整输出摘要：

```json
{
  "mode": "dry-run",
  "platform": "win32",
  "binaryPath": "C:\\Users\\windfile\\AppData\\Local\\agy\\bin\\agy.exe",
  "cliVersion": "1.5.16",
  "profileA": {
    "profileName": "agy-iso-a",
    "aclMode": "windows-icacls",
    "geminiDir": "D:\\AgentDockTemp\\hm-agy-e2e-P8Dh7E\\profile-a\\.gemini",
    "agentInfo": {
      "name": "Antigravity ACP Server",
      "version": "1.5.16"
    },
    "authMethods": [
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform"
    ],
    "sessionResult": null,
    "sessionError": {
      "code": -32000,
      "message": "Authentication required"
    },
    "timedOut": false,
    "stderrPreview": ""
  },
  "profileB": {
    "profileName": "agy-iso-b",
    "aclMode": "windows-icacls",
    "geminiDir": "D:\\AgentDockTemp\\hm-agy-e2e-P8Dh7E\\profile-b\\.gemini",
    "agentInfo": {
      "name": "Antigravity ACP Server",
      "version": "1.5.16"
    },
    "authMethods": [
      "oauth-personal",
      "oauth-business",
      "gemini-api-key",
      "agent-platform"
    ],
    "sessionResult": null,
    "sessionError": {
      "code": -32000,
      "message": "Authentication required"
    },
    "timedOut": false,
    "stderrPreview": ""
  },
  "isolatedUsageCliProbe": {
    "exitCode": null,
    "timedOut": false,
    "fastAbortedAuth": true,
    "stdoutPreview": "",
    "stderrPreview": "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com&code_challenge=NAqFElJ4V56h_DuGran-6q0U4AlaTRZPHbqbRJkdYUc&code_challenge_method=S256&prompt=co"
  },
  "isolationVerified": true,
  "humanOAuthStatus": "[未真机验证 / 需人工双 Google 账号交互登录]"
}
```

实测结论：
1. 宿主机官方 `C:\Users\windfile\AppData\Local\agy\bin\agy.exe`（`Antigravity ACP Server 1.5.16`）在双隔离临时目录及 Windows `icacls`（`/inheritance:r /grant:r <user>:(OI)(CI)F`）下正常完成 `initialize` 握手；
2. 两个新隔离 Profile 对 `session/new` 均返回 `-32000 Authentication required`，直接证实**未发生任何来自宿主 Windows Credential Manager 或主目录 `.gemini` 的隐式凭据串话**；
3. `agy -p /usage` 在隔离 `GEMINI_HOME` 下于 `stderr` 输出标准登录提示并被脚本快速中止（`fastAbortedAuth: true`, `timedOut: false`），未挂起卡死。
4. 在 AGY-6 真机测试过程中同步发现并加固了 `packages/daemon/src/harnesses/agy/agy-profile-manager.ts`：显式解析 `${SystemRoot}\System32\icacls.exe`，避免在极简 PATH 环境下报 `spawnSync icacls ENOENT`。

---

## 4. 合规与架构红线核查（R-01 ~ R-08）

- **零反向代理**：全仓仅直连本地官方 `agy.exe` 进程，未引入任何 HTTP 代理或中转服务。
- **零自动额度轮换**：`FailoverCoordinator` 对同 `driverId === 'agy'` 实例强制返回 `canAutoFailover = false`，`UsageDashboardModal` 与 `AgyComposerControls` 仅保留人工一键手动切换。
- **零自建 OAuth 客户端**：仅展示官方 `agy acp --login` 返回的 `https://accounts.google.com/o/oauth2/...` 授权链接并严格校验回填 URL（R-08）。
- **零跨 Profile 凭据复用/复制**：各隔离 Profile 独立生成在专属根目录并施加 `System32\icacls.exe` 权限锁（POSIX `0o700`）。
- **既存架构无退化保留**：Plugin SDK V5、Canonical Event、TurnBlock V2、Context Handoff V2、`HarnessInstanceRegistry`、Git Checkpoints 与 Multi-Harness Orchestrator 全部保留并通过回归验证。

---

## 5. 最终全量回归门禁实测结果

最后一次代码修改之后执行的全量门禁命令与实测结果（全部退出码 `0`）：

| 检查项 | 执行命令 | 实测结果 |
| --- | --- | --- |
| 全包构建 | `pnpm build` | `plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web` (Vite 2127 modules built in 25.96s), `electron` 全部 `Done` |
| 全包类型检查 | `pnpm typecheck` | 上述全部 6 个 workspace 包 `tsc --noEmit` 全部 `Done` |
| 插件契约校验 | `pnpm contracts:check` | `plugin-api` 构建 + `scripts/plugin-contracts.mjs --check` 通过 |
| Protocol 单元测试 | `pnpm --filter @harnessmate/protocol test` | **1 file / 1 test passed** |
| Web UI 与 V5 插槽测试 | `pnpm --filter @harnessmate/web test` | **11 files / 50 tests passed**（含 `tests/phase-agy-ui.test.tsx` 5/5） |
| Daemon 全量集成与回归测试 | `pnpm --filter @harnessmate/daemon exec vitest run --maxWorkers=2` | **30 files / 134 tests passed**（含 `agy-launch-context.test.ts` 6/6、`agy-auth-usage.test.ts` 7/7、`agy-config-scope.test.ts` 4/4、`agy-lifecycle-events.test.ts` 5/5、`agy-replay-protocol.test.ts` 2/2，以及 Codex / Claude / Strict ACP / Orchestrator / Git Checkpoints / Handoff V2 / Compression / Terminal / Triage 全套） |
| Electron 测试入口 | `pnpm --filter @harnessmate/electron test` | `vitest run --passWithNoTests` 退出码 `0` |
| Windows `agy.exe` 隔离探测 | `node scripts/verify-agy-windows-isolation.mjs --dry-run` | 退出码 `0`，`"isolationVerified": true` |
