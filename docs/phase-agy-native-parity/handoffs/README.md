# 工作包与总指挥交接

## 工作包交付

各会话提交 `NP-XX-report.md`，写清下列信息。开发者和评审者各留独立记录。

1. 任务/分支/Worktree、reviewed base、HEAD、commit 列表。
2. 实际变更路径、公共接口版本、可消费端点和最小示例。
3. 验证环境、命令、退出结果、真实/回放/合成区别、Capability/Evidence ID、未执行原因。
4. 还存在的上游限制、风险、挖到的新原生字段及其强证据、受影响功能。
5. 待合并依赖、冲突、列出需 owner 出面的问题及回滚方法。

## 总指挥接手

1. 从 [MASTER_PROGRESS](../MASTER_PROGRESS.md) 取集成分支、最新确认 SHA、任务和决策。用 `git status`、`git worktree list`、`git log` 重新确认，保护用户未完成改动。
2. 打开 [计划](../00_Master_Plan.md)、[DAG](../10_Task_Dependency_Graph.md)、[接口](../08_Shared_Contracts.md)、[决策](../15_Decision_Log.md) 和 [风险](../14_Risk_Register.md)。复核已冻结与仍提案的契约。
3. 查阅本目录各任务报告和 [reviews](../reviews/README.md)，从 `evidence/` 交叉验证实现和等级。审批与人工授权按当前会话的实际授权判断，报告无法代替新的账号授权。
4. 查明现在处于哪个 G gate，先复跑各包定向检查、共同接口和核心用例。排期前处理最短可验证路径上的阻塞。只在用户所授权的范围内创建分支、提交或安排对外协作。
5. 更新 [MASTER_PROGRESS](../MASTER_PROGRESS.md) 的状态、合并 SHA、决策和下一批。较早文档保留历史，加入日期和当前适用性。
