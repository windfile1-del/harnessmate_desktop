# NP-16 / NP-17 开工与验收安排

使用 `D:\HarnessMate\harnessmate_desktop` 中的本地标签 `agy-np-g3-wave2`。集成分支为 `codex/agy-np-integration`。该标签含已复验源码 `b8f79fe58bd58044f1682b0601149c943f102fbb`、[联合审查](../reviews/G3-wave2-verification.md)与本次提示词。

| 会话 | 开工条件 | 独立写入范围 | 首轮交付 |
| --- | --- | --- | --- |
| [NP-16 性能、安全与隔离](../prompts/NP-16-hardening.md) | 用本地标签立即开工。 | `scripts/agy-np/bench/**`、Daemon/Web 的 `agy-np-hardening*` 用例、自有报告和基线。 | T15/T17/T18 回归、10k events / 100 agents / 20 pending requests 的 p95、RSS、恢复与渲染记录，含环境、版本、重跑命令。 |
| [NP-17 集成与独立验收](../prompts/NP-17-integration.md) | 可用同一标签并行准备测试装置和清单。正式验收使用总指挥收到 NP-16 复验后给出的固定 SHA。 | `scripts/agy-np/e2e/**`、独立夹具、`reviews/NP-17-*.md`、`handoffs/NP-17-*.md`。 | 按 Capability ID 列出证据、等级、默认门控、发布与回退结果。列明只读和未实测功能。 |

建议先开 NP-16 的正式会话。需要加快准备时，可同时开第二个会话给 NP-17，限定在脚本、夹具、验收清单和无身份检查。正式 G4 的顺序为 NP-16 证据和修复复验 → 审查剩余生产接线或确认发布门控 → 冻结正式验收 SHA → NP-17 独立验证。

## 创建独立 Worktree

先用 `git worktree list` 核对现有目录。已有同任务的 Worktree 可直接复用并核对基线。以下命令适用于尚未创建的任务 Worktree。

~~~powershell
$repo = 'D:\HarnessMate\harnessmate_desktop'
$base = git -C $repo rev-parse --verify 'refs/tags/agy-np-g3-wave2^{commit}'
if ($LASTEXITCODE -ne 0) { throw 'Missing local tag agy-np-g3-wave2' }
git -C $repo merge-base --is-ancestor 'b8f79fe58bd58044f1682b0601149c943f102fbb' $base
if ($LASTEXITCODE -ne 0) { throw 'The tag does not include the reviewed source' }
git -C $repo worktree list
git -C $repo worktree add -b codex/agy-np-16-hardening 'D:\HarnessMate\agy-np-worktrees\np-16' $base
# 需要并行准备独立验收时执行
git -C $repo worktree add -b codex/agy-np-17-integration 'D:\HarnessMate\agy-np-worktrees\np-17' $base
~~~

标签由专项集成工作树写入上述本地仓库。Codex 即使打开其他工作树，仍可在 PowerShell 中通过 `git -C $repo` 指定仓库读取标签。独立 clone 若需开工，可从该本地仓库获取此标签。

## 总指挥串行负责的接线

- NP-12 / NP-15 联合确认 `TasksRecoveryEvidencePort` 与恢复服务之间的作用域、断连和跨代工作关联。保活只消费经确认的实时工作，待真机验证后审查接线。
- NP-13 的 Settings / REST 只读投影沿用现有账号与会话作用域。CLI 查询须验证实际 launch 上下文、来源和用户确认，保留默认关闭。
- NP-14 的现有旧面板保留只读呈现。原生 Workspace / REST 的只读桥仍需实例、会话和版本范围联测；Review / Browser 写控制和 Teamwork 回应依赖实证协议。
- NP-15 的主动恢复、ACL 校验、历史回放完成信号和进程回收应先验证生产 attach/ingress/close 的顺序及真实 Windows 所有权。保持 ACP v1 默认。

NP-16/17 把共享文件修复提议交给总指挥，实现会话分别在 `handoffs/` 交付。U01 继续使用专用 Profile 和 Gemini 3.8 Flash，能力发现、20 秒唤醒与 Windows 官方客户端对照各自记录。
