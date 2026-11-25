# NP-01 Scenario Captures (`docs/phase-agy-native-parity/evidence/scenarios/`)

本目录存放符合单源 Observatory v1 Schema（`scripts/agy-np/observatory/schema/capture-v1.schema.json`）且经零泄露校验的场景证据样本。保留已提交历史版本证据原貌，新增重生成摘要均注明工具版本（`toolVersion: 0.2.0`）。

| 文件 | `source`（Provenance） | 工具版本 / AGY 版本 | 场景与内容 |
| --- | --- | --- | --- |
| [windows-1.5.16-clean-v1.ndjson](windows-1.5.16-clean-v1.ndjson) | `live_raw` | v0.1 原始保留 / AGY `1.5.16` | 原提交保留（通过 v0.2 单源校验）：Windows 官方 AGY 1.5.16 无身份 v1 握手、`models`/`agents` 与 `session/new` `-32000` |
| [windows-1.5.16-request-v2.ndjson](windows-1.5.16-request-v2.ndjson) | `live_raw` | v0.1 原始保留 / AGY `1.5.16` | 原提交保留（通过 v0.2 单源校验）：Windows 官方 AGY 1.5.16 请求 protocol 2 返回 1 |
| [windows-1.5.17-clean-v1.ndjson](windows-1.5.17-clean-v1.ndjson) | `live_raw` | v0.2 / AGY `1.5.17` | 通过 Windows Authenticode `Google LLC` 签名校验后采集的无身份 v1 样本，含 `process_exit` 先于 `capture_end`、`outcome: expected_auth_required` 与 `dropReasons` |
| [windows-1.5.17-request-v2.ndjson](windows-1.5.17-request-v2.ndjson) | `live_raw` | v0.2 / AGY `1.5.17` | 通过 `Google LLC` 签名校验后采集的 v2 请求降级样本，显式区分 `requestedProtocol: 2` 与 `negotiatedProtocol: 1`、`outcome: expected_v2_downgrade_to_v1` |
| [synthetic-t02-t04-t06-four-layer.ndjson](synthetic-t02-t04-t06-four-layer.ndjson) | `synthetic` | v0.2 / `1.5.16-synthetic-peer` | 真实基线 `AcpSessionHandle` + `AntigravityAcpFlavorPolicy` 配合合成对端的四层关联轨迹（raw / normalized / native_canonical / ui） |
| [synthetic-t02-t04-t06-four-layer.md](synthetic-t02-t04-t06-four-layer.md) | `synthetic` | v0.2 | 按 `connectionId/generation/channel#ordinal` 分组的四层对比简表，完整保留 `conn-1/gen-1/live#10` 的入站 `session/request_permission` 与出站 `outcome=cancelled` 应答 |
| [synthetic-t02-t04-t06-summary.json](synthetic-t02-t04-t06-summary.json) | `synthetic` | v0.2 | 四层归因完整 JSON 摘要（`toolVersion: 0.2.0`） |
| [synthetic-t02-t04-t06-np03.json](synthetic-t02-t04-t06-np03.json) | `synthetic` | v0.2 | 面向 NP-03 的全局唯一安全可复制诊断编号输入样例（含 `generation/channel/seq`） |

## 待补齐的真实场景（需 U01 人工完成官方登录）

- `u01-discover.ndjson`（`--discover-confirmed`）：专用测试 Profile (`D:\HarnessMate\agy-np-test-profile\gemini`) 登录后采集真实广告模型（含 Gemini 3.8 Flash ID）、模式与斜杠命令。
- `u01-reactive-t02.ndjson`（`--reactive-confirmed --model <id>`）：单次 20 秒有限后台 Prompt 真实真机轨迹（须由用户在终端交互键入 `YES` 并逐项审核原生权限）。
