# NP-01 交付报告 · 协议观测与事件录制（R1–R5 复验更新）

## 1. 基线、分支与提交信息

| 项目 | 值 |
| --- | --- |
| 源码审计基线 | `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039` |
| Reviewed G0 Checkpoint Base | `a01280176348974a0ddc00fd491afddc1d985c9e` (`docs(agy-np): record G0 worktree and verification setup`) |
| 初始实现 Commit | `acfd18c9752c96c67da2a7489461c3315dc4a58f` (`feat(agy-np-01): add AGY protocol observatory, sanitizer, replay fixtures, and scenario evidence`) |
| 首轮报告 Commit（评审基线） | `dd190a98137b9b9fa906296d4978be1ead2fd656`（对应独立评审 `NP-01-review-dd190a9.md`） |
| R1–R5 修复 Commit | `cea9688ca45c6f25149e13f504acb4e5c48bb430` (`fix(agy-np-01): address review blockers R1-R5 (...)`) |
| 最终报告 Commit | 本报告所在最新 `HEAD`（`docs(agy-np-01): update NP-01 handoff report after R1-R5 fixes`） |
| 工作分支 | `np01_protocol_observatory`（D 盘独立 Worktree，未越权改动 `codex/agy-np-01-observatory` 或其他 Worktree） |
| Worktree 实际路径 | `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np01_protocol_observatory` |
| 本机运行环境 | Windows (`win32`), Node `v24.18.0`, pnpm `11.21.0`, 官方 Google LLC 签名 `agy.exe`（首轮采样 `1.5.16`，本轮实机自动更新后 `1.5.17`，两版证据分文件独立保留） |

**未触碰禁改区确认**：`packages/daemon/src/harnesses/jsonrpc.ts`、`packages/daemon/src/core/session-manager.ts`、`packages/daemon/src/harnesses/acp/strict-acp-adapter.ts`、`packages/web/src/stores/app-store.ts`、`packages/protocol/src/**`、`packages/daemon/tests/fixtures/agy-1.5.14/**` 与 `docs/phase-agy-native-parity/MASTER_PROGRESS.md` 均 **0 修改**。

---

## 2. 独立评审 R1–R5 对照修复与复验

对应 `reviews/NP-01-review-dd190a9.md` 全部 5 项阻塞与改进项：

| 项 / 级别 | 原问题 | 修复实现（`cea9688`） | 复验用例与结论 |
| --- | --- | --- | --- |
| **R1 · P1** 脱敏输出与先写后检 | `recorder.mjs` 命中泄露仅替换 `shape`，`scenario`/`provenance`/`generation`/`unknownKeys` 原值仍进入 sink/文件；`cli.mjs migrate` 先写出无效 v1 再退出 1；校验错误回显非法原值。 | 1) `sanitizer.mjs` 建立严格元数据与动态键信任边界（`safeMetaToken`/`safeProvenance`/`isSafeProtocolKey`，屏蔽高熵/敏感键并仅输出 `redactedUnknownKeyCount`）。<br>2) `recorder.mjs._emit` 在写入 `records`/`sink`/文件前执行全记录 `validateCaptureRecord`（Schema + `scanRecordForLeaks`），失败直接阻断并计数 `leak_blocked`/`validation_blocked`，零字节流出。<br>3) `migrator.mjs` 与 `cli.mjs migrate` 改为先校验后写出，失败时 `records=[]`、`stdout` 0 字节、不创建 `--out`。<br>4) `schema-validator.mjs` 仅输出 `<path>: <reasonCode>`，不回显非法值或字段名。 | **PASS**：`agy-np-observatory.test.ts` 新增 R1 虚构邮箱反例，覆盖 `scenario`/`captureId`/`provenance`/`generation`/动态键/嵌套值及 `migrate` `stdout` 与 `--out` 两种模式，验证 0 泄露、0 无效写出。 |
| **R2 · P1** 四层归因折叠与误判 | `four-layer.mjs` 仅按 `connectionId+ingressOrdinal` 聚合且每层只留首条（遗漏 ordinal 10 出站 `cancelled` 应答）；纯 raw 采集将 `server_request` 误判为 `dropped_before_adapter`；`pending` RPC 缺 `generation/channel` 作用域；诊断编号可碰撞。 | 1) `recorder.mjs` 将 `pending` RPC 与 `ingressOrdinals` 均按 `connectionId + generation + channel` 作用域隔离。<br>2) `four-layer.mjs` 按 `connectionId + generation + channel + ingressOrdinal` 分组，保留同序号多事件与出站审批应答（`raw.eventCount` 与 Markdown 显式列出 `outcome=cancelled`）。<br>3) 按范围统计实际观测层，明确区分 `layer_not_captured`（下游未采集）、`observation_interrupted`（截断/超时/丢帧）与真实 `dropped_before_adapter`（含 `server_request_cancelled_before_adapter`）。<br>4) `AGY-DIAG-v1` 编号纳入 `generation + channel + s<seq>`，确保每条记录唯一。 | **PASS**：新增 R2 多代次/跨 `live`+`history_replay`/纯 raw `server_request` 反例与唯一编号校验；重生成 `synthetic-t02-t04-t06-four-layer.md`（`toolVersion: 0.2.0`）完整呈现 `conn-1/gen-1/live#10` 的入站审批与出站 `outcome=cancelled`。 |
| **R3 · P1** U01 边界、签名与退出码 | 接受任意 D 盘 Profile（如 `D:\qa\other-profile`）及任意路径同名 `agy.exe`；`child close` 前结束摘要；模型拒绝/未广告/deadline 可能退出 0；v2 摘要误读首条 `protocol=2`。 | 1) `probe-live.mjs` 将授权 `--test-profile` 严格绑定为 G0 专用目录 `D:\HarnessMate\agy-np-test-profile\gemini`（含 `realpathSync` 逃逸校验），`--scratch`/`--out`/`--summary-out` 限制在批准 D 盘目录内。<br>2) 校验官方 `agy.exe` 安装位置，实机运行前执行 Windows `Get-AuthenticodeSignature` 验证 `Status=Valid` 且签名主体匹配 `Google LLC`。<br>3) `initiateStop` 等待 `child` `close` 并 `await recorder.flush()` 后再写 `capture_end` 与摘要。<br>4) `evaluateCaptureOutcome` 显式区分成功语义（`expected_auth_required` / `expected_v2_downgrade_to_v1` / `discovery_complete` / `reactive_observed`）与失败路径（`cli.mjs` 对模型未广告/拒绝/超时等返回退出码 `1`）。<br>5) 初始 `protocol: null`，待 `initialize` 响应回填 `negotiatedProtocol`，摘要分列 `requestedProtocol` 与 `negotiatedProtocol`。 | **PASS**：新增 R3 边界单测（拒绝 `D:\qa\other-profile`、`C:\evil\agy.exe`）与 Mock Server 端到端用例（覆盖模型未广告、模型拒绝、discovery 成功、reactive 成功、v2→v1 降级）；实机通过 `Google LLC` 签名校验并采集 `1.5.17` 无身份 v1/v2 样本。 |
| **R4 · P2** 内存、别名与 IO 上界 | `maxRecords` 饱和前仍分配 20 个别名；`enabled=false` 直调仍写 pending；同步 `appendFileSync` 跑在回调热路径；`probe-live` 换行前无界累计 stderr。 | 1) 所有 `record*` 入口在关闭或 `records.length >= maxRecords` 时立即提前返回（停止别名分配与 pending 记录），导出分类 `dropReasons`。<br>2) `AliasTable` 增设 `maxAliasesPerNamespace` / `maxTotalAliases` 硬上限；`clampRawText` 限制原始输入长度。<br>3) 文件输出改为有界非阻塞异步队列（`maxQueuedWriteLines`/`maxQueuedWriteBytes` + `flush()`），队列满按 `io_queue_overflow` 丢弃不阻塞调用方。<br>4) `probe-live.mjs` 换行前 stderr 缓冲限制为 `4096` 字节并丢弃超长尾部。 | **PASS**：新增 R4 单测覆盖 `enabled=false` 零分配、`maxRecords=2` 注入 20 RPC 提前止损、`AliasTable` 溢出上限与异步 IO 队列溢出/刷新。 |
| **R5 · P2** 单源 Schema 校验与 T03 稳定性 | 手工校验器漏拦 `shape` 字符串、`provenance` 额外字段、数字 `generation`；T03 1500ms watchdog 与子进程启动竞争导致偶发失败且断言只打印布尔值。 | 1) `schema-validator.mjs` 改为直接加载 `schema/capture-v1.schema.json` 并由单源 Schema 驱动校验，消除漂移。<br>2) `replay-runner.mjs` 通过 IPC `replay_ready` 将子进程启动就绪与场景定时/watchdog 完全分离，超时或结束后等待 `child close` 与流关闭再评判 verdict；T03 watchdog 放宽至 `8000ms`。<br>3) 测试断言改为 `expect(result.verdict.checks.filter(c => !c.passed)).toEqual([])` 直接输出失败明细。 | **PASS**：新增 R5 三项反例单测全数拦截；新增模拟慢启动（`simulateSlowStartMs: 700`）T03 用例通过；连续 5 次 CLI 复跑 T03 100% 通过（`T03_5X_PASS`）。 |

---

## 3. 共享契约 Revision

- 对齐 `docs/phase-agy-native-parity/08_Shared_Contracts.md` **v0.1 提案**（`NativeIngress` 的 `connectionId / generation / ingressOrdinal / channel`、RPC ID 类型保真、四层投影隔离）。
- NP-01 专属契约：`observatory-capture-v1`（单源 JSON Schema `scripts/agy-np/observatory/schema/capture-v1.schema.json`）与 `AGY-DIAG-v1`（v0.2 唯一格式 `AGY-DIAG-v1:<captureId>:<scenario>:<conn>:<gen>:<channel>:<ordinal>:s<seq>:<layer>:<reasonCode>`，供 NP-03 在 G1 复核）。

---

## 4. 测试命令与结果

所有测试均在 D 盘临时目录（`$env:TEMP='D:\HarnessMate\np00-research'`）下执行，零跳测：

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `node scripts/agy-np/observatory/cli.mjs record --agy <agy.exe> --scratch D:\HarnessMate\np00-research --catalog --out ...` | **PASS** | 通过 Windows `Google LLC` 签名校验，采集本机 `1.5.17` 无身份 v1 样本（9 条记录，`outcome: expected_auth_required`，0 错误 0 泄露，退出码 0） |
| `node scripts/agy-np/observatory/cli.mjs record --agy <agy.exe> --scratch D:\HarnessMate\np00-research --protocol 2 --out ...` | **PASS** | 通过签名校验，采集 `1.5.17` v2→v1 降级样本（5 条记录，`requestedProtocol: 2` / `negotiatedProtocol: 1`，`outcome: expected_v2_downgrade_to_v1`，0 错误 0 泄露，退出码 0） |
| `node scripts/agy-np/observatory/cli.mjs replay --mode four-layer --out ... --summary-out ...` | **PASS** | 56 条四层记录，`conn-1|gen-1|live#10` 完整保留入站审批与出站 `outcome=cancelled` 应答（`server_request_cancelled_before_adapter`） |
| `node scripts/agy-np/observatory/cli.mjs validate --in <5 scenario ndjson files>` | **PASS (5/5)** | 原保留 `1.5.16`（v1/v2）、新增 `1.5.17`（v1/v2）与四层基线样本全部通过单源 Schema + 零泄露校验 |
| `pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np-observatory.test.ts` | **PASS (18/18)** | 全量覆盖 R1–R5 反例、T01–T06、慢启动 T03、Mock Server 模型路径、四层基线关联、迁移与零泄露 |
| 连续 5 次 `cli.mjs replay --fixture t03-long-finite-timeout-exit.ndjson` | **PASS (5/5)** | `T03_5X_PASS`，零偶发失败 |
| `pnpm typecheck` | **PASS** | 全部 6 个 workspace package 通过 |
| `pnpm build` | **PASS** | 全部 6 个 workspace package 构建通过 |
| `pnpm test` | **PASS (203 tests + plugin contracts)** | `contracts:check` 通过；`protocol`: 1/1、`web`: 50/50（11 files）、`daemon`: 152/152（31 files，含 18 项 NP-01 及全部既有 AGY 1.5.14 / Codex / Claude / DeepSeek / OpenCode / Strict ACP / Handoff / Orchestrator / Plugin 回归）、`electron`: 0 files exit 0 |
| `git diff --check a012801...HEAD` | **PASS** | 无空白/格式错误 |

**未运行项与原因**：
- U01 `--discover-confirmed` 与 `--reactive-confirmed` 授权采集：需用户在 `D:\HarnessMate\agy-np-test-profile\gemini` 完成官方交互登录并确认实际广告的 Gemini 3.8 Flash ID 后执行。

---

## 5. 验证类别、Capability ID 与真实证据/缺口

| 证据 ID | 来源类别 | 关联 Capability ID | 路径 | 结论与边界 |
| --- | --- | --- | --- | --- |
| NP01-E01 | `live_raw`（无身份） | `AGY-R01` | `docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-clean-v1.ndjson` | 原提交保留（v0.1 采集，通过 v0.2 单源校验）：AGY `1.5.16` v1 握手与 `-32000` |
| NP01-E02 | `live_raw`（无身份） | `AGY-R01` | `docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-request-v2.ndjson` | 原提交保留（v0.1 采集，通过 v0.2 单源校验）：AGY `1.5.16` 请求 v2 返回 1 |
| NP01-E06 | `live_raw`（无身份） | `AGY-R01` | `docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.17-{clean-v1,request-v2}.ndjson` | v0.2 工具经 `Google LLC` 签名校验采集的 AGY `1.5.17` 无身份实证，`process_exit` 在 `capture_end` 前记录且明确区分 `requestedProtocol`/`negotiatedProtocol` |
| NP01-E03 | `synthetic` | `AGY-R02`–`AGY-R05`, `AGY-R08` | `docs/phase-agy-native-parity/evidence/scenarios/synthetic-t02-t04-t06-four-layer.{ndjson,md,summary.json,np03.json}` | v0.2（`toolVersion: 0.2.0`）重生成：按 `connectionId/generation/channel#ordinal` 归因，完整呈现 `turn_bg` 误归属与 `conn-1/gen-1/live#10` 权限前置 `cancelled` 应答 |
| NP01-E04 | `synthetic` | `AGY-R02`–`AGY-R09`, `AGY-W01` | `packages/daemon/tests/fixtures/agy-np/{t01..t06,failure-malformed-and-secret-trap}.ndjson` | 确定性验证 T01–T06、慢启动 T03、畸形行、强制超时、非零退出及 0 泄露 |
| NP01-E05 | `replay_with_provenance` | `AGY-R02`, `AGY-R08`, `AGY-R09` | `scripts/agy-np/observatory/migrator.mjs` + `agy-np-observatory.test.ts` | 无损迁移 NP-00 与 `agy-1.5.14` 夹具为 Observatory v1，原 1.5.14 夹具保持字节不变 |

**真实证据缺口**：`AGY-R02`–`AGY-R09`、`AGY-W01` 的真实授权会话帧（U01 能力发现、Gemini 3.8 Flash 20 秒有限后台 wake、真实 child/approval 负载及官方 App/CLI 同场景对照）仍为 `Not Tested`，能力矩阵等级维持 G0，待用户登录专用 Profile 后复现采集。

---

## 6. 数据与其他 Harness 回归结论

- **数据隔离**：零修改生产 SQLite、零修改 `packages/daemon/tests/fixtures/agy-1.5.14/**`、零触碰宿主机默认凭据或生产工作区；所有临时文件均在 `D:\HarnessMate\np00-research` 隔离。
- **其他 Harness 与核心能力**：全量 `pnpm test` 203 项测试与插件契约检查全部通过，Codex、Claude、DeepSeek、OpenCode、Strict ACP、既有 AGY 1.5.14 回放、Context Handoff V2、Multi-Harness Orchestrator、Git Checkpoints、Terminal Workspace 与 Plugin SDK V4/V5 **0 回归**。

---

## 7. 冲突与协作请求

### 7.1 致 NP-02（Daemon 传输与生命周期接入缝 — G1 审查候选）

- `createDaemonTapCallbacks` (`scripts/agy-np/observatory/recorder.mjs`) 已补齐 `generation + channel` 作用域隔离、提前止损与非阻塞异步文件队列，供 NP-02 在 G1 接入缝评估 `StdioJsonRpcClient` / `AcpSessionHandle` / `NativeLifecyclePort` 只读 `onRawTap` 接线。关闭 opt-in 时零分配、零 IO 开销。

### 7.2 致 NP-03（前端四层简表与全局唯一可复制诊断编号 — G1 契约候选）

- `buildFourLayerSummary(records).np03DiagnosticInput` 输出稳定结构（样例见 `docs/phase-agy-native-parity/evidence/scenarios/synthetic-t02-t04-t06-np03.json`，`toolVersion: 0.2.0`）。
- 诊断编号格式升级为全局唯一 `AGY-DIAG-v1:<captureId>:<scenario>:<connectionId>:<generation>:<channel>:<ingressOrdinal>:s<seq>:<layer>:<reasonCode>`，每条记录独立编号且不含任何路径、账号、Prompt 或 Token。

---

## 8. 回滚命令

- **运行时关闭**：NP-01 观察器为纯 opt-in 工具，未接入生产热路径；未来接入 Daemon 后关闭 opt-in 开关即可即时停用。
- **代码撤销**：
  ```powershell
  # 按逆序撤销 R1-R5 修复提交与初始实现提交（或合并后 revert 对应 merge commit）
  git revert --no-edit cea9688ca45c6f25149e13f504acb4e5c48bb430 acfd18c9752c96c67da2a7489461c3315dc4a58f
  ```

---

## 9. 审查者快速核验索引

| 检查项 | 证据 ID / 路径 | 核验命令 |
| --- | --- | --- |
| 范围与格式检查 | `a012801...HEAD` | `git diff --name-status a01280176348974a0ddc00fd491afddc1d985c9e...HEAD` & `git diff --check a01280176348974a0ddc00fd491afddc1d985c9e...HEAD` |
| 单源 Schema 与 5 份场景零泄露 | NP01-E01/E02/E03/E06 | `node scripts/agy-np/observatory/cli.mjs validate --in docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.17-request-v2.ndjson` |
| 四层归因表（含出站 cancelled）与 NP-03 | NP01-E03 (`synthetic-t02-t04-t06-four-layer.md`) | `node scripts/agy-np/observatory/cli.mjs summarize --in docs/phase-agy-native-parity/evidence/scenarios/synthetic-t02-t04-t06-four-layer.ndjson --format np03` |
| R1–R5 反例、T01–T06 与慢启动 T03 | NP01-E04 (`agy-np-observatory.test.ts`) | `pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np-observatory.test.ts` |
| 全量门禁 | 全仓 | `pnpm typecheck` & `pnpm build` & `pnpm test` |
