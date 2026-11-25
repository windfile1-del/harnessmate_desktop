# G3 第一批开发安排 · NP-08 至 NP-11

上一阶段涵盖 NP-04 至 NP-07 和 NP-03b 的联合接入。先读 [总进度](../MASTER_PROGRESS.md)、[G2 修复验收](../reviews/G2-candidate-verification.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试策略](../12_Test_Strategy.md) 和 [协作约定](../13_Git_Collaboration.md)。四项任务统一使用包含交接文档的 G2 检查点 `agy-np-g2`，源码修复提交为 `f895bf44ad5e850109ab8641fbfb81522214390f`。公共协议为 `agy-native-v1.0.0`，SQLite 组件迁移为 `1`。G2 增量新增本机读取原生请求详情，已有快照、WS 和数据库格式继续适用。

## 可并行启动四个 Coding Agent 会话

| 会话 | 独立提示词与建议分支 | 文件所有权 | 第一项可验收交付 |
| --- | --- | --- | --- |
| NP-08 Swarm | [NP-08](../prompts/NP-08-swarm.md) · `codex/agy-np-08-swarm` | `native/workflows/swarm/**`、Web `native/swarm/**`、专属测试和夹具 | Studio 和 typed observer。Coordinator、Worker、Verifier 和 Board 分开投影，Board 无已验证 feed 时能从可观察协作轨迹进入官方说明。 |
| NP-09 Boost | [NP-09](../prompts/NP-09-boost.md) · `codex/agy-np-09-boost` | `native/workflows/boost/**`、Web `native/boost/**`、专属测试和夹具 | 明确资格、广告、阶段和验证的各自证据。覆盖没有原生阶段、重复更新、拒绝和停止。 |
| NP-10 Teamwork | [NP-10](../prompts/NP-10-teamwork.md) · `codex/agy-np-10-teamwork` | `native/workflows/teamwork/**`、Web `native/teamwork/**`、专属测试和夹具 | 访谈、审阅、项目/里程碑与静态降级。消费 NP-07 typed receipt，在 NP-14 确认原生 Artifact 控制后完成批准联测。 |
| NP-11 Dynamic Workflow | [NP-11](../prompts/NP-11-dynamic-workflow.md) · `codex/agy-np-11-dynamic-workflow` | `native/workflows/dynamic/**`、Web `native/workflow/**`、专属测试和夹具 | 审阅、执行轨迹、受限日志和结果。Graph 边以实录为前提，缺字段时提供可审查的 timeline。Artifact 联测等待 NP-14。 |

后端 `native/**` 路径相对 `packages/daemon/src/harnesses/agy/`，Web 路径相对 `packages/web/src/components/agy/`。在各自任务目录增加 Workbench 注册导出、typed observer 导出、独立 fixture 和 tests。每个任务提交接线提议和用例。总指挥统一修改 `wiring/**`、公共协议与持久化、`SessionManager`、ACP 传输、公共 App/Store/Shell 和 capability catalog。若必须新增公共类型、资源路由或迁移，先提交提案和回放样本，由 owner 一次接线。

## Worktree 设置

优先从同一个已审本地 SHA 切分支。启动者可使用 Codex Worktree 或以下 PowerShell 命令。已有合适工作树时复用其路径，先核对分支和 HEAD。

~~~powershell
$repo = 'D:\HarnessMate\harnessmate_desktop'
$base = 'agy-np-g2'
$base = git -C $repo rev-parse --verify "$base^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'G2 reviewed checkpoint is unavailable' }
git -C $repo worktree list
git -C $repo worktree add -b codex/agy-np-08-swarm 'D:\HarnessMate\agy-np-worktrees\np-08' $base
git -C 'D:\HarnessMate\agy-np-worktrees\np-08' status --short --branch
~~~

NP-09、10、11 按表替换分支和编号。当前报告若给的是候选补丁，先固定一次共同源码提交，再创建各 Worktree。按 G1 审查点切未补丁的独立工作树会缺少本轮的组合接线与审批语义。NP-01 至 NP-07 的已交付分支用作溯源。共享依赖、临时目录和缓存使用 D 盘，任务报告各自存入 `handoffs/NP-XX-report.md`。

## 开发和验收顺序

1. 四个会话先同时完成各自领域的离线实现、回放和不支持状态。只消费有证据的会话、子 Agent、工作流和资源 ID。广告本身允许发现入口，模式执行还需完成实际触发、回执和生命周期取证。
2. 分别提交 T10、T11、T12、T13 实现、源码范围、提交 SHA、缺失证据、验证日志和回滚方式。先审 typed observers 与 UI 注册，再由总指挥串行接运行时、目录、路由和工作台。各 PR 可独立审查，指到共同 G2 基线。
3. 第二批安排 NP-14 Artifact / Browser 与 NP-15 Recovery，另并行 NP-12 Goal/Schedule 和 NP-13 生态。NP-10/11 参与 Artifact 联测，NP-12 与 NP-15 联测恢复。
4. G3 整体验收覆盖被拒、未知、重试、子 Agent、失序、断线、下一代绑定和默认门控。实机取证由总指挥串行登记，按 [U01 专用 Profile](G0_Test_Profile.md) 用 Gemini 3.8 Flash 完成一次能力发现及一次 20 秒唤醒复现。生产原生功能维持默认关闭。各模式的额外付费试验、其他模型和账号单独由用户授权。
