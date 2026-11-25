# MASTER_PROGRESS · AGY Native Parity

总指挥维护本页。更新于 2026-11-25（Asia/Shanghai）。源码基线 `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。集成分支 `codex/agy-np-integration`。规划提交 `82e04f703cdf6adfc1062c80fa437ba3d116d3a5`，最近已审开工点 G0 `a01280176348974a0ddc00fd491afddc1d985c9e`。本集成 Worktree 的文档为专项进度的权威副本。

## 当前状态

| 部分 | 状态与证据 |
| --- | --- |
| NP-00 调研与总体设计 | 已完成。附件全文、Google/ACP 一手资料、T3 当前代码/PR/Issue/测试、HM 源码与项目文档已对照 |
| 能力矩阵 | [69 项](02_Capability_Matrix.md)，按 Desktop / IDE / CLI / ACP 入口、观察、控制和只读证据分别记录 |
| 本机运行时 | Google 签名 AGY 1.5.16。真实 v1 握手及请求 v2 返回 v1。干净 Profile 的 `session/new` 返回认证要求。App 2.35.1 与 IDE 2.5.5 的安装注册可见，等待 E2E |
| 核心失效路径 | 离线合成探针已复现晚帧进入 `turn_bg`、脱离轮次或不同 native session 的审批被取消、并行任务的一项完结清空单一 TTL。真实用户场景等待采样。详见 [源码](05_Source_Audit.md) · [证据](06_Protocol_Evidence.md) |
| 共享接口 | `agy-native-v1.0.0 @ 4cde14e` 为当前候选。NP-01 五份 NDJSON 共 84 条通过 NP-02 校验，NP-02 / 03 命令回执、审批事件和能力缓存仍待对齐。[联合复验](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md) |
| G0 基线门禁 | 185 项及插件契约、类型检查、构建通过。集成与原预置任务 Worktree 安装锁定依赖并构建，集成分支的 7 项 AGY 定向测试通过 |
| NP-01 集成评审 | `51e3b3b` 独立 18 项通过。U01 探针在 Prompt 错误或未见 wake 时仍标记已观察，等待 J1。[联合复验](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md) |
| NP-02 集成评审 | `a183adc` 独立 Protocol 6 项及 Daemon 专项 9 项通过。同 runtime 换代、并发幂等与 501 条回放复验通过，旧 Profile runtime 写入仍需修复。[联合复验](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md) |
| NP-03 集成评审 | `e582fa8` 独立 Web 67 项通过，03a 窄屏焦点复验通过。03b 等待命令/审批 DTO 与旧代能力对齐。[联合复验](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md) |
| 当前合并与冲突 | G1 暂未冻结，集成源码仍为 G0。当前阻塞是 U01 判定、旧 Profile runtime 写入、NP-02 / 03 接口联测。[联合复验](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md) |
| 真实能力验收 | U01 已选 Gemini 3.8 Flash，等待专用 Profile 官方登录和安全工具复验。真实后台 wake、child、付费模式、App/CLI/HM 同场景及 L5 等待有效证据 |

## 任务看板

| 状态 | 任务 |
| --- | --- |
| 已完成 | NP-00 研究、矩阵、源码审计、协议证据、架构与前端、共享契约设计、17 项任务/提示词、Git 与验收规划 |
| 复验待修 | NP-01 唤醒证据分类 J1 |
| 已复验 | NP-03a 窄屏焦点与方向键。NP-03b Connected 联审等待 J3 |
| 复验待修 | NP-02 当前 runtime 栅栏 J2，与 NP-03 联审 J3 |
| 等待检查点 | G1 联审、NP-03b 真实接线与 NP-04 至 NP-17。NP-04–07 从已审 G1 启动，见 [DAG](10_Task_Dependency_Graph.md) |
| 等待测试账号及工具复验 | [U01 登录与范围](handoffs/G0_Test_Profile.md)。Gemini 3.8 Flash 的真实采集等待 J1 复验及专用 Profile 就绪 |

## 当前协调

| 会话 | 实际分支和 Worktree | 当前交接 |
| --- | --- | --- |
| NP-01 | `np01_protocol_observatory` · `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np01_protocol_observatory` | [独立评审](reviews/NP-01-review-dd190a9.md)。当前复验 J1 见 [联审](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md) |
| NP-02 | `np02_shared_contracts_persistence` · `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np02_shared_contracts_persistence` | [独立评审](reviews/NP-02-review-e58948f.md)。继续修复 J2，与 NP-03 完成 J3 [联审](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md) |
| NP-03 | `np03_agy_workbench` · `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np03_agy_workbench` | [独立评审](reviews/NP-03-review-fb91c9c.md)。03a 窄屏通过，03b 等待 J3 [联审](reviews/G1-recheck-51e3b3b-a183adc-e582fa8.md)。 |

后续工作包由已审查检查点启动。公共 ADR 和试验范围见 [决策](15_Decision_Log.md)，架构仍以 ACP v1 默认、独立原生活动与用户 turn、依证据开放控制、共享核心单 owner 为准。独立交付放在 `handoffs/`，独立审核放在 `reviews/`。总指挥负责本页、矩阵等级和检查点。换手时查阅 [接手说明](handoffs/README.md) · [总计划](00_Master_Plan.md) · [工作包索引](11_Parallel_Development_Plan.md)。
