# NP-01 · AGY Protocol Observatory（Windows 运行与脱敏说明）

本目录提供独立、零生产侵入、默认白名单脱敏的 AGY ACP 协议观测、录制、迁移、回放与四层归因工具链。

- **默认无身份路径**：不登录、不读取生产配置、不发送模型 Prompt，仅在 D 盘临时目录运行隔离探针。
- **零业务侵入**：Recorder 输出不会进入 HarnessMate 生产业务事件或 SQLite；Daemon 侧通过 `createDaemonTapCallbacks` 回调接口以 opt-in 方式接入（由 NP-02 审核接线），采集失败不阻塞业务。
- **字段 allowlist 重建**：入站与出站 JSON-RPC 帧默认按字段白名单重建；过滤 OAuth 参数、凭据、邮箱、路径、Prompt/Response 正文与审批原文；仅对固定测试标记（如 `NP00_FINITE_DONE`）做加盐关联，并保留未知字段名与类型。

## 1. Windows PowerShell 快速执行

所有临时目录与输出文件均须位于 **D 盘**。

### 1.1 Dry-run（不启动 `agy.exe`，校验路径/参数/脱敏策略）

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

> 遵守 U01 约定：专用个人测试 Profile 位于 `D:\HarnessMate\agy-np-test-profile`，仅在用户交互登录完成后执行一次能力发现与一次 **Gemini 3.8 Flash** 20 秒有限后台复现。工具不会自动登录或自动批准权限。

```powershell
$testRoot = 'D:\HarnessMate\agy-np-test-profile'
$profile = Join-Path $testRoot 'gemini'
$scratch = Join-Path $testRoot 'runs'
$env:TEMP = Join-Path $testRoot 'temp'
$env:TMP = $env:TEMP; $env:TMPDIR = $env:TEMP
$agy = (Get-Command agy.exe).Source

# 1) 官方交互登录（仅用户本人终端操作）
node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --test-profile $profile --login-test-profile

# 2) 能力发现（不发送 Prompt）
node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --test-profile $profile --discover-confirmed `
  --out "$scratch\u01-discover.ndjson" --summary-out "$scratch\u01-discover-summary.json"

# 3) 从 u01-discover.ndjson 中取得实际广告的 Gemini 3.8 Flash model ID 后，执行单次 20 秒复现（需终端键入 YES）
$modelId = '<由上一步实际广告的 Gemini 3.8 Flash ID>'
node scripts/agy-np/observatory/cli.mjs record --agy $agy --scratch $scratch --test-profile $profile --reactive-confirmed --model $modelId `
  --out "$scratch\u01-reactive-t02.ndjson" --summary-out "$scratch\u01-reactive-t02-summary.json"
```

### 1.4 校验、迁移、回放与四层归因简表

```powershell
# 校验 Schema 与零泄露规则
node scripts/agy-np/observatory/cli.mjs validate --in docs/phase-agy-native-parity/evidence/scenarios/windows-1.5.16-clean-v1.ndjson

# 将旧 NP-00 或 agy-1.5.14 stage fixture 迁移为 Observatory v1（不修改原文件）
node scripts/agy-np/observatory/cli.mjs migrate --in docs/phase-agy-native-parity/evidence/windows-1.5.16-clean-v1.ndjson --out D:\HarnessMate\np00-research\migrated.ndjson

# 运行离线确定性回放并核对失败判定条件
node scripts/agy-np/observatory/cli.mjs replay --fixture packages/daemon/tests/fixtures/agy-np/t02-reactive-20s-wake.ndjson

# 运行真实基线适配器（AcpSessionHandle + AntigravityAcpFlavorPolicy）的四层归因回放（需先 pnpm --filter @harnessmate/daemon build）
node scripts/agy-np/observatory/cli.mjs replay --mode four-layer --out D:\HarnessMate\np00-research\four-layer.ndjson --summary-out D:\HarnessMate\np00-research\four-layer-summary.json

# 生成 Markdown 四层对比表或 NP-03 安全诊断编号输入
node scripts/agy-np/observatory/cli.mjs summarize --in D:\HarnessMate\np00-research\four-layer.ndjson --format markdown
node scripts/agy-np/observatory/cli.mjs summarize --in D:\HarnessMate\np00-research\four-layer.ndjson --format np03
```

## 2. 给 NP-03 的安全诊断编号输入格式

`summarize --format np03` 输出以下无敏感信息 JSON 结构，可直接用于前端复制诊断编号与归因摘要：

```json
{
  "schemaVersion": 1,
  "copyableDiagnosticCode": "AGY-DIAG-v1:<captureId>:<scenario>:<conn-1>:<ordinal>:<layer>:<reasonCode>",
  "captureId": "baseline-four-layer-t02-t04-t06",
  "scenario": "T02_T04_T06_baseline_four_layer",
  "provenance": "synthetic",
  "cliVersion": "1.5.16-synthetic-peer",
  "protocol": 1,
  "layerCoverage": { "raw": 12, "normalized": 6, "native_canonical": 6, "ui": 6 },
  "anomalySummary": [
    {
      "status": "adapter_misattributed_placeholder",
      "reasonCode": "placeholder_turn_slot",
      "diagnosticCode": "AGY-DIAG-v1:..."
    }
  ]
}
```

## 3. 采样来源标记（Provenance）与限制

| `source` | 含义 | 可支持结论 |
| --- | --- | --- |
| `synthetic` | 合成对端或合成输入 | 生命周期/解析/边界逻辑复现，不代表官方 AGY 真机行为 |
| `replay_with_provenance` | 带有明确出处与时间线说明的回放夹具（含迁移自 1.5.14） | 回归与协议形态验证，不替代当前 1.5.16 真机证据 |
| `live_raw` | 真实官方 `agy.exe` 原始 ACP 采集（默认无身份或 U01 专用 Profile） | 版本、能力声明、真实帧形状与时序证据 |
| `live_hm` | 真实 HarnessMate Daemon + 官方 `agy.exe` 联合采集（待 NP-02 tap 接线） | 四层真实归因证据 |
| `official_comparison` | 同场景官方 App / CLI / raw ACP / HM 对照 | L5 验收依据 |

**当前限制**：
1. 生产 Daemon 传输层 tap 接线由 NP-02 在 G1 接入缝统一合入；当前通过 `createDaemonTapCallbacks` 与离线真实 `AcpSessionHandle` 回放证明工具链。
2. U01 授权能力发现与 Gemini 3.8 Flash 20 秒真实后台复现需等待用户在专用 Profile 完成官方登录并交互确认。
