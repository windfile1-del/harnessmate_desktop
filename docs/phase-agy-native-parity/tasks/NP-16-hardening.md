# NP-16 · 性能、安全与隔离审查

验证从协议输入、持久化、插件、身份控制到 Web 的安全和资源边界，给出可重复的发布证据。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G3 集成目标，基准和负测可提前写。依 02/03 给予性能与请求观测测试钩子。 |
| 契约 | 应用 scope/idempotency/privacy、插件最小投影、native event cursor、原生账户来源策略和 T17/T18。 |
| Git | `codex/agy-np-16-hardening`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-16` |
| 写入范围 | `scripts/agy-np/bench/**`、`packages/daemon/tests/agy-np-hardening*`、`packages/web/tests/agy-np-hardening*`、独立风险评审与基线。 |
| 潜在冲突 | 不直接重写任何领域、core 或 store，delegate 修复给拥有文件的 Agent。使用固定集成 SHA 和单独数据目录。 |
| 范围排除 | 不运行任意生产测试、绕审批、读凭据或私下改核心代码。不采用未证实的性能虚构阈值，不从合成规模推断真实模型质量。 |

## 工作内容与前端

检查 consumer OAuth 的手动/自动入口（HM Orchestrator、failover、插件、HM Remote、后台任务），私有路径/跨 profile、可控性升级、未验证 allow、逃逸 HTML 与敏感 capture。先测当前/启用后的 10k events、100 agents、20 requests，给 p95、吞吐、RSS、描画和 DB 带上版本与样本。修复交给 owner，复验其 reviewed SHA。限制溢出行为可被用户查到。

检查高负载列表/焦点、并发审批、隔离作用域与断开处理，明确页面可观测指标。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/daemon/src/harnesses/jsonrpc.ts](../../../packages/daemon/src/harnesses/jsonrpc.ts)
- [packages/daemon/src/harnesses/agy/agy-profile-manager.ts](../../../packages/daemon/src/harnesses/agy/agy-profile-manager.ts)
- [packages/daemon/src/core/failover-service.ts](../../../packages/daemon/src/core/failover-service.ts)
- [packages/daemon/src/core/orchestrator-service.ts](../../../packages/daemon/src/core/orchestrator-service.ts)
- [packages/daemon/src/server/app.ts](../../../packages/daemon/src/server/app.ts)
- [packages/daemon/src/plugin-host/runtime/map-event.ts](../../../packages/daemon/src/plugin-host/runtime/map-event.ts)
- [packages/web/src/slots/SandboxedPluginFrame.tsx](../../../packages/web/src/slots/SandboxedPluginFrame.tsx)
- [docs/plugin-api/slots.md](../../../docs/plugin-api/slots.md)

[agentclientprotocol.com · security](https://agentclientprotocol.com/protocol/v1/security) · [google-antigravity/antigravity-cli issues 1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) · [antigravity.google · permissions](https://antigravity.google/docs/permissions/)

## 测试、交付及合并

T15/T17/T18，跨平台 host / Windows 读路径，第三方插件、传统客户端和安全回归。发现高危就冻结该 feature gate。

审查报告、可复跑 benchmark 基线与日志、风险初始和结束判定、按领域列修复列表。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。失败 feature gate 保持关闭，回退测量脚本可单提交撤销。

报告写入 `handoffs/NP-16-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-16-hardening.md)
