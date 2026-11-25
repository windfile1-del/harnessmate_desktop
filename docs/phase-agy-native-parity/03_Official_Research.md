# 03 · 官方研究

基准日期 2026-11-25。以 Google 文档索引和 sitemap 做普查，共获取 119 份英语官方页面与路由快照；逐项核对相关功能正文、App/CLI 使用、CLI Reference、IDE 扩展、ACP 集成、CLI GitHub Releases 与 Issues，以及 ACP v1/v2 Preview 规范和 Subagents 草案。官网 surface 标签可能跨产品，功能正文和 Slash Overview 优先确认具体入口。IDE 列区分独立 IDE、官方扩展、第三方 ACP 客户端。逐能力索引见 [矩阵](02_Capability_Matrix.md)。[Google 文档索引](https://antigravity.google/llms.txt) · [ACP 文档索引](https://agentclientprotocol.com/llms.txt) · [Google IDE 扩展](https://antigravity.google/docs/ide/extensions/)

## 核心运行时、命令与权限

- 官方提供 `agy acp`，使用 stdio JSON-RPC，当前公开版本为 ACP v1。Google 说明该路径可渲染回复、工具、diff 和权限，`session/resume` 可重连无历史，`session/load` 的历史重放语义见规范及 release。Google 的文档还列出模型、思考级别、每编辑器第三方模型限制和多根支持。本机干净握手返回 `loadSession` 与 `sessionCapabilities.{resume,close,load,list,additionalDirectories}`，这些是声明层。需要登录后逐方法验证。[Google ACP 集成](https://antigravity.google/docs/ide/extensions/acp/) · [CLI ACP](https://antigravity.google/docs/cli/acp/) · [ACP v1 Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)
- v1 的 `session/prompt` 返回 `stopReason`。工具以 `tool_call` / `tool_call_update` 推送。`available_commands_update` 是原生提示命令枚举，不能据此保证 TUI 管理面板拥有可供第三方调用的结构化方法。`session/cancel` 是通知，无响应即无确认。`session/request_permission` 由 Agent 调用 Client，用户只能选服务器给出的选项或取消。当前 ACP v1 规范还定义可协商 `elicitation/create` 与可选子会话标准扩展，并非 AGY 1.5.16 已证实使用。 [ACP v1 Prompt](https://agentclientprotocol.com/protocol/v1/prompt-turn) · [ACP v1 slash](https://agentclientprotocol.com/protocol/v1/slash-commands) · [ACP v1 tool calls](https://agentclientprotocol.com/protocol/v1/tool-calls) · [ACP v1 elicitation](https://agentclientprotocol.com/protocol/v1/elicitation) · [ACP v1 child sessions](https://agentclientprotocol.com/protocol/v1/subagents)
- v1 子会话扩展的客户端宣告是 `clientCapabilities.subagents: {}`。Agent 没有对应发布位，收到首个 `subagent_update` 才能确认对端支持。外层 `sessionId` 是真实父会话，更新内 `sessionId` 是 child。Child `idle` 有前台语义，child session 或后台工作仍可存在。当前允许运行时控制只有 child 单独广告的 `cancel`，ACP 子会话不接受第三方直接发 `session/prompt`、load/resume/close 或任意配置。友好的父端请求聚合不能替代原生请求路由。[ACP v1 Subagents](https://agentclientprotocol.com/protocol/v1/subagents) · [Subagent Sessions RFD](https://agentclientprotocol.com/rfds/subagents)
- v2 仍为 Preview。`prompt` 成功表示接收，前台状态从 `state_update` 得到，单个请求挂起不必让全局变成 `requires_action`。`idle` 可同时携带后台活动。v2 用 `session/resume` 加 `replayFrom` 及 `replay_complete` 支持重放。当前 v1 的 `additionalDirectories` 已有扩展声明，v2 对 schema 进行了调整。AGY 协议默认继续走 v1。本机请求 v2 得到 v1，不能以 T3 文件名 `AdapterV2` 或 ACP 的 Preview 推断 Google 端已支持。[ACP v2 Migration](https://agentclientprotocol.com/protocol/v2/migration) · [Prompt Lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle) · [ACP v2 Subagents](https://agentclientprotocol.com/protocol/v2/subagents) · [本机握手](evidence/windows-1.5.16-request-v2.ndjson)
- Google 的公开 Auto 模式是服务端权限模式，受沙箱、平台和计划约束。Windows 从 CLI 1.4.4 起有条件可用。1.5.16 release 扩大部分工作区外编辑场景，同时保留规则与组织策略。HarnessMate 的 `client_guard` 降级、HM 终端和 AGY Terminal sandbox 是各自独立的能力。`terminal:false` 仅代表客户端不托管 ACP Terminal，AGY 自己仍可能运行 shell。[Agent Settings](https://antigravity.google/docs/agent-settings/) · [权限](https://antigravity.google/docs/permissions/) · [Terminal sandbox](https://antigravity.google/docs/sandbox/) · [CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16)

## 版本演进及报告中的差异

| 版本 | 一手证据与调查用途 |
| --- | --- |
| 1.5.0–1.5.4 | 1.5.0 公开 `agy acp`，支持图片/嵌入内容、再发 prompt steering、session resume。1.5.4 增加受条件限制的 ACP Auto。用来核查早期能力门控。[Changelog](https://antigravity.google/docs/changelog/) |
| 1.5.7–1.5.10 | T3 的早期版本缺陷与版本线索见 [第三方研究](04_T3Code_Research.md)。**Google 已在 1.5.10** release 记载后台完成后主动转发回复、调用和权限，以及 cancel/close 停止子任务。这是报告归到 1.5.15 的一组修复。实际完整传递仍与版本、模型和工作类型有关。[CLI 1.5.10](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.10) |
| 1.5.11–1.5.14 | 第三方于 1.5.11 观察到 post-settle，1.5.12/13 有 Swarm 或 child 转发不全的对照，1.5.14 在 HarnessMate 有仓库回放。1.5.14 release 还改进 TUI Swarm Board 概览。保留 1.5.14 的回放兼容。[CLI 1.5.14](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.14) |
| 1.5.15 | 官方修正 finite/background/subagent 导致初次回复结束即提前结算，声明延长 prompt 直到相关工作收尾并合并 usage，daemon 可脱离。另修 `session/load` 重放先后、重连后的权限问题、附件前导下的 slash 识别与 cancel 后工具行，并更新 Remote Control 队列提示。对照组仍需记录结果。[CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| 1.5.16 | 官方修正 default/accept-edits 下子 Agent/Workflow 的审批表单与问题转发，以及 Swarm Board 的系统唤醒归属。新增 `-r/--resume` CLI 别名及 `~/.agents/skills` 全局发现，`~/.gemini` 优先。Board attribution 是 Google 内部修复，未向 ACP 承诺 Board feed。[CLI 1.5.16](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16) |
| 官网 App / IDE | App、IDE、CLI 独立发版。官方 App 文档已将个人账号内嵌 Browser Subagent 标在 2.30+，本地 `/btw` 可持续子对话标在 2.32+，较旧版本或 remote 使用单次卡片。Windows 对照须记录 App/IDE 实装版本。[Browser](https://antigravity.google/docs/browser/) · [/btw](https://antigravity.google/docs/commands/btw/) · [发布总表](https://antigravity.google/docs/changelog/) |

## 原生执行模式与真实界面

| 功能 | 官方操作、状态和边界 |
| --- | --- |
| Background / daemon | AGY 可把长 shell 命令转后台。有限任务完成可唤醒 Agent，daemon 可长期保留。CLI `/tasks` 可观察日志，后台运行和“当前用户轮次阻塞”应分开看。队列在等待部分非 daemon 工作时可能 hold，用户选择 Send Now 可改变发送策略。ACP 对应 task ID 与更新样本需要实录。[Tools](https://antigravity.google/docs/tools/) · [CLI 1.5.15](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.15) |
| Subagent / Custom Agent | 主 Agent 可委派，App 有子会话面板和停止入口，CLI Agent Manager 有键盘控制及自定义角色选择。官方还描述恢复、消息唤醒和权限冒泡。会话中选不同主自定义 Agent 可能另开 fork。`@` 提及可输入 context 和 Agent 引用，具体格式以 surface 和版本为准。[Subagents](https://antigravity.google/docs/subagents/) · [Agent Manager](https://antigravity.google/docs/cli/commands/agents/) · [Mentions](https://antigravity.google/docs/at-mentions/) |
| Swarm | 明确由 `/swarm <task>` 启动。Coordinator、实名 worker、verifier 通过共享 Board 交换帖子、状态和提及，idle worker 可被成员唤醒。CLI `/swarm board` 或 Alt+S，App 内置 Board。预览，所有计划，Business/Enterprise 受管理员策略约束。ACP Board/mention 控制未证实。[Swarm](https://antigravity.google/docs/swarm/) |
| Boost | `/boost <task>` 启动按需加强推理，运行实现、挑战、修复、独立核验。角色/阶段名称是产品语义。App/CLI 付费，Slash Overview 也列 IDE 扩展，具体编辑器/模型仍应实测。[Boost](https://antigravity.google/docs/boost/) · [Slash Overview](https://antigravity.google/docs/slash-commands/) |
| Teamwork | `/teamwork <goal>` 启动长时项目。需求访谈和 Prompt Artifact 是启动关口，随后原生项目目录、Sentinel、Project Orchestrator、各里程碑与审计。正文按 App/CLI 付费说明，Slash Overview 也列 IDE 扩展。不得从旧 `/teamwork-preview` 迁移推断支持当前动作。[Teamwork](https://antigravity.google/docs/teamwork/) · [Slash Overview](https://antigravity.google/docs/slash-commands/) |
| Dynamic Workflows | `/run-workflow <task>` 由 AGY 写 Python，用户审核并允许执行。CLI phase tree 与 `/tasks` 提供日志，各 Agent 返回结构化结果，parallel/pipeline 属原生脚本接口。App/CLI 各计划。CLI Reference 的核心表当前未列，功能页和 Slash Overview 有正式记录，故以实录确认 ACP 入口。[Dynamic Workflows](https://antigravity.google/docs/dynamic-workflows/) · [Slash Overview](https://antigravity.google/docs/slash-commands/) |
| Goal | `/goal <objective>` 使当前会话持续验证目标。原生状态和取消路径见产品文档，启动新目标可替换旧目标，CLI `/tasks` 可观察。通用 ACP 无 Goal CRUD，本机要录原生事件或经过验证的路径。[Goal](https://antigravity.google/docs/commands/goal/) |
| Schedule / Automations | `/schedule` 创建当前会话的单次或 cron，支持原生 TimerCondition 和原生任务查看/取消。App `/automation` 属持久定时，每次新会话，可暂停和重新启用，交互权限不同。Sidecars 也是 App 生命周期管理的后台进程，支持原生 `agentapi`；该本地入口应作为单独的上游能力调查，不与 ACP/第三方自主编排混用。[Schedule](https://antigravity.google/docs/commands/schedule/) · [Automations](https://antigravity.google/docs/commands/automation/) · [Sidecars](https://antigravity.google/docs/sidecars/) |
| Plan / review / forms | `/plan` 支持研究和计划；`/grill-me` 专注逐题访谈。App/IDE 有审阅和评论，CLI `/artifact` 的原生 TUI 支持审阅、评论与批准。ACP diff、plan、permission 和产品的行级 Artifact review 需要分别验证。[Plan](https://antigravity.google/docs/plan/) · [Design interview](https://antigravity.google/docs/commands/grill-me/) · [App Artifact Review](https://antigravity.google/docs/artifact-review/) · [CLI Artifacts](https://antigravity.google/docs/cli/artifacts/) · [Change Review](https://antigravity.google/docs/review-changes/) |
| Browser | 个人 App 2.30+ 内嵌浏览器与一个或多个 Browser Subagent。CLI、部分企业 App 用 Chrome DevTools MCP，需要 Chrome v144+。IDE 还有独立 Chrome Profile、录屏和 browser UI。ACP 的普通工具、浏览器影像、浏览器交互应分能力验收。[Browser](https://antigravity.google/docs/browser/) · [IDE Chrome Profile](https://antigravity.google/docs/ide/separate-chrome-profile/) · [IDE Browser Recordings](https://antigravity.google/docs/ide/browser-recordings/) |
| 生态、跨目录和账户 | Skills、Rules、Hooks、Plugins/MCP、Marketplace、Projects 与多根是原生配置体系。App 的 MCP Apps iframe、IDE Tab 补全、IDE 工作流到 Skills 迁移均有独立 surface。CLI 另有 `/learn` 提案应用及 `agy-customizations` 指南。账户、Credits、Usage、Orchestrator 的权限跟随计划、组织和真实会话能力。[Features](https://antigravity.google/docs/features/) · [Projects](https://antigravity.google/docs/projects/) · [Customizations](https://antigravity.google/docs/customization-discovery/) · [Models](https://antigravity.google/docs/models/) · [MCP Apps](https://antigravity.google/docs/mcp-apps/) · [IDE Workflows](https://antigravity.google/docs/ide/workflows/) |
| 会话、远程与周边 | CLI `/fork`、`/rewind`、`/resume` 是原生对话工具。`/btw` fork 有独立内容。App/CLI 的 Remote Agents 使用 Google 管理的远端环境，Remote Control 是跨设备控制不同的能力，App 有 SSH workspace。与 HM-Remote、HM Fork、Context Handoff 的行为分别验收。代码搜索、Notebook、语音、截图、Generative UI、快捷键和 CLI 状态行均已纳入矩阵。[Conversations](https://antigravity.google/docs/cli/conversations/) · [/btw](https://antigravity.google/docs/commands/btw/) · [Remote Agents](https://antigravity.google/docs/remote-agents/) · [Remote Control](https://antigravity.google/docs/remote-control/) · [SSH](https://antigravity.google/docs/ssh/) · [CLI Reference](https://antigravity.google/docs/cli/reference/) |

## 上游 Issues 与产品约束

- [Google CLI #1493](https://github.com/google-antigravity/antigravity-cli/issues/1493) 中维护者解释，人直接驱动的第三方交互 ACP UI 可启动未修改的 AGY；consumer OAuth 下将 AGY 作为另一 Agent 的后台 worker、覆盖系统身份或自动轮换账户超出该解释的范围。条款正文与解释各保留原始链接。NP 采用 user-direct 能力边界，企业功能按明确授权与组织策略评估。[条款](https://antigravity.google/terms) · [FAQ](https://antigravity.google/docs/faq/)
- [Google CLI #1610](https://github.com/google-antigravity/antigravity-cli/issues/1610) 有共享钥匙串的 Linux 版本报告。Windows 空白探活能证明本次干净进程返回认证要求，无法证明所有认证方法或实账号强隔离；1.5.16 还改了 macOS SSH/keychain 行为。以平台、版本和 authMethod 三维测试。[1.5.16 发布记录](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.5.16)
- [Google CLI #1540](https://github.com/google-antigravity/antigravity-cli/issues/1540) 是 Rules 未生效的用户报告，ACP 团队成员表达认领。记录为版本依赖和重验项。不开启系统 Prompt 注入 workaround。
- [Google CLI #1041](https://github.com/google-antigravity/antigravity-cli/issues/1041) 曾报告流完成无 Prompt 响应，评论不足以证明当前 1.5.16 的结论。测试应包括该排序和给 UI 诚实的连接未知。App/IDE 会话共享仍有独立的 [#1830](https://github.com/google-antigravity/antigravity-cli/issues/1830) 用户请求，不能默认两个数据目录共享会话身份。

## 附件结论分类

| 附件位置 | 归类 | 本轮处理 |
| --- | --- | --- |
| 第 5–67 行的基线、功能表与版本 | 官方事实与第三方证据混合 | SHA 与 v1 核实。纠正占位轮次结论、1.5.10/1.5.15 时间线、v1 可选 child/多目录和 IDE 支持细分 |
| 第 71–132 行的故障层级与当前实现 | 源码静态事实及工程假设 | 核实布尔、晚事件、辅助 CLI、子 ID。App 目录字段真实形状与报告推定不同。核心故障仍需同场景抓帧 |
| 第 134–162 行 | 第三方参考 | 核对 PR 合并状态、源码和测试，区分 1.5.11 实测、1.5.12/13 讨论与本机 1.5.16 [对照](04_T3Code_Research.md) |
| 第 164–300 行 | 内部架构和体验提案 | 模块名、字段、状态转换、只读 observer 和功能工作台均保持提案，接口以本专项文档定义为准 |
| 第 302–384 行 | 开发建议和待验证场景 | 全文阅读后拆为独立任务。本轮不执行该段的正式重构、付费模式测试、账户产品改造或 Git 分支创建 |
