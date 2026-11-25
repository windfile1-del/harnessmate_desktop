# NP-06 · 原生命令目录、路由与模型入口

运行时发现的原生命令真正走正确执行通道，阻止交互工作流无意落到 final-only 辅助进程。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G1（NP-01/02）。独立用 capability/command fixtures；G2 与 reactive、approval 和 UI 对照。 |
| 契约 | CapabilityDescriptor、CommandLane、catalogRevision、idempotencyKey、binding generation 与 user-direct provenance。旧 /commands enum 兼容。 |
| Git | `codex/agy-np-06-command-router`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-06` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/commands/**`、`harnesses/agy-commands.ts`、`core/harness-commands.ts`、`packages/web/src/components/agy/native/commands/**`、专属测试。 |
| 潜在冲突 | 共享 REST、parser 调用处由 NP-02，Composer shell 由 NP-03。NP-08–12 只贡献 workflow descriptor，不能各写全局执行器。 |
| 范围排除 | 不大规模改通用命令枚举，不把用户任意输入交到 shell，不自动 fallback 自己开多个 agent、低配模式或账户。 |

## 工作内容与前端

合并每绑定 runtime advertised、文档与验证 support，并实现 query/config/live_workflow/manager。真实用户意图、param、revision、权限、计划和 Profile 校验；native workflow 同 live session 一次发送，支持附件顺序，关闭未知动态 slash 的运行操作。保留 /usage 和 /skills 合适独立查询，修多 Profile skills 缺 harnessId，并证实查询不会写 conversation。管理入口用现有数据或官方指引。

Native Command Palette 和 Mode Picker 使用同一 descriptor，搜索、禁用原因、参数提示、请求冲突保留草稿。模型/effort 获取实际 options。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/core/harness-commands.ts](../../../packages/daemon/src/core/harness-commands.ts)
- [packages/daemon/src/harnesses/agy-commands.ts](../../../packages/daemon/src/harnesses/agy-commands.ts)
- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/src/harnesses/agy/agy-driver.ts](../../../packages/daemon/src/harnesses/agy/agy-driver.ts)
- [packages/protocol/src/remote-v1.ts](../../../packages/protocol/src/remote-v1.ts)
- [packages/web/src/lib/command-palette.ts](../../../packages/web/src/lib/command-palette.ts)

[antigravity.google · reference](https://antigravity.google/docs/cli/reference/) · [antigravity.google · slash-commands](https://antigravity.google/docs/slash-commands/) · [agentclientprotocol.com · slash-commands](https://agentclientprotocol.com/protocol/v1/slash-commands) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15)

## 测试、交付及合并

T01/06/08/15，已出现/撤销/错误版本/权限/双账号 cache、重复 key、usage/skills 正常与通用 Codex/Claude 命令回归，工作流未开辅助进程。对未获授权命令做负例。

目录服务、路由、AGY picker 子组件与 fixtures，命令动作矩阵和已验证入口。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。保留已有静态 /commands query。关新的 native workflow 路由 feature，不影响已经记录的 runs。

报告写入 `handoffs/NP-06-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-06-command-router.md)
