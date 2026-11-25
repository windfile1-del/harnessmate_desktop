# MASTER_PROGRESS · AGY Native Parity

总指挥维护本页。更新于 2026-11-25（Asia/Shanghai）。集成分支 `codex/agy-np-integration`。源码审计基线 `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`，G0 开工点 `a01280176348974a0ddc00fd491afddc1d985c9e`，**G1 已审源码 `966451ceaa2d8cfbf268b05a973dbb400715b616`，含交接文档的固定开工标签 `agy-np-g1`**。本页是进度权威副本。[总计划](00_Master_Plan.md) · [G1 验收](reviews/G1-final-966451c.md) · [G2 开工安排](handoffs/G2_Launch_Plan.md)

## 当前状态

| 部分 | 状态与证据 |
| --- | --- |
| NP-00 调研与总体设计 | 已完成。研究、基线、架构和 17 项工作包见 [总计划](00_Master_Plan.md) |
| 能力矩阵 | [69 项](02_Capability_Matrix.md)。真机等级按已获证据记录 |
| NP-01 协议观测 | 合入 G1。18 项专项通过。U01 判定区分 Prompt 错误、无 wake 和观测到 wake |
| NP-02 共享契约与持久化 | 合入 G1。Zod `agy-native-v1.0.0`，SQLite 组件迁移 1，旧 runtime 和代次写入受当前绑定限制。默认 feature off |
| NP-03 前端骨架与投影 | 合入 G1。03a 的 480px 工作台交互已复验。03b REST/WS 已用真实本机传输和桩验证回执、审批事件与重连 |
| G1 门禁 | 最终验证覆盖 238 项测试、插件契约、类型检查、构建。使用桩与回放做联合门禁。[测试明细](reviews/G1-final-966451c.md) |
| 官方运行时证据 | AGY 1.5.16 / 1.5.17 无身份握手采集，v2 请求返回 v1。真实后台 wake、child、付费模式、App 对照等待相应证据 |
| 真实授权试验 | Gemini 3.8 Flash U01 的一次发现、一次 20 秒复现仍待专用 Profile 就绪。[U01](handoffs/G2_Launch_Plan.md#联合验收顺序) |

## 任务看板

| 状态 | 任务 |
| --- | --- |
| 已完成 | NP-00，以及 G1 的 NP-01 / NP-02 / NP-03a 与 03b 共享传输接线 |
| 待分配，可并行 | NP-04 Reactive、NP-05 Child Identity、NP-06 Command Router、NP-07 Approvals。四项使用同一 G1 提交并分别工作 |
| 等待 G2 联合验收 | 03b 与 NP-04–07 的真实生命周期、原生控制及回执，默认门控关闭 |
| 等待后续依赖 | NP-08 至 NP-17，按 [依赖图](10_Task_Dependency_Graph.md) 启动 |

前四项提示词、工作树建议、文件所有权和联合测试顺序见 [G2 开工安排](handoffs/G2_Launch_Plan.md)。遇到新的结果，开发者将交付报告放入 `handoffs/`，总指挥在 `reviews/` 记录验收并统一维护本页。换手从 [交接说明](handoffs/README.md) 开始。
