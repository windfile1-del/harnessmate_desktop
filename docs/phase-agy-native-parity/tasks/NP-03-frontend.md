# NP-03 · AGY 工作台与通用前端投影

让所有 AGY 领域组件共享稳定的工作台、事件读取、焦点、权限和交互层，避免 ChatStage 堆叠多个专属面板。

| 项目 | 约定 |
| --- | --- |
| 依赖 | G0 先 03a 做 IA 和组件样本。03b 等 NP-02 G1，真实生命周期验收联合 NP-04/05/07，领域 Studio 按 registry 装配。 |
| 契约 | 09 信息架构；08 NativeRuntimeProjection、snapshot cursor、capabilities/receipt DTO。shell 与各领域 props、注册接口单独冻结。 |
| Git | `codex/agy-np-03-frontend`，建议 Worktree `D:\HarnessMate\agy-np-worktrees\np-03` |
| 写入范围 | `packages/web/src/components/agy/native/shared/**`、`packages/web/src/lib/native-client.ts`、AGY 通用 Composer/Studio adapter、slot registry、`App.tsx`、`ChatStage.tsx`、`stores/app-store.ts`、`lib/projector.ts` 与专属 tests。 |
| 潜在冲突 | 唯一本地 shared Store/ChatStage writer。各工作包贡献自己的 UI 组件，不修改 registry 之外的共享接口，需变更由本任务处理。 |
| 范围排除 | 不添加 backend routes、权限决定、slash 处理、子任务数据解码，不独占其他领域的组件目录。 |

## 工作内容与前端

03a 设计 shell、路由、status badge、EvidenceDetails、NativeTimeline、工作台 registry、真实/未知/过期/崩溃/unsupported fixtures，先验证键盘和窄屏。03b 接快照与增量 feed，pending 从共享 Approval 数据获取，activity/child 分作用域。通过 stable props 注册 Runtime、Child 与多个 Studio。落地虚拟列表、batch 刷新和快速切换，移除 native placeholder 对 UI 的依赖。

采用现有界面语言与 slots。对模式选择、原生 continuation、忙碌与 detach、快捷键、焦点回返、App 宽度和窄版给交互证据。未验证 source 明示可见边界。

## 阅读与参考

必读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)。

- [packages/web/src/App.tsx](../../../packages/web/src/App.tsx)
- [packages/web/src/components/ChatStage.tsx](../../../packages/web/src/components/ChatStage.tsx)
- [packages/web/src/stores/app-store.ts](../../../packages/web/src/stores/app-store.ts)
- [packages/web/src/lib/projector.ts](../../../packages/web/src/lib/projector.ts)
- [packages/web/src/lib/command-palette.ts](../../../packages/web/src/lib/command-palette.ts)
- [packages/web/src/components/agy/AgyComposerControls.tsx](../../../packages/web/src/components/agy/AgyComposerControls.tsx)
- [packages/web/src/components/agy/AgyStudioBlocks.tsx](../../../packages/web/src/components/agy/AgyStudioBlocks.tsx)
- [docs/plugin-api/slots.md](../../../docs/plugin-api/slots.md)
- [packages/web/tests/phase-agy-ui.test.tsx](../../../packages/web/tests/phase-agy-ui.test.tsx)

[antigravity.google · features](https://antigravity.google/docs/features/) · [antigravity.google · agents](https://antigravity.google/docs/cli/commands/agents/) · [antigravity.google · artifact-review](https://antigravity.google/docs/artifact-review/) · [pingdotgg/t3code discussions 39503](https://github.com/pingdotgg/t3code/discussions/39503)

## 测试、交付及合并

纯 UI 测试及 snapshot pagination、重连、seq gap、旧事件/切换账号；100 child/10k 实例样本与 NP-16 联合。原生控制按后端证据决定，不从截图提升等级。

通用工作台、前端契约与例子、交互截图或安全 fixture、回归结果并说明 mock/connected 阶段。。

依 [DAG](../10_Task_Dependency_Graph.md) 的检查点独立评审与合并。禁用新版 native UI，保留既有 AGY-5 组件和旧客户端。

报告写入 `handoffs/NP-03-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。

[直接用于新会话的提示词](../prompts/NP-03-frontend.md)
