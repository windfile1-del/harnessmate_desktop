# G2 开工安排 · NP-04 至 NP-07

本地开工标签 `agy-np-g1` 固定了交接文档和已验源码 `966451ceaa2d8cfbf268b05a973dbb400715b616`，公共协议 `agy-native-v1.0.0`，SQLite `agy-native-runtime` 组件迁移 `1`。四个独立开发会话都从该标签开工。每个会话使用对应完整提示词，统一以 [G1 验收](../reviews/G1-final-966451c.md)、[共享契约](../08_Shared_Contracts.md) 和 [总进度](../MASTER_PROGRESS.md) 作为交接入口。

## 并行分配

| 会话 | 提示词与分支 | 独立实现和首条验收 |
| --- | --- | --- |
| NP-04 Reactive Runtime | [NP-04](../prompts/NP-04-reactive.md) · `codex/agy-np-04-reactive` | `agy/native/runtime/**` 与前端 `native/runtime/**`。同 runtime 多个有限任务独立保活，先完成的 B 不释放 A。通过结算 sink 验证 held → 终态只结算一次 |
| NP-05 Child Identity | [NP-05](../prompts/NP-05-child.md) · `codex/agy-np-05-child` | `agy/native/child/**`、`agy-child-work.ts` 与前端 `native/child/**`。无确证 native child ID 时保留 unresolved。验证两个 child 的父关系、轨迹、跨代隔离 |
| NP-06 Native Command Router | [NP-06](../prompts/NP-06-command-router.md) · `codex/agy-np-06-command-router` | `agy/native/commands/**`、现有 AGY command 映射与前端 `native/commands/**`。同一幂等键只执行一次，模型/配置/任务入口按广告和现存模式开放 |
| NP-07 Native Approvals | [NP-07](../prompts/NP-07-approvals.md) · `codex/agy-np-07-approvals` | `agy/native/requests/**` 与前端 `native/requests/**`。旧、新入口共享审批 CAS。同一次原生请求只写一次、保留数字/字符串 RPC ID，旧代或连接失效后返回相应收据 |

后端目录以 `packages/daemon/src/harnesses/` 为根，前端目录以 `packages/web/src/components/agy/` 为根。每个会话持有自己的领域目录、专属测试和报告。需要公共接口变更时提交单独用例与接线建议。总指挥统一处理 `wiring/**`、通用 SessionManager、SQLite、协议包、共享 Store 和 UI registry。

## 工作区与启动

四项使用独立 Worktree，目录建议为 `D:/HarnessMate/agy-np-worktrees/np-04` 至 `np-07`。本次准备包含开工基线、提示词与命令。由启动会话者或总指挥选择各自 Worktree 创建入口。若平台为会话创建了其他 D 盘路径，直接记录实际路径。

PowerShell 示例，按任务替换分支和工作树目录。先检查 `git worktree list` 与同名分支，复用已存在的合适工作树。

~~~powershell
$repo = 'D:\HarnessMate\harnessmate_desktop'
$base = git -C $repo rev-parse 'refs/tags/agy-np-g1^{}'
if ($LASTEXITCODE -ne 0) { throw 'G1 tag is unavailable in this repository' }
$worktree = 'D:\HarnessMate\agy-np-worktrees\np-04'
git -C $repo worktree add -b codex/agy-np-04-reactive $worktree $base
git -C $worktree status --short --branch
git -C $worktree rev-parse HEAD
~~~

依赖缺失时，在各自 Worktree 内运行 `pnpm install --frozen-lockfile --store-dir D:\HarnessMate\agy-np-pnpm-store`。临时目录、回放数据和账户测试目录使用 D 盘。报告提交到 `handoffs/NP-XX-report.md`，包含源码基线、交付 SHA、测试、来源分类、剩余缺口、共享接口变更请求和回滚方式。

## 联合验收顺序

1. 四项在合成和回放环境并行实现。NP-05/07 先通过共同签名和 child fixture 对齐；NP-04/06 对齐运行时句柄、任务 ID 和 Stop 回执。在已证实的定向测试前保留产品门控关闭。
2. 先评审各自的 fixture 和领域模块，再接 `AgyNativeRuntimeRegistry.registerModules`。共享接线集中提交，按 [依赖图](../10_Task_Dependency_Graph.md) 做回归。前端消费已冻结的 HTTP 和专用 WS，按运行态可见性门控工作台动作。
3. 验证 T02–T06、1.5.14 回放、双任务乱序、审批重复与代际隔离，以及跨 Harness 回归。T02 的授权真实采集由一人负责。Gemini 3.8 Flash 只用 [U01 专用 Profile](G0_Test_Profile.md)，执行一次能力发现和一次 20 秒任务，原生权限由用户决定。保留 `reactive_not_observed` 和握手或 Prompt 失败的证据。
4. G2 的跨模块 Windows 实机验收覆盖有限后台 wake、相关工具或 child 任务、脱离轮次的审批、Stop 和完成。成功路径和缺失证据都登记。其他高消耗、付费模式及 L5 对照沿用已有授权边界。通过合成门禁的领域功能仍按已证实数据判定是否可启用。
