# 02 · Native Parity Matrix

基准 2026-11-25，HarnessMate `0409bc8`、本机 AGY `1.5.16`、T3 `5ebb275`。共 69 项。三张视图通过同一 Capability ID 连接，按功能域分组。证据、ID 到任务与分级方法见 [官方研究](03_Official_Research.md)、[T3 Code](04_T3Code_Research.md)、[源码审计](05_Source_Audit.md)、[协议证据](06_Protocol_Evidence.md) 和 [任务分工](11_Parallel_Development_Plan.md)。

- Desktop 指独立 App，IDE 列注明独立 IDE、官方扩展或 ACP editor。✓ 为已文档声明，△ 为部分或有条件，? 为未知，— 表示该列未声明或该能力不适用。动态资格和组织开关以当前会话证据为准。
- **L0** 有官方来源。**L1** 本机官方二进制、握手或实际本地记录可发现。**L2** 已真实触发并保留可定位的证据。**L3** 后端生命周期、持久化、异常和所需控制通过（需对应 L2）。**L4** 真实状态的完整 UI 与支持的原生交互通过。**L5** Windows 真机与官方 App/CLI 交叉验收。仓库真实出处未完全可追的 fixture 只记回放覆盖，不抬升本机功能等级。
- **Unknown** 表示未获可用性或标准支持证据，**Unsupported** 表示当前公开能力/目标下不支持，**Upstream Limited** 表示官方端存在能力而 ACP 数据或动作受限，**Not Tested** 表示仍有该项的本机实际场景待执行。级别与标签可并列。
- **P0** 运行时正确性、身份与隔离，**P1** 直接专属能力，**P2** 扩展和证据驱动的后续适配，**P3** 明确适用端/上游限制和导航。任务编号是工作包依赖或验收所有者，合并依赖以 DAG 为准。


## 运行时、审批与工具

### 官方支持和入口

| Capability ID | 能力与官方描述 | Desktop | IDE / 扩展 | CLI | 原生触发及来源 |
| --- | --- | --- | --- | --- | --- |
| AGY-R01 | **握手与协议版本**。建立 stdio JSON-RPC，交换版本与会话能力 | — | ✓ ACP 客户端 | ✓ | 启动 agy acp / initialize。[acp](https://antigravity.google/docs/ide/extensions/acp/) · [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) · [ACP v2](https://agentclientprotocol.com/protocol/v2/migration) |
| AGY-R02 | **基本 Agent、流式消息和工具**。用户提交后接收回复、思考和工具结果 | ✓ | ✓ | ✓ | 文本、附件、工具调用。[features](https://antigravity.google/docs/features/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) |
| AGY-R03 | **Reactive Wakeup**。后台事件或子任务结束触发 AGY 原生继续 | ✓ | △ ACP host | ✓ | 非 daemon 有限后台完成等。[CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [CLI 1.5.10](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10) · [tools](https://antigravity.google/docs/tools/) |
| AGY-R04 | **有限后台命令**。异步 shell 可被 Agent 等待并在完成后返回 | ✓ | △ 工具 | ✓ | shell 原生后台化。[tools](https://antigravity.google/docs/tools/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [reference](https://antigravity.google/docs/cli/reference/) |
| AGY-R05 | **长驻 daemon**。dev server 或 watcher 在后台保留 | ✓ | △ 工具 | ✓ | 原生命令 daemon 模式。[tools](https://antigravity.google/docs/tools/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [CLI 1.5.10](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10) |
| AGY-R06 | **Mid-turn steering**。运行中发送另一条用户输入 | ✓ | △ ACP 依客户端 | ✓ | Send Now / 再发用户 prompt。[prompting](https://antigravity.google/docs/cli/prompting/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| AGY-R07 | **原生消息队列**。排队、立即发送和后台 hold | ✓ | ? | ✓ | Composer queue / Send Now。[using](https://antigravity.google/docs/cli/using/) · [remote-control](https://antigravity.google/docs/remote-control/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| AGY-R08 | **原生工具审批**。用户选 Agent 提供的权限决定 | ✓ | ✓ | ✓ | 工具 action 发出权限请求。[permissions](https://antigravity.google/docs/permissions/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-R09 | **原生结构化问题与表单**。用户单选、自定义或回答表单 | ✓ | ✓ 按 surface | ✓ | 原生交互请求。[grill-me](https://antigravity.google/docs/commands/grill-me/) · [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-R10 | **Stop 与安全收尾**。停止正在执行的对话或任务 | ✓ | ✓ | ✓ | 原生 Stop / Esc / ACP。[ACP v1](https://agentclientprotocol.com/protocol/v1/overview) · [CLI 1.5.10](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [using](https://antigravity.google/docs/cli/using/) |
| AGY-R11 | **ACP Client Terminal 与 AGY sandbox**。区分远端工具、客户端 terminal 和原生终端隔离 | ✓ | ✓ 部分 | ✓ | AGY 工具或 Client 能力。[sandbox](https://antigravity.google/docs/sandbox/) · [ACP Terminals](https://agentclientprotocol.com/protocol/v1/terminals) · [agent-settings](https://antigravity.google/docs/agent-settings/) |

### ACP、本地与版本边界

| Capability ID | ACP 触发 | ACP 实时状态 | 原生控制与交互 | 只读本地来源 | 限制与兼容 |
| --- | --- | --- | --- | --- | --- |
| AGY-R01 | ✓ v1 | `agentInfo` 与 capability | 选择可用 protocol | 无 | E02–E03 为 1.5.16 v1。v2 Preview |
| AGY-R02 | ✓ session/prompt | ✓ v1 chunks、tool patches | 取消和权限 | E06 conversation 历史形状 | 模型可不发 thought，音频未宣告 |
| AGY-R03 | △ 原生工具触发 | 1.5.10/15 release 声明，E07 待捕获 | 原生 cancel，勿补 prompt | E06 日志目录；当前无关联 | 具体复现端未定位，1.5.15 为版差 |
| AGY-R04 | △ tool invoke | tool patches 与 vendor IDs 待实录 | `/tasks` CLI，ACP 根 cancel | E06 tasks 目录，未知格式/状态 | 1.5.15 延长 prompt。命令失败、乱序待测 |
| AGY-R05 | △ tool invoke | `IsDaemon` 为候选 vendor 属性 | 根 cancel 与原生 manager | E06 tasks 候选 | 进程树归属、cancel/close 行为按版验 |
| AGY-R06 | △ AGY v1 1.5.0+ | 消息/tool stream，双 RPC | 用户主动 steer | 无已验独立来源 | 1.5.0+ 声明，旧 fixture 模拟 |
| AGY-R07 | ? ACP queue 控制 | 未见队列结构化 feed | App/CLI/Remote Control 原生动作 | 未验证 | daemon 与非 daemon 不同，依版本 |
| AGY-R08 | ✓ request_permission | ✓ 选项/pending | 按原 option ID 响应 | 无 | 1.5.16 修复子 Agent/Workflow 转发，空白未测 |
| AGY-R09 | △ AGY interaction，标准 elicitation 可选 | 权限包装兼容字段待实录 | 选择原生选项；free text 待证 | 无 | 1.5.16 转发修复，standard elicitation 未知 |
| AGY-R10 | ✓ session/cancel 通知 | 后续 tool state / stopReason | 根 cancel；child 须能力 | E06 样本无实时停止证据 | 方法无响应，1.5.10 与 1.5.15 行为改动 |
| AGY-R11 | △ ACP 可选 terminal | agent tool 和 ACP terminal 分开 | ACP terminal 须 advertised | 未验证 | Windows 1.4.4+ Auto/沙箱有条件 |

### 当前实现与验收

| Capability ID | T3 Code | HarnessMate / 前端 | 缺失与可行做法 | 优先级 / 工作包 | 当前等级 / 标签 | 下一步验收 |
| --- | --- | --- | --- | --- | --- | --- |
| AGY-R01 | T3 preview 连接可降级 | 严格 ACP 固定 v1。无独立诊断界面 | 补齐协商 DTO 与来源 | P0 · NP-02 / NP-15 | L2 · Not Tested | 重放 v1/v2 回复，拒绝未知版本 |
| AGY-R02 | 已维护 provider UI | S04 通用 ACP 基础。ChatStage 原生工具行 | 补齐消息分段、附件与思考证据 | P0 · NP-01 / NP-02 / NP-04 / NP-17 | L1 · Not Tested | 单 prompt 各 chunk 不丢失，录 App/CLI/ACP 同场景 |
| AGY-R03 | #38864 与 #38916 有 1.5.11 轨迹 | S04–S07 用轮次槽与布尔保活。晚帧可进空转 turn | 按 causal activity 与 bounded lease 修复 | P0 · NP-01 / NP-02 / NP-04 / NP-17 | L0 · Not Tested | 20s finite 后不发新 prompt，真实第二个工具和文本可见 |
| AGY-R04 | 按 taskId held run | S06 单布尔。后台卡 | 每 work 条目合并原始字段 | P0 · NP-01 / NP-04 | L0 · Not Tested | A/B 两任务逆序结束且成功/失败均准确 |
| AGY-R05 | 原生 daemon 不 hold，退出可续跑 | S06 daemon 也影响 TTL。同通用后台卡 | 不阻塞前台，独立运行与 Stop | P0 · NP-01 / NP-04 / NP-15 | L0 · Not Tested | 证明 turn 结束、daemon 仍活跃且显式关停可观测 |
| AGY-R06 | 有 concurrent prompt 和测试 | S04 效果受版本 gate。S19 和提示 | 按 RPC origin 捕获，保持后端并行正确 | P0 · NP-01 / NP-04 / NP-06 | L0 · Not Tested | Steer 两次乱序响应，旧任务不被取消 |
| AGY-R07 | T3 通用发送队列，原生队列不等价 | 即时 steering 部分。无原生队列 | 用确定的用户动作及原生收据 | P1 · NP-01 / NP-04 / NP-06 | L0 · Unknown | 并行后台+队列 hold 与 Send Now 原生序列 |
| AGY-R08 | 有主轮次与轮次外审批 | S08、S18，轮次外或非当前根 session 的请求会被 AGY 适配层取消。Approval Center 为通用界面 | 正确的请求作用域和可核实收据 | P0 · NP-01 / NP-02 / NP-07 | L0 · Not Tested | 轮次外、child、重复、过期与重连必须正确 |
| AGY-R09 | T3 支持可用选项，禁止伪造 free text | S08 interaction_* + 回退首项。有 UserQuestion | 规范化表单和专用可表达文本 | P0 · NP-01 / NP-07 | L0 · Not Tested | 验证准确所选 option 或表单，覆盖 native unknown child |
| AGY-R10 | 1.5.11 两类 Stop 体验 | S04 本地立即结算。通用 Stop | 取消区分 requested/confirmed/unknown | P0 · NP-04 / NP-05 / NP-07 / NP-15 | L0 · Not Tested | 同轮、轮后、child 与 transport exit 分层校验 |
| AGY-R11 | T3 有 provider terminal/工具投影 | S02 明示 terminal:false，有 HM PTY。通用工具 / 终端 | 沿用 AGY 自有终端，不开启未实现的 terminal bridge | P1 · NP-02 / NP-04 / NP-16 | L0 · Not Tested | 确认 terminal:false 仍能运行 AGY 工具与原生审批 |


## 原生工作流与专属视图

### 官方支持和入口

| Capability ID | 能力与官方描述 | Desktop | IDE / 扩展 | CLI | 原生触发及来源 |
| --- | --- | --- | --- | --- | --- |
| AGY-W01 | **Subagents 与 parent/child**。独立 Agent 被委派、执行、idle 再唤醒 | ✓ | ✓ 原生功能有差异 | ✓ | 模型委派或有效 @agent。[subagents](https://antigravity.google/docs/subagents/) · [ACP child](https://agentclientprotocol.com/protocol/v1/subagents) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-W02 | **Native Agent Manager**。查看和控制原生 Agent 与其活动 | ✓ | △ 原生面板 | ✓ | App child panel / CLI /agents。[subagents](https://antigravity.google/docs/subagents/) · [agents](https://antigravity.google/docs/cli/commands/agents/) |
| AGY-W03 | **Custom Agents**。发现自定义 Markdown 角色，新会话选择 Agent | ✓ | ✓ 支持范围依 surface | ✓ | `agy agents`、`--agent`、`/agents`。[subagents](https://antigravity.google/docs/subagents/) · [agents](https://antigravity.google/docs/cli/commands/agents/) · [customization-discovery](https://antigravity.google/docs/customization-discovery/) |
| AGY-W04 | **Swarm**。Coordinator、实名 Workers 与 verifier 协作 | ✓ | — | ✓ | `/swarm <task>`。[swarm](https://antigravity.google/docs/swarm/) · [slash-commands](https://antigravity.google/docs/slash-commands/) |
| AGY-W05 | **Swarm Board、帖子与 mentions**。查看协作状态、线程与系统唤醒 | ✓ | — | ✓ | `/swarm board` / Alt+S / App。[swarm](https://antigravity.google/docs/swarm/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-W06 | **Boost**。按需实现、挑战、修复和独立验证 | ✓ | △ Slash Overview 列扩展 | ✓ | `/boost <task>`。[boost](https://antigravity.google/docs/boost/) · [slash-commands](https://antigravity.google/docs/slash-commands/) |
| AGY-W07 | **Teamwork**。访谈、Prompt Artifact、项目及多级里程碑审计 | ✓ | △ Slash Overview 列扩展 | ✓ | `/teamwork <goal>`。[teamwork](https://antigravity.google/docs/teamwork/) · [slash-commands](https://antigravity.google/docs/slash-commands/) |
| AGY-W08 | **Dynamic Workflows**。原生批准脚本、phase、并行 Agent 与结构结果 | ✓ | — | ✓ | `/run-workflow <task>`。[dynamic-workflows](https://antigravity.google/docs/dynamic-workflows/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-W09 | **Goal**。目标核验完成前持续工作 | ✓ | ✓ 扩展 | ✓ | `/goal <objective>`。[goal](https://antigravity.google/docs/commands/goal/) · [slash-commands](https://antigravity.google/docs/slash-commands/) |
| AGY-W10 | **Schedule 与定时唤醒**。单次或 cron 在同会话按时触发 | ✓ | ✓ 扩展 | ✓ | `/schedule <when> <task>`。[schedule](https://antigravity.google/docs/commands/schedule/) · [slash-commands](https://antigravity.google/docs/slash-commands/) |
| AGY-W11 | **Native Tasks 管理**。查看后台命令、调度、工作流与日志 | △ App 有分散入口 | ? | ✓ | `/tasks` / Ctrl+T。[reference](https://antigravity.google/docs/cli/reference/) · [dynamic-workflows](https://antigravity.google/docs/dynamic-workflows/) · [schedule](https://antigravity.google/docs/commands/schedule/) |
| AGY-W12 | **App Automations**。跨会话持续计划，每次新会话 | ✓ | — | — 划为 App | `/automation` 或 Automations tab。[automation](https://antigravity.google/docs/commands/automation/) · [sidecars](https://antigravity.google/docs/sidecars/) |
| AGY-W13 | **Plan 与执行步骤**。计划、步骤清单和审阅准备 | ✓ | ✓ | ✓ | `/plan` 或 native mode。[plan](https://antigravity.google/docs/plan/) · [implementation-plan](https://antigravity.google/docs/implementation-plan/) · [ACP Plan](https://agentclientprotocol.com/protocol/v1/agent-plan) |
| AGY-W14 | **Artifacts、审阅与行级反馈**。读取、逐行评论与批准产物 | ✓ | ✓ 随 UI | ✓ | Artifact tab/`/artifact`。[artifacts](https://antigravity.google/docs/artifacts/) · [artifact-review](https://antigravity.google/docs/artifact-review/) · [artifacts](https://antigravity.google/docs/cli/artifacts/) |
| AGY-W15 | **Diff 与变更审阅**。文件、turn、提交变更可审阅 | ✓ | ✓ | ✓ | Diff 面板 / `/diff`。[review-changes](https://antigravity.google/docs/review-changes/) · [diff](https://antigravity.google/docs/cli/commands/diff/) · [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) |
| AGY-W16 | **Browser Agent**。子 Agent 浏览并产生测验/截图结果 | ✓ | ✓ | ✓ | `/browser` 或内嵌 Agent 委派。[browser](https://antigravity.google/docs/browser/) · [browser](https://antigravity.google/docs/ide/browser/) |
| AGY-W17 | **Grill Me 设计访谈**。逐个收集与建议用户选择 | ✓ | ✓ 扩展 | ✓ | `/grill-me`。[grill-me](https://antigravity.google/docs/commands/grill-me/) · [slash-commands](https://antigravity.google/docs/slash-commands/) |

### ACP、本地与版本边界

| Capability ID | ACP 触发 | ACP 实时状态 | 原生控制与交互 | 只读本地来源 | 限制与兼容 |
| --- | --- | --- | --- | --- | --- |
| AGY-W01 | △ 可观察的 native launch 待验 | 标准 child 可选，AGY 尚无报文 | 只有证实的 child cancel 或原生 UI | E06 App JSON，ACP 未证 | 1.5.16 子请求修正；不能推断 v1 扩展实际使用 |
| AGY-W02 | ? GUI/TUI 管理入口未证 | child events 未确认 | 如有 native cancel；无统一 steer API | E06 App records | 结构化 ACP 受 upstream 约束 |
| AGY-W03 | ? ACP --agent 帮助可见，切换 RPC 未知 | 会话启动实录待验 | 官方选择可建 fork | 已知文档目录，未扫描内容 | 同名优先级、角色与模型/计划可变 |
| AGY-W04 | ? ACP live trigger 未实录 | coordinator 通用流，worker feed 未证 | 原生 Board/mention，ACP 控制未证 | 无当前验证的 Board 源 | Preview 所有计划，组织可禁 |
| AGY-W05 | ? 管理入口 | 未见标准事件 | TUI 交互有，ACP 未证 | E06 未验证，勿猜路径 | 1.5.16 系统 attribution 修复未发布 feed |
| AGY-W06 | ? scope 必须验证 | 无公开 ACP stages | 审批/根取消可复用，专项未知 | 无已验证 | 付费，模型与账号广告 |
| AGY-W07 | ? 同 ACP session 未实录 | 表单与 artifact 证据需采 | 原生先审批，ACP action 未证 | 官方专属项目目录，尚无关联 | 付费及早期 preview 命名差异 |
| AGY-W08 | ? 需录命令及脚本批准 | 原生事件不保证完整 DAG | 工具审批/问题；其他未知 | 无已验证 | App/CLI 全计划，1.5.16 修请求 |
| AGY-W09 | △ 仓库广告，实际路由用 quick CLI | AGY goal 工具投影候选 | 原生 follow-up/cancel，ACP CRUD 未见 | E06 未证单源 | E05 有目录，非当前真机 entitlement |
| AGY-W10 | ? 原生命令实录待采 | E05 有 DurationSeconds 字段形状 | CLI Tasks 与 Agent 取消；ACP 待证 | E06 tasks 样本无时序 | 配置时区、重启及多个触发需验 |
| AGY-W11 | ? TUI manager | ACP 普通工具输出不保证全列表 | 日志、输入、取消取真实动作 | E06 tasks 目录样本，只读关联待验 | 工具 patch、handoff 和 watch 有版本问题 |
| AGY-W12 | 无公开方法 | 无已证 feed | 官方暂停/启动，ACP 无 | 文档有 Sidecar，未读实装 | 无人值守与权限，受 App 版本限制 |
| AGY-W13 | △ ACP config/plan 可承载 | plan update 与 AGY update_steps | 原生权限/审核，逐项证据待验 | E06 Artifact 目录可候选 | 区分标准 plan 与 Vendor 工具 |
| AGY-W14 | △ ACP 标准无完整 review | 普通工具产物/diff，review feed 未证 | 原生评论/approve 需 wire 证据 | S21/evidence 已有路径候选，未验真实产物 | ACP 标准与 TUI 控制不同 |
| AGY-W15 | ✓ v1 tool diff 内容 | ACP diff chunk | 审批 / 原生评审待证 | 工作区 Git 可只读，非原生评论 | workspace/file scope |
| AGY-W16 | ? AGY command/普通工具可见性待实证 | 标准 ACP 无浏览器专属 UI feed | 浏览器操作经原生权限 | 截图/录屏有官方产物，未验匹配 | 个人 App v2.30+ 内嵌，其他 Chrome 144+ 及管理员限制 |
| AGY-W17 | ? 原生触发待实录 | 真实问题与回执 | 选择/自由文本依 wire | 无 | 模型/session 广告待验证 |

### 当前实现与验收

| Capability ID | T3 Code | HarnessMate / 前端 | 缺失与可行做法 | 优先级 / 工作包 | 当前等级 / 标签 | 下一步验收 |
| --- | --- | --- | --- | --- | --- | --- |
| AGY-W01 | T3 有只读 batch 与 native reader | S06/S09 标题识别与错误 ID 假设。batch 展开卡 | 稳定映射、child scope、独立轨迹 | P0 · NP-01 / NP-04 / NP-05 / NP-07 | L1 · Unknown, Not Tested | 真实 batch/tool/child/approval 同场景关联，child idle 后再唤醒 |
| AGY-W02 | T3 只读，单 child 控制有限 | 有 list/detail，错配风险。折叠子卡 | 实现 manager + parent navigation | P1 · NP-03 / NP-05 / NP-07 | L1 · Upstream Limited, Not Tested | 从主会话跳真实子 timeline，禁止不可用的 Stop |
| AGY-W03 | 有启动/配置组合，完整管理未核实 | 当前无专属入口。AGY 设置和生态摘要 | 读取可验证 catalog，显式切换语义 | P1 · NP-06 / NP-13 | L1 · Not Tested | 本机已验证目录先后，换 Agent 的会话身份核实 |
| AGY-W04 | #39503 payload 不全 | 无专属路由和 observer。无 Studio | 先触发与协调者状态，再步进 worker | P1 · NP-04 / NP-05 / NP-06 / NP-07 / NP-08 | L0 · Upstream Limited, Not Tested | 真实启动一个小 worker，对照 coordinator 与 Board |
| AGY-W05 | 讨论有 UX prototype | 当前未适配。无 Board | 有结构化/只读源则实现；其余降级 | P1 · NP-05 / NP-08 | L0 · Upstream Limited, Not Tested | 同一 worker 线程、帖子、状态与源配对，缺证 UI 禁控制 |
| AGY-W06 | 通用 child 路线，未阅完整 Studio | 当前未适配。无 Studio | 真触发与阶段证据才渲染 | P1 · NP-04 / NP-05 / NP-06 / NP-07 / NP-09 | L0 · Upstream Limited, Not Tested | 用低成本原生 Boost 真跑，缺阶段按通用轨迹 |
| AGY-W07 | 未见完整 Teamwork UI | 当前未适配。无 Studio | 按实际访谈与里程碑证据做项目视图 | P1 · NP-04 / NP-05 / NP-06 / NP-07 / NP-10 / NP-14 | L0 · Upstream Limited, Not Tested | 识别真实 scoping，Artifact 批准路由和最小里程碑 |
| AGY-W08 | 未见专项 phase 视图 | 当前未适配。无 Studio | 只展示观察到的 phase 与实际结果 | P1 · NP-04 / NP-05 / NP-06 / NP-07 / NP-11 | L0 · Upstream Limited, Not Tested | 采并行两节点的真实 phase、日志和结构结果 |
| AGY-W09 | 有 slash，未支持 goal status/controls | S12 现有 Goal 隔离进程。ext:agy.goal_status | 走同一 live runtime，关联证据和终态 | P1 · NP-04 / NP-06 / NP-12 | L0 · Not Tested | 原生 start、阶段、终态或取消，复现不损同会话 |
| AGY-W10 | T3 有时间保持测试 | S06 背景卡片粗略。无 occurrence | 区分 pending/fired、可跨用户轮次 | P1 · NP-01 / NP-04 / NP-06 / NP-12 / NP-15 | L0 · Not Tested | 短单次在主轮次结束后起真实 activity，复核 reboot |
| AGY-W11 | 有待工作摘要 | S06 若识别有限可见。后台块 | Runtime Center 聚合证据，不从 shell 输出猜状态 | P1 · NP-03 / NP-04 / NP-12 | L1 · Upstream Limited, Not Tested | 有限/daemon/任务三类独立过滤，同一 task log 能分页 |
| AGY-W12 | 未见 | HM 自有功能另计。无接口 | 官方 App 管理入口说明，独立验证 | P2 · NP-12 / NP-13 | L0 · Unsupported, Upstream Limited | 核实官方 App 支持路径，HM 不代跑 |
| AGY-W13 | 能用原生 Plan，T3 checklist | 已有 plan config 与事件 S06/20。计划卡 | 统一 plan tracking，审核单独能力 | P1 · NP-04 / NP-06 / NP-14 | L0 · Not Tested | 实际 Plan mode、steps 和退出后恢复权限 |
| AGY-W14 | T3 通用 artifacts / diff 与 html_render | 现有只读 API。只读 panel | 保持只读，提高交互以协议门控 | P1 · NP-07 / NP-14 | L0 · Upstream Limited, Not Tested | 真实产物读取与内容安全；支持控制时逐行评论可回放 |
| AGY-W15 | 已有 diff projection | 通用 diff 与 Checkpoints。现有 inspector | 验证真实 AGY 输出及原生反馈限制 | P1 · NP-07 / NP-14 | L0 · Not Tested | 真实编辑 diff、拒批与原生 artifact action 区分 |
| AGY-W16 | 通用工具部分 | 无 AGY runtime 专属。通用结果 | 观察 browser child 与产物，保留官方入口 | P2 · NP-05 / NP-07 / NP-14 | L0 · Upstream Limited, Not Tested | 同场景 Chrome DevTools 与内嵌 Browser 区分，禁止伪造 live view |
| AGY-W17 | 有 question cards | S08 问题部分。通用审批/提问 | 原生访谈按请求实体展示 | P2 · NP-06 / NP-07 | L0 · Not Tested | 记录一题一答以及退出访谈 |


## 会话、项目与配置

### 官方支持和入口

| Capability ID | 能力与官方描述 | Desktop | IDE / 扩展 | CLI | 原生触发及来源 |
| --- | --- | --- | --- | --- | --- |
| AGY-S01 | **会话列表与历史**。发现、分栏和查看原生会话记录 | ✓ | ✓ 各自历史 | ✓ | picker / ACP session list。[conversations](https://antigravity.google/docs/cli/conversations/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [ACP Setup](https://agentclientprotocol.com/protocol/v1/session-setup) |
| AGY-S02 | **Session Resume / load**。按 ID 情况恢复、不重播或重播历史 | ✓ | ✓ | ✓ | `session/resume`、`session/load` 或 `-r`。[acp](https://antigravity.google/docs/ide/extensions/acp/) · [resume](https://antigravity.google/docs/cli/commands/resume/) · [ACP Setup](https://agentclientprotocol.com/protocol/v1/session-setup) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| AGY-S03 | **Crash/重启恢复**。重连时还原原生运行时活性 | △ 原生自有恢复 | △ 按客户端 | △ | 重启 / attach / resume。[CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) · [ACP Setup](https://agentclientprotocol.com/protocol/v1/session-setup) · [ACP v2](https://agentclientprotocol.com/protocol/v2/migration) |
| AGY-S04 | **原生 Fork / branch**。复制对话成为并行新会话 | △ App 按版 | ? | ✓ | `/fork`、`/branch`。[conversations](https://antigravity.google/docs/cli/conversations/) · [reference](https://antigravity.google/docs/cli/reference/) · [features](https://antigravity.google/docs/features/) |
| AGY-S05 | **原生 Rewind / undo**。回退原生对话状态 | △ 交互依版本 | ? | ✓ | `/rewind` / `/undo`。[reference](https://antigravity.google/docs/cli/reference/) · [conversations](https://antigravity.google/docs/cli/conversations/) |
| AGY-S06 | **原生 Side Conversation / btw**。侧问使用快照并独立运行 | ✓ | △ Slash Overview 扩展 | ✓ | `/btw <question>`。[btw](https://antigravity.google/docs/commands/btw/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| AGY-S07 | **Projects 与工作区设置**。按 project 组织多目录/权限/历史 | ✓ | △ 编辑器 workspace | ✓ | `/projects`、`--project`、`--new-project`。[projects](https://antigravity.google/docs/projects/) · [reference](https://antigravity.google/docs/cli/reference/) |
| AGY-S08 | **Additional Directories**。在一个会话声明多个授权根 | ✓ | ✓ 多根编辑器 | ✓ | `--add-dir` 或 negotiated payload。[projects](https://antigravity.google/docs/projects/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [ACP Setup](https://agentclientprotocol.com/protocol/v1/session-setup) |
| AGY-S09 | **Compaction 与 context**。总结当前上下文并观察窗口消耗 | ✓ compaction | △ | ✓ | `/compact`、`/context`。[compact](https://antigravity.google/docs/commands/compact/) · [context](https://antigravity.google/docs/cli/commands/context/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| AGY-S10 | **模型与实际可用性**。模型列表、每会话/单轮设定 | ✓ | ✓ 第三方模型仅指定编辑器 | ✓ | `/model`、`agy models`、config option。[models](https://antigravity.google/docs/models/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [reference](https://antigravity.google/docs/cli/reference/) |
| AGY-S11 | **Native Orchestrator 模型**。Planner/Executor 双角色与各自设置 | ✓ | △ 依 model/配置 | ✓ | `/model` Orchestrator 与设置。[models](https://antigravity.google/docs/models/) · [features](https://antigravity.google/docs/features/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| AGY-S12 | **Thinking Level / Effort**。选择当前模型允许的思考强度 | ✓ | ✓ 分 editor/model | ✓ | `/effort` 或 config option。[effort](https://antigravity.google/docs/cli/commands/effort/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [models](https://antigravity.google/docs/models/) |
| AGY-S13 | **Permission Modes 与授权规则**。default/plan/accept-edits/auto，文件和命令规则 | ✓ | ✓ 按 surface | ✓ | App/CLI Settings、`/permissions`。[agent-settings](https://antigravity.google/docs/agent-settings/) · [permissions](https://antigravity.google/docs/permissions/) · [permissions](https://antigravity.google/docs/cli/commands/permissions/) |
| AGY-S14 | **认证、登出和账户**。官方 OAuth、API key 与 Enterprise 路径 | ✓ | ✓ 依客户端 | ✓ | 官方登录/登出，HM 手动 profile。[acp](https://antigravity.google/docs/ide/extensions/acp/) · [workspace](https://antigravity.google/docs/workspace/) · [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) · [#1610](https://github.com/google-antigravity/antigravity-cli/issues/1610) |
| AGY-S15 | **Usage、配额与刷新**。原生模型用量、context 与额度视图 | ✓ 用量视图 | △ 指定 IDE | ✓ | `/usage` / `/quota`。[usage](https://antigravity.google/docs/cli/commands/usage/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) · [slash-commands](https://antigravity.google/docs/slash-commands/) |
| AGY-S16 | **Credits、付费与计划**。查看额度、购买入口与计划权限 | ✓ 计划/账单 | ? | ✓ | `/credits`、官方设置。[credits](https://antigravity.google/docs/cli/commands/credits/) · [plans](https://antigravity.google/docs/plans/) · [pay-as-you-go](https://antigravity.google/docs/pay-as-you-go/) |

### ACP、本地与版本边界

| Capability ID | ACP 触发 | ACP 实时状态 | 原生控制与交互 | 只读本地来源 | 限制与兼容 |
| --- | --- | --- | --- | --- | --- |
| AGY-S01 | △ 1.5.16 声明 list | 历史 replay 或已验证 reader | 原生打开；删除单独能力 | E06 三数据目录；S10 有 reader | App/IDE 同步未承诺，#1830 |
| AGY-S02 | △ 本机 capability 探测 | v1 load 会重放，resume 无历史 | 连接/关闭按 scope | E06 .db 目录，未开 SQLite | 1.5.15 replay 修正，1.5.16 CLI 别名 |
| AGY-S03 | △ v1 可重新连接 | 1.5.15 允许新请求，v2 有 replay 设计 | 同 profile 恢复，旧权限不可重放 | 历史最后观测，未来有界补源 | 没有普遍 survive process 保证 |
| AGY-S04 | ? 1.5.16 未识别方法 | 新 session 真实 ID 待验 | 原生控制，ACP 未证 | E06 文件无法证明 fork relation | 不得视 Context Handoff 等价 fork |
| AGY-S05 | ? 未证 | 无已知原生 replay control | 官方 TUI；ACP 版本能力待验 | 历史 .db 非控制接口 | 文件、聊天回滚与分支保留语义不同 |
| AGY-S06 | ? 无专门方法证明 | side card 或独立 fork 未见 ACP | TUI Esc，App tab 或新会话 | E06 未证 | App 本地 v2.32+，旧/remote 单次 |
| AGY-S07 | ? ACP project API 未证 | setup cwd，project 对象未见 | GUI/TUI 管理 | 文档路径，未读私有 project files | remote 与 local 同名不等价 |
| AGY-S08 | △ 声明 E02，wire 效果未验 | v1 及 v2 schema 注意差异 | setup 或来源允许的管理动作 | 配置路径，仅有产品约定 | 隔离与 symlink/root 越界需测试 |
| AGY-S09 | △ slash 部分版本 | usage_update、上下文与 compaction extension | 原生 config 和 prompt 逐项验 | 历史锚点，未证实 | 1.5.15 自动阈值变化 |
| AGY-S10 | △ ACP options 登录后 | 配置和 current value | 已声明 config 可设 | 官方 settings 文件，未读值 | E04 未登录，计划/账号/客户端模型差异 |
| AGY-S11 | ? 各字段及控制待录 | 支持的 metadata 与 config | 原生选择/effort，只能确认受支持字段 | 设置可读候选，未读取 | Pro/Ultra/符合条件计划，Enterprise 固定组合 |
| AGY-S12 | △ config 规范与旧夹具 | 完整 options update | set_config_option 按广告 | 无单独验证 | 不同模型、版本和 tier |
| AGY-S13 | △ v1 modes/config | confirmed mode 有限 | set_mode/options，规则 CRUD 未见 | 文档设置文件；无本轮私有修改 | Auto Windows 1.4.4+ 受 sandbox 与账号影响 |
| AGY-S14 | ✓ initialize 声明四种，负例 E02 | 仅 auth status/官方选项，不可公开凭据 | 用户手动操作；已有安全路由 | 配置隔离，未读 token | oauth-business、Windows 和 shared keyring 版差 |
| AGY-S15 | △ usage_update 和独立官方 CLI | 采样/模型组和 context 区分 | 只读查询 | E05 context fields | 账户级需实际登录，1.5.16 长轮刷新变化 |
| AGY-S16 | 无交易 API 证据 | tier metadata 非支付数据 | 仅官方入口 | 无 | 计划、地区、管理员可变 |

### 当前实现与验收

| Capability ID | T3 Code | HarnessMate / 前端 | 缺失与可行做法 | 优先级 / 工作包 | 当前等级 / 标签 | 下一步验收 |
| --- | --- | --- | --- | --- | --- | --- |
| AGY-S01 | 支持 provider 会话管理 | 已有导入和 Session Explorer。通用历史与 App/CLI 来源 | 绑定验证和分页 | P1 · NP-02 / NP-15 | L1 · Not Tested | 同 profile 列表、导入并重放原始历史 |
| AGY-S02 | T3 按协议分 load/resume | S10 有 attach 及 replay idle。通用历史入口 | 区分 passive history 和 active attach | P0 · NP-02 / NP-15 | L1 · Not Tested | 长历史与 startup config、主动 attach 后 pending 真实送达 |
| AGY-S03 | T3 有 snapshot 和 fallback | S15 一律 stale→idle。通用重启 | 原生 reconcile/stale、掉线可诊断 | P0 · NP-02 / NP-04 / NP-05 / NP-07 / NP-15 | L1 · Not Tested | 杀 worker、daemon crash、前端 reload、断网后无假终态 |
| AGY-S04 | T3 有编辑后的新会话适配 | HM 自有 fork 路径。通用 Fork | 展示 provenance 与新会话关联 | P2 · NP-06 / NP-15 | L0 · Unknown, Not Tested | CLI/ACP 对照新 native ID 与共享/继承历史 |
| AGY-S05 | T3 从旧用户 Prompt 编辑走新会话 | HM rollback/checkpoint 另计。通用时间线 | 缺源时使用官方入口 | P2 · NP-06 / NP-15 | L0 · Upstream Limited, Not Tested | 确认是否只改对话、如何影响 diff 后决定 expose |
| AGY-S06 | 未确认 | HM Side Chat 自有。无 AGY Native | 只在独立真实 ID 后另映射 | P2 · NP-05 / NP-06 / NP-15 | L0 · Upstream Limited, Not Tested | 主对话不被写入，side response 未误归 main |
| AGY-S07 | T3 有自身 Project 概念 | HM workspaces 独立。通用项目侧栏 | 关联入口与身份须官方证据 | P2 · NP-06 / NP-13 / NP-15 | L1 · Upstream Limited, Not Tested | 确认 scope；不向原生项目文件写入 |
| AGY-S08 | T3 有 scoped client roots | Profile 配置可见，启动链路需验。设置可见性依来源 | 按作用域验证每根真实生效 | P1 · NP-02 / NP-13 / NP-15 / NP-16 | L1 · Not Tested | 实际读取额外根、拒绝未授权路径、child 不提升权限 |
| AGY-S09 | T3 native compact 广告门控 | 独立 CLI 与历史通用压缩。Usage 与上下文既有 | 附带连接、真实压缩水位可验证 | P2 · NP-06 / NP-13 / NP-15 | L0 · Not Tested | 确认原生 compaction 与 HM compression 各自来源 |
| AGY-S10 | provider catalog 和 model 控件 | S11 三层配置模型。Dashboard/Composer 模型 | 从 capability 真实选项计算 gating | P1 · NP-06 / NP-13 | L1 · Not Tested | 取一份 authorized config snapshot，模型切换得到确认 |
| AGY-S11 | 有 provider metadata | AGY-3 已有 metadata。S20 Orchestrator 标签 | 提供角色细节与约束来源 | P1 · NP-06 / NP-13 | L0 · Not Tested | 选择/恢复同会话的真实 planner/executor，对照 App |
| AGY-S12 | T3 按模型提供 picker | AGY-3 动态缓存和还原。Composer effort | 按 actual 最新选项和 scope 路由 | P1 · NP-06 / NP-13 | L1 · Not Tested | 按模型校验允许级别及预设还原 |
| AGY-S13 | T3 policy ceiling | AGY-3 client_guard。通用设置与 guard提示 | 显示服务端 effective/宿主 cap，保留用户批准 | P0 · NP-02 / NP-06 / NP-07 / NP-13 | L1 · Not Tested | 未广告 auto 不虚构，权限拒绝不降级绕过 |
| AGY-S14 | #39485 profile 兼容 | AGY-2 账户与手动切换。Settings/Usage Center | 保留隔离，验证所有入口；不自动换号 | P0 · NP-02 / NP-13 / NP-15 / NP-16 | L1 · Not Tested | 用户授权选单一测试账号；登录和退出确认，其他 Profile 无受扰 |
| AGY-S15 | T3 有 usage reader | AGY-2 独立查询和静默 quota。Usage Center | 区分 context / billing；查询必须 scope | P1 · NP-06 / NP-13 / NP-16 | L0 · Not Tested | 同一授权 instance 的配额与模型组核对，scope 错配返回错误 |
| AGY-S16 | 有 tier 信息，交易未核实 | AGY-3 单 tier 摘要。无购买 | 读资格/跳官方，交易留官方 | P2 · NP-06 / NP-13 | L0 · Upstream Limited, Not Tested | 误配 entitlement 不启用模式，官方入口当前可用 |


## 生态与扩展

### 官方支持和入口

| Capability ID | 能力与官方描述 | Desktop | IDE / 扩展 | CLI | 原生触发及来源 |
| --- | --- | --- | --- | --- | --- |
| AGY-E01 | **Skills 与全局发现**。加载、查询与调用 Agent Skills | ✓ | ✓ | ✓ | `/skills`、`/skills reload`、命令/提及。[skills](https://antigravity.google/docs/skills/) · [customization-discovery](https://antigravity.google/docs/customization-discovery/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-E02 | **Rules 与 AGENTS.md/GEMINI.md**。持久工作区或用户约束 | ✓ | ✓ | ✓ | 配置文件/Settings。[rules](https://antigravity.google/docs/rules/) · [customization-discovery](https://antigravity.google/docs/customization-discovery/) · [#1540](https://github.com/google-antigravity/antigravity-cli/issues/1540) |
| AGY-E03 | **Hooks**。原生工作区/全局生命周期 hooks | ✓ | △ lifecycle 差异 | ✓ | `/hooks`、hooks.json。[hooks](https://antigravity.google/docs/hooks/) · [reference](https://antigravity.google/docs/cli/reference/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| AGY-E04 | **AGY Plugins**。安装、启停、列出 AGY 插件 | ✓ | ✓ 部分 | ✓ | `/plugin` / `agy plugin`。[plugins](https://antigravity.google/docs/plugins/) · [reference](https://antigravity.google/docs/cli/reference/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-E05 | **MCP 连接**。列出、管理与使用 MCP servers/tools | ✓ | ✓ | ✓ | `/mcp`、`agy mcp` 或 session setup。[mcp](https://antigravity.google/docs/mcp/) · [reference](https://antigravity.google/docs/cli/reference/) · [ACP Setup](https://agentclientprotocol.com/protocol/v1/session-setup) |
| AGY-E06 | **MCP Apps**。原生 iframe 工具 UI 和插件面板 | ✓ | — | — | MCP tool widget 或 App guide。[mcp-apps](https://antigravity.google/docs/mcp-apps/) · [mcp-app-development](https://antigravity.google/docs/commands/mcp-app-development/) |
| AGY-E07 | **Learn / 配置发现**。生成并审查规则/Skills 改动方案 | ✓ | ✓ 扩展 | ✓ | `/learn`、`agy-customizations`。[learn](https://antigravity.google/docs/commands/learn/) · [agy-customizations](https://antigravity.google/docs/commands/agy-customizations/) · [customization-discovery](https://antigravity.google/docs/customization-discovery/) |
| AGY-E08 | **Sidecars 与 agentapi**。App 自管后台进程及其官方本地 API | ✓ | — | — agy CLI 面不同 | Sidecar manifest / App UI。[sidecars](https://antigravity.google/docs/sidecars/) · [automation](https://antigravity.google/docs/commands/automation/) |
| AGY-E09 | **Antigravity SDK / Personas (旁系)**。官方可编程运行时、工具、结构结果 | — Antigravity SDK 单独 | — | — | 官方 SDK 入口。[overview](https://antigravity.google/docs/sdk/overview/) · [personas](https://antigravity.google/docs/sdk/personas/) · [subagents](https://antigravity.google/docs/sdk/subagents/) · [structured-output](https://antigravity.google/docs/sdk/structured-output/) |
| AGY-E10 | **Marketplace 与 Build with Google**。发现集成并安装官方或第三方插件 | ✓ | △ 官方扩展范围 | △ CLI 插件入口 | App Marketplace / plugin manager。[marketplace](https://antigravity.google/docs/marketplace/) · [build-with-google](https://antigravity.google/docs/build-with-google/) · [plugins](https://antigravity.google/docs/plugins/) |

### ACP、本地与版本边界

| Capability ID | ACP 触发 | ACP 实时状态 | 原生控制与交互 | 只读本地来源 | 限制与兼容 |
| --- | --- | --- | --- | --- | --- |
| AGY-E01 | △ 广告/加载依实现 | ACP 跨 scope catalog 未证 | 原生 reload 逐版本验 | 文档路径；源码有 scanner/sync | 1.5.16 全局 .agents/skills，其优先级低于 .gemini |
| AGY-E02 | ? #1540 ACP Rule 读取缺陷报告 | 无标准 Rules feed | 原生文档支持，不加 systemPrompt | 官方布局、HM 同步逻辑 | 未确认本机 ACP runtime 是否应用 |
| AGY-E03 | ? 不提供 CRUD | 无标准 hook feed | 原生管理，严格权限 | 文档目录，只读候选 | 组织禁用、事件名和作用域版差 |
| AGY-E04 | △ 官方 CLI 子命令；ACP TUI 未证 | 非标准 plugin 列表 | 原生 CLI 明确操作及确认 | 文档路径和 HM 生态视图 | 1.5.16 managed plugin controls 改动 |
| AGY-E05 | △ ACP 可选类型，E02 无 mcpCapabilities | 工具和真实 server 状态分别验证 | 只有已宣告类型和管理入口 | scope 配置已文档，未读密钥 | process-per-session 影响 HTTP editor 注入 |
| AGY-E06 | 无 AGY ACP view schema | 工具结果如有，界面 feed 未证 | MCP App 协议与 App UI | 已文档 manifest 约定，未验 | App 渲染方式、CSP 和来源明确限制 |
| AGY-E07 | ? command 及 schema 待验 | 可能显示工具和方案 | 用户确认应用方案 | 官方目录，纯读取候选 | 受 native config policy |
| AGY-E08 | 无标准 ACP interface | App 侧进程/自有日志 | App lifecycle 控制 | 官方路径文档，未审实机 | 权限、用户驱动限制，非 ACP API |
| AGY-E09 | 与 agy acp 分离 | SDK API，ACP 不复用 | SDK 自有 | 无 | 独立 SDK 的权限与发行条件 |
| AGY-E10 | 未见原生 ACP market API | 后台与扩展 v1 无列表规范 | 原生管理、组织权限 | 无已验 | 组织和账户、付费计划差异 |

### 当前实现与验收

| Capability ID | T3 Code | HarnessMate / 前端 | 缺失与可行做法 | 优先级 / 工作包 | 当前等级 / 标签 | 下一步验收 |
| --- | --- | --- | --- | --- | --- | --- |
| AGY-E01 | T3 有 skills catalog，当前文档滞后 | 现有 /skills 与目录同步。生态快照 | 统一作用域、保留厂商先后 | P1 · NP-06 / NP-13 / NP-16 | L0 · Not Tested | 同名和 reload 正确，可见真实加载集合 |
| AGY-E02 | T3 有提示注入相关策略 | AGY profile rules 复制。生态计数 | 可读汇总，按版本复验是否生效 | P1 · NP-13 / NP-16 | L0 · Unknown, Not Tested | 测试规则有/无，不读凭据、不改系统提示 |
| AGY-E03 | 未核实完整 UI | 生态统计。只读摘要 | 管理功能需官方 API 和用户操作 | P2 · NP-13 / NP-16 | L0 · Upstream Limited, Not Tested | 展示对当前范围的可验证 hooks，不运行未知脚本 |
| AGY-E04 | 未核实 native 管理 | 有通用 Plugin/tool 路线，SDK 独立。生态快照 | 读优先，官方管理按权限和组织政策 | P2 · NP-06 / NP-13 / NP-16 | L1 · Upstream Limited, Not Tested | 官方清单与 disabled 策略，保证不污染 HM SDK |
| AGY-E05 | T3 有 MCP 集成 | HM MCP service/AGY setting，启动默认空。全局与生态入口 | 分别确认 local/http/MCP server 与 OAuth | P1 · NP-02 / NP-06 / NP-13 / NP-16 | L1 · Not Tested | 只接专用本地服务，核实初始化与退出 |
| AGY-E06 | html_render 是 T3 自有能力 | HM sandbox iframe 与 preview 自有。无 AGY MCP Apps | 只读说明或单独评估显式桥 | P2 · NP-13 / NP-14 / NP-16 | L0 · Unsupported, Upstream Limited | 验证哪些结构有正式输出，未支持时只提供文档 |
| AGY-E07 | 未核实 | 当前无 AGY 专属。Settings 摘要 | 普通原生输入、真实提案/approval | P2 · NP-06 / NP-13 / NP-14 | L0 · Not Tested | 从提案到确认，拒绝时文件不变化 |
| AGY-E08 | 未见 | 无。无 | 记录上游途径，预留人工启用的集成评估 | P3 · NP-13 / NP-16 | L0 · Unsupported, Upstream Limited | 明确 App 依赖与只读可见性，HM 不启动 sidecar |
| AGY-E09 | T3 通过官方 CLI | HM 仅 CLI/ACP 路线。无 | 资料索引。实现范围以 CLI/ACP 约束收口 | P3 · NP-13 / NP-16 | L0 · Unsupported | 记录正式 SDK/ACP 差异，不引入第二个 runtime |
| AGY-E10 | 未核实 | HM Plugin Catalog 独立。无原生市场 | 以官方入口与明确权限呈现 | P3 · NP-13 / NP-16 | L0 · Upstream Limited, Not Tested | 验证官方链接与只读状态，避免混同插件商店 |


## 其他原生能力与界面限定项

### 官方支持和入口

| Capability ID | 能力与官方描述 | Desktop | IDE / 扩展 | CLI | 原生触发及来源 |
| --- | --- | --- | --- | --- | --- |
| AGY-X01 | **Remote Control**。用远程浏览器接续操控本地 AGY 会话 | ✓ | — | ✓ | `/remote-control`、子命令、官方 URL。[remote-control](https://antigravity.google/docs/remote-control/) · [reference](https://antigravity.google/docs/cli/reference/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-X02 | **Remote Agents**。在 Google 管理的隔离远程环境运行会话 | ✓ | ? | ✓ | `--remote-agent` / Remote project。[remote-agents](https://antigravity.google/docs/remote-agents/) · [projects](https://antigravity.google/docs/projects/) · [reference](https://antigravity.google/docs/cli/reference/) |
| AGY-X03 | **SSH Workspace**。App 的远端 Linux workspace | ✓ | △ IDE 自身有 SSH | △ CLI 可在远端运行 | App SSH 新项目 / remote shell。[ssh](https://antigravity.google/docs/ssh/) · [features](https://antigravity.google/docs/features/) |
| AGY-X04 | **Generative UI**。App 对话与侧栏交互小组件 | ✓ | — | — | `/generative_ui` 或 App。[generative-ui](https://antigravity.google/docs/commands/generative-ui/) · [side-panel](https://antigravity.google/docs/side-panel/) |
| AGY-X05 | **Notebook**。原生查看并编辑 Notebook、关联代码单元 | ✓ | ✓ Antigravity IDE | ✓ 文档标记 | 打开 notebook 或 Agent工具。[jupyter-notebooks](https://antigravity.google/docs/jupyter-notebooks/) |
| AGY-X06 | **Browser recordings 与 Screenshots**。保存浏览器过程与截图并供审阅 | ✓ | ✓ | △ 依浏览器工具 | 浏览器子 Agent 输出 / App 截图入口。[browser-recordings](https://antigravity.google/docs/ide/browser-recordings/) · [screenshots](https://antigravity.google/docs/screenshots/) · [artifacts](https://antigravity.google/docs/artifacts/) |
| AGY-X07 | **@ Mentions 与内容引用**。关联文件、Agent 或上下文引用 | ✓ | ✓ 具体 picker 各异 | ✓ 依对应引用 | Composer @ 对象、附件或行引用。[at-mentions](https://antigravity.google/docs/at-mentions/) · [acp](https://antigravity.google/docs/ide/extensions/acp/) · [ACP v1](https://agentclientprotocol.com/protocol/v1/overview) |
| AGY-X08 | **Voice / dictation**。实时语音、听写或录制附件 | ✓ | ? | ✓ | `/voice`、`/record`。[voice-mode](https://antigravity.google/docs/voice-mode/) · [voice](https://antigravity.google/docs/cli/commands/voice/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| AGY-X09 | **CLI Code Search**。会话内交互代码查找 | — | △ IDE 自己的代码搜索 | ✓ | `/codesearch` / `/cs` / `/search`。[codesearch](https://antigravity.google/docs/cli/commands/codesearch/) |
| AGY-X10 | **IDE Tab 补全**。编辑器行内联建议与后续编辑跳转 | — | ✓ | — | IDE native Tab。[tab](https://antigravity.google/docs/ide/tab/) · [extensions](https://antigravity.google/docs/ide/extensions/) |
| AGY-X11 | **IDE 旧 Workflows**。通过 IDE 自定义 Markdown 工作流 | — | ✓ deprecated | — | IDE 旧 Workflow。[workflows](https://antigravity.google/docs/ide/workflows/) · [workflows-to-skills](https://antigravity.google/docs/migration/workflows-to-skills/) |
| AGY-X12 | **CLI 本地会话工具**。复制/打开/清屏/反馈/快捷键/显示设置 | △ App 自有对应能力 | △ IDE 对应能力独立 | ✓ | `/clear`、`/copy`、`/open`、`/rename`、其他见下表。[reference](https://antigravity.google/docs/cli/reference/) · [statusline](https://antigravity.google/docs/cli/statusline/) · [title](https://antigravity.google/docs/cli/title/) |
| AGY-X13 | **官方指导、发行说明和诊断**。展示版本、原生指南及诊断 | ✓ 指南 | ? | ✓ | `/antigravity-guide` / `agy changelog` / Help。[antigravity-guide](https://antigravity.google/docs/commands/antigravity-guide/) · [changelog](https://antigravity.google/docs/cli/commands/changelog/) · [troubleshooting](https://antigravity.google/docs/cli/troubleshooting/) |
| AGY-X14 | **CLI Headless 与结构输出**。官方 print/stream-json 的单次或脚本构建 | — CLI surface | — | ✓ | `-p`、`--output-format`、`--json-schema`。[headless](https://antigravity.google/docs/cli/headless/) · [reference](https://antigravity.google/docs/cli/reference/) · [#1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) |
| AGY-X15 | **原生编辑器与终端工作台**。App 文件/终端窗格、快速预览和项目上下文 | ✓ | ✓ | △ TUI 覆盖对话与工具 | 原生 Side Panel / Terminal / Editor。[features](https://antigravity.google/docs/features/) · [side-panel](https://antigravity.google/docs/side-panel/) · [agent-side-panel](https://antigravity.google/docs/ide/agent-side-panel/) |

### ACP、本地与版本边界

| Capability ID | ACP 触发 | ACP 实时状态 | 原生控制与交互 | 只读本地来源 | 限制与兼容 |
| --- | --- | --- | --- | --- | --- |
| AGY-X01 | 无 AGY ACP 控制 API | 原生 Web 状态而非 stdio | 官方远控开启/关闭 | 未验证 | 个人计划、设备与版本约束 |
| AGY-X02 | ? 当前 ACP 入参未见 | 远端 workspace/live 状态待证 | 官方 TUI 或 App 管理 | 不能按本地 path 推断远端 | 计划、区域、接入与组织限制 |
| AGY-X03 | ACP 能运行远端 CLI，非 SSH 连接 manager | 标准会话，专属 SSH 状态未证 | 官方 SSH 连接或编辑器 | 只读配置不在本阶段 | 本地/SSH/Remote Agent 是不同 surface |
| AGY-X04 | 无已证 AGY ACP surface | 无公开专属 event | 在 App 内交互 | 无 | App-only，保障 iframe 源安全 |
| AGY-X05 | △ 通用文件工具；专属 UI 未证 | diff/资源按原生格式 | 官方编辑器/CLI，ACP 仅通用工具 | 工作区 .ipynb 非私有状态 | 产物内容安全、运行权限 |
| AGY-X06 | △ 资源项可能可见 | 专属录制事件未见 | 官方播放、预览，浏览器 live 无 | Artifact 读取路径候选 | 不能自动发现宿主 Chrome profile 私有文件 |
| AGY-X07 | ✓ 嵌入资源能力声明，特定 Agent mention 未证 | 用户内容与串流 | 输入明确引用；不自动派 child | 官方 workspace roots | 模型、feature 类型与 client 支持 |
| AGY-X08 | 1.5.16 握手 prompt audio:false | 无 v1 voice session 事件 | 原生录音、权限 | 不访问本地音频记录 | 账号、平台、音频 format |
| AGY-X09 | 无 TUI panel 方法证据 | 普通 grep/tool 不等于 native panel | 官方 TUI 交互 | 工作区按权限可只读 | CLI-only 原生交互 |
| AGY-X10 | 无公开 AGY ACP 方法 | 无 | 编辑器交互 | 无 | 随 editor、账户、模型 |
| AGY-X11 | 无 | 无 | 官方 IDE 与迁移入口 | 文档位置，未读取 | deprecated，独立于 Dynamic Workflows |
| AGY-X12 | 仅部分会话标题有协议更新 | `session_info_update` 可观察标题，TUI 无 feed | 仅核实命令的操作可用 | CLI 配置文档 | 退出或 /logout 不走通用 chat |
| AGY-X13 | ? 只有指令和版本声明 | `agentInfo.version`，日志本地 | 批准后打开官方来源 | 本机签名和版本可只读 | 吸收 CLI/App 独立发版差异 |
| AGY-X14 | 和 ACP 独立通道 | 最终 JSON 或 NDJSON 非 live ACP | 受明确用户查询/确定性脚本范围 | 无 | 禁止 consumer OAuth 自主代理编排 |
| AGY-X15 | 通用文件和终端可选，GUI 无统一 feed | 仅可验证工具内容 | 权限内文件/diff，App controls 独立 | 本地 Git/文件可只读 | 权限根、远程场景、编辑器差异 |

### 当前实现与验收

| Capability ID | T3 Code | HarnessMate / 前端 | 缺失与可行做法 | 优先级 / 工作包 | 当前等级 / 标签 | 下一步验收 |
| --- | --- | --- | --- | --- | --- | --- |
| AGY-X01 | 未见原生桥 | HM-Remote 自身设备配对。无原生远控 | 保持两体系并写清作用域 | P3 · NP-13 / NP-16 | L1 · Upstream Limited, Not Tested | 核验实际官方运行条件，HM 不替用户开启远控 |
| AGY-X02 | 未核实 | 无专属。无原生环境 | 仅在有官方 scope 控制时做增量 | P3 · NP-13 / NP-15 / NP-16 | L1 · Upstream Limited, Not Tested | 证明 remote session 的 identity 与资源访问区隔 |
| AGY-X03 | T3 环境能力独立 | 无 AGY SSH manager。无专属 | 可说明官方入口，避免跨边界复用 creds | P3 · NP-13 / NP-15 / NP-16 | L0 · Upstream Limited, Not Tested | 确认已连接测试环境时的路径与认证范围 |
| AGY-X04 | T3 html_render 属自有 | HM Render HTML 另有展现。无原生 widgets | 只呈现已证实安全产物 | P3 · NP-13 / NP-14 / NP-16 | L0 · Unsupported, Upstream Limited | 文档入口与普通工具内容正确区分 |
| AGY-X05 | 未核实原生交互 | 通用文件/diff。无 Notebook 专属适配 | Notebook viewer 逐证扩展 | P3 · NP-13 / NP-14 | L0 · Upstream Limited, Not Tested | 有证才提供 cell delta 与预览 |
| AGY-X06 | 通用图片/文件 | 只读 Artifact 及浏览器预览插件。无原生轨迹播放器 | 验证媒体类型与会话所属 | P2 · NP-05 / NP-14 / NP-16 | L0 · Upstream Limited, Not Tested | 获得测试截图/录屏并按可信链接显示 |
| AGY-X07 | T3 支持附件/文件内容 | 通用附件和 context/HM handoff。AGY picker 不完整 | 保留原生引用输入兼容 | P2 · NP-05 / NP-06 / NP-13 | L1 · Not Tested | 单测文件引用路径，真机区分 @child 和附件 |
| AGY-X08 | T3 文档说有 provider 音频路径，当前 HM 不用作本机证据 | 通用输入。无原生 voice | 明确 CLI/App 路径与上传能力 | P3 · NP-13 / NP-14 / NP-16 | L0 · Upstream Limited, Not Tested | 当前连接 audio:false 须关闭原生音频选项 |
| AGY-X09 | 未核实 | HM 通用内容搜索另计。无 native | 使用官方入口，独立记录 | P3 · NP-06 / NP-13 | L0 · Upstream Limited, Not Tested | 不把搜索结果塞进虚假 ACP lifecycle |
| AGY-X10 | 未核实 | 无。无 | 标 IDE 能力，桌面暂不承接 | P3 · NP-13 / NP-17 | L0 · Unsupported | 按 IDE-only 结案，标版本和文档 |
| AGY-X11 | 未见 | 无。无 | 文档引导迁移 Skills | P3 · NP-13 / NP-17 | L0 · Unsupported | 矩阵不将两种 Workflow 合并，保留迁移来源 |
| AGY-X12 | T3 自己的 UI 管理 | 已有部分通用动作。无本地原生 TUI | 帮助/官方本地动作优先，无隐藏副作用 | P3 · NP-06 / NP-13 | L0 · Upstream Limited, Not Tested | 按目录逐项选择官方、HM 或未支持 |
| AGY-X13 | T3 有 managed release | 有 health/probe。无 AGY 验证详情 | 可添加版本、来源与可观察状态说明 | P3 · NP-01 / NP-06 / NP-13 | L1 · Not Tested | 对照最新版官方发布，校验证据链接可访问 |
| AGY-X14 | 有官方 CLI side queries | S12 query/命令复用。使用/技能展示 | 保留受验证的有限查询，工作流选 live | P1 · NP-02 / NP-06 / NP-16 | L1 · Upstream Limited, Not Tested | 独立查询保持 profile，无 native workflow 意外走 headless |
| AGY-X15 | T3 自有 IDE/changes UI | HM Inspector、PTY、Context Chips。通用界面 | 只在有 native 证据时归属，GUI 特性按界面分别结案 | P3 · NP-03 / NP-14 / NP-16 | L0 · Upstream Limited, Not Tested | 与官方窗口对照，将审阅/终端/资源能力分别标识 |

## CLI 命令覆盖索引

CLI Reference 的主表共 48 行，以下按相关能力归集。功能正文与 Slash Overview 还发现不在该主表里的其他命令，列在末行。命令列入文档仅代表原生界面发现。`/skills reload`、`/plugin` 子动作、`/voice dictate` 等具体操作见同一能力行。[CLI Reference](https://antigravity.google/docs/cli/reference/) · [Slash Overview](https://antigravity.google/docs/slash-commands/)

| 入口 | 能力 ID |
| --- | --- |
| `/add-dir` | AGY-S08 |
| `/agents` | AGY-W01 / W02 / W03 |
| `/agy-customizations`、`/learn` | AGY-E07 |
| `/antigravity-guide`、`/changelog`、`/help` | AGY-X13 |
| `/artifact`、`/diff` | AGY-W14 / W15 |
| `/boost`、`/swarm`、`/swarm board`、`/teamwork`、`/goal` | AGY-W06 / W04 / W05 / W07 / W09 |
| `/browser` | AGY-W16 / X06 |
| `/btw` | AGY-S06 |
| `/clear`（`/new`）、`/copy`、`/exit`（`/quit`）、`/feedback`、`/keybindings`、`/open`、`/rename`、`/statusline`、`/title` | AGY-X12 |
| `/codesearch`（`/cs` / `/search`） | AGY-X09 |
| `/compact`、`/context` | AGY-S09 |
| `/config`（`/settings`） | AGY-S10 / S12 / S13 / X12 |
| `/credits` | AGY-S16 |
| `/effort`、`/model` | AGY-S12 / S10 / S11 |
| `/fork`（`/branch`）、`/rewind`（`/undo`）、`/resume`（`/switch` / `/conversation`） | AGY-S04 / S05 / S02 |
| `/grill-me`、`/plan` | AGY-W17 / W13 |
| `/hooks`、`/mcp`、`/plugin`（`/plugins`）、`/skills` | AGY-E03 / E05 / E04 / E01 |
| `/logout`、`/permissions`、`/usage`（`/quota`） | AGY-S14 / S13 / S15 |
| `/remote-control` | AGY-X01 |
| `/schedule`、`/tasks` | AGY-W10 / W11 |
| `/voice`、`/record` | AGY-X08 |
| 正文/独立功能页补充 `/run-workflow`、`/automation`、`/generative_ui`、`/mcp-app-development`、`/projects` | AGY-W08 / W12 / X04 / E06 / S07 |

`agy acp`、`agy agents` / `agent`、`agy models`、`agy mcp`、`agy plugin` / `plugins`、`agy remote-control`、`agy changelog` 分别见对应 ID。`help`、`install`、`update` 属 X13 安装诊断，`mic-serve` 属 X08。AGY 的安装、更新、登录、启停远控或写配置不属于 NP-00。矩阵范围以可发现的用户能力为单位，内部实现及文档中的平台选项沿各能力记录。
