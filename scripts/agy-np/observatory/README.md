# NP-01 · AGY Protocol Observatory v0.2（Windows 运行与脱敏说明）

本目录提供独立、零生产侵入、默认白名单脱敏且具备单源 Schema 强校验的 AGY ACP 协议观测、录制、迁移、回放与四层归因工具链。

- **默认无身份路径**：不登录、不读取生产配置、不发送模型 Prompt，仅在 D 盘白名单临时目录运行隔离探针。
- **U01 强边界约束**：所有授权模式（`--login-test-profile` / `--discover-confirmed` / `--reactive-confirmed`）强制绑定 G0 专用 Profile 目录 `D:\HarnessMate\agy-np-test-profile\gemini`，输出与 scratch 仅限允许的 D 盘目录；实机启动前校验官方 `agy.exe` 安装位置与 Windows Authenticode Google 数字签名。
- **先校验后输出（Fail-Closed）**：`ProtocolObservatoryRecorder` 与 `migrate` CLI 均在校验（单源 `capture-v1.schema.json` + 零泄露扫描）完全通过后才写入 `sink`、`stdout` 或文件；任何非法/泄露记录均被阻断，校验错误仅报告字段路径与原因码，不回显敏感原值。
- **有界内存与非阻塞 IO**：所有记录数、Pending RPC、别名表、原始行长、stderr 换行前缓冲（4 KiB）与文件异步写队列均有硬上限，饱和或关闭后提前返回并按原因输出 `dropReasons` 计数。

## 1. Windows PowerShell 快速执行

所有临时目录与输出文件均须位于允许的 **D 盘** 目录内。

### 1.1 Dry-run（不启动 `agy.exe`，校验路径/官方路径/参数/脱敏策略）

```powershell
$agy = (Get-Command agy.exe).Source
$scratch = 'D:\HarnessMate\np00-research'
node scripts/agy-np/observatory/cli.mjs record --dry-run --agy $agy --scratch $scratch --catalog
```

### 1.2 默认无身份真实握手采样（v1 + catalog / v2 对照）

```powershell
$agy = (Get-Command agy.exe).Source
$scratch = 'D:\HarnessMate\np00-research'
$env:TEMP = $scratch; $env:TMP = $scratch; $env:TMPDIR = $scratch

node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --catalog `
  --out "$scratch\clean-v1.ndjson" --summary-out "$scratch\clean-v1-summary.json"

node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --protocol 2 `
  --out "$scratch\clean-v2.ndjson" --summary-out "$scratch\clean-v2-summary.json"
```

### 1.3 U01 授权测试 Profile（人工登录后执行）

> 遵守 U01 约定：专用个人测试 Profile 严格绑定 `D:\HarnessMate\agy-np-test-profile\gemini`，仅在用户交互登录完成后执行一次能力发现与一次 **Gemini 3.8 Flash** 20 秒有限后台复现。工具不会自动登录或自动批准权限；审批交互仅输出到操作终端 `stderr`，不进入证据流。

```powershell
$testRoot = 'D:\HarnessMate\agy-np-test-profile'
$profile = Join-Path $testRoot 'gemini'
$scratch = Join-Path $testRoot 'runs'
$env:TEMP = Join-Path $testRoot 'temp'
$env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
$agy = (Get-Command agy.exe).Source

# 1) 官方交互登录（仅用户本人终端操作）
node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --test-profile $profile --login-test-profile

# 2) 能力发现（不发送 Prompt；未开会话将退出码 1）
node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --test-profile $profile --discover-confirmed `
  --out "$scratch\u01-discover.ndjson" --summary-out "$scratch\u01-discover-summary.json"

# 3) 从 u01-discover.ndjson 中取得实际广告的 Gemini 3.8 Flash model ID 后，执行单次 20 秒复现（需终端键入 YES）
$modelId = '<由上一步实际广告的 Gemini 3.8 Flash ID>'
node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --test-profile $profile --reactive-confirmed --model $modelId `
  --out "$scratch\u01-reactive-t02.ndjson" --summary-out "$scratch\u01-reactive-t02-summary.json"
```

### 1.4 校验、迁移、回放与四层归因简表

```powershell
# 校验单源 Schema 与零泄露规则
node scripts/agy-np/observatory/cli.mjs validate --in docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-clean-v1.ndjson

# 将旧 NP-00 或 agy-1.5.14 stage fixture 迁移为 Observatory v1（先校验后写出，失败不写出任何字节）
node scripts/agy-np/observatory/cli.mjs migrate --in docs/phase-agy-native-parity/evidence/windows-1.5.16-clean-v1.ndjson --out D:\HarnessMate\np00-research\migrated.ndjson

# 运行离线确定性回放并核对失败判定条件
node scripts/agy-np/observatory/cli.mjs replay --fixture packages/daemon/tests/fixtures/agy-np/t02-reactive-20s-wake.ndjson

# 运行真实基线适配器（AcpSessionHandle + AntigravityAcpFlavorPolicy）的四层归因回放（需先 pnpm --filter @harnessmate/daemon build）
node scripts/agy-np/observatory/cli.mjs replay --mode four-layer --out D:\HarnessMate\np00-research\four-layer.ndjson --summary-out D:\HarnessMate\np00-research\four-layer-summary.json

# 生成 Markdown 四层对比表或 NP-03 安全诊断编号输入
node scripts/agy-np/observatory/cli.mjs summarize --in D:\HarnessMate\np00-research\four-layer.ndjson --format markdown
node scripts/agy-np/observatory/cli.mjs summarize --in D:\HarnessMate\np00-research\four-layer.ndjson --format np03
```

### U01 结果判读

- `reactive_observed` 需要同会话、同工具 ID 的有限后台任务在 Prompt 返回后完成、工具结果包含固定测试标记，随后观察到新的工具调用。
- `reactive_not_observed` 表示采集窗口结束且保留了有效记录，仍缺唤醒证据。不要把此结果登记为能力通过。
- `reactive_failed_prompt-rpc-error` 等失败结果保留脱敏证据。遵守 U01 一次授权试验范围，重新调用前等待新的授权。

## 2. 给 NP-03 的安全诊断编号输入格式（v0.2 唯一编号）

每条记录均按 `connectionId + generation + channel + ingressOrdinal + seq` 生成全局唯一且无敏感信息的可复制编号：

```text
AGY-DIAG-v1:<captureId>:<scenario>:<connectionId>:<generation>:<channel>:<ingressOrdinal>:s<seq>:<layer>:<reasonCode>
```

`summarize --format np03` 输出稳定的 JSON 输入（含 `requestedProtocol`、`negotiatedProtocol`、`layerCoverage`、`anomalySummary` 与每行完整范围 `rowKey`）。四层摘要按 `connectionId + generation + channel + ingressOrdinal` 分组，保留同序号多事件与出站审批应答，并将「未采集下游层」（`layer_not_captured`）、「观测中断」（`observation_interrupted`）与真实「适配器前置丢弃/取消」（`dropped_before_adapter`）严格区分。

## 3. 采样来源标记（Provenance）与限制

| `source` | 含义 | 可支持结论 |
| --- | --- | --- |
| `synthetic` | 合成对端或合成输入 | 生命周期/解析/边界逻辑复现，不代表官方 AGY 真机行为 |
| `replay_with_provenance` | 带有明确出处与时间线说明的回放夹具（含迁移自 1.5.14） | 回归与协议形态验证，不替代当前 1.5.16 真机证据 |
| `live_raw` | 真实官方 `agy.exe` 原始 ACP 采集（默认无身份或 U01 专用 Profile） | 版本、能力声明、真实帧形状与时序证据 |
| `live_hm` | 真实 HarnessMate Daemon + 官方 `agy.exe` 联合采集（待 NP-02 tap 接线） | 四层真实归因证据 |
| `official_comparison` | 同场景官方 App / CLI / raw ACP / HM 对照 | L5 验收依据 |
