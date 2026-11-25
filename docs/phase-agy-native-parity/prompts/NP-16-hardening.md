# 独立开发提示词 · NP-16 性能、安全与隔离审查

你负责 HarnessMate Desktop 的 **NP-16 性能、安全与隔离审查**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

验证从协议输入、持久化、插件、身份控制到 Web 的安全和资源边界，给出可重复的发布证据。

**依赖与可并行范围**　G3 集成目标，基准和负测可提前写。依 02/03 给予性能与请求观测测试钩子。

**接口契约**　应用 scope/idempotency/privacy、插件最小投影、native event cursor、原生账户来源策略和 T17/T18。

使用建议分支 `codex/agy-np-16-hardening`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-16-hardening.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/jsonrpc.ts](../../../packages/daemon/src/harnesses/jsonrpc.ts)
- [packages/daemon/src/harnesses/agy/agy-profile-manager.ts](../../../packages/daemon/src/harnesses/agy/agy-profile-manager.ts)
- [packages/daemon/src/core/failover-service.ts](../../../packages/daemon/src/core/failover-service.ts)
- [packages/daemon/src/core/orchestrator-service.ts](../../../packages/daemon/src/core/orchestrator-service.ts)
- [packages/daemon/src/server/app.ts](../../../packages/daemon/src/server/app.ts)
- [packages/daemon/src/plugin-host/runtime/map-event.ts](../../../packages/daemon/src/plugin-host/runtime/map-event.ts)
- [packages/web/src/slots/SandboxedPluginFrame.tsx](../../../packages/web/src/slots/SandboxedPluginFrame.tsx)
- [docs/plugin-api/slots.md](../../../docs/plugin-api/slots.md)

[agentclientprotocol.com · security](https://agentclientprotocol.com/protocol/v1/security) · [google-antigravity/antigravity-cli issues 1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) · [antigravity.google · permissions](https://antigravity.google/docs/permissions/)

## 工作与权限范围

**允许写入**　`scripts/agy-np/bench/**`、`packages/daemon/tests/agy-np-hardening*`、`packages/web/tests/agy-np-hardening*`、独立风险评审与基线。

**具体实现**　检查 consumer OAuth 的手动/自动入口（HM Orchestrator、failover、插件、HM Remote、后台任务），私有路径/跨 profile、可控性升级、未验证 allow、逃逸 HTML 与敏感 capture。先测当前/启用后的 10k events、100 agents、20 requests，给 p95、吞吐、RSS、描画和 DB 带上版本与样本。修复交给 owner，复验其 reviewed SHA。限制溢出行为可被用户查到。

**交互和前端**　检查高负载列表/焦点、并发审批、隔离作用域与断开处理，明确页面可观测指标。

**范围排除**　不运行任意生产测试、绕审批、读凭据或私下改核心代码。不采用未证实的性能虚构阈值，不从合成规模推断真实模型质量。

**所有权和冲突处理**　不直接重写任何领域、core 或 store，delegate 修复给拥有文件的 Agent。使用固定集成 SHA 和单独数据目录。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T15/T17/T18，跨平台 host / Windows 读路径，第三方插件、传统客户端和安全回归。发现高危就冻结该 feature gate。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 审查报告、可复跑 benchmark 基线与日志、风险初始和结束判定、按领域列修复列表。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。失败 feature gate 保持关闭，回退测量脚本可单提交撤销。

报告写入 `handoffs/NP-16-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
