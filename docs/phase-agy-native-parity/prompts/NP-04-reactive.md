# 独立开发提示词 · NP-04 Reactive Runtime 与后台保活

你负责 HarnessMate Desktop 的 **NP-04 Reactive Runtime 与后台保活**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

**已审 G1 开工点**　本地标签 `agy-np-g1`，源码验收提交 `966451ceaa2d8cfbf268b05a973dbb400715b616`。先读 [G2 开工安排](../handoffs/G2_Launch_Plan.md) 和 [G1 验收](../reviews/G1-final-966451c.md)。

使用 `NativeLifecyclePort` 和 `NativeTurnSettlementSink`，以 `(runtimeId, generation, turnId)` 结算同一 held turn。晚帧仅由原生事件开启 activity，`reactive_not_observed` 的采样要保留缺口。

修复真实 AGY wake 后工作、有限命令/daemon 持有、多并行任务与 Stop 的生命周期；诊断 upstream 和 HM 失效点。

**依赖与可并行范围**　G1（NP-01/02）。在 NP-05/07 真实 child/request 接线前可用契约 stub；G2 要与 03b/05/07 联合验收。

**接口契约**　NativeLifecyclePort、PromptContext、Activity、NativeWork、Blocking；active native lease 与用户 turn 结算独立。事件源和未知行为按 07/08。

使用建议分支 `codex/agy-np-04-reactive`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-04-reactive.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/harnesses/agy/agy-driver.ts](../../../packages/daemon/src/harnesses/agy/agy-driver.ts)
- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/tests/agy-lifecycle-events.test.ts](../../../packages/daemon/tests/agy-lifecycle-events.test.ts)

[google-antigravity/antigravity-cli releases tag 1.5.10](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864) · [pingdotgg/t3code pull 38916](https://github.com/pingdotgg/t3code/pull/38916)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/runtime/**`、`packages/web/src/components/agy/native/runtime/**`、专属 lifecycle tests 与 report。

**具体实现**　建立对有限、daemon、未知 work 的 per-ID 补丁、阻塞集合与保活。早 Prompt response 保留有证据的 pending 任务。晚 tool update 与原生 wake segment 区分，归属单次真实用户 turn 或 native-only activity。使用 captured RPC scope 防 stop→next turn 旧响应污染。处理 cancel grace、transport exit、warm LRU、strict 和调参 reload。用可验证边界估计 quiescence，观测超时标 unknown。若有确定用例证明兼容字段可用，写版本化 codec 规则并引用 trace。

**交互和前端**　Native Runtime 顶部等待/需要用户/重新连接，有限/daemon 标识，Stop 的目标、等待、结果。UI 不显示模型未发的成功。

**范围排除**　不自行构造继续 Prompt、模型文本解析逐项造状态、控制 Windows 未归属进程、修改通用 SessionManager/ABI。无 Swarm/Workflow 具体状态。

**所有权和冲突处理**　共享 wiring 由 NP-02。请求 TTL/目标归 NP-07，恢复重连归 15；对 Lease 与 canceled 状态先在 G1 合同里对齐。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T02–T06/T08/T14，执行单次 20s 授权后实时验证，无补发。并行逆序、重复/缺字段、15min+ 只先合成。等待状态不误判，daemon 不阻塞。对旧 1.5.14 做回放。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. Runtime controller+tracker、状态转移和 fixture、专属显示、层级归因与真机证据或明确缺口。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关闭 AGY runtime feature，保留 native 历史只读；接线回滚交 NP-02 管。

报告写入 `handoffs/NP-04-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
