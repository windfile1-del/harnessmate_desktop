# 独立开发提示词 · NP-01 协议观测与事件录制

你负责 HarnessMate Desktop 的 **NP-01 协议观测与事件录制**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

能够以时间线和关联 ID 区分 AGY 未发帧、传输接收、适配器归属、持久化或 Web 投影，建立可重复的 Windows 最小录制和回放。

**依赖与可并行范围**　G0，可与 NP-02、NP-03a 独立开始。最终 daemon tap 接线需要 NP-02 的 G1 接入缝。

**接口契约**　证据 E01–E07；测试策略 capture metadata；NativeIngress 的 connection/ordinal/replay；Recorder 输出不进生产业务事件。

使用建议分支 `codex/agy-np-01-observatory`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-01-observatory.md) 和以下源码。第三方实现用于对照。

- [docs/phase-agy-native-parity/evidence/probe-acp.mjs](../../../docs/phase-agy-native-parity/evidence/probe-acp.mjs)
- [packages/daemon/src/harnesses/jsonrpc.ts](../../../packages/daemon/src/harnesses/jsonrpc.ts)
- [packages/daemon/src/harnesses/acp/strict-acp-adapter.ts](../../../packages/daemon/src/harnesses/acp/strict-acp-adapter.ts)
- [packages/daemon/tests/agy-replay-protocol.test.ts](../../../packages/daemon/tests/agy-replay-protocol.test.ts)

[antigravity.google · acp](https://antigravity.google/docs/ide/extensions/acp/) · [google-antigravity/antigravity-cli releases tag 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 工作与权限范围

**允许写入**　`scripts/agy-np/observatory/**`、`packages/daemon/tests/fixtures/agy-np/**`、专属 recorder tests 与 `evidence/scenarios/`。

**具体实现**　保留 NP-00 探针的默认无身份路径。补一键 live 录制、dry-run、格式迁移和 JSON schema。让同一 alias 能贯穿 raw/normalized/native canonical/UI。包括 stderr 分类、进程退出、drop/overflow、延时和未知字段，明确 synthetic/replay/live provenance。入站与出站默认以字段 allowlist 重建，保留固定测试值的加盐关联，仅读可授权测试场景。现有 1.5.14 fixture 原状保存。具备单账户授权时先做 T01/T02。

**交互和前端**　无新增产品页面。需要可比较的四层简表与支持复制安全诊断编号的输入格式给 NP-03。

**范围排除**　无产品状态重构、自动账号登录、付费任务、捕获或发布私人 session/原始日志。不得改共享 JSON-RPC、SessionManager 与 app-store。

**所有权和冲突处理**　NP-02 写 transport/event 接线。先用回调接口证明工具，再以最小 diff 提交接线需求给 owner。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T01–T06 的采集形状；至少包含畸形行、无日志泄露、强制超时、连接与审批相关性验证。授权前只执行无身份/合成。每个失败 fixture 写出判定条件。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 录制工具、脱敏器、至少两份最小 replay、Windows 执行说明、采样来源及限制报告。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关 recorder opt-in，可撤销工具提交。fixture/证据历史保持可读。

报告写入 `handoffs/NP-01-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
