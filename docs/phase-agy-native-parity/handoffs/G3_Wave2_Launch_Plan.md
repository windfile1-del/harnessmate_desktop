# G3 第二批开发安排 · NP-12 至 NP-15

四个 Coding Agent 会话可以从固定源码基线 `agy-np-g2 @ fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c` 同时开工。先读各自的完整提示词、[共享契约](../08_Shared_Contracts.md) 和 [测试策略](../12_Test_Strategy.md)。[第一批联合审查](../reviews/G3-wave1-intake.md) 记录了后续联测依赖和已复现的连接归属问题。G3 第一批候选仍在修复验证阶段。

| 会话与独立提示词 | 建议分支 | 单独验收内容 |
| --- | --- | --- |
| [NP-12 Goal、Schedule、Native Tasks](../prompts/NP-12-goal-tasks.md) | `codex/agy-np-12-goal-tasks` | 区分 Goal、原生计划与 occurrence 生命周期。以已获证据投影时区、执行状态、原生控制和降级。 |
| [NP-13 原生生态与配置](../prompts/NP-13-ecosystem.md) | `codex/agy-np-13-ecosystem` | 按 Profile、项目、会话三个作用域管理 Custom Agents、Skills、Rules、Hooks、Plugins 与 MCP。按证据开放现有配置入口。 |
| [NP-14 Artifact、Review、Browser](../prompts/NP-14-review-browser.md) | `codex/agy-np-14-review-browser` | 先交付作用域校验、脱敏、版本化只读预览与降级，定义 Teamwork、Dynamic 的审阅桥。 |
| [NP-15 Recovery 与兼容性](../prompts/NP-15-recovery.md) | `codex/agy-np-15-recovery` | 区分 load、resume 和只读历史，验证代次变更、迟到帧、断连状态与旧数据兼容。 |

## 开工与文件所有权

Git 示例使用不同的 D 盘路径，已有合适 Worktree 可复用。四个会话的基线 SHA 必须一致。

~~~powershell
$repo = 'D:\HarnessMate\harnessmate_desktop'
$base = git -C $repo rev-parse --verify 'agy-np-g2^{commit}'
if ($LASTEXITCODE -ne 0 -or $base -ne 'fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c') {
    throw 'The reviewed G2 checkpoint is unavailable'
}
git -C $repo worktree list
git -C $repo worktree add -b codex/agy-np-12-goal-tasks 'D:\HarnessMate\agy-np-worktrees\np-12' $base
~~~

NP-13 至 NP-15 按表替换分支和 Worktree 末级目录。各会话写入自己的领域目录和测试，所有权以提示词为准。共享协议、数据库编号、`SessionManager`、ACP 传输、`wiring/**`、目录与公共 App/Store 接线由总指挥归口。任务遇到共享契约缺口，提交包含输入、输出、模拟夹具、失败语义与回滚的提议。账户、依赖缓存及测试临时目录沿用 D 盘隔离方案。

## 联测与交付

1. NP-12 和 NP-15 联测关闭再恢复、独立 occurrence 关联、跨代去重和计划状态来源。对缺恢复证据的 occurrence 维持诚实状态。
2. NP-14 先冻结 opaque artifact ID、revision、有效作用域和只读读取结果，再与 NP-10/11 联测相同 ID 的审阅。批准、评论和 Browser 操作按真实接口能力门控。
3. NP-13 与目录 owner 联测同名 Profile、失效实例、范围切换和 Windows 路径。四个任务均覆盖 feature-off、其他 Harness 与必要的 G2 回放。
4. 每个任务提交固定 SHA、工作树范围、通过和失败的完整命令结果、证据类别、共享接线提议、回滚命令与 `handoffs/NP-XX-report.md`。实机 U01 使用专用 Profile 与 Gemini 3.8 Flash，额外的付费场景独立授权。
