# 07 · Native Parity 总体架构

方案以 [S04–S09、S14–S19](05_Source_Audit.md) 和 [E01–E07](06_Protocol_Evidence.md) 为输入。实现从 `agy` flavor 的可选原生运行时开始。严格 ACP、Codex、Claude 和外部适配器继续走现有通路。客户端负责发现、发起经验证的原生操作、观察、审批和恢复。AGY 继续拥有工具、原生 Agent 与工作流调度权。

## 生命周期与主路径

| 生命周期 | 身份与所有者 | 关闭条件 |
| --- | --- | --- |
| HM Session / Binding | `sessionId + instanceId + bindingRevision`，SessionManager 管再连接、账户、来源和当前 workspace | HM 归档/显式关闭可终结绑定操作。旧记录可读，Profile 切换开新 generation |
| User Turn | 已存在的 `turnId`，用户提交或明确的用户原生命令产生 | 真实 Prompt 结果和已确认与此 turn 阻塞的 work 结算，或失败/停止。一次写终态、Checkpoint、Task Ledger 和 binding watermark |
| Prompt RPC | `connectionId + direction + rpcId + request ordinal`，由 transport/codec 关联 | v1 response 或端断开，错误和 timeout 单列。Steer 可能与原请求并行，响应各归自身 |
| Native Activity / continuation | `activityId`，由可归属入站帧及已知 turn/work 的因果关系建立。允许 `turnId = null` | 显式协议事实优先，可靠且有版本证据的完成标记次之。观察中断转 stale/unknown。可多次唤醒 |
| Work | `workId` 对应有限命令、daemon、子任务、定时触发等一次工作实例，关联 native aliases | 任务/Agent 结果的可信终态。不同回合可共用原生实体，保留不同 occurrence |
| Child Agent | `agentId` 和一组 native identity，父边可无、已验证、冲突；Child Session Router 管 | 原生会话关系的明确关闭，或观察源断开。`idle` 可再被原生唤醒。工作成功由结果字段单独记录 |
| Workflow | `workflowId`，由证实的启动事实关联 origin activity，按模式 observer 更新 | 证实的 workflow 结果。阶段、里程碑和 worker 完成分别记录，主 Prompt 结束不取代 workflow 结果 |

~~~mermaid
flowchart LR
  A["AGY v1 stdio / future v2"] --> B["Transport + Protocol codec"]
  B --> E["Ordered ingress · generation + wire ordinal"]
  C["Verified native read-only snapshots"] --> E
  E --> D["Child / request router + reactive controller"]
  D --> F["Registry · observed activities, work, relations, workflows"]
  F --> G["SQLite transaction + native event feed"]
  G --> H["Runtime Center + scoped studios"]
  G --> I["Optional read-only plugin projection"]
  J["Explicit user action"] --> K["Native command router + scope verification"]
  K --> B
  D --> L["SessionManager · optional lifecycle port"]
  L --> M["One conventional turn terminal event"]
~~~

## 模块职责与接入

| 模块 / 所有者 | 输入、输出、依赖与错误处理 |
| --- | --- |
| Transport Observatory / NP-01 + NP-02 | stdio 请求/响应/通知、进程退出、monotonic time、入口 ordinal → 按同一 correlation ID 的 raw-shape/normalized/canonical/UI 标记。白名单脱敏、限制大小并记录 dropped count。采集失败不阻塞业务。NP-01 管独立工具，NP-02 提供挂载点。 |
| Versioned Protocol Adapter / NP-02、NP-15 | 真实协议版本、profile, agentInfo、caps、session/setup 和 live frame → vendor-neutral envelope。v1 尊重 stopReason，未来 v2 拆出接受与状态流。请求 v2 的测试/开关默认关闭，只有版本和 schema 双确认才能进新分支；跨版本 fallback 在发用户 Prompt 前完成。未知帧保留结构诊断，未知 request 有界返回规范错误。 |
| Capability Discovery & Command Catalog / NP-06 | 从每个 binding 的握手、setup 配置、广告更新、版本证据、policy 生成带 revision 的 descriptor。维度为 launch / observe / control / read-only。更新空表视作当前广播结果，未见广播是 unknown；撤销时前端降级。账号、实例、来源、模型和生效 mode 均参与缓存键。 |
| Native Command Router / NP-06 | 用户意图 + descriptor revision + 当前绑定 → synthetic-free live prompt、原生 config RPC、已验证的 side query 或查看/引导。检查 arity、资格、源、操作权限和幂等，一条 utterance 只发一次。并发能力未验证时报冲突或保留草稿。 |
| Native Registry and Storage Port / NP-02 | 可信 normalized observation → field-level evidence、revision、持久化原生事件。单 binding 单写者，事务提交后发事件。复用 SQLite 和现有审批业务对象，可选新表/事件前缀。按 namespace 识别任务、Agent 和子关系，保留矛盾可查。 |
| Reactive Runtime & Background Work / NP-04 | Prompt、tool patches、request、process exit、attach、stop signal → typed work delta、blocking 集合和本地 segment。保活按 work/权限/传输状态，关闭只能按证据或明确的回收路径。避免以一次布尔或完成时间戳清整会话。 |
| Agent Registry & Child Session Router / NP-05 | 原生 child 事件、父 launch/tool 字段、版本化只读 record → Agent ID、父子边、可观察能力、独立 transcript。保留 unbound/ambiguous。仅通过同连接稳定 ID 或同一受验证的 record join 建立关联。活动可嵌套，检查环、多父、profile 错配和过期 generation。 |
| Native Permission Router / NP-07 | 带目标原生会话和 connection 的 request、真实选项，结合用户决策 → 原始 JSON-RPC 响应和 HM 收据。未知 child 请求在明确绑定前不可冒充父请求。连接丢失、过期、重复和不可编码答案以明确结果落库。 |
| Workflow Observers / NP-08–NP-12 | 按经验证的触发、结构化更新、关联 child/state 和只读 snapshot 生成对应工作流投影。只能更新自己模式，依赖 registry/identity/auth port。没有字段则保持 unknown，官方界面仍可完成该部分。 |
| Native State Reader & Recovery / NP-05、NP-13–NP-15 | 受管根的有限版本化文件、历史、明确 resume/load 与 runtime 能力 → 可验证的 read-only projection 或 reconciling/unknown。审批、认证、原生控制永远从 live connection 取。缓存故障不能触发新任务或换账号。 |
| UI 与插件投影 / NP-03 | Authoritative state + decision receipts + capability snapshot → 首方 React workspace、列表、快捷操作和降级。可选插件只读快照按授权字段投影。Slice 与 capability revision 变化由单一 store owner 管理。 |

## 运行时归属与状态转换

处理顺序以 connection ingress ordinal 为准。同一会话的多个 Prompt 响应，通过 request context 匹配原始 turn 和 origin activity。更新若自带 child/session/tool/task 身份优先查实体和对应 generation。没有关联证据的根会话消息可形成「原生续跑」segment；非根身份或未知 ownership 则留缓冲和诊断。实时根带多个候选 turn 时保留独立 activity，不能把历史文本和下一次用户输入合并。Tool patch 的 omitted 字段保留旧值，null 只按已知 schema 清理。

| 观测 | 状态及规则 |
| --- | --- |
| 用户启动、prompt RPC 未回 | 前台 active。工具和消息从具体 session/turn 归属，已证实有限阻塞加入集合 |
| 有限任务运行而 prompt 早回 | Prompt 已结算，用户 turn 可见为「等待后台」并持有 lease。A、B 各自完成。处于待回答时，界面同时呈现 pending requests 和可进展工作 |
| 任务结算后收到 wake 的后续原生帧 | 同一仍持有 turn 可接新 segment。前一个 turn 已终结则另记 native activity，按证据链接前因，不重开已结束 turn。纯旧 tool result 仅补旧 work |
| daemon、定时未到、无证据表明阻塞的子任务 | 在 Runtime Center 保留，主 turn 允许结束。进程 lease 按是否需要保持观察和是否具备可恢复性单独评估 |
| 真实前台完成、没有阻塞 work 或未决关键请求 | 按对应 v1/v2 结算规则关闭 activity。收齐证据后只一次发旧式主 turn 终态，晚到 native 事件保留独立 |
| 连接超时、缺终态、silent wake、已知 marker 缺失 | 放弃等待或断开时报告「状态未确认」，保留最后观测。`usage_update` 只在特定版本闭合协议经实录后辅助划分回复段。收尾时限可结束客户观察，不能制造原生 success |
| 用户 Stop | 先对真实 target 发已证实的 cancel，再在有限 grace 内等待原生终止/确认。等待场景仍可 Stop。请求回执、确认与生效分别展示。未知子或不支持操作只能提供能验证的父端动作 |
| 重连/reload/crash | 按 generation 栅栏旧帧，状态进入 reconciling。进程遗失导致旧 permission 失效。重新请求要有新对端帧，scope 不变。继续等待不产生用户消息 |

前台 `requires_action` 表示证据确认前台阻塞，独立 badge 显示所有可行动请求。状态快照保持可重复应用。工作进程退出可确认「观测连接结束」，不能直接确认所有其后台子进程按逻辑取消。旧版异常时明确关闭 observe lease，选择可证明的原生关闭与进程回收。形成 detached daemon 时区分 **不阻塞 turn** 和 **是否保持正在观察的连接**。只对确由 HM 启动且记录的进程一代做限时回收。池满且全有 lease 时给可诊断的容量提示，不任意淘汰。

## 命令与工作流

| 路由 | 使用条件 |
| --- | --- |
| Inspect | `/usage`、`/skills` 仅在已验证的 profile-scoped 官方查询下用辅助 CLI。超时只影响该查询，不能退回默认账户 |
| Session configuration | 通过实际返回的配置选项与确认更新执行。`/model`、`/permissions`、Agent selection 的变化区分即刻生效、另开会话/fork、原生端只读 |
| Interactive workflow | NP 模式经过版本及当前 session 的广告或有针对性的验证后，可由用户路径送入同一 `agy acp`。未验证的模式说明可见，运行控制暂不可用。附加内容保留 slash 顺序与用户同意 |
| Local UI / native manager | `/agents`、`/tasks`、`/swarm board` 等管理面板优先用结构化数据和只读来源。缺少经验证的操作时显示来源和官方入口。不会为了取得输出在另一个进程打开原会话 |
| Context / raw user text | 仍支持明确的普通消息，已识别危险分发时使用已有权限边界。受控 router 不把任意 TUI 命令当成同一 native workflow 丢给模型作为隐式降级 |

| 模式 | 模型与证据优先级 | 没有协议时 |
| --- | --- | --- |
| Subagents | Launch batch 与独立 child 两种实体。ACP 子会话明确 announcement 优先，AP/CLI 只读证据按版本可补充。权限仍指向实际发送者 | 保留 launch batch、未确认身份和真实 coordinator 活动，禁用 child 动作 |
| Swarm | Coordinator、实名 worker/verifier、Board posts+threads 与 worker state 独立维度。只从结构化 feed 或匹配 run 的已验证本地 Board | Board 显示未暴露，可查看协调者事件和官方 `/swarm board` 操作说明，不从文本造帖子或 worker |
| Boost | 保存独立 workflow，阶段/角色仅由授权实录验证。亲缘关系与 Boost 阶段分别维护 | 显示启动事实、通用工作活动和各观察来源，省去阶段进度 |
| Teamwork | Scoping form → prompt artifact/review → 专属项目与 milestones/gates。项目根来自原生证据与授权选择，approval 保留 scope | 展示实际问答与明确的 artifact，缺原生批准动作时引导官方端继续 |
| Dynamic Workflow | 脚本审阅、已给出的 phase/edge、多个 agent execution、logs 和有 schema 的结果。客户端只观察原生执行 | 展示脚本预览、实际工具/日志片段，不读取任意 script path 或推断 DAG |
| Goal / Schedule | Goal 记录原生目标和 terminal evidence。Schedule 记录计划、各 occurrence 和 wake 映射，cron 的下次执行依据原生数据 | 格式化可见的时间/工具证据，状态未知。区分历史任务与在运行，持久 Automations 为 App 能力另列 |
| Artifact / Browser | 通用 plan/diff、只读 Artifact 和 Browser Agent runtime 是多个能力。基于真实动作才显示 inline 评论/批准或 chrome/浏览器控制 | 当前保留支持的只读卡片、官方入口和标准 ACP 工具结果 |

## 恢复和只读来源

1. Daemon 启动后检查持久下来的 binding、live owner 与最后快照。现有 HM session 恢复仍可结算损失的用户执行，额外标记其原生状态 reconciling，避免以全局 idle 代表原生结束。旧源码数据不存在 native 表时安全视为 unknown 或未启用。
2. 只有相同 profile、source、workspace scope 和已确认的 native conversation ID 可以 attach。按 capability 选择 v1 resume（无 replay）或 load（有 replay），未来 v2 的 resume + replay cursor 另实现。Replay frame 隔离，不重复发交互、历史工具或用户消息。没有新的权威状态时最后观察作为 stale。
3. 本地 parser 细分 namespace 和 schema/version，使用 allowlist filename、realpath 在配置根、逐层拒绝 reparse、重新验证实际句柄身份、限体积/深度/观察频率。SQLite 实验仅读，活跃 WAL 不能为读而制造文件。必要时用经授权 D 盘克隆作为研究样本。Provider 真实支持必须依赖 live route。
4. Windows watcher 可以漏、并、乱序。用有上界并可取消的 snapshot scan 校正。过期即 stale，未知版本停用 parser。Artifact 内容作为不可信文本/资源，CSP、URL 白名单和限制；允许的审批由原生 RPC，用户文件只读。
5. Context Handoff 继续只传用户选定的已持久上下文。禁止跨 binding replay 认证/审批、后台控制或自动续接。HM Task Ledger 可在后续用稳定链接显示真实工作证据，既有 Worktree、Git Checkpoint 和 turn `seq` 不由 detached 活动推进。HM Orchestrator 和 AGY 原生 Orchestrator 权限分开。

## 验收门槛

基础运行时上线前需让同样的普通 AGY turn、Codex、Claude 和 strict ACP fixture 的现有事件、审批及 Handoff 行为一致。任何模式的触发、观察和控制按三个维度单独解锁。能力受上游限制时可以发布已验证的读视图。竞态、重启、新旧客户端、Profile 隔离和发送幂等见 [共享契约](08_Shared_Contracts.md) 与 [测试方案](12_Test_Strategy.md)。
