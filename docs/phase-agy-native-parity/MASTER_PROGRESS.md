# MASTER_PROGRESS · AGY Native Parity

总指挥维护本页。更新于 2026-11-25（Asia/Shanghai）。集成分支 `codex/agy-np-integration`。源码审计基线 `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`，G0 开工点 `a01280176348974a0ddc00fd491afddc1d985c9e`，**G1 已审源码 `966451ceaa2d8cfbf268b05a973dbb400715b616`，含交接文档的固定开工标签 `agy-np-g1`**。G2 修复源码 `f895bf44ad5e850109ab8641fbfb81522214390f`，G3 统一开工标签 `agy-np-g2`。本页是进度权威副本。[总计划](00_Master_Plan.md) · [G1 验收](reviews/G1-final-966451c.md) · [G2 开工安排](handoffs/G2_Launch_Plan.md) · [G3 第一批联合审查](reviews/G3-wave1-intake.md) · [G3 第二批开工安排](handoffs/G3_Wave2_Launch_Plan.md)

## 当前状态

| 部分 | 状态与证据 |
| --- | --- |
| NP-00 调研与总体设计 | 已完成。研究、基线、架构和 17 项工作包见 [总计划](00_Master_Plan.md) |
| 能力矩阵 | [69 项](02_Capability_Matrix.md)。真机等级按已获证据记录 |
| NP-01 协议观测 | 合入 G1。18 项专项通过。U01 判定区分 Prompt 错误、无 wake 和观测到 wake |
| NP-02 共享契约与持久化 | 合入 G1。Zod `agy-native-v1.0.0`，SQLite 组件迁移 1，旧 runtime 和代次写入受当前绑定限制。默认 feature off |
| NP-03 前端骨架与投影 | 合入 G1。03a 的 480px 工作台交互已复验。03b REST/WS 已用真实本机传输和桩验证回执、审批事件与重连 |
| G1 门禁 | 最终验证覆盖 238 项测试、插件契约、类型检查、构建。使用桩与回放做联合门禁。[测试明细](reviews/G1-final-966451c.md) |
| G2 六项阻塞修复 | NP-04 至 NP-07 已接通。构建、类型检查、插件契约与 290 项按包串行测试通过。接线、复验与真实证据缺口见 [G2 修复复验](reviews/G2-candidate-verification.md)，四项交付来源见 [联合审查](reviews/G2-intake-7d2c0ac-27b2caa-829d3ba-06d1fb0.md)。 |
| G3 第一批交付审查 | NP-08 至 NP-11 的联合快照构建、类型检查、插件契约及 333 项用例通过。定向复现确认 Boost 错误归属、Teamwork 广告和各模式断线或历史隔离缺口，待修复与共享接线。[联合审查](reviews/G3-wave1-intake.md) |
| 官方运行时证据 | AGY 1.5.16 / 1.5.17 无身份握手采集，v2 请求返回 v1。真实后台 wake、child、付费模式、App 对照等待相应证据 |
| 真实授权试验 | Gemini 3.8 Flash U01 的一次发现、一次 20 秒复现仍待专用 Profile 就绪。[U01](handoffs/G2_Launch_Plan.md#联合验收顺序) |

## 任务看板

| 状态 | 任务 |
| --- | --- |
| 已完成 | NP-00，以及 G1 的 NP-01 / NP-02 / NP-03a 与 03b 共享传输接线 |
| G2 已通过源码与合成门禁 | NP-04 `7d2c0ac` Reactive、NP-05 `27b2caa` Child Identity、NP-06 `829d3ba` Command Router、NP-07 `06d1fb0` Approvals。 |
| G3 第一批已交付，待复验与接线 | NP-08 `007209d`、NP-09 `d7bfd2c`、NP-10 `fd13f84`、NP-11 `50e4c16`。四份提交锁定在 [联合审查](reviews/G3-wave1-intake.md)。 |
| G3 第二批可开工 | NP-12 Goal/Schedule、NP-13 生态、NP-14 Artifact/Review/Browser、NP-15 Recovery，统一从 `agy-np-g2` 切分支。[四份提示词及分工](handoffs/G3_Wave2_Launch_Plan.md) |
| 等待真实环境验收 | U01 Gemini 3.8 Flash 官方环境取证。一次能力发现、一次 20 秒后台唤醒。独立记录 child、脱轮次审批、Stop、Windows 官方客户端对照。 |
| 等待后续依赖 | NP-14 与 NP-10/11、NP-12 与 NP-15 联测。NP-16 / NP-17 在 G3 后按 [依赖图](10_Task_Dependency_Graph.md) 正式验收。 |

当前开工提示词与工作树安排见 [G3 第二批](handoffs/G3_Wave2_Launch_Plan.md)。开发者在 `handoffs/` 提交独立交付报告，总指挥在 `reviews/` 记录验收并维护本页。换手从 [交接说明](handoffs/README.md) 开始。
