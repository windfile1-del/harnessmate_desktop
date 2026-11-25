# NP-01 交付报告 · 协议观测与事件录制

## 1. 基线、分支与提交信息

| 项目 | 值 |
| --- | --- |
| 源码审计基线 | `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039` |
| Reviewed G0 Checkpoint Base | `a01280176348974a0ddc00fd491afddc1d985c9e` (`docs(agy-np): record G0 worktree and verification setup`) |
| 实现代码 Commit | `acfd18c9752c96c67da2a7489461c3315dc4a58f` (`feat(agy-np-01): add AGY protocol observatory, sanitizer, replay fixtures, and scenario evidence`) |
| 报告 Commit | 本报告所在最新 `HEAD`（`docs(agy-np-01): add NP-01 handoff report`） |
| 工作分支 | `np01_protocol_observatory`（注：按 `13_Git_Collaboration.md` 由工具在 D 盘独立 Worktree 创建；`codex/agy-np-01-observatory` 已被另一目录占用，未越权改动） |
| Worktree 实际路径 | `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np01_protocol_observatory` |
| 本机运行环境 | Windows (`win32`), Node `v24.18.0`, pnpm `11.21.0`, 官方 `agy.exe` `1.5.16`（位于 `%LOCALAPPDATA%\agy\bin\agy.exe`） |

### 文件变更范围（严格符合 NP-01 允许写入清单）

- `scripts/agy-np/observatory/schema/capture-v1.schema.json` — Observatory v1 NDJSON JSON Schema（Draft 2020-12）
- `scripts/agy-np/observatory/sanitizer.mjs` — 入站/出站字段 allowlist 重建器、`AliasTable` 加盐短别名、测试标记加盐关联、`stderr` 分类与骨架哈希、未知字段名/类型提取、`scanTextForLeaks`/`scanRecordForLeaks` 零泄露守卫
- `scripts/agy-np/observatory/schema-validator.mjs` — 运行时 Schema 校验、单调 `seq` 校验与泄露扫描
- `scripts/agy-np/observatory/four-layer.mjs` — 四层对比简表（`raw` / `normalized` / `native_canonical` / `ui`）生成器、异常归因分类器、Markdown 导出及 NP-03 安全诊断编号（`AGY-DIAG-v1:...`）编码/解码器
- `scripts/agy-np/observatory/recorder.mjs` — `ProtocolObservatoryRecorder`（opt-in、有界缓冲与 `drop_overflow`/截断统计、请求/审批延时测量、sink 错误隔离）与 `createDaemonTapCallbacks` 回调接口
- `scripts/agy-np/observatory/migrator.mjs` — 历史格式迁移器（NP-00 `probe-acp.mjs`、`0409bc8-synthetic-routing.ndjson` 与 `agy-1.5.14` stage fixture → Observatory v1，不修改源文件）
- `scripts/agy-np/observatory/probe-live.mjs` — 保留默认无身份探针，新增 `--dry-run`、一键 live 录制（clean / `--discover-confirmed` / `--reactive-confirmed --model <id>` / `--login-test-profile`）与 D 盘路径/Gemini 3.8 Flash 强校验
- `scripts/agy-np/observatory/replay-runner.mjs` — 离线确定性 stdio 回放器（支持分片帧、畸形行、stderr 陷阱、强制超时、非零退出、显式判定条件评估）与真实基线 `AcpSessionHandle` + `AntigravityAcpFlavorPolicy` 四层关联回放器
- `scripts/agy-np/observatory/cli.mjs` — 统一 CLI 入口（`record` / `validate` / `migrate` / `summarize` / `replay`）
- `scripts/agy-np/observatory/README.md` — Windows 执行说明、脱敏策略、NP-03 输入格式及采样来源/限制说明
- `packages/daemon/tests/fixtures/agy-np/{t01..t06,failure-malformed-and-secret-trap}.ndjson` + `README.md` — T01–T06 及失败/泄露陷阱回放夹具（每份均含显式 `verdictCriteria`）
- `packages/daemon/tests/agy-np-observatory.test.ts` — 13 项 NP-01 专属单测、回放与安全零泄露测试
- `docs/phase-agy-native-parity/evidence/scenarios/*` — 默认无身份 Windows AGY 1.5.16 Observatory v1 真实采集样本（v1 + v2）及四层基线归因样本（NDJSON / JSON / Markdown / NP-03 输入）
- `docs/phase-agy-native-parity/handoffs/NP-01-report.md` — 本交付报告

**未触碰禁改区确认**：`packages/daemon/src/harnesses/jsonrpc.ts`、`packages/daemon/src/core/session-manager.ts`、`packages/daemon/src/harnesses/acp/strict-acp-adapter.ts`、`packages/web/src/stores/app-store.ts`、`packages/protocol/src/**`、`packages/daemon/tests/fixtures/agy-1.5.14/**` 与 `docs/phase-agy-native-parity/MASTER_PROGRESS.md` 均 **0 修改**。

---

## 2. 已实现与未覆盖事项

### 已实现

1. **Observatory Capture v1 Schema 与元数据契约**：完整实现 `12_Test_Strategy.md` 要求的捕获字段（`schemaVersion, captureId, scenario, platform, cliVersion, protocol, accountCategory, source, observedAt, producer, seq, monotonicMs, layer, direction, messageKind`）与 `08_Shared_Contracts.md` 的 `NativeIngress` 关联字段（`connectionId, generation, ingressOrdinal, channel, rpcIdAlias, rpcIdType` 及同别名穿透 `session/child/tool/task/workflow/approval/turn/activity/work/agent`）。
2. **默认白名单脱敏与零泄露守卫**：入站与出站 JSON-RPC 帧默认按字段 allowlist 重建；保留 RPC ID 类型（`number` vs `string`）、未知字段名、往返延时 `latencyMs`、测试标记加盐关联（`salted:<12-hex>`）；`stderr` 仅输出分类与脱敏骨架哈希；内建 `scanRecordForLeaks` 兜底阻断 OAuth URL 参数、Bearer/ya29/AIza/sk Token、Cookie、邮箱、Windows/POSIX 绝对路径与 `HARNESSMATE_*_TOKEN`。
3. **有界保护与业务隔离**：默认 opt-in；超限触发 `drop_overflow` 与行截断 `truncated: true`；sink 异常全部隔离计数，不抛错也不进入生产业务事件或 SQLite。
4. **一键录制、Dry-run 与格式迁移**：保留 NP-00 默认无身份路径；支持 `--dry-run` 参数与策略预检；支持从 NP-00 探针、`0409bc8` 合成轨迹与 `agy-1.5.14` 夹具无损迁移为 Observatory v1（显式标注 `provenance.timingSynthetic`）。
5. **T01–T06 及失败夹具回放与四层归因**：交付 7 份独立夹具（含 T03 强制超时+非零退出、畸形行+分片+敏感信息泄露陷阱，每份写明判定条件），并基于真实已构建的基线 `AcpSessionHandle` + `AntigravityAcpFlavorPolicy` 跑通四层归因对比表，精准定位 `turn_bg` 误归属（`conn-1#8/#9`）与轮次外权限前置取消（`conn-1#10`）。
6. **面向 NP-03 的安全诊断输入格式**：定义并生成无敏感信息的 `AGY-DIAG-v1:<captureId>:<scenario>:<conn>:<ordinal>:<layer>:<reasonCode>` 及 `np03DiagnosticInput` JSON。

### 未覆盖 / 保持门控事项

1. **U01 授权真机发现与 20 秒复现（Gemini 3.8 Flash）**：遵守 U01 约定，不在自动化会话中执行 OAuth 登录或发送模型 Prompt。待用户在专用测试 Profile (`D:\HarnessMate\agy-np-test-profile`) 完成官方交互登录后，按 `scripts/agy-np/observatory/README.md` §1.3 执行 `--discover-confirmed` 与 `--reactive-confirmed --model <id>` 补齐 `live_raw` 授权轨迹。
2. **生产 Daemon 传输层 tap 接线**：按文件所有权约定，NP-01 不直接修改 `jsonrpc.ts` / `strict-acp-adapter.ts` / `session-manager.ts`。已提供经单测验证的 `createDaemonTapCallbacks` 回调接口，待 NP-02 在 G1 接入缝审查合入（见 §7 协作请求）。

---

## 3. 共享契约 Revision

- 对齐 `docs/phase-agy-native-parity/08_Shared_Contracts.md` **v0.1 提案**（`NativeIngress` 的 `connectionId / generation / ingressOrdinal / channel`、RPC ID 类型保真、四层投影隔离）。
- 新增 NP-01 专属契约：`observatory-capture-v1`（`scripts/agy-np/observatory/schema/capture-v1.schema.json`）与 `AGY-DIAG-v1`（NP-03 可复制诊断编号格式，样例见 `docs/phase-agy-native-parity/evidence/scenarios/synthetic-t02-t04-t06-np03.json`）。

---

## 4. 测试命令与结果

所有测试均在 D 盘临时目录（`$env:TEMP='D:\HarnessMate\np00-research'`）下执行，无跳测：

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile --store-dir D:\HarnessMate\agy-np-pnpm-store` | **PASS** | 锁定依赖完整安装 |
| `pnpm build` | **PASS** | `plugin-api` / `plugin-sdk` / `protocol` / `daemon` / `web` / `electron` 全部构建通过 |
| `node scripts/agy-np/observatory/cli.mjs record --agy <agy.exe> --scratch D:\HarnessMate\np00-research --catalog --out ...` | **PASS** | 采集 Windows AGY 1.5.16 真实无身份 v1 样本（9 条记录，0 校验错误，0 泄露） |
| `node scripts/agy-np/observatory/cli.mjs record --agy <agy.exe> --scratch D:\HarnessMate\np00-research --protocol 2 --out ...` | **PASS** | 采集 Windows AGY 1.5.16 真实无身份 v2→v1 降级样本（5 条记录，0 错误，0 泄露） |
| `node scripts/agy-np/observatory/cli.mjs replay --mode four-layer --out ... --summary-out ...` | **PASS** | 56 条四层关联记录，精准识别 `conn-1#8/#9` (`adapter_misattributed_placeholder`) 与 `conn-1#10` (`dropped_before_adapter`) |
| `node scripts/agy-np/observatory/cli.mjs validate --in <each scenario ndjson>` | **PASS** | 全部 3 份场景 NDJSON 通过 Schema + 零泄露校验 |
| `pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np-observatory.test.ts` | **PASS (13/13)** | 覆盖 Schema/allowlist/别名/延时/有界丢帧/stderr/泄露陷阱/T01–T06/基线四层关联/迁移/CLI 安全门禁 |
| `pnpm typecheck` | **PASS** | 全部 6 个 workspace package 类型检查通过 |
| `pnpm test` | **PASS (198 tests + plugin contracts)** | `contracts:check` 通过；`protocol`: 1/1、`web`: 50/50（11 files）、`daemon`: 147/147（31 files，含新增 13 项及全部既有 AGY 1.5.14 / Codex / Claude / Strict ACP / Handoff / Orchestrator / Plugin 回归）、`electron`: 0 files exit 0 |
| `git diff --check` | **PASS** | 无空白/格式错误 |

**未运行项与原因**：
- U01 `--discover-confirmed` 与 `--reactive-confirmed` 真机授权采集：等待用户交互登录 `D:\HarnessMate\agy-np-test-profile` 并确认实际广告的 Gemini 3.8 Flash ID 后执行。

---

## 5. 验证类别、Capability ID 与真实证据/缺口

| 证据 ID | 来源类别 | 关联 Capability ID | 路径 | 结论与边界 |
| --- | --- | --- | --- | --- |
| NP01-E01 | `live_raw`（无身份） | `AGY-R01` | `docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-clean-v1.ndjson` | 实证本机 Windows AGY `1.5.16` v1 握手（`latencyMs: 874.33`）、`loadSession/resume/close/load/list/additionalDirectories`、`session/new` `-32000`（`latencyMs: 216.8`）及 `models`/`agents` 无身份行为 |
| NP01-E02 | `live_raw`（无身份） | `AGY-R01` | `docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-request-v2.ndjson` | 实证请求 protocol `2` 返回 protocol `1`（`latencyMs: 895.58`）并安全停止 |
| NP01-E03 | `synthetic` | `AGY-R02`–`AGY-R05`, `AGY-R08` | `docs/phase-agy-native-parity/evidence/scenarios/synthetic-t02-t04-t06-four-layer.{ndjson,md,summary.json,np03.json}` | 在真实基线 `AcpSessionHandle` + `AntigravityAcpFlavorPolicy` 上验证四层时间线与同别名穿透，复现 `turn_bg` 误归属与轮次外权限前置 `cancelled` |
| NP01-E04 | `synthetic` | `AGY-R02`–`AGY-R09`, `AGY-W01` | `packages/daemon/tests/fixtures/agy-np/{t01..t06,failure-malformed-and-secret-trap}.ndjson` | 离线确定性验证 T01–T06 采集形状、RPC ID 数值/字符串区分、未知字段、畸形行、强制超时、非零退出及 0 泄露 |
| NP01-E05 | `replay_with_provenance` | `AGY-R02`, `AGY-R08`, `AGY-R09` | `scripts/agy-np/observatory/migrator.mjs` + `agy-np-observatory.test.ts` | 无损迁移 NP-00 与 `agy-1.5.14` 夹具为 Observatory v1，原 1.5.14 夹具保持字节不变 |

**真实证据缺口**：`AGY-R02`–`AGY-R09`、`AGY-W01` 的真实授权会话帧（U01 能力发现、Gemini 3.8 Flash 20 秒有限后台 wake、真实 child/approval 负载、与官方 App/CLI 同场景对照）仍为 `Not Tested`，需用户登录后按 `scripts/agy-np/observatory/README.md` 采集。

---

## 6. 数据与其他 Harness 回归结论

- **数据隔离**：零修改生产 SQLite、零修改 `packages/daemon/tests/fixtures/agy-1.5.14/**`、零读取宿主机默认 AGY 凭据或生产工作区；所有临时探针均在 `D:\HarnessMate\np00-research` 内隔离执行。
- **其他 Harness 与核心能力**：全量 `pnpm test` 198 项测试全部通过，Codex、Claude、DeepSeek、OpenCode、Strict ACP、既有 AGY 1.5.14 回放、Context Handoff V2、Multi-Harness Orchestrator、Git Checkpoints、Terminal Workspace 与 Plugin SDK V4/V5 契约均 **0 回归**。

---

## 7. 冲突与协作请求

### 7.1 致 NP-02（Daemon 传输与生命周期接入缝 — 最小 Diff 提议）

为在不耦合业务事件的前提下接入 `ProtocolObservatoryRecorder`（默认关闭，opt-in 注入），建议在 G1 接入缝增加以下最小只读回调选项（具体实现与单测原型见 `createDaemonTapCallbacks` in `scripts/agy-np/observatory/recorder.mjs` 及 `packages/daemon/tests/agy-np-observatory.test.ts` 第 1 个用例）：

1. **`StdioJsonRpcClient` (`packages/daemon/src/harnesses/jsonrpc.ts`)**：
   - 在 `JsonRpcHandlers` 新增可选 `onRawTap?: { onOutboundFrame?; onInboundFrame?; onMalformedLine?; onStderrLine?; onTimeout?; onProcessExit? }`。
   - 在 `writeLine` 写入前调用 `onOutboundFrame({ connectionId, frame })`；在 `handleMessage` 入口递增单调 `ingressOrdinal` 后同步调用 `onInboundFrame({ connectionId, ingressOrdinal, frame })`；在 `onNoise` / `stderr` / 超时 `reject` / `close` 处分别回调对应只读钩子（用 `try/catch` 吞掉观察器异常，保证永不阻塞或抛错）。
2. **`AcpSessionHandle` & `NativeLifecyclePort`**：
   - 将当前同步处理的 `ingressOrdinal` 传递给 `onNormalizedEvent` / `onNativeCanonicalEvent`，确保多行同 chunk 到达时四层记录严格 1:1 对齐（可彻底消除外层代理按 chunk 监听时的 ordinal 偏移问题）。
   - 关闭 opt-in 时默认传入 `undefined`，零额外分配与运行时开销。

### 7.2 致 NP-03（前端四层简表与可复制诊断编号输入）

- `scripts/agy-np/observatory/four-layer.mjs` 的 `buildFourLayerSummary(records).np03DiagnosticInput` 提供稳定的 v1 诊断 JSON 结构（样例见 `docs/phase-agy-native-parity/evidence/scenarios/synthetic-t02-t04-t06-np03.json`）。
- 诊断编号格式固定为 `AGY-DIAG-v1:<captureId>:<scenario>:<connectionId>:<ingressOrdinal>:<layer>:<reasonCode>`，已通过正则与零泄露校验，可直接支持前端一键复制与粘贴到排查报告，不含任何本地路径、账号、Prompt 或 Token。

---

## 8. 回滚命令

- **运行时关闭**：NP-01 观察器为纯 opt-in 工具，不接入生产热路径；未来接入 Daemon 后关闭 recorder opt-in 开关即可即时零成本停用。
- **代码撤销**：
  ```powershell
  # 若需撤销本工作包实现提交（保留 fixture/证据历史或按需整体回退）
  git revert --no-edit acfd18c9752c96c67da2a7489461c3315dc4a58f
  ```

---

## 9. 审查者快速核验索引

| 检查项 | 证据 ID / 路径 | 核验命令 |
| --- | --- | --- |
| 范围与格式检查 | `a012801..HEAD` | `git diff --name-status a01280176348974a0ddc00fd491afddc1d985c9e...HEAD` & `git diff --check a01280176348974a0ddc00fd491afddc1d985c9e...HEAD` |
| 场景证据零泄露与 Schema | NP01-E01 / E02 / E03 (`docs/phase-agy-native-parity/evidence/scenarios/`) | `node scripts/agy-np/observatory/cli.mjs validate --in docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-clean-v1.ndjson` |
| 四层归因表与 NP-03 格式 | NP01-E03 (`synthetic-t02-t04-t06-four-layer.md`) | `node scripts/agy-np/observatory/cli.mjs summarize --in docs/phase-agy-native-parity/evidence/scenarios/synthetic-t02-t04-t06-four-layer.ndjson --format np03` |
| T01–T06 与失败/泄露陷阱回放 | NP01-E04 (`packages/daemon/tests/fixtures/agy-np/`) | `pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np-observatory.test.ts` |
| 全量类型与回归门禁 | 全仓 | `pnpm typecheck` & `pnpm test` |
