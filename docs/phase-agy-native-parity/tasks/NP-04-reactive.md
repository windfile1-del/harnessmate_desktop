# NP-04 · Reactive Runtime 与后台保活

修复真实 AGY wake 后工作、有限命令/daemon 持有、多并行任务与 Stop 的生命周期；诊断 upstream 和 HM 失效点。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G1（NP-01/02）。在 NP-05/07 真实 child/request 接线前可用契约 stub；G2 要与 03b/05/07 联合验收。 |
| 契约 | NativeLifecyclePort、PromptContext、Activity、NativeWork、Blocking；active native lease 与用户 turn 结算独立。事件源和未知行为按 07/08。 |
| Git | `codex/agy-np-04-reactive`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-04` |
| 写入范围 | `packages/daemon/src/harnesses/agy/native/runtime/**`、`packages/web/src/components/agy/native/runtime/**`、专属 lifecycle tests 与 report。 |
| 潜在冲突 | 共享 wiring 由 NP-02。请求 TTL/目标归 NP-07，恢复重连归 15；对 Lease 与 canceled 状态先在 G1 合同里对齐。 |
| 范围排除 | 不自行构造继续 Prompt、模型文本解析逐项造状态、控制 Windows 未归属进程、修改通用 SessionManager/ABI。无 Swarm/Workflow 具体状态。 |

## 工作内容与前端

建立对有限、daemon、未知 work 的 per-ID 补丁、阻塞集合与保活。早 Prompt response 保留有证据的 pending 任务。晚 tool update 与原生 wake segment 区分，归属单次真实用户 turn 或 native-only activity。使用 captured RPC scope 防 stop→next turn 旧响应污染。处理 cancel grace、transport exit、warm LRU、strict 和调参 reload。用可验证边界估计 quiescence，观测超时标 unknown。若有确定用例证明兼容字段可用，写版本化 codec 规则并引用 trace。

Native Runtime 顶部等待/需要用户/重新连接，有限/daemon 标识，Stop 的目标、等待、结果。UI 不显示模型未发的成功。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/daemon/src/harnesses/agy/agy-driver.ts](../../../packages/daemon/src/harnesses/agy/agy-driver.ts)
- [packages/daemon/src/core/session-manager.ts](../../../packages/daemon/src/core/session-manager.ts)
- [packages/daemon/tests/agy-lifecycle-events.test.ts](../../../packages/daemon/tests/agy-lifecycle-events.test.ts)

[google-antigravity/antigravity-cli releases tag 1.5.10](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864) · [pingdotgg/t3code pull 38916](https://github.com/pingdotgg/t3code/pull/38916)

## 测试、交付及合并

T02–T06/T08/T14，执行单次 20s 授权后实时验证，无补发。并行逆序、重复/缺字段、15min+ 只先合成。等待状态不误判，daemon 不阻塞。对旧 1.5.14 做回放。

Runtime controller+tracker、状态转移和 fixture、专属显示、层级归因与真机证据或明确缺口。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。关闭 AGY runtime feature，保留 native 历史只读；接线回滚交 NP-02 管。

报告写入 `handoffs/NP-04-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-04-reactive.md)
