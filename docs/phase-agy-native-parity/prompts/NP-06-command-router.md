# 独立开发提示词 · NP-06 原生命令目录、路由与模型入口

你负责 HarnessMate Desktop 的 **NP-06 原生命令目录、路由与模型入口**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

**已审 G1 开工点**　本地标签 `agy-np-g1`，源码验收提交 `966451ceaa2d8cfbf268b05a973dbb400715b616`。先读 [G2 开工安排](../handoffs/G2_Launch_Plan.md) 和 [G1 验收](../reviews/G1-final-966451c.md)。

使用 `NativeCommandRouterPort`、`NativeCommandRequestSchema` 和 `NativeCommandResponseSchema`。当前命令回执使用 `kind: accepted | inspect`。同键领取和重复回执由共享接线负责，领域模块只返回已观测的结果。

运行时发现的原生命令真正走正确执行通道，阻止交互工作流无意落到 final-only 辅助进程。

**依赖与可并行范围**　G1（NP-01/02）。独立用 capability/command fixtures；G2 与 reactive、approval 和 UI 对照。

**接口契约**　CapabilityDescriptor、CommandLane、catalogRevision、idempotencyKey、binding generation 与 user-direct provenance。旧 /commands enum 兼容。

使用建议分支 `codex/agy-np-06-command-router`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-06-command-router.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/core/harness-commands.ts](../../../packages/daemon/src/core/harness-commands.ts)
- [packages/daemon/src/harnesses/agy-commands.ts](../../../packages/daemon/src/harnesses/agy-commands.ts)
- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/src/harnesses/agy/agy-driver.ts](../../../packages/daemon/src/harnesses/agy/agy-driver.ts)
- [packages/protocol/src/remote-v1.ts](../../../packages/protocol/src/remote-v1.ts)
- [packages/web/src/lib/command-palette.ts](../../../packages/web/src/lib/command-palette.ts)

[antigravity.google · reference](https://antigravity.google/docs/cli/reference/) · [antigravity.google · slash-commands](https://antigravity.google/docs/slash-commands/) · [agentclientprotocol.com · slash-commands](https://agentclientprotocol.com/protocol/v1/slash-commands) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/commands/**`、`harnesses/agy-commands.ts`、`core/harness-commands.ts`、`packages/web/src/components/agy/native/commands/**`、专属测试。

**具体实现**　合并每绑定 runtime advertised、文档与验证 support，并实现 query/config/live_workflow/manager。真实用户意图、param、revision、权限、计划和 Profile 校验；native workflow 同 live session 一次发送，支持附件顺序，关闭未知动态 slash 的运行操作。保留 /usage 和 /skills 合适独立查询，修多 Profile skills 缺 harnessId，并证实查询不会写 conversation。管理入口用现有数据或官方指引。

**交互和前端**　Native Command Palette 和 Mode Picker 使用同一 descriptor，搜索、禁用原因、参数提示、请求冲突保留草稿。模型/effort 获取实际 options。

**范围排除**　不大规模改通用命令枚举，不把用户任意输入交到 shell，不自动 fallback 自己开多个 agent、低配模式或账户。

**所有权和冲突处理**　共享 REST、parser 调用处由 NP-02，Composer shell 由 NP-03。NP-08–12 只贡献 workflow descriptor，不能各写全局执行器。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T01/06/08/15，已出现/撤销/错误版本/权限/双账号 cache、重复 key、usage/skills 正常与通用 Codex/Claude 命令回归，工作流未开辅助进程。对未获授权命令做负例。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 目录服务、路由、AGY picker 子组件与 fixtures，命令动作矩阵和已验证入口。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。保留已有静态 /commands query。关新的 native workflow 路由 feature，不影响已经记录的 runs。

报告写入 `handoffs/NP-06-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
