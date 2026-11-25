# MASTER_PROGRESS · AGY Native Parity

总指挥维护本页。更新于 2026-11-25（Asia/Shanghai）。源码基线 `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`，查询远端同 SHA。集成分支 `codex/agy-np-integration` 已建立，G0 已准备完成。规划提交 `82e04f703cdf6adfc1062c80fa437ba3d116d3a5` 包含 NP-00 交付与本轮测试约定。三项任务从当前集成分支的 G0 快照开工。此分支是专项进度的权威副本，文档保存在 `docs/phase-agy-native-parity/`。

## 当前状态

| 部分 | 状态与证据 |
| --- | --- |
| NP-00 调研与总体设计 | 已完成。附件全文、Google/ACP 一手、T3 当前代码/PR/Issue/测试、HM 源码与现有文档已对照 |
| 能力矩阵 | 69 项，按 Desktop / IDE / CLI / ACP 入口、观察、控制和只读证据分别记录。详见 [矩阵](02_Capability_Matrix.md) |
| 本机运行时 | Google 签名 AGY 1.5.16。真实 v1 握手及请求 v2 返回 v1。干净 Profile 的 `session/new` 返回认证要求。App 2.35.1 与 IDE 2.5.5 的安装注册可见，未启动做 E2E |
| 核心失效路径 | 现有 `turn_bg` 会承载晚帧；AGY 直接取消脱离轮次或不同 native session 的审批；单 TTL 会被并行任务之一清掉。离线合成探针复现晚帧、审批取消和 lease 错置；真实用户场景尚未抓帧。详见 [源码](05_Source_Audit.md) · [证据](06_Protocol_Evidence.md) |
| 共享接口 | [v0.1 设计提案](08_Shared_Contracts.md)；无已发布实现或已冻结 v1。待 NP-02 提交 G1 |
| 本轮基线门禁 | `pnpm test`（185 测试及插件契约通过）、`pnpm typecheck`、`pnpm build` 成功。空白 Profile 与离线 probe 已跑 |
| 真实能力验收 | 登录、真实模型、后台 wake、child、付费模式、App/CLI/HM 同场景及 L5 尚待指定测试环境 |
| G0 专项验证 | 集成分支及三项任务均成功安装锁定依赖并完成构建。专用空白 Profile 真实握手后返回认证要求，错误模型参数在启动前被拒绝。集成分支的类型检查、插件契约及 7 项 AGY 定向测试通过。正式的模型测试需账号就绪 |
| 当前集成冲突 | 无待解决 merge 冲突。共享写入所有权已定义 |

## 任务看板

| 状态 | 任务 |
| --- | --- |
| 已完成 | NP-00 研究、矩阵、源码审计、协议证据、架构与前端、共享契约、17 项任务/提示词、Git 与验收规划 |
| 正在执行 | 无正式开发任务，首批任务环境就绪 |
| 待分配，可开工 | NP-01 协议观测、NP-02 共享契约、NP-03a 前端骨架 |
| 等待依赖 | NP-03b、NP-04 至 NP-17，详见 [DAG](10_Task_Dependency_Graph.md) |
| 等待测试账号 | U01 范围与模型已确认，专用 Profile 等待用户完成官方登录并发现 Gemini 3.8 Flash。其他 [决策](15_Decision_Log.md#g0-启动确认) 按建议执行 |

## 下一批建议

各独立会话从同一已审 G0 快照开工。首批 **3 个**。专用测试 [登录与运行说明](handoffs/G0_Test_Profile.md)。

| 会话 | 分支 / Worktree | 输入提示词 | 文件范围 |
| --- | --- | --- | --- |
| NP-01 | `codex/agy-np-01-observatory` · `D:/HarnessMate/agy-np-worktrees/np-01` | [协议观测](prompts/NP-01-observatory.md) | 单独采集脚本、脱敏 fixture 与 evidence |
| NP-02 | `codex/agy-np-02-contracts` · `D:/HarnessMate/agy-np-worktrees/np-02` | [共享契约](prompts/NP-02-contracts.md) | Protocol、SessionManager、Strict ACP、JSON-RPC、SQLite、API 注册及 AGY 接入缝 |
| NP-03 | `codex/agy-np-03-frontend` · `D:/HarnessMate/agy-np-worktrees/np-03` | [前端骨架](prompts/NP-03-frontend.md) | AGY 公共组件、App/ChatStage/Store 前端接入，首批用 fixture |

当前关键设计是 v1 默认、独立原生活动与真实用户 turn、native controls 依证据开放、共享核心单 owner。详见 [决策](15_Decision_Log.md)。遇到新的工作结果，把独立报告放进 `handoffs/`，评审记录放进 `reviews/`。只有总指挥更新本页、矩阵等级与各检查点。更换总指挥时从 [接手说明](handoffs/README.md) 恢复。[总计划](00_Master_Plan.md) · [工作包索引](11_Parallel_Development_Plan.md)
