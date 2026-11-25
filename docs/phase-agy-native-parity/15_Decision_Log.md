# 15 · 决策记录

日期 2026-11-25，范围 NP-00 设计。后续改动应记录决策 ID、证据、受影响 package 和迁移/验收影响。

## 已采用的设计

| ID | 提案及依据 | 后续验证 |
| --- | --- | --- |
| D01 | `agy acp` 为执行标准入口，AGY 1.5.16 默认 v1。保留有边界的 vendor adapter，v2 Preview 仅在真实协商后启用 | E02/E03，NP-02/15 |
| D02 | Native Activity、Prompt、User Turn 和 Work 分离。未知归属原生运行内容不用占位 turn，晚帧可创建本地 segment | S04–S07，T02/T05/T08 |
| D03 | 原生观察、字段和控制按证据开放，child ID/模式阶段不推测。官方功能矩阵区别于 HM 支持等级 | E06、T3 #39503，NP-05/08–12 |
| D04 | 复用 HM 现有 approval center、event envelope 和业务接口，引入可选原生 feed 与新增 SQLite 表。保留旧进度/记录 | S14–S18，NP-02 G1 review |
| D05 | 第一方 AGY 界面复用现有 React 槽与 Workspace，模式各有自己的交互语义 | S19–S22，NP-03 的 IA 和真实 UX |
| D06 | 单一契约/核心 owner、单一前端共享 owner。领域工作在专属模块按稳定接口拼接 | Git/DAG 与独立验收 |
| D07 | 原生继续工作来自 AGY 的后续事件。保留官方登录和原生权限，不改系统提示，不自动轮换或以多 Harness 模拟原生模式 | 用户约束与 [Google #1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) |

## G0 启动确认

用户确认用 **Gemini 3.8 Flash** 并按 NP-00 的建议开展初始准备。以下事项以 2026-11-25 决定为准。

| ID | 已确定 | 执行状态和验证条件 |
| --- | --- | --- |
| U01 | AGY 1.5.16，D 盘单独的个人测试 Profile。先做能力发现，再进行一次 Gemini 3.8 Flash 的 20 秒有限后台复现 | 测试目录已准备。由用户完成官方登录后发现实际模型 ID，Probe 只使用服务端确认的指定模型。其他付费或长时场景独立安排 |
| U02 | 建立本地 `codex/agy-np-integration`、规划提交与首批三个任务 Worktree | 实际推进状态见 [MASTER_PROGRESS](MASTER_PROGRESS.md) |
| U03 | 保留 AGY 1.5.14 回放，Reactive 路径优先验证 1.5.15+，运行时按证据门控 | 兼容范围待验证。保持官方 CLI 当前安装 |
| U04 | 经验证的专用样本才可接入版本化只读来源，未知 schema 默认关闭 | Board 和 child 等各来源按单项证据评审 |
| U05 | 显式 Stop/close，按真实活动保活，崩溃后 reconcile | 持久 daemon、Schedule 和数据保留在 Windows 对照后确定生产细则 |
| U06 | 首期由第一方 AGY 工作台消费原生数据 | 第三方只读 DTO 等明确需求及权限评审 |
| U07 | 保留现有手动多 Profile，首期不加单活选项 | 现有隔离与原生账户操作继续回归 |

## 尚待真实证据的协议能力

- 1.5.16 在特定模型、权限与用户实际故障条件下的 Prompt 收尾、wake 后更新/权限/新工具及两个并行任务。
- 授权会话真实广告的 slash、config、模型、Orchestrator 角色、mode 和 entitlement。快照应区分 profile、source 与 workspace。
- 准确的 child session ID 与 tool/task/record 关联，是否发 v1 子会话扩展，父/子/Workflow 请求目标与真实编码。
- Swarm Board/worker state、Boost 阶段、Teamwork Artifact 批准和 milestones、Workflow phase/DAG、Goal/Schedule 的真实数据与控制边界。
- 各种 v1 resume/load 的 active/replay 切分与权限重发、重启后仍活任务、cancel/close 控制、长驻场景和真实隔离。
- 原生 Artifact 逐行反馈、Browser Subagents、Multi-root、Rules 和部分生态工具。当前资料充分说明相应产品入口，未证明本机 ACP 暴露。

[证据](06_Protocol_Evidence.md) 与 [矩阵](02_Capability_Matrix.md) 是报告未知项的依据，后续按任务更新。
