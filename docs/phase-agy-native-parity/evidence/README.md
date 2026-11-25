# 证据目录

本目录保留低成本探针、可安全分享的字段摘要及独立离线复现。各项属性、时间线与限制详见 [06 Protocol Evidence](../06_Protocol_Evidence.md)。

| 文件 | 类型和用途 |
| --- | --- |
| [probe-acp.mjs](probe-acp.mjs) | 默认无身份的真实 Windows AGY ACP 握手。可选的授权发现与授权 reactive 启动前检查 |
| [windows-1.5.16-clean-v1.ndjson](windows-1.5.16-clean-v1.ndjson) | 空白 Profile 的 v1 采样，认证要求，未发送模型 Prompt |
| [windows-1.5.16-request-v2.ndjson](windows-1.5.16-request-v2.ndjson) | 空白 Profile 请求 v2，对端返回 1 |
| [g0-test-profile-clean.ndjson](g0-test-profile-clean.ndjson) | G0 专用空白 Profile 真实握手，返回认证要求 |
| [probe-current-routing.mjs](probe-current-routing.mjs) | 用合成 ACP 对端重现固定基线适配器的问题，依赖已有 `pnpm build` 输出，不运行 AGY |
| [0409bc8-synthetic-routing.ndjson](0409bc8-synthetic-routing.ndjson) | 合成晚帧、审批结束和多任务 lease 的基线证据 |

本地临时绝对路径 `D:\HarnessMate\np00-research`。真正的 native 工作流需要专用已授权的 Profile。后续 capture 可置于 `scenarios/`，按 [格式及数据规则](../12_Test_Strategy.md) 审核后提交。
