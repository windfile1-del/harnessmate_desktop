# G3 第二批联合审查 · NP-12 至 NP-15

审核日期 2026-11-26（Asia/Shanghai）。共同开工标签为 **agy-np-g3-wave1**，解析为 9826359a46d0518c88d12ca45318bb5cb891a73a。四支交付范围互不重叠，合并为 7a24bfdefafc9c4745a8457ea53165941b8b38e3。修复后复验源码为 **b8f79fe58bd58044f1682b0601149c943f102fbb**。本次接收边界为默认关闭的源码和合成验证，生产接线、授权实机和发布验收单列。

| 工作包 | 交付 HEAD | 交接记录 |
| --- | --- | --- |
| NP-12 | 76302f387c698541576fe01bae83adc9fab75622 | [Goal、Schedule 与 Native Tasks](../handoffs/NP-12-report.md) |
| NP-13 | f9e4a5a5f57ae795f7a6c771bc628d43c933ce11 | [原生生态与配置](../handoffs/NP-13-report.md) |
| NP-14 | 8e9fa051918c356562096196dddd194b2ea4d072 | [Artifact、Review、Browser](../handoffs/NP-14-report.md) |
| NP-15 | cf0a5f9cfa31244b45a518d381d3b6f1da86a33a | [恢复与兼容性](../handoffs/NP-15-report.md) |

## 已处理的审查发现

| 编号 | 位置 | 行为、影响与复验 |
| --- | --- | --- |
| G3-06 | [恢复服务](../../../packages/daemon/src/harnesses/agy/native/recovery/recovery-service.ts) · acceptLiveIngressCheck / reconcileScheduleOccurrences | 旧连接或元数据缺失的 occurrence 经原生 ID 匹配后曾能晋升为已确认。新判定要求当前 binding、当前连接、回放结束及完整证据，过期 snapshot 退回未证实。以两条 native ID 的键去重，同一 occurrence 优先保留当前代次的 WorkId。NP-15 Suite 3/5 复验。 |
| G3-07 | [制品服务](../../../packages/daemon/src/harnesses/agy/native/artifacts/artifact-store.ts) · registerHistoricalSession / registerObservedArtifact / submitNativeArtifactApproval | 同一 binding 的回放曾可替换活动制品或降级连接，审阅曾允许未声明决定并发生并发二次写。隔离历史与活动数据，核验允许的决定，在 transport 调用前认领请求，复验连接、版本和请求。NP-14 Suite 2 的重复、禁用决定、历史和断连用例复验。 |
| G3-08 | [生态服务](../../../packages/daemon/src/harnesses/agy/native/ecosystem/service.ts) · collectSnapshot | profile 用于显示，launchContext 用于读取，交错输入曾可读取其他 Profile。先校验实例、认证、隔离及目录作用域再扫描。开启只读收集后每次刷新扫描，关闭时跳过本地 policy 内容读取。NP-13 T15 的交错输入和同 Profile 新增文件复验。 |
| G3-09 | [进程回收协调器](../../../packages/daemon/src/harnesses/agy/native/recovery/process-tree.ts) · teardownConnection | cancel/close 等待后可能用已被替换的 PID 所有权操作。各阶段重核原记录身份，拒绝操作或移除替换记录。NP-15 Suite 7 用伪 transport 验证 PID 复用，此用例仅模拟回收。 |
| G3-10 | [Daemon 装配](../../../packages/daemon/src/harnesses/agy/native/wiring/composition.ts) · [Web 入口](../../../packages/web/src/App.tsx) | Native Tasks 视图注册到 AGY 工作台。Daemon 新增默认关闭的 nativeTasksObservation，仅在启用时以严格解析器接受当前 live 连接并接入已有只读 workflow resource 路由。唤醒只匹配唯一已观测的 occurrence，缺失的原生触发时间不再带入本机时间。NP-12 新用例通过 Daemon 装配入口验证关、开、回放、过期连接、错误的计划标识、正确恢复及只读查询。 |
| G3-11 | [恢复测试](../../../packages/daemon/tests/agy-np15-recovery.test.ts) · makeTempDir | 测试曾优先写同名的固定 D 盘目录，受管环境返回 EPERM。现在由进程配置的 Windows TEMP 决定根目录，独立复验显式指向有权限的 D 盘目录。 |

## 联合门禁

| 检查 | 结果 |
| --- | --- |
| pnpm build / typecheck / contracts:check | 通过。最后一次 Schedule 修改另行重跑 Daemon 构建和类型检查。 |
| Protocol / Web | 串行 Vitest 分别 6/6、118/118。 |
| Daemon | 251 项均有通过记录。受管运行首次有 3 条失败，NP-12 修正断言选中 occurrence 的 WorkId 后 7/7 通过。OpenCode 子进程回收和 AGY auth 清理在具备进程回收权限的 Windows 复跑中通过。该复跑出现 DeepSeek 单项 30 秒超时，同一用例在候选的受管定向运行中通过。 |
| 变更范围和 Git | `git diff --check 9826359a46d0518c88d12ca45318bb5cb891a73a HEAD` 通过。 |

合计 375 项有通过记录，统计覆盖联合运行与定向复跑。Windows 进程回收涉及宿主权限，单次全套绿色运行仍作为下一个固定发布候选的验收项。

使用按包串行 Vitest 和 D 盘临时目录。Web 构建报告现有的大包体积提示，纳入 NP-16 记录。未调用真实带账号 AGY 模型或对用户 Profile 写入，Capability Matrix 保持已有证据等级。

## 验收缺口与关闭条件

| 边界 | 当前证据 | 关闭标准 |
| --- | --- | --- |
| NP-12 / NP-15 | Goal/Schedule 实验观察经合成 Daemon 输入可见。恢复判定的作用域负例和跨代去重通过专项测试。 | 取得真实 Goal/Schedule、事件、断连和恢复样本后，连接 TasksRecoveryEvidencePort 与恢复服务，验证 WorkId / wake ActivityId、计划保活及停止行为。保持调度和主动恢复控制关闭。 |
| NP-13 | 生态只读收集及 UI 插槽作为领域模块可用，旧生态端点仍提供现有信息。 | 校验通过实际账号与会话选择取得的只读 API/Settings 工作路径。官方查询还须在真实用户确认和作用域匹配后独立验证。 |
| NP-14 | Plan / Diff / Browser 观察和 Teamwork / Dynamic 端口已用夹具复验。旧面板使用只读预览。 | 新 Workspace、REST 和生产 observer 的端到端接线需绑定会话、版本和来源校验。审阅写操作与 Browser 控制须使用获证原生接口。 |
| NP-15 | 恢复和兼容服务、历史读源及进程协调器专项通过。 | 接入生产 attach / replay / close 和真实 Windows 进程所有权验证。核实只读历史与恢复期间的审批隔离。ACP v2 Preview 保持关闭。 |
| U01 | 未获得 Gemini 3.8 Flash 的专用 Profile 真实记录。 | 分别存档能力发现、20 秒后台唤醒、真实 ACP 事件及官方 Windows App 对照。 |

四支原交付与修复分别保留提交。出现回归时关闭 nativeTasksObservation 和 Web 工作台 gate，以固定源码重跑回放；需要源码回退时，在新的回退提交中撤销修复或用第一父快照审查回退范围。保留 SQLite 已有增量数据。后续分工见 [NP-16 / 17 开工方案](../handoffs/G4_Launch_Plan.md)。
