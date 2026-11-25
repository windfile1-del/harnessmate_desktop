# 独立开发提示词 · NP-15 会话恢复与协议兼容

你负责 HarnessMate Desktop 的 **NP-15 会话恢复与协议兼容**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

建立原生数据、进程连接与 HM 历史之间可追踪的恢复，维持 ACP v1 并为 v2 分线。

**依赖与可并行范围**　G2（02/04/05/07、03b）。可先按 G1 契约编写重放/版本探针，Recovery 需与 NP-12 联测。

**接口契约**　RuntimeBinding/generation、NativeIngress channel、asOfSeq、stale reason。v1 load 与 resume 分开，v2 preview 只在受控下实例化。

使用建议分支 `codex/agy-np-15-recovery`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-15-recovery.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/src/db/sqlite.ts](../../../packages/daemon/src/db/sqlite.ts)
- [packages/daemon/src/harnesses/history-scanner.ts](../../../packages/daemon/src/harnesses/history-scanner.ts)
- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/tests/agy-replay-protocol.test.ts](../../../packages/daemon/tests/agy-replay-protocol.test.ts)
- [packages/daemon/tests/handoff-v2.test.ts](../../../packages/daemon/tests/handoff-v2.test.ts)

[agentclientprotocol.com · session-setup](https://agentclientprotocol.com/protocol/v1/session-setup) · [agentclientprotocol.com · migration](https://agentclientprotocol.com/protocol/v2/migration) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [pingdotgg/t3code pull 38916](https://github.com/pingdotgg/t3code/pull/38916)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/recovery/**`、`harnesses/history-scanner.ts` 的 AGY 作用域、专属 recovery tests。Core migration/adapter wiring 交 02。

**具体实现**　启动由绑定恢复、profile/source/revision guard、连接丢失标 reconciling。按真实能力选 attach/replay，历史不应投递审批或伪造实时状态。原生 job 可续的条件来自新连接或读源证据。旧 session list 和 HM Handoff 保留。为 v2 提供 codec tests，默认 v1。逐版本测试 cancellation/session close 与 Windows 进程树，坏版本可以降级。

**交互和前端**　状态为连接恢复中、最后见、失效审批、可恢复/需手工接入，给正常历史读取路径。无授权时不弹自动登录。

**范围排除**　不自动重发用户 Prompt、旧审批或原生任务。没有权限时不改安装文件/私有数据库。没有证据不宣称旧 daemon 跨进程存活。

**所有权和冲突处理**　NP-02 共享启动与 SQLite owner，NP-04 lease、07 receipt 清除；NP-05 child read-only；NP-13 account。恢复 UI 依 NP-03 shared selectors。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T09/T14/T15，新旧 DB、乱序 attach、重连后晚 response、进程崩溃/网络/Windows 重启、v1/v2 负面和旧客户端。Handoff/Orchestrator 回归。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. recovery service、版本适配、兼容与崩溃记录、Windows 运行指南。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关闭主动 reconcile，历史 native feed 只读并保留；新增 DB 不删，旧版本能启动。

报告写入 `handoffs/NP-15-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
