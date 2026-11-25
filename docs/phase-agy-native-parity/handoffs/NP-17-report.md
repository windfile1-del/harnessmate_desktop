# NP-17 交付与交接报告 · 集成与独立验收

原交付基于 G3 Wave 2。当前候选的命令、产物位置和证据范围见[复跑说明](../../../scripts/agy-np/e2e/README.md)。
> [!IMPORTANT]
> 本报告基于本地基线标签 `agy-np-g3-wave2`（`81393496ac1ad95afa6232111efa1b1e5c3ec792`）完成 **NP-17 并行阶段交付**：建成独立 E2E 与四态 UI 验收装置、完成全仓库门禁与多维度测试对照、完成本机 `agy.exe 1.5.17` 非鉴权实机探针与门控/前向 Schema 回滚复跑验证，并逐项复核 69 个 Capability IDs。**正式 G4 最终验收需在总指挥合并 NP-16 并冻结正式 SHA、且 U01 完成人工授权登录后复跑结案。**

---

## 1. 任务与基线元信息

| 字段 | 值 |
| --- | --- |
| 任务 | **NP-17 · 集成与独立验收** |
| Reviewed Base Tag | `agy-np-g3-wave2` -> `81393496ac1ad95afa6232111efa1b1e5c3ec792`（含已审源码 `b8f79fe58bd58044f1682b0601149c943f102fbb`） |
| 源码审计基线 | `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039` |
| 分支与 Worktree | `np17_integration_acceptance` @ `D:\AppDataCache\.gemini\antigravity\worktrees\harnessmate_desktop\np17_integration_acceptance`（平台预建 D 盘 Worktree，等价替代 `codex/agy-np-17-integration`） |
| 共享契约 Revision | `AGY_NATIVE_CONTRACT_REVISION = 'agy-native-v1.0.0'`、`AGY_NATIVE_MIGRATION_COMPONENT = 'agy-native-runtime'` (`v1`) |
| 官方测试环境 | Windows (`win32`), Node `v24.18.0`, pnpm `11.21.0`; 本机官方 `agy.exe` `1.5.17` (`Google LLC` Authenticode Valid); 已装 `Antigravity 2.35.1`、`Antigravity IDE (User) 2.5.5` |

---

## 2. 变更文件与范围合规性

全部写入严格限定于 NP-17 授权边界内，未修改任何 `packages/**`、`MASTER_PROGRESS.md`、`02_Capability_Matrix.md` 或 `packages/daemon/tests/fixtures/**`：

| 路径 | 用途 | 类别 |
| --- | --- | --- |
| [scripts/agy-np/e2e/README.md](../../../scripts/agy-np/e2e/README.md) | 独立验收装置说明与 Post-NP-16 / U01 复跑清单 | 文档 |
| [scripts/agy-np/e2e/run-acceptance.mjs](../../../scripts/agy-np/e2e/run-acceptance.mjs) | 真实编译产物 Daemon HTTP/WS/SQLite/Child ACP + Gate-OFF 回滚复跑 + Schema 99 防护 + Replay/1.5.14 + 洁净 `agy.exe` 探针一键验收脚本 | 脚本 |
| [scripts/agy-np/e2e/ui-four-states.test.tsx](../tests/agy-np17-ui-four-states.test.tsx) | React SSR 独立验收：覆盖 `actionable`、`read_only`、`no_data`、`stale_request` 四态 UI 边界 | 测试 |
| [scripts/agy-np/e2e/fixtures/README.md](../../../scripts/agy-np/e2e/fixtures/README.md) | NP-17 独立脱敏夹具清单与零泄露声明 | 夹具说明 |
| [scripts/agy-np/e2e/fixtures/mock-acp-peer.mjs](../../../scripts/agy-np/e2e/fixtures/mock-acp-peer.mjs) | 独立合成 ACP stdio JSON-RPC 2.0 对端模拟进程 | 合成对端 |
| [scripts/agy-np/e2e/fixtures/e2e-t01-t06-lifecycle.ndjson](../../../scripts/agy-np/e2e/fixtures/e2e-t01-t06-lifecycle.ndjson) | 独立 T02+T04+T06 四层回放验证夹具 | `synthetic` |
| [scripts/agy-np/e2e/fixtures/e2e-legacy-1.5.14-compat.ndjson](../../../scripts/agy-np/e2e/fixtures/e2e-legacy-1.5.14-compat.ndjson) | 独立 AGY 1.5.14 阶段格式向后兼容夹具 | `synthetic` |
| [scripts/agy-np/e2e/fixtures/e2e-ui-four-states.json](../../../scripts/agy-np/e2e/fixtures/e2e-ui-four-states.json) | 四态 UI 体验验证断言矩阵 | 夹具 |
| [scripts/agy-np/e2e/fixtures/windows-comparison-checklist.json](../../../scripts/agy-np/e2e/fixtures/windows-comparison-checklist.json) | Windows App 2.35.1 / IDE 2.5.5 / CLI 1.5.17 / ACP / HM 结构化对照清单 | 对照清单 |
| [docs/phase-agy-native-parity/reviews/NP-17-review-8139349.md](../reviews/NP-17-review-8139349.md) | 完整独立审查表、69 项 Capability IDs 复核、接线缺口与 G4/回滚清单 | 独立审查 |
| [docs/phase-agy-native-parity/handoffs/NP-17-report.md](NP-17-report.md) | 本交接交付报告 | 交接报告 |

---

## 3. 已覆盖事项与未覆盖事项

### 已覆盖（在 `8139349` 上执行并通过）
1. 离线依赖锁校验与全仓构建、类型检查、插件契约检查。
2. 4 个测试包串行全量执行及 3 份 Windows 超时文件定向复跑核查。
3. 本机 `agy.exe 1.5.17` 真实数字签名校验、`--help`/各子命令/`changelog` (`1.5.14–1.5.17`) 对比、洁净无鉴权 ACP v1 & v2 降级实时录制（`cap-20261125184209-ba589b`、`cap-20261125184219-96d92c`）与双 Profile `icacls` 隔离 dry-run。
4. 全 8 项 NP-01 Observatory 确定性回放（`four-layer` + `t01..t06` + `failure-malformed-and-secret-trap`）及 `windows-1.5.17-*.ndjson` 独立复验。
5. 独立 NP-17 E2E 套件（`A1–A6`、`B1–B2`、`C1`、`D1`）覆盖真实 `createDaemon`、Fastify/HTTP Origin 校验、真实 WebSocket `native/ws`、`node:sqlite`、T02/T04 有限 vs daemon 结算、T06/T07 权限/问答与 CAS 冲突、T08 命令路由幂等与 `409`/未授权 `422` 门控、**Gate-OFF 回滚复跑**、**前向 Schema 99 隔离**、1.5.14 向后兼容及 DTO 零泄露扫描。
6. 四类 UI 体验（`actionable`、`read_only`、`no_data`、`stale_request`）真实组件 React SSR 验收及 `PluginSlotSync.tsx` 生产接线走查。
7. 全 69 项 Capability IDs 逐项 L0–L5 保守复核、上游版本差异梳理与 G4 上线/回退检查表。

### 未覆盖事项（明确标注原因）
1. **含 NP-16 的正式冻结 SHA 验收**：`np16_performance_security_review` 工作树尚在基线 `8139349`，未合并交付；待总指挥完成 NP-16 复验并冻结新 SHA 后需重跑全部门禁。
2. **U01 人工 Google OAuth 登录与 Gemini 3.8 Flash 真机采集**：`D:\HarnessMate\agy-np-test-profile\gemini` 需由人类操作员在官方 OAuth 页面完成登录；未登录前未执行任何带账号模型 Turn、20s 后台真实唤醒、`live_hm` 端到端或付费模式 (`/boost` / `/teamwork`) 试验。
3. **官方 Windows App `2.35.1` / IDE `2.5.5` 同屏实录对照**：因涉及带账号交互式 GUI 界面（Artifact 行级批注、Embedded Browser 截图、Swarm Board TUI/App 截面），尚待 U01 就绪后按 `windows-comparison-checklist.json` 与 `12_Test_Strategy.md` 补录脱敏对照。
4. **Electron 安装包构建与真机安装测试 (`pnpm --filter @harnessmate/electron pack:exe`)**：按任务要求列为发布前独立作用域，本次未执行打包与安装器运行。

---

## 4. 测试与验证命令及真实结果记录

全部临时目录固定于 D 盘（`$env:TEMP = $env:TMP = $env:TMPDIR = 'D:\HarnessMate\np17-temp'`），严禁使用原环境污染 C 盘或生产 profile。

| # | 命令 | 类别 | 结果 / 退出码 | 实测摘要 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm install --frozen-lockfile --offline --store-dir D:\HarnessMate\agy-np-pnpm-store` | 环境安装 | `exit=0` (`33.4s`) | 新增 554 个锁依赖包 |
| 2 | `pnpm build` | 构建门禁 | `exit=0` | `plugin-api`, `plugin-sdk`, `protocol`, `daemon`, `web` (Vite 2199 modules, `45.33s`), `electron` 全通过 |
| 3 | `pnpm typecheck` | 类型检查 | `exit=0` | 全 6 个子包 `tsc --noEmit` 通过 |
| 4 | `pnpm contracts:check` | 插件契约 | `exit=0` | `@harnessmate/plugin-api` 与 `scripts/plugin-contracts.mjs --check` 通过 |
| 5 | `pnpm --filter @harnessmate/protocol exec vitest run --maxWorkers=1 --reporter=default` | 单元测试 | `exit=0` (`3.05s`) | **2/2 文件通过，6/6 用例通过** |
| 6 | `pnpm --filter @harnessmate/web exec vitest run --maxWorkers=1 --reporter=default` | Web UI 测试 | `exit=0` (`144.47s`) | **24/24 文件通过，118/118 用例通过** |
| 7 | `pnpm --filter @harnessmate/electron test` | Electron 测试 | `exit=0` | 含 `--passWithNoTests`，0 测试文件正常退出 |
| 8 | `pnpm --filter @harnessmate/daemon exec vitest run --maxWorkers=1 --reporter=default` | Daemon 全套 | `exit=1` (`671.74s`) | **42/45 文件通过（243/251 用例通过）**；全部 NP-01..NP-15 专项、Codex、Claude、DeepSeek/OpenCode、Handoff v2、Plugin v4/v5/Isolation 全通；3 文件共 8 条用例超时/失稳 |
| 9 | 定向复跑 3 份超时 Daemon 文件（`vitest run --maxWorkers=1`） | 定向复验 | `git-checkpoints`: `exit=0` (`39.35s`)<br>`terminal-workspace`: `exit=0` (`23.44s`)<br>`multi-harness-orchestrator`: `exit=1` (`94.06s`) | `git-checkpoints` **7/7 通过**；`terminal-workspace` **5/5 通过**；`multi-harness-orchestrator` **4/6 通过**，2 条真实 Git Worktree 集成用例稳定超出其硬编码 `30000ms` 超时（基线已知约束） |
| 10 | `node scripts/agy-np/observatory/cli.mjs record ...` (`--protocol 1` 与 `--protocol 2`) + `validate` | `live_raw` (`agy.exe 1.5.17`) | `exit=0` | `cap-20261125184209-ba589b` (9 条记录) & `cap-20261125184219-96d92c` (5 条记录) 校验 `valid: true, errorCount: 0, leakCount: 0`，v2 真实降级 v1 |
| 11 | `node scripts/agy-np/observatory/cli.mjs replay --mode four-layer` 及全部 7 份 `agy-np/*.ndjson` | `replay_with_provenance` / `synthetic` | `exit=0` | `four-layer` (56 条) 及 `t01..t06` + `failure-malformed-and-secret-trap` 共 8/8 `verdictPassed: true`、0 泄露 |
| 12 | `node scripts/verify-agy-windows-isolation.mjs`（默认 `--dry-run`） | `live_raw` 隔离探针 | `exit=1` (清理阶段 `EPERM`) | `agy.exe 1.5.17` 双 `icacls` Profile 握手与 `-32000`、`usage` OAuth 快速中止均通过 (`isolationVerified: true`)，末尾 `rmSync` 删除 ACL 目录被 Windows 拒绝 |
| 13 | `node scripts/agy-np/e2e/run-acceptance.mjs --out-dir D:\HarnessMate\np17-temp\e2e-run` | `synthetic` E2E + 回滚 + `live_raw` (D1) | **`exit=0`** | **10/10 检查全通过**：`A1` (`403` origin gate)、`A2` (WS `native_hello`)、`A3` (T02/T04 有限 vs daemon + 19 原生事件 + 19 WS 帧 + 0 泄露)、`A4` (`inspect_models` `200` + `409` 幂等冲突 + `422` 门控)、`A5` (权限/问答 CAS)、`A6` (接线缺口探测)、`B1` (**Gate-OFF 回滚+历史保留+复跑**)、`B2` (**Schema 99 fail-closed**)、`C1` (**独立 33 条回放+1.5.14 迁移+清单**)、`D1` (**实机 `agy 1.5.17` 洁净探针**) |
| 14 | `pnpm --filter @harnessmate/web exec vitest run --dir ..\.. --maxWorkers=1 --reporter=default scripts/agy-np/e2e/ui-four-states.test.tsx` | 四态 UI 验收 (`synthetic`) | **`exit=0`** (`8.42s`) | **4/4 用例全通过**：验证 `actionable`、`read_only`、`no_data`、`stale_request` 四类界面语义与越权按钮抑制 |

---

## 5. 上游新增证据与版本差异（`agy.exe 1.5.17` 实机对照）

通过 `agy.exe --help`、子命令帮助与离线内置 `agy.exe changelog` 直接观察到官方 `1.5.14`–`1.5.17` 重要行为演进，均已录入 [NP-17-review-8139349.md](../reviews/NP-17-review-8139349.md)：
1. **`1.5.17` Orchestrator 同模优化**：`Planner` 与 `Executor` 选用相同模型和 `Effort` 时直走单 Agent 执行，仅当 `Effort` 不同时才拆两阶段。
2. **`1.5.17` 预付钱包与刷新机制**：企业预付钱包余额为空时立即中止并返回明确提示，不再误报配额重试；OAuth 访问令牌提前刷新并自动重试 Stream 前 `401`；`/usage` 超 24 小时改按 `Nd Nh Nm` 展示；加强企业版对 `.git`、`.env`、`config.json`、`hooks.json`、`mcp_config.json` 拦截。
3. **`1.5.16` 子请求与生态**：修复 `default`/`accept-edits` 下子 Agent/Workflow 请求 60s 卡死并正确转发编辑器；新增 `~/.agents/skills`（`~/.gemini` 优先）；Swarm Board 唤醒归因改为 `"system"`；`pluginsDisabled` 不再禁用内置插件。
4. **`1.5.15` ACP 生命周期**：修复 `session/prompt` 在非 daemon 后台任务运行期间过早结束、修复 `session/load` 历史重放未完提前回包与 `-32603 -> -32002`、修复 `session/cancel` 遗留工具卡死、取消本地对话 500 条裁剪。

---

## 6. 现有数据、跨 Harness 回归与待协调问题

1. **老数据库、老客户端与跨 Harness**：`EV-NP17-E2E-RUNNER` (`B1` & `B2`) 与现有回归套件共同证明：在原生功能开启产生数据后再彻底关闭开关回滚，原有会话及历史事件（实测 `17` 条）完全可读，标准会话继续执行且 Codex Context Handoff 成功；即便是只识别 v1 的旧读取器遇到未来 v99 原生迁移表，依然可 `200` 正常读旧会话、同时原生端 fail-closed（`503`）。Codex (`5/5`)、Claude (`4/4`)、DeepSeek/OpenCode (`5/5`)、Handoff v2 (`12/12`)、Plugin SDK & Isolation 均保持零回归。
2. **向总指挥及各模块 Owner 提交的生产接线与修复清单**（详见审查附件第 8.1 节）：
   - **NP-13/14/15 生产接线决策**：当前 `8139349` 上 `GET /api/v1/sessions/:id/native/ecosystem-catalog` 与 `/native/artifacts` 返回 `404`；`PluginSlotSync.tsx` 未给 `AgySettingsSlot`/`AgyArtifactReviewPanel` 传原生 Props；`SessionManager.recoverStaleSessions()` 尚未接入 `AgyNativeRecoveryService.reconcileOnDaemonStartup()`；`composition.ts` 尚未透传 `dynamic`/`swarm`/`teamwork` 请求路由。建议总指挥按 `G4_Launch_Plan.md` 决定随 G4 串行接线或作为门控后阶段项。
   - **NP-16 协调项**：关注 `packages/daemon/tests/multi-harness-orchestrator.test.ts` 的 2 条 `30s` Git Worktree 超时用例在 Windows 下的稳定性，以及 `scripts/verify-agy-windows-isolation.mjs#L322` 的 Windows ACL 临时目录清理 `EPERM`。

---

## 7. 回滚命令与回滚后复跑实证

### 7.1 运行时门控秒级回退（无代码改动，保留历史数据）
```powershell
# 1. 移除或置零进程环境变量
Remove-Item Env:HARNESSMATE_AGY_NATIVE_RUNTIME -ErrorAction SilentlyContinue
# 2. 在桌面端/浏览器控制台清除实验 UI 开关并重启 Daemon
# localStorage.removeItem('hm_agy_native_ui')
```

### 7.2 代码与合并回退命令（按 `13_Git_Collaboration.md`）
```powershell
# 若需回退某一 G4/G3 合并提交（保留历史，不破坏只读旧数据）：
git revert -m 1 <merge_commit_sha>

# 若需在验收分支整体撤回至本轮评审起点 tag：
git checkout -b rollback/verify-pre-np17 agy-np-g3-wave2
pnpm build ; pnpm typecheck ; pnpm contracts:check
```

### 7.3 回滚后复跑实证结果（来自 `EV-NP17-E2E-RUNNER` Suite `B1` & `B2`）
- **Gate-OFF 实机复跑（`B1`）**：同一启用过原生特性并落地过事件的 SQLite 数据库在全部 Feature Flag 关闭重启后，`/native/snapshot` 返回 `200 (enabled: false)`，`/native/commands` 与 `/native/control` 均返回 `503 NATIVE_RUNTIME_DISABLED`，原会话（`17` 条历史事件）无损读出，且**回滚后重新提交标准会话 Turn 成功执行并完成至 `30` 条事件 + 成功 Handoff 到 `codex`**。
- **前向 Schema 防护（`B2`）**：SQLite `agy-native-runtime` 版本置为 `99` 后，`HarnessMateStore.getNativeRuntimeSchemaStatus()` 准确返回 `compatible: false, newerThanReader: true`，写入触发 `NATIVE_SCHEMA_NEWER_THAN_READER`，原生路由 `503` 阻断，同时既有非原生会话 REST 读取返回 `200`。

---

## 8. 审查者可复现 Evidence IDs 与命令

```powershell
$env:TEMP = 'D:\HarnessMate\np17-temp'
$env:TMP = 'D:\HarnessMate\np17-temp'
$env:TMPDIR = 'D:\HarnessMate\np17-temp'

# 1. 构建、类型、契约门禁
pnpm build ; pnpm typecheck ; pnpm contracts:check

# 2. NP-17 独立后端 E2E、回滚复跑、Schema 99 与洁净 agy.exe 1.5.17 校验
node scripts/agy-np/e2e/run-acceptance.mjs --out-dir D:\HarnessMate\np17-temp\e2e-run

# 3. NP-17 四类 UI 体验验收 (actionable / read_only / no_data / stale_request)
pnpm --filter @harnessmate/web exec vitest run --dir ..\.. --maxWorkers=1 --reporter=default scripts/agy-np/e2e/ui-four-states.test.tsx

# 4. 关键证据文件引用
# - D:\HarnessMate\np17-temp\e2e-run\np17-acceptance-summary.json
# - docs\phase-agy-native-parity\reviews\NP-17-review-8139349.md
# - scripts\agy-np\e2e\fixtures\windows-comparison-checklist.json
```
