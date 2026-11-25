# 06 · Protocol Evidence

## 本轮实际执行

| ID | 证据及结果 | 可下结论 |
| --- | --- | --- |
| E01 | 本机 Windows Google 签名有效的 CLI 1.5.16，运行 `--version`、`--help`、`acp --help`。可见 stdio、`--process-per-session`、`--add-dir`、`--agent`、`--mode`、`--settings`、`--resume/-r`、`models/agents`、`--remote-agent` 及隔离参数。 | 帮助证明安装可发现。帮助 flags 的行为和账号授权仍需验证。 |
| E02 | [空白 Profile，v1](evidence/windows-1.5.16-clean-v1.ndjson)。`initialize` 返回 1.5.16 / protocol 1，标识 Antigravity ACP Server；auth IDs 为 oauth-personal、oauth-business、gemini-api-key、agent-platform。`loadSession:true`，声明 resume/close/load/list/additionalDirectories，prompt 声明 image 和 embeddedContext，audio false。结果含新旧别名，没有 `mcpCapabilities` 字段。紧接 `session/new` 返回 `-32000`。 | 版本、能力声明及空白认证分支是 Windows 实证。文件是字段形状采样，未保留原始 OAuth 或模型内容。 |
| E03 | [空白 Profile，客户端请求 2](evidence/windows-1.5.16-request-v2.ndjson)。返回 protocol 1。探针确认降级值后退出。 | AGY 1.5.16 当前连接选择 v1，v2 Preview 的内部设计不启动。 |
| E04 | 同一空白环境 `agy models` 退出 1 且出现认证提示，`agy agents` 退出 0 且无 stdout。`session/new` 未开通，因此无当场 config options / available commands / entitlement。 | 账号的模型、有效模式和命令目录仍 Unknown。CLI 帮助与旧 fixture 不能证明该账户当前可用。 |
| E05 | `packages/daemon/tests/fixtures/agy-1.5.14/{session-full,auth-required}.ndjson`。初始夹具 15 帧，认证夹具 2 帧，按 stage 组织。Fixture 自述脱敏的 1.5.14，测试的 mock server 填入动态 id 并合成部分响应和时序。 | 证实仓库可回放的形状和当前处理路径。缺逐帧原始时戳、全部请求/响应和 provenance，不能把回放通过当作当前真机证据。 |
| E06 | 本机历史目录只读普查，详见下文。 | 能证实 App 样本的文件布局和字段形状，未证实当前 AGY 1.5.16 ACP 工作流的映射与新鲜度。 |
| E07 | [20 秒探针脚本](evidence/probe-acp.mjs) 的空白握手路径已运行，交互 reactive 场景等待用户指定已授权测试 Profile。 | 当前未观察真实 Prompt、wake、late response、workflow、child permission 或 App 同任务。 |
| E08 | [合成 ACP 样本](evidence/0409bc8-synthetic-routing.ndjson)，在当前基线的真实适配器上运行。 | 提前 Prompt 响应、布尔保活与晚审批路径可复现，输入对端为合成。 |

空白探针参数示例。`--protocol 2` 是独立对照，和 `--catalog` 分开执行。

~~~powershell
$npTemp = 'D:\HarnessMate\np00-research'
$env:TEMP=$npTemp
$env:TMP=$npTemp
$env:TMPDIR=$npTemp
$agy = (Get-Command agy).Source
$probe = 'docs\phase-agy-native-parity\evidence\probe-acp.mjs'
node $probe --agy $agy --scratch $npTemp --catalog
node $probe --agy $agy --scratch $npTemp --protocol 2
~~~

## 仓库回放与真实字段边界

`available_commands_update` 的仓库样本仅见 `plan, goal, review`。其余样本含 config_option_update、usage_update、session_info_update、`Run update_steps`、`invoke_subagent` 的 Role/TypeName/Prompt、定时工具 DurationSeconds、interaction/security approval、steer/cancel/quota。样本无连续的后台启动→触发→新回复→最终结算，也无 child session ID 或 native Board。测试需要继续保留并标记录制版、改写内容来源。[现有回放测试](../../packages/daemon/tests/agy-replay-protocol.test.ts) · [现有 fixture](../../packages/daemon/tests/fixtures/agy-1.5.14/session-full.ndjson)

| 字段或方法 | 证据类别 |
| --- | --- |
| `initialize`、`session/new`、`session/update`、`session/prompt`、`session/cancel`、`session/request_permission` | ACP v1 规范。一部分在本机无登录可见，运行时请求仍有待采样 |
| `available_commands_update.availableCommands`、`configOptions`、`toolCallId` 与 tool patch | ACP v1，仓库 fixture 形状可见 |
| `IsDaemon`、`DurationSeconds`、`CronExpression`、`backgroundTaskId`、`interaction_*`、`agy.security.warning` | AGY 工具参数、T3 观测或当前 HM parser；每项要记录具体证据、版本及大小写。没有统一 AGY public schema |
| `subagent_update` / `session_message` | 现行 ACP v1 可选扩展与 v2 Preview。仅在实现了 child routing 后可以送正确 client capability；空白握手不能证明 AGY 发该字段 |
| `state_update`、`replay_complete`、`replayFrom` | ACP v2 Preview 定义，未在本次 AGY v1 流上观测 |
| `runtimeId`、`activityId`、`workId`、`blocking`、`availability` | [HarnessMate 内部契约](08_Shared_Contracts.md)，不同层级的身份、状态和能力 |

官方规范与说明见 [ACP v1](https://agentclientprotocol.com/protocol/v1/overview)、[v1 child](https://agentclientprotocol.com/protocol/v1/subagents)、[v2 Migration](https://agentclientprotocol.com/protocol/v2/migration)、[AGY ACP](https://antigravity.google/docs/ide/extensions/acp/)。

## 原生本地状态的只读观察

仅检查已知 `.gemini` 根的三种应用目录。入口是已存在的 Windows junction，解析一次后，只枚举根下实际目录及有限常规文件，避开后代链接。只输出计数和 JSON 顶层字段类型。未打开 SQLite、记录内容、会话 ID 或凭据。样本来源是本机历史数据，写入时的实际版本未知。

| 数据分区 | 实际结果 | 结论 |
| --- | --- | --- |
| `antigravity-cli` | 73 个 brain 父目录与 73 个 conversation DB。扫描 73 个父目录，在采样上限内未发现 child JSON/JSONL，见 `.system_generated/{tasks,messages,logs}` 片段。 | CLI/ACP 的真实 child 路径和 schema 未得到证据。空列表不能证明没有子 Agent。 |
| `antigravity`（App） | 209 个 brain 父目录与 208 个 conversation DB。检查 209 个父目录及每目录最多 30 条，得到 88 条 child JSON；采样无 sibling JSONL。88 条顶层字段均为 `conversationId:string`、`subagentDescriptor:object`、`state:string`、`spawnStepIndex:number`、`workspaceUris:array`。 | App 有真实 child 候选。当前 HM 读取的 `id/status/role/typeName` 顶层 schema 与该样本不一致。slot 中工具 ID 与 record identity 不能直接等同。 |
| `antigravity-ide` | 15 个 brain 父目录与 15 个 conversation DB。在采样上限内可见 tasks / messages / logs，未见 child 记录。 | IDE 目录独立。当前 AGY 历史读路径只区分 CLI 和桌面。 |
| `antigravity-acp` | 此默认根未发现该目录。 | T3 profile 中使用此名是第三方的启动目录选择，不能直接复制本机默认读路径。 |

各应用目录的 `tasks` 下存在非 JSON 条目，采样仅证明目录及文件存在。没有打开任务正文或解释其生命周期。消息、子 Agent 轨迹、工作流、Board 和运行中任务的关联需在专用测试会话里验证。只读引入流程见 [恢复](07_Architecture.md#恢复和只读来源)。

## 合成输入复现当前适配器行为

先执行 `pnpm build`，再在仓库根运行 `node docs/phase-agy-native-parity/evidence/probe-current-routing.mjs`。Probe 从已有 build 载入 `AcpSessionHandle` 和 `AntigravityAcpFlavorPolicy`。合成对端先发 A/B 启动和 `session/prompt` 响应，待适配器发出 `turn.completed` 才发 A 完成、晚文本和轮次外权限请求。三条证据为：

1. `turn.completed` 时 lease 仍为 true，A/B 在合成原生端均运行。
2. 仅 A 完成后，晚文本进入 `turn_bg`，lease 已 false，B 未发终态。
3. 同一根会话轮次外权限请求直接回 `cancelled`，没有 `approval.requested`，与 `agy-driver.ts:311–312` 一致。

该实验调用当前适配器与合成对端，SessionManager 和 Web 的影响按 [源码审计](05_Source_Audit.md) 记录。真实用户场景保留到授权真机对照。

## 授权后最小复现

模型已确认为 Gemini 3.8 Flash。专用 Profile 的登录、实际模型 ID 选择和输出位置见 [本机运行步骤](handoffs/G0_Test_Profile.md)。

1. 由用户选择一个已通过官方登录的 D 盘专用个人测试 Profile，确认允许一个低成本 prompt，工作目录由探针在 D 盘创建。官方 App 和 CLI 对照使用各自的测试目录副本及相同账号类别/模型/权限。默认账户和活跃会话不作为样本。
2. 可先运行 `--discover-confirmed`，只创建专用测试会话，收集可见的模式、模型配置与内建命令名，不提交 Prompt。随后在交互 PowerShell 中用 `--reactive-confirmed` 复现。脚本展示任务和确认后只送一个 Prompt，请原生非 daemon 后台工具运行约 20s 的 PowerShell 命令。Probe 先通过原生配置确认指定模型，再允许用户提交。用户逐项检视权限，允许一次或拒绝一次。CLI 若未走 manual/default，应记录实际配置，审批对照不计验收。
3. 观察 `session/prompt` 发送、工具启动/背景身份、工具终态、wake 后的新工具调用及其审批、回复、prompt response。脚本最多观察 150s，总过程与响应后窗口分开。需要证明 marker 来自 shell 完成而非模型复述，WP01 扩充可检验脱敏记录。若 Agent 在前台跑完、本来没转后台或未按脚本发第二次工具，结果为场景未触发。成功不依赖用户补发消息。
4. 同任务用 HarnessMate 与原生 CLI/App 各一次，标记版本、时序及溯源。先完成单个成功，再用独立批准的样本扩大到失败、并行、daemon、stop、两次 wake、问答和重启。不同计划的付费模式留单独预算。

~~~powershell
$npRoot = 'D:\HarnessMate\agy-np-test-profile'
$agy = (Get-Command agy.exe).Source
$testProfile = Join-Path $npRoot 'gemini'
$scratch = Join-Path $npRoot 'runs'
$probe = 'docs\phase-agy-native-parity\evidence\probe-acp.mjs'
node $probe --agy $agy --scratch $scratch --test-profile $testProfile --discover-confirmed
$modelId = '<由上一步实际广告的 Gemini 3.8 Flash model ID>'
node $probe --agy $agy --scratch $scratch --test-profile $testProfile --reactive-confirmed --model $modelId
~~~

| 同场景结果 | 归因 |
| --- | --- |
| 无后台化证据或无任务结束证据 | 未触发/样本不完整，保留真实装置错误并复验 |
| 任务结束、官方同场景有 wake，raw ACP 无相应帧 | 上游 ACP 暴露/版本问题候选。对比本机授权 raw、确认观察窗口，提交脱敏记录前征得用户同意 |
| raw 有 wake/请求，normalized 没有或进入占位轮次 | Adapter parser、归属、注册、连接进程要查 |
| normalized 完整，canonical 被提前收口或 scope 错误 | SessionManager、审批路由或 persistence 工序 |
| canonical/spans 正确，UI 仍 idle 或没有卡片 | WS cursor、store 或 projector/UI 工序 |

Probe 输出为 allowlist 摘要。CLI 自身本地日志留在 D 盘 scratch，交互审批详情只到 stderr。禁止提交原始本机日志、Profile、真实会话路径或账号内容。后续录制规范在 [测试策略](12_Test_Strategy.md)。
