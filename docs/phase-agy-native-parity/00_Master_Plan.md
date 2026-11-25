# AGY-NP-00 总体计划

目标是在官方 Antigravity CLI 与 ACP 可验证的边界内，把 HarnessMate 的 AGY 入口、原生执行观察、用户交互和恢复做完整。本轮交付调研、设计、最小探针和开发组织，后续 Coding Agent 按工作包开发，总指挥掌握共享契约、合并和验收。

## 先看哪些文档

| 路径 | 用途 |
| --- | --- |
| [MASTER_PROGRESS.md](MASTER_PROGRESS.md) | 专项唯一进度入口。开工、接手和合并前先看 |
| [01_Baseline.md](01_Baseline.md) | 源码锚点、环境、依赖和门禁结果 |
| [02_Capability_Matrix.md](02_Capability_Matrix.md) | 原生功能目录、证据、ACP 可操作边界和验收 |
| [03_Official_Research.md](03_Official_Research.md) · [04_T3Code_Research.md](04_T3Code_Research.md) | Google/ACP 一手结论和 T3 对照 |
| [05_Source_Audit.md](05_Source_Audit.md) · [06_Protocol_Evidence.md](06_Protocol_Evidence.md) | 当前实现、故障路径、真机握手和录制方法 |
| [07_Architecture.md](07_Architecture.md) · [08_Shared_Contracts.md](08_Shared_Contracts.md) · [09_Frontend_Design.md](09_Frontend_Design.md) | 运行时、接口、持久化和产品设计 |
| [10_Task_Dependency_Graph.md](10_Task_Dependency_Graph.md) · [11_Parallel_Development_Plan.md](11_Parallel_Development_Plan.md) | 关键路径、任务、提示词和首批并行安排 |
| [12_Test_Strategy.md](12_Test_Strategy.md) · [13_Git_Collaboration.md](13_Git_Collaboration.md) | 测试分层、Windows 对照及分支 Worktree 操作 |
| [14_Risk_Register.md](14_Risk_Register.md) · [15_Decision_Log.md](15_Decision_Log.md) | 风险关闭条件、决策和用户待确认项 |
| [任务评审规则](reviews/README.md) · [总指挥接手说明](handoffs/README.md) | 独立审查和跨会话恢复 |

## 实施顺序

1. 固定现有 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。观测覆盖原始 ACP、适配器及持久化投影，确保能区分上游未发帧、传输、后端归属和界面四类问题。
2. 建立可选原生运行时契约和最窄的核心接入缝。先实现有限任务、daemon、权限和真实续跑，之后才扩大工作流入口。
3. 对子 Agent 与每种原生工作流分别录制和验收。按证据启用操作。没有状态源的部分允许以协调者信息或官方界面引导交付。
4. 在相同账号类别、模型、权限、版本与目录副本下做 Windows 同场景对照。官方 App 的内嵌能力按可观察范围逐项结案。

## 约束及完成条件

使用未修改的官方 CLI。用户直接发起 AGY 会话，AGY 内部自行编排。保留手动切换账户、权限、ACP v1 兼容及其他 Harness 行为。涉及登录、真实模型和长时额度的任务按 [测试授权范围](12_Test_Strategy.md) 执行。与用户原生 Profile 的交互限只读观测，项目数据库单独维护。

NP-00 完成以文档、可复核证据、工作包独立提示词与本机基线为准。产品专项完成以矩阵逐项结案为准，L5 需要真机对照，受上游限制项须写明当前证据、可交付部分和重验条件。
