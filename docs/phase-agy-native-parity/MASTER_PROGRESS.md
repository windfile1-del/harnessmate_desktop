# MASTER_PROGRESS · AGY Native Parity

总指挥维护本页。更新于 2026-11-25（Asia/Shanghai）。源码基线 `main @ 0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。集成分支 `codex/agy-np-integration`。规划提交 `82e04f703cdf6adfc1062c80fa437ba3d116d3a5`，最近已审开工点 G0 `a01280176348974a0ddc00fd491afddc1d985c9e`。本集成 Worktree 的文档为专项进度的权威副本。

## 当前状态

| 部分 | 状态与证据 |
| --- | --- |
| NP-00 调研与总体设计 | 已完成。附件全文、Google/ACP 一手资料、T3 当前代码/PR/Issue/测试、HM 源码与项目文档已对照 |
| 能力矩阵 | [69 项](02_Capability_Matrix.md)，按 Desktop / IDE / CLI / ACP 入口、观察、控制和只读证据分别记录 |
| 本机运行时 | Google 签名 AGY 1.5.16。真实 v1 握手及请求 v2 返回 v1。干净 Profile 的 `session/new` 返回认证要求。App 2.35.1 与 IDE 2.5.5 的安装注册可见，等待 E2E |
| 核心失效路径 | 离线合成探针已复现晚帧进入 `turn_bg`、脱离轮次或不同 native session 的审批被取消、并行任务的一项完结清空单一 TTL。真实用户场景等待采样。详见 [源码](05_Source_Audit.md) · [证据](06_Protocol_Evidence.md) |
| 共享接口 | [v0.1 设计提案](08_Shared_Contracts.md) 与 NP-02 的 `agy-native-v1.0.0 @ a701cf7` 候选。G1 暂未冻结，等待共用代次、回放、审批和跨包 DTO 联审 |
| G0 基线门禁 | 185 项及插件契约、类型检查、构建通过。集成与原预置任务 Worktree 安装锁定依赖并构建，集成分支的 7 项 AGY 定向测试通过 |
| NP-01 集成评审 | `np01_protocol_observatory @ dd190a9` 已收件并审查。独立全量复跑通过 198 项，定向运行有一次 T03 失败。脱敏输出、事件归因与 U01 边界存在阻塞。详见 [独立评审](reviews/NP-01-review-dd190a9.md) |
| NP-02 集成评审 | `np02_shared_contracts_persistence @ e58948f` 已收件。独立全量 197 项及类型检查通过。换代写入、审批 CAS、并发幂等和 WS 回放有阻塞。详见 [独立评审](reviews/NP-02-review-e58948f.md) |
| NP-03 集成评审 | `np03_agy_workbench @ fb91c9c` 已收件。Web 62 项和类型检查通过。03a 窄屏焦点待修，03b stub 在补缺、代次和操作作用域存在阻塞，实际接入等待 NP-02 G1。详见 [独立评审](reviews/NP-03-review-fb91c9c.md) |
| 当前合并与冲突 | 集成源码仍为 G0，首批三份独立评审均已入档。优先复验 NP-02 的共享不变量及 NP-01/03a 的 G1 前置条件 |
| 真实能力验收 | U01 已选 Gemini 3.8 Flash，等待专用 Profile 官方登录和安全工具复验。真实后台 wake、child、付费模式、App/CLI/HM 同场景及 L5 等待有效证据 |

## 任务看板

| 状态 | 任务 |
| --- | --- |
| 已完成 | NP-00 研究、矩阵、源码审计、协议证据、架构与前端、共享契约设计、17 项任务/提示词、Git 与验收规划 |
| 评审退回 | NP-01，原交付分支追加修复并提交新 HEAD。R1–R5 见 [独立评审](reviews/NP-01-review-dd190a9.md) |
| 评审退回 | NP-03a / NP-03b stub，在原交付分支追加修复。见 [独立评审](reviews/NP-03-review-fb91c9c.md) |
| 评审退回 | NP-02，在原交付分支追加修复并提交新 HEAD。R1–R6 见 [独立评审](reviews/NP-02-review-e58948f.md) |
| 等待检查点 | G1 联审、NP-03b 真实接线与 NP-04 至 NP-17。NP-04–07 从已审 G1 启动，见 [DAG](10_Task_Dependency_Graph.md) |
| 等待测试账号及工具复验 | [U01 登录与范围](handoffs/G0_Test_Profile.md)。运行 NP-01 的账号测试需通过脱敏与专用 Profile 边界复验 |

## 当前协调

| 会话 | 实际分支和 Worktree | 当前交接 |
| --- | --- | --- |
| NP-01 | `np01_protocol_observatory` · `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np01_protocol_observatory` | [独立评审](reviews/NP-01-review-dd190a9.md)，录制、夹具及 evidence 范围内修复 |
| NP-02 | `np02_shared_contracts_persistence` · `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np02_shared_contracts_persistence` | [独立评审](reviews/NP-02-review-e58948f.md)。先修事务、授权、回放及 port，再与 NP-01/03 联审候选契约 |
| NP-03 | `np03_agy_workbench` · `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np03_agy_workbench` | [独立评审](reviews/NP-03-review-fb91c9c.md)。03a 复验窄版交互，03b 修复 stub 并在 G1 对接冻结契约。 |

后续工作包由已审查检查点启动。公共 ADR 和试验范围见 [决策](15_Decision_Log.md)，架构仍以 ACP v1 默认、独立原生活动与用户 turn、依证据开放控制、共享核心单 owner 为准。独立交付放在 `handoffs/`，独立审核放在 `reviews/`。总指挥负责本页、矩阵等级和检查点。换手时查阅 [接手说明](handoffs/README.md) · [总计划](00_Master_Plan.md) · [工作包索引](11_Parallel_Development_Plan.md)。
