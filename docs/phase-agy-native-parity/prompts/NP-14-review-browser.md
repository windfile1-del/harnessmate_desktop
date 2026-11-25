# 独立开发提示词 · NP-14 Plan、Artifact Review 与 Browser Agent

你负责 HarnessMate Desktop 的 **NP-14 Plan、Artifact Review 与 Browser Agent**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。从本地标签 `agy-np-g3-wave1` 切分支，按 [第二批开工安排](../handoffs/G3_Wave2_Launch_Plan.md) 校验提交。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

参考 [Teamwork 审阅端口](../../../packages/daemon/src/harnesses/agy/native/workflows/teamwork/ports.ts) 和 [Dynamic Artifact 端口](../../../packages/daemon/src/harnesses/agy/native/workflows/dynamic/ports.ts)。真机支持证据齐备前，桥接限于只读及合成用例。批准关联须包含同绑定、连接、当前 Artifact 和请求 ID。

把 AGY 的计划、原生产物、diff、审阅和浏览器角色清晰地接入安全工作台。

**依赖与可并行范围**　G2（05/06/07、03b），与 NP-10/11 联合验证各自 Artifact。现有只读 UI 可先复用。

**接口契约**　Opaque artifact resource、scope/redaction、revision 与 verified action keys；权限与实际评论/批准的 wire 形状先录后声明。

使用建议分支 `codex/agy-np-14-review-browser`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-14-review-browser.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-artifacts.ts](../../../packages/daemon/src/harnesses/agy/agy-artifacts.ts)
- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyArtifactReviewPanel.tsx](../../../packages/web/src/components/agy/AgyArtifactReviewPanel.tsx)
- [packages/web/src/components/DiffInspectorPanel.tsx](../../../packages/web/src/components/DiffInspectorPanel.tsx)
- [docs/plugin-browser-preview.md](../../../docs/plugin-browser-preview.md)

[antigravity.google · artifact-review](https://antigravity.google/docs/artifact-review/) · [antigravity.google · artifacts](https://antigravity.google/docs/cli/artifacts/) · [antigravity.google · browser](https://antigravity.google/docs/browser/) · [antigravity.google · browser-recordings](https://antigravity.google/docs/ide/browser-recordings/)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/artifacts/**`、`agy-artifacts.ts`、`packages/web/src/components/agy/native/review/**`、`AgyArtifactReviewPanel.tsx`、专属 tests。

**具体实现**　复用路径白名单与只读 API，验证实际产物类型/上下文、parent/child 归属及安全内容渲染。将标准 Plan/diff 与 AGY review 分开。若真实支持评论/批准，按经证的 wire schema 幂等交付。Browser Agent 仅呈现真实角色/日志/截图；区分 App 内嵌与 CLI/企业 Chrome MCP。用官方指引补完整 App-only 操作。

**交互和前端**　Artifact & Review Workspace 有列表/过滤、Markdown/text/diff、行号与来源。只读/需官方端明确。禁止加载未审查的未知链接。

**范围排除**　无 AGY 内嵌浏览器控制复刻、协议 UI 未证的评论或批准、任意 HTML/任意 Native path、发布私有产物。

**所有权和冲突处理**　NP-05 child identity、07 approvals，02 API、03 shell。Teamwork 与 workflow 只各自管理业务关联，Artifact reader 由 14 唯一维护。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T12/T13/T16：真实文件与路径边界，恶意内容与 XSS 防御，回放真实审批和拒绝。含历史读、viewport、授权后的 app/cli 对照。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. 安全内容 reader、计划/review/Browser 组件、供应商支持和截图/录像证据。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。保持旧只读面板，控制和媒体 gate 独立关停。

报告写入 `handoffs/NP-14-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
