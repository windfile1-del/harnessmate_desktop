# 09 · AGY 前端信息架构

原生产品以 App 的多会话工作台、CLI 的 Agent/Task Manager 及模式 Board 为对照。HarnessMate 采用现有 Session、ChatStage、Inspector、Approval Center 和 Settings 的交互与视觉语言，以原生状态做专属工作台。以下为将来实现的设计，功能在同一确证投影上开放。[功能总览](https://antigravity.google/docs/features/) · [Agent Manager](https://antigravity.google/docs/cli/commands/agents/) · [Swarm Board](https://antigravity.google/docs/swarm/) · [Artifact Review](https://antigravity.google/docs/artifact-review/)

## 信息架构

~~~text
会话列表 ── AGY 会话
  会话顶栏     Native Runtime 摘要 · 有待操作时显示数量
  聊天主体     用户/主 Agent 时间线，已关联原生活动卡、需操作的原生请求
  输入区       Agent Mode Picker · Native Command Palette · 模型/思考/权限
  Inspector    Runtime · Artifacts · 当前已打开的 Studio
  工作台       Subagents │ Swarm │ Boost │ Teamwork │ Workflows │ Native Tasks
  全局设置     Harness → Antigravity → Accounts / Models / Custom Agents / Ecosystem
~~~

默认打开聊天。进入专属视图时用 session scoped route/state 保存选择，允许侧栏返回主 Agent，并可通过现有窗口空间扩展到全宽。URL 只包含 HM scoped IDs。账户/Profile 或会话切换清理旧订阅和选中项。适配键盘、480px 窄布局、双栏和独立窗口；窄版 Inspector 作为可关闭的全宽层，焦点返回触发按钮。切换视图不会停止 AGY。

## 发起与管理

- **Agent Mode Picker** 位于 `composer.traits` 或 `composer.actions`，使用一个选择控件显示普通、子 Agent 引用和经确证的工作模式。菜单显示计划、能否运行和状态来源，说明文字按需展开。选择后保留草稿与附件，输入提示随工作流目的变化，只有用户点击发送才走 native router，一次产生一个提交。不可用模式带清楚原因和官方入口。没有 profile 验证时可看功能说明，不能运行。
- **Native Command Palette** 复用 `/` 搜索、键盘、参数提示和现有 Composer。会话本地输入、config、live workflow、manager/query 有各自图标和操作说明。先看 runtime per-binding 广告，静态文档可帮助发现。列表选择既不点击即执行，也不把本机命令串投给 shell。有效 revision 变化时刷新可用项并保留用户文本。
- **提交反馈** 用 accepted/failed 与实际 evidence 分隔。点击之后显示「正在发起」，只有已验证帧给出「Swarm 正在运行」等状态。后端告知已发送但缺模式证据时显示「已发送，等待原生确认」。重复按键复用提交 key。`409` 保留草稿并重新取 capabilities，避免按钮再发一次。
- **忙碌期间** 继续用 Composer 草稿。仅在服务端验证了原生 steer/queue 路径时呈现相应操作与队列原因。预计需要先等现场证据，初期显示「可查看正在进行的工作」。前台完成后仍可见活动中的后台任务。Stop 附带明确目标，点击进入「正在取消」直至原生证据或状态未知。
- **审批与问题** 主时间线和全局 Approval Center 使用同一 pending 列表。来自已证实的 child 的请求展示真实所属 Agent、目标与单独跳转。来源范围不清楚时提示未确认并响应现有支持的原生途径；UI 不代选、不以自由文本填固定选项。审批提交后提示等待后续状态；连接改变后可以查看旧收据。

## 工作台逐页设计

| 页面 | 默认区块与日常操作 | 观察与降级 |
| --- | --- | --- |
| **Native Tasks & Runtime Center** | 顶部连接、等待、运行与需操作摘要。下面分活动、有限后台、常驻进程、定时任务。点任何任务打开详情（来源、最后状态、相关 activity、logs、请求、原生控制）。Schedule 列表可展开每次 wake，等待期间主聊天仍可用。 | 只有证据支持运行时才显示「运行中」。记录迟到及恢复状态分别可见。原生任务状态源不可读时显示「最后观测」、实际工具流和官方 `/tasks` 说明。daemon 与阻塞标签独立。 |
| **Subagent Manager** | 父树和可筛选表：批次、child、角色、最后活动、需操作。主 Agent 行可返回聊天。展开 child 查看其 own transcript、工具、产物和请求，支持面包屑回父。多个真实 child 用独立 ID。 | 初次只有 launch 时显示「已观察到委派」「身份待确认」。跨 child 切换时取消旧读取。支持后才显示已证实的取消。无原生 steer 时只提供回主代理交互。 |
| **Swarm Studio** | Overview 显示 coordinator/目标，Workers 区查看已证实成员与 verifier，Board 以实际帖子和 thread 展开，Activity 按来源看轨迹。明确的 worker identity 允许跳转其权限与输出。 | Board 无 feed 时显示「当前 ACP 未提供 Board」，保留协调者与已确认子项，附官方 Board 的入口说明。无原生 member command 则保持只读。未知/idle 的 worker 不计入成功进度。 |
| **Boost Studio** | 进入后显示任务、已观察活动和验证结果。若原生提供阶段，依次列被证实的实现、挑战、修复、验证，各阶段能点到证据和子执行。 | 只有阶段/role 证据才显示阶段区块，运行中可仅有原生任务与通用工作项。付费限制显示实际资格或未知。 |
| **Teamwork Studio** | Teamwork 建议为独立全宽项目页，分访谈、Prompt Artifact 审阅、项目、里程碑、角色/审计和产物。可见访谈逐题推进，原生 approval 路径经 Evidence 可直接从 Artifact 审阅触发。 | 无批准 API 时用可查看原始 Artifact 的路径说明。里程碑未发则隐藏图表，保留已观察的原生阶段。用户可返回关联会话，不跳转到猜测出的目录或跨 Profile session。 |
| **Dynamic Workflow Studio** | 流程顶部脚本预览和权限。实际 phase/edge 可切换列表或 DAG，点节点看 Agent 执行、日志、结构结果；无依赖图时展示可排序 timeline。 | 未得实际 edges 时不用模型输出生成流程。脚本作为文本审阅，点击原生批准需经 Approval Router。运行结果和结构数组分页，不信任产物内嵌 HTML。 |
| **Goal / Schedule** | Goal 由任务详情展示目标、当前验证、终态、已证实控制。Schedule 页以时间和 occurrence 整理运行与完成，并可直接跳到原生醒来的 activity。 | 缺时区/下一次时间时按原生日志与观测值显示。未开放编辑、暂停、取消的路径有原生界面指引。App Automations 持久管理另列，避免以 HM 调度替代。 |
| **Artifact & Review Workspace** | 使用 Inspector 已有 Artifact 与 Diff，文件列表按类型和引入的 activity/child 定位，内容可切换 Markdown、文本、diff。只在原生 action descriptor 可用时画行级评论按钮、批准结果。 | 继续支持只读。来源、旧版本和读取失败分别提示。使用端侧安全 Markdown 渲染和授权 manifest 资源。Browser screenshot/recording 是参考产物，Browser Agent 的 live 来源另行支持。 |
| **Custom Agent Manager / Ecosystem** | Settings 中分「当前账户」「原生 Agents」「Skills & Rules」「Hooks」「Plugins & MCP」「Projects」。显示来源层级，编辑前校验路径和权限；可能 fork 的模式更改先解释会产生新会话。 | 对只读、沿用 CLI 的项目显示实际支持能力。AGY Plugins 和 HM Plugins 在不同命名空间和导航内。校验组织限制与重启生效要求，按 verified descriptor 进行操作。 |

## 可重用组件与数据读取

| 组件或服务 | 职责 |
| --- | --- |
| Native Runtime Store + selector | 以 `runtimeId/generation/asOfSeq` 管状态。按 entity ID selector 局部渲染。使用 snapshot+cursor 恢复。弃旧 payload、不把 detached 事件进通用 projector |
| NativeActivityLink · EntityStatus · EvidenceDetails | 聊天引用、状态/来源、错误及最后观察时间。请求待处理时可进入同一个源明细 |
| NativeTimeline · RequestCard · NativeControlMenu | 时间线可虚拟化与分页，采用现有 diff/tool/approval 展示组件。目标和权限选择来自投影，统一操作错误和收据 |
| Workflow Workspace layout | 用同一 workspace shell 的 header、panel、focus 与权限行为，专属 view 读取各自 workflow DTO |
| CapabilityUnavailable | 已读写降级、登录要求、过期、上游无 feed 的状态说明，提供刷新、只读跳转或官方文档入口 |
| UI 插槽 | `composer.actions` / `composer.traits`、`session.sidebar.badge`、`inspector.tabs`、`chat.block`、`harness.settings` 等。首方共用 Native Runtime client。第三方 iframe 用获批的摘要能力及 iframe bridge。[当前公开插槽](../plugin-api/slots.md) |

列表没有信息时分别显示「尚未观察到活动」与「该来源不提供」。空列表一次读取不能证明已停止。所有模式共用版本化 status dictionary 和无障碍语义，颜色仅辅助。pending badge 可读、没有高频 aria-live 抖动。当视图上推入大量事件时批量处理，文本追加合并，长日志虚拟滚动，保持焦点和滚动锚点。后台标签关闭时取消网络细节拉取，保留必要的 runtime 概览订阅。用户选择收起能减少聊天密度。

## 验收流

1. 登录且有真实广告的模式，从聊天发起并能进入正确 Workspace。capability 变化、断网和账户切换能关闭过期 action。
2. 在有限后台期间可见等待，Stop 与原生权限可用。Prompt 返回后仍显示 active/unknown 的真实 work。无需用户补发消息即可看到 wake 的有效输出。
3. 从父 Agent 跳到确证的 child 并完成归属正确的审批。多个子任务与请求并行，重连仍可看时间线和已提交收据。
4. Swarm Board 缺 feed、Boost 缺 phases、Teamwork approval 不开放、Dynamic 没有 DAG 时分别走诚实降级。
5. App 与 CLI 对照侧重关键动作、状态与证据。快速交互、窄屏、主题、键盘、焦点回返和批量事件测试见 [测试策略](12_Test_Strategy.md)。
