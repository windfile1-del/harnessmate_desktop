# 11 · 并行开发计划与任务入口

后续使用用户创建的独立 Coding Agent 会话开发。每个会话对应一个任务分支与 Worktree，用户通过下表指定提示词和工作目录。总指挥确认接入缝、分配 owner、处理冲突及合并。验收等级由独立证据确认。

## 首批建议开 3 个会话

| 会话 | 提示词 | 负责范围 | 首个可审输出 |
| --- | --- | --- | --- |
| NP-01 协议观测 | [独立提示词](prompts/NP-01-observatory.md) | `scripts/agy-np/observatory/**`、`evidence/scenarios/**`、`packages/daemon/tests/fixtures/agy-np/**` | 可跑空白和回放录制、脱敏规范、等待授权的真实测试方案 |
| NP-02 共享契约 | [独立提示词](prompts/NP-02-contracts.md) | `packages/protocol/src/**`、`SessionManager/SQLite/Strict ACP/JSON-RPC/server API` 的增量接线，AGY native wiring | v1 类型/迁移/事件水位、可选 port 和旧单测通过，准备 G1 |
| NP-03 前端工作台 | [独立提示词](prompts/NP-03-frontend.md) | AGY 共享前端、通用 `App/ChatStage/app-store/projector` 合同，首批只执行 03a | shell、props/注册契约与可视导航，合成状态测试；03b 等 G1 |

首批三项可各自从同一 plan commit 切出。NP-01 只负责独立工具和录制格式，NP-03a 用 fixtures 定 UI，NP-02 维护公共接口。G1 之后，原生续跑、子会话、命令和审批的四包可同时开发，03b 回到原前端会话。按可用会话数优先安排关键路径。

## 全量任务

| ID | 任务卡 | 可直接复制的提示词 | 开始/集成条件 |
| --- | --- | --- | --- |
| NP-10 | [Teamwork 访谈、项目与里程碑](tasks/NP-10-teamwork.md) | [开发提示词](prompts/NP-10-teamwork.md) | G2（04/05/06/07、03b）。审阅控制联合 NP-14，前端骨架 可用现成契约及 disabled props 先并行。付费时另授权。 |
| NP-11 | [Dynamic Workflows 与执行轨迹](tasks/NP-11-dynamic-workflow.md) | [开发提示词](prompts/NP-11-dynamic-workflow.md) | G2（04/05/06/07、03b），按 T13 单次授权后录制。Artifact 类型读取走 NP-14 的接口。 |
| NP-12 | [Goal、Schedule 与 Native Tasks](tasks/NP-12-goal-tasks.md) | [开发提示词](prompts/NP-12-goal-tasks.md) | G2（04/06/07、03b），重启与恢复和 NP-15 联测；原生 Automations 只做证据收口。 |
| NP-13 | [原生生态、Custom Agents 与配置](tasks/NP-13-ecosystem.md) | [开发提示词](prompts/NP-13-ecosystem.md) | G1，需 NP-06 command/catalog contract 对齐。与 G2 模式并行，私有文件读产品化决策 U04。 |
| NP-14 | [Plan、Artifact Review 与 Browser Agent](tasks/NP-14-review-browser.md) | [开发提示词](prompts/NP-14-review-browser.md) | G2（05/06/07、03b），与 NP-10/11 联合验证各自 Artifact。现有只读 UI 可先复用。 |
| NP-15 | [会话恢复与协议兼容](tasks/NP-15-recovery.md) | [开发提示词](prompts/NP-15-recovery.md) | G2（02/04/05/07、03b）。可先按 G1 契约编写重放/版本探针，Recovery 需与 NP-12 联测。 |
| NP-16 | [性能、安全与隔离审查](tasks/NP-16-hardening.md) | [开发提示词](prompts/NP-16-hardening.md) | G3 集成目标，基准和负测可提前写。依 02/03 给予性能与请求观测测试钩子。 |
| NP-17 | [集成与独立验收](tasks/NP-17-integration.md) | [开发提示词](prompts/NP-17-integration.md) | G3 后 NP-16 与其他各 task 的评审合并。真实账户、长时和模式额度由 U01 授权，缺证允许保守结案。 |
| NP-01 | [协议观测与事件录制](tasks/NP-01-observatory.md) | [开发提示词](prompts/NP-01-observatory.md) | G0，可与 NP-02、NP-03a 独立开始。最终 daemon tap 接线需要 NP-02 的 G1 接入缝。 |
| NP-02 | [共享契约、持久化和核心接入](tasks/NP-02-contracts.md) | [开发提示词](prompts/NP-02-contracts.md) | G0 可立即设计和实现增量骨架。与 NP-01 对齐采集格式、NP-03 对齐 projection。G1 是后续领域实现的依赖。 |
| NP-03 | [AGY 工作台与通用前端投影](tasks/NP-03-frontend.md) | [开发提示词](prompts/NP-03-frontend.md) | G0 先 03a 做 IA 和组件样本。03b 等 NP-02 G1，真实生命周期验收联合 NP-04/05/07，领域 Studio 按 registry 装配。 |
| NP-04 | [Reactive Runtime 与后台保活](tasks/NP-04-reactive.md) | [开发提示词](prompts/NP-04-reactive.md) | G1（NP-01/02）。在 NP-05/07 真实 child/request 接线前可用契约 stub；G2 要与 03b/05/07 联合验收。 |
| NP-05 | [原生子 Agent 身份与会话路由](tasks/NP-05-child.md) | [开发提示词](prompts/NP-05-child.md) | G1（NP-01/02），NP-07 可依赖 ChildSessionRouter 契约先并行。G2 需要共同验收。 |
| NP-06 | [原生命令目录、路由与模型入口](tasks/NP-06-command-router.md) | [开发提示词](prompts/NP-06-command-router.md) | G1（NP-01/02）。独立用 capability/command fixtures；G2 与 reactive、approval 和 UI 对照。 |
| NP-07 | [原生审批、Elicitation 和问题路由](tasks/NP-07-approvals.md) | [开发提示词](prompts/NP-07-approvals.md) | G1（NP-01/02），可先用 NP-05 child resolver stub。G2 起在 04/05/03b 上联测真实归属与延迟。 |
| NP-08 | [Swarm 与共享 Board](tasks/NP-08-swarm.md) | [开发提示词](prompts/NP-08-swarm.md) | G2（04/05/06/07、03b）。低成本真机使用单一账号和一个经授权的 worker 场景。 |
| NP-09 | [Boost 多段推理](tasks/NP-09-boost.md) | [开发提示词](prompts/NP-09-boost.md) | G2（04/05/06/07、03b）。付费试验需用户确认账号资格和单场景预算。 |

## 契约与冲突管理

- 原生 transport、SessionManager、shared schema、SQLite migration、API 注册与插件权限扩展由 NP-02 审核。前端 Store、路由、slots、ChatStage 装配由 NP-03 审核。其余 tasks 使用各自目录及冻结契约。
- 需跨文件修改时，先给 owner 一个可复现例子、影响链和建议接口。Owner 将接线或字段变更作为独立 commit，专项 Agent 从已审 checkpoint 更新 base。
- 新观察先提交 capture/notes，再申请调整 capability。原生边界仍没有证据时继续实现降级、采集接口或测试，集成环境先关闭该动作。
- 审查者与开发者使用独立报告。总指挥合并后更新进度、风险与能力矩阵，记录回滚点和验收范围。[Git 协作](13_Git_Collaboration.md) · [评审模板](reviews/README.md) · [交接模板](handoffs/README.md)
