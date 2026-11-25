# NP-01 Scenario Captures (`docs/phase-agy-native-parity/evidence/scenarios/`)

本目录存放符合 Observatory v1 Schema（`scripts/agy-np/observatory/schema/capture-v1.schema.json`）且经零泄露校验的场景证据样本。

| 文件 | `source`（Provenance） | 场景与内容 | 覆盖范围 / 限制 |
| --- | --- | --- | --- |
| [windows-1.5.16-clean-v1.ndjson](windows-1.5.16-clean-v1.ndjson) | `live_raw` | Windows 本机官方 AGY `1.5.16` 空白临时 Profile 的 v1 握手、`models`/`agents` CLI catalog 与 `session/new` `-32000` 认证要求（含往返延时 `latencyMs` 与安全诊断编号） | 默认无身份路径实证；未登录、未发模型 Prompt |
| [windows-1.5.16-request-v2.ndjson](windows-1.5.16-request-v2.ndjson) | `live_raw` | Windows 本机官方 AGY `1.5.16` 空白临时 Profile 请求 protocol 2，服务端返回 protocol 1 后安全停止 | 默认无身份路径实证 |
| [synthetic-t02-t04-t06-four-layer.ndjson](synthetic-t02-t04-t06-four-layer.ndjson) | `synthetic` | 真实基线 `AcpSessionHandle` + `AntigravityAcpFlavorPolicy` 配合合成对端的四层关联轨迹（raw / normalized / native_canonical / ui），复现并行有限任务+daemon 早结算、`turn_bg` 误归属及轮次外权限静默 `cancelled` | 合成对端；用于验证四层时间线、同别名穿透与异常归因 |
| [synthetic-t02-t04-t06-four-layer.md](synthetic-t02-t04-t06-four-layer.md) | `synthetic` | 上述轨迹对应的四层对比简表（Markdown） | 可直接用于审查和归因对照 |
| [synthetic-t02-t04-t06-summary.json](synthetic-t02-t04-t06-summary.json) | `synthetic` | 四层归因完整 JSON 摘要 | 供自动化断言与回归检查 |
| [synthetic-t02-t04-t06-np03.json](synthetic-t02-t04-t06-np03.json) | `synthetic` | 面向 NP-03 的安全可复制诊断编号输入样例（`AGY-DIAG-v1:...`） | 无 PII / 路径 / 凭据 |

## 待补齐的真实场景（需 U01 人工完成官方登录）

- `u01-discover.ndjson`（`--discover-confirmed`）：专用测试 Profile 登录后采集真实广告模型（含 Gemini 3.8 Flash ID）、模式与斜杠命令。
- `u01-reactive-t02.ndjson`（`--reactive-confirmed --model <id>`）：单次 20 秒有限后台 Prompt 真实真机轨迹（须由用户在终端交互键入 `YES` 并逐项审核原生权限）。
