# 独立开发提示词 · NP-09 Boost 多段推理

你负责 HarnessMate Desktop 的 **NP-09 Boost 多段推理**。项目在 AGY-0 至 AGY-6 后启动 Native Parity。NP-00 已做研究和最小探针，源码审计基线为 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。以总指挥交给你的已审 checkpoint commit 为 coding base。你的成果由总指挥及独立审查者集成。

## 目标与开工条件

可触发及呈现经证据确认的 AGY Boost 和它特有的验证阶段。

**依赖与可并行范围**　G2（04/05/06/07、03b）。付费试验需用户确认账号资格和单场景预算。

**接口契约**　WorkflowDetail.boost、NativeStage、source and revision；无字段 phase 列表省略；用户明确选用 live_workflow。

使用建议分支 `codex/agy-np-09-boost`，在自己的 D 盘 Worktree 工作。先读 [总进度](../MASTER_PROGRESS.md)、[源码审计](../05_Source_Audit.md)、[协议证据](../06_Protocol_Evidence.md)、[总体架构](../07_Architecture.md)、[共享契约](../08_Shared_Contracts.md)、[前端设计](../09_Frontend_Design.md)、[测试方案](../12_Test_Strategy.md)、[Git 协作](../13_Git_Collaboration.md) 与 [风险](../14_Risk_Register.md)，再读 [本任务卡](../tasks/NP-09-boost.md) 和以下源码。第三方实现用于对照。

- [packages/daemon/src/harnesses/agy/agy-protocol.ts](../../../packages/daemon/src/harnesses/agy/agy-protocol.ts)
- [packages/web/src/components/agy/AgyComposerControls.tsx](../../../packages/web/src/components/agy/AgyComposerControls.tsx)
- [docs/phase-agy-native-parity/09_Frontend_Design.md](../../../docs/phase-agy-native-parity/09_Frontend_Design.md)

[antigravity.google · boost](https://antigravity.google/docs/boost/) · [antigravity.google · slash-commands](https://antigravity.google/docs/slash-commands/) · [pingdotgg/t3code pull 38864](https://github.com/pingdotgg/t3code/pull/38864)

## 工作与权限范围

**允许写入**　`packages/daemon/src/harnesses/agy/native/workflows/boost/**`、`packages/web/src/components/agy/native/boost/**` 和专属 tests。

**具体实现**　记录 model/tier 广告、原生 /boost 启动、子 Agent 角色、真实验证及停止。使用只读实际阶段。存在 initial/improvement/verification 信号才定义标准内部枚举；解析未知角色作为 observed label，不推断进度或轮数。无资格采用确定性提示，保持原始模式意图。

**交互和前端**　Boost Studio 有可查验证线索、原生阶段和活动。没有 phase 时展示可观察活动与已证启动。默认不自动升级到付费模式。

**范围排除**　无 model 自发模式，不以独立 AGY 实例替代 Boost，不硬编码阶段，不从外部协作框架追因。

**所有权和冲突处理**　使用 05、06、07 公共子路由/权限，自己的 projection 与 UI 独立，不能驱动其它包的工作流。

使用未经修改的官方 AGY CLI。能力须能溯源到官方规范、可验证的实际数据、live 协议或标明为模拟/回放的证据。保证原生 Agent 自主编排，醒来只认真实原生事件。保留现有其他 Harness、数据、账号、Context Handoff 和 Plugin SDK。用户直接发起会话，登录、凭据和权限走官方路径。禁止解析、复制 token，修改 system prompt、代理模型、轮换账号或绕过权限。私有运行时只读，未验证格式关闭。真机和额度按 U01 授权，生产数据不参加试验，临时文件只放 D 盘。

## 实施与验收

1. 用 `git status --short --branch`、`git rev-parse HEAD` 核对 Worktree、依赖与用户改动。确认当前行为与证明改动所需的最低证据。
2. 按当前可用数据完成本域模块。遇到缺接口，先用冻结的 stub，给 owner 附用例的变更提议。真实模式无法验证时保留 gate，提交可审查的降级或限制证据。
3. T11，合成未知阶段、重复和 server denied，获得授权后对 App/CLI/ACP 做一个小目标。记录实际可用中断。
4. 运行适用的包测试及 `pnpm typecheck`，检查 `git diff --check` 与文件范围。进入 G2/G3/G4 前按 [全量门禁](../12_Test_Strategy.md) 执行。未跑的检查和原因写在报告中。
5. Boost resolver/observer、专属 Studio、门控和 fixture，带实际计划等级与证据。。提交便于审查的最小 commit，用固定 SHA 交付。集成分支和其他 Worktree 由各自 owner 维护。

**合并和回滚**　经 [独立审查](../reviews/README.md) 后按 [依赖图](../10_Task_Dependency_Graph.md) 合入。关闭模式入口和 projection，保持通用原生 trace。

报告写入 `handoffs/NP-09-report.md`。列出 reviewed base/HEAD、代码提交与路径、实现和未覆盖事项、契约 revision、测试命令与结果、验证类别和 Capability ID、真实证据/缺口、数据与其他 Harness 回归、冲突/协作请求及回滚命令。给审查者证据 ID、路径与命令。`MASTER_PROGRESS.md` 由总指挥统一更新。
