# NP-03 独立评审 · fb91c9c

评审日期 2026-11-25（Asia/Shanghai）。结论 **修改后复验，当前交付等待合并**。基线 G0 `a01280176348974a0ddc00fd491afddc1d985c9e`。交付 `np03_agy_workbench @ fb91c9c169857fce023e6fcc86a45b3c04ec093d`，实现提交 `fd855ee3af4e433650a447c5423bc015e4acc304`。实际 Worktree 位于 `D:/AppDataCache/.gemini/antigravity/worktrees/harnessmate_desktop/np03_agy_workbench`。报告为该分支的 `docs/phase-agy-native-parity/handoffs/NP-03-report.md`。

03a 的工作台、注册表、共享组件和夹具已交付，窄屏交互需修复。03b 客户端和 Store 是 G0 的 stub 实现。公开接口和原生动作走 [G1/G2 检查点](../10_Task_Dependency_Graph.md)。`0.1-np03-stub` 和 registry 修订均作为候选，真实能力矩阵沿用 G0。

## 合并前需修复

### R1 · P1 · 补缺可丢帧并误标 Live，旧状态帧可替换绑定

`packages/web/src/lib/native-client.ts:1037` hydration 后发起补缺，未保证重新排空 hydration 前已排队且计时器已触发的帧。`:1158` 在发现缺口前清空队列，gap 之后的后缀不会重试。`:1088` 至 `:1110` 忽略分页中 reducer 返回的缺口，在空页或触达 50 页上限时也可以改为 Live。`:779` 至 `:799` 只比较 generation 不同就将 `native.runtime.changed` 视为推进，跳过旧代、重复和缺口检查。

独立桩测试从水位 12 开始。hydrate 前排队 seq 13、实时先来 seq 14 而补缺 API 暂无数据、分页从 seq 14 开始，这三条路径最终均为水位 12 且显示 Live。另注入含旧 binding 的 seq 1 `native.runtime.changed`，投影实际回退成旧代和 disconnected。

以 G1 明确的 binding/cursor 范围为准。保留待补后缀并在完整前缀后重放，或使用有界重同步。按当前请求和绑定校验快照、分页与 capability 回复，拒绝乱序请求结果和旧代事件。重连、410、空页、分页上限、缺失页与中途切代都需要测试。超过重试边界时明确显示数据未完成同步，保留可重试入口。

### R2 · P1 · 操作回执和幂等键脱离原提交范围

`packages/web/src/stores/app-store.ts:2175` 复用任何正在提交的 key，未比较目标与参数。晚返回的成功和失败路径都可通过 `createEmptyNativeSlice()` 重建已清理会话。`:2270` 用执行时最新 projection 的 generation 补请求，调用处未携带按钮渲染时的绑定。关闭门控停止 feed，但不能阻止已提交操作的 UI 回执写回。 `packages/web/src/components/ChatStage.tsx:715` 仅发送 prompt 文本，成功时只比较文本便清草稿。如果有未传入的附件或终端上下文，会一并清掉草稿；也没有排除提交期间发生的附件编辑。`NativeRequestCard` 最终走现有 `resolveRuntimeRequest`，G1/G2 要验证该路径与原生收据及当前绑定同权威。

独立 stub 向同一会话同时提交两个不同 prompt。实际调用两次，使用同一个 key。清空 session slice 并关闭门控之后再返回 stub 成功，两次 action 均返回 true，已清空的 slice 被重建，显示 confirmed。

绑定应覆盖会话、实例、runtime、generation、能力修订和提交标识。仅相同完整意图可重用 key，改绑、切换、掉线或禁用后忽略迟到的 UI 回执。真实服务端仍负责鉴权、绑定、CAS 和幂等。模式动作仅在当前已证实能力允许时启用。附件、终端上下文及草稿消费要与实际发出的内容一致。验收覆盖切会话、登出、旧代 409、同/异 payload 的连续点击和提交中编辑附件。Stub 阶段使用可控 transport 测试这些路径。

### R3 · P1 · 时间线的来源和作用域可错配，实验开关可隐藏历史

`packages/web/src/components/agy/native/shared/AgyWorkbenchShell.tsx:85` 与 `:398` 切换选中项后直接启动新请求且保留旧条目，标题立即换成新项。Runtime 的加载更多从 `:349` 开始，没有取消或作用域检查，晚回的旧页直接 append。`:557` 的子 Agent 时间线只展示首批条目。 `packages/web/src/components/ChatStage.tsx:901` 与 `:1914` 使用固定 HTTP transport，绕过 Store 注入的 stub。内联 loader 会在 ChatStage 重渲染时更换，导致依赖该引用的首屏读取重启。

`ChatStage.tsx:335` 仅凭 UI opt-in 即隐藏旧 `turn_bg` 和 `turn_unknown` 事件，即使 native projection 空或无法读取。`projector.ts:571` 将原事件移入 `detachedNativeEvents`，现有界面没有回读该集合的入口。 `native-client.ts:932` 对合并后的条目仅记首条 ID，并只检查 delta key 与 kind。独立复现 `a + b` 后重复到达的 b 被追加为 `abb`，不同 agent 使用相同 key 时其文本被合并到首位 agent。

使用同一个注入 transport。当前 runtime/generation/scope 的数据与选中项同时切换，取消首屏和分页请求或在回执处隔离旧结果。时间线保留完整的已合并条目身份及 actor/scope。端点缺失、快照过期或尚无替代视图时让旧事件可访问。复验切 child/会话、分页在切换后返回、连续重渲染、重记 delta 和 stub 网络隔离。

### R4 · P2 · 03a 窄屏抽屉焦点与键盘选项卡不满足交互验收

`packages/web/src/components/agy/native/shared/AgyWorkbenchShell.tsx:939` 至 `:984` 设置 modal ARIA，未在打开后移入焦点或阻止背景控件获焦。方向键在 `:964` 至 `:977` 只更新路由，没有移动选项卡焦点。全宽分支卸载顶部触发按钮，`:947` 当下检查 ref 的回返路径还需实际验证。

在本机 Windows 的隔离 Chrome headless 会话以 500px 实际 CSS viewport 挂载 03a 窄版夹具。打开后焦点未进入抽屉，背景按钮仍可获焦。ArrowRight 将选中项改成 Subagents，活动焦点仍在 Runtime。该夹具的 Escape 关闭与触发按钮回返通过。现有组件测试采用 SSR 静态标记，覆盖窄版 ARIA 和有界 DOM 数量。

使用项目可复用的 modal 行为或实现等价的焦点进入、限制与回返。保持 tab 选中和实际焦点一致。按 480px、分栏及全宽路径，验证打开、Tab/Shift+Tab、方向键、Escape、嵌套弹窗及回返。03a 可作为独立修复提交先复审。

### R5 · G1/G2 · 冻结 DTO、WS 闭环与操作权限仍是接入条件

`packages/web/src/lib/native-client.ts:618` 将任意成功响应强制转换为 stub DTO。`app-store.ts:721` 的 WS 分派没有 native frame 接入。当前客户端没有由生产订阅链路验证的实时启动、重连和断链投影。registry 的类型依赖 stub DTO。`ChatStage` 的两处壳组装也需要统一选中作用域、transport 和 gate。报告中的 API 名称、请求回执、WS op、路由与诊断字段目前作为 G1 建议。

G1 后用协议包的冻结类型和边界校验，跑实际快照、分页、能力与 WS 订阅闭环。与 NP-02 确认批准路由与错误码，与 NP-04/05/07 在 G2 验证过期能力、断线请求和 native 实例隔离。G2 前保持真实动作关闭；Web 类型检查和 synthetic UI 成功仅用于当前代码范围。

## 验证及协调

- 24 个变更文件在 NP-03 所有权范围内，仅前端、专属测试和交接。交付树干净，`git diff --check a012801 HEAD` 通过。没有 SQLite 或公开插件契约变更。
- 独立复跑 `pnpm --filter @harnessmate/web test` 通过 13 文件、62 项，Web typecheck 通过。交付报告记录 build、全仓 typecheck、插件契约及选定 protocol/daemon 验证，本评审复跑范围限 Web。定向合成反例与浏览器夹具结果见 R1 至 R4。没有调用 AGY 或使用真实账号。
- NP-03 在原分支追加修复提交并附新的 HEAD。把 03a 可独立消费的交付与 03b 接线分成可分别审查的提交。领域任务可预读 registry 方向，G1 冻结前以候选契约协作。NP-02 继续其独立 G0 工作，NP-01 的评审状态沿用 [总进度](../MASTER_PROGRESS.md)。
