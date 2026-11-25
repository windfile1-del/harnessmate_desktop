# 05 · HarnessMate 源码审计

所有路径与行号针对 [0409bc8](https://github.com/windfile1-del/harnessmate_desktop/tree/0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039)，相对仓库根目录。静态证据用于确认代码路径及可能影响。用户观察到的真机 wake 故障需按 [协议对照](06_Protocol_Evidence.md) 归因。

## 当前调用链

~~~mermaid
flowchart LR
  A["ChatStage / Composer / Settings"] --> B["REST / WS · server/app.ts"]
  B --> C["SessionManager · per-session startup lock"]
  C --> D["AgyAdapter + AGY flavor + LaunchContext"]
  D --> E["AcpSessionHandle · StdioJsonRpcClient"]
  E <-->|stdio| F["官方 agy acp"]
  C --> G["SQLite · bindings / runs / events / approvals / turn items"]
  G --> H["Event bus / frontend store / projector"]
  D -. "有限子命令" .-> I["官方 agy CLI"]
  B -. "只读" .-> J["AGY profile / history / artifact / child files"]
  G --> K["Task Ledger / Handoff / Plugin event mapping"]
~~~

## 运行时、协议和身份

| ID | 基线位置及实际行为 | 影响 |
| --- | --- | --- |
| S01 | `packages/daemon/src/harnesses/acp-adapter.ts` 是兼容入口。`harnesses/agy/agy-driver.ts:85,339,416,615` 复用 `AcpAdapter`，经 flavor、launcher、profile 传入 CLI 和环境。`harnesses/registry.ts:51` 保护核心驱动。 | 优先增量扩展 flavor，保留适配器兼容导出及其他 Harness。 |
| S02 | `harnesses/acp/strict-acp-adapter.ts:580,742,977–998` 固定发 v1，false fs/terminal，读取部分 agent 能力和版本。`harnesses/types.ts:198–229` 主要是 session handle 能力和布尔。 | v1 是合适默认。需要分别表述规格、声明、触发、观察和控制。静态 `subagents` 能力不能当作真 child 支持。 |
| S03 | `harnesses/jsonrpc.ts:39–132,152–233` 以换行解析 stdin/stdout 对应流，用 pending map 关联 request/response，设置超时，进程关闭拒绝 pending，服务端请求经 callback 单独路由。`harnesses/process.ts` 处理命令生成、直接运行及 Windows 进程树处置。 | 已有传输缝可加脱敏 recorder 与 generation。RPC 超时和 transport exit 要分开，未知 server 方法在 strict 只记诊断，见 S08。 |
| S04 | `strict-acp-adapter.ts:1544–1655` 普通发送直接进入 `session/prompt`，15min 客户端 RPC 时间上限，响应时立即清空 `currentTurnId`，合并文本/思维，AGY `afterTurnPrompt` 静默失败检查后转 completed/cancelled/failed。结算 closure 读当前槽，未捕获自己的 turn id。`:1660–1692` Stop 即清槽和结算，steering 单独发第二个 prompt。 | Prompt 与用户轮次、native work 绑定，旧响应在取消并开始新轮后有机会读取新 turn。旧响应、两个短时间 steer、真实 15min+、重复完成都需要回放。上游 1.5.15 延长 finite prompt 后，固定 deadline 更容易碰到长任务。 |
| S05 | `strict-acp-adapter.ts:1770–1775,1841–1875` 确实使用 `turn_unknown` 与 `turn_bg`。通知未校验外层 `params.sessionId`，累加当前 handle 的 assistant/thinking。`:1900–1916` 工具按 ID 与事件转发。 | **纠正附件第 15 行。** 晚更新可被转发到占位 turn，若新 turn 已在跑，晚活动可能混入。子通知也会误投影或漏归属。AGY 审批还会被 flavor 提前处理，见 S08。 |
| S06 | `harnesses/agy/agy-protocol.ts:158–251` 依据标题和 rawInput 猜测 invoke、schedule、background、goal。后台保活信号为布尔，`agy-driver.ts:233–239` 转发，`strict-acp-adapter.ts:1695,1852–1854` 将其变成一个 30min TTL。`parseAgyBackgroundOrSubagentUpdate` 的 invoke 分支未给保活值。 | A 完成可清掉仍运行的 B，daemon 完成仍可能刷新 TTL，只有 status 的补丁缺标题/rawInput 时漏识别，Cron/定时器会混入命令。现代码不能证明有限任务阻塞集合。 |
| S07 | `core/session-manager.ts:174–199,2294–2376,2379–2403` 按 sessionId 串行启动，warm handle key 为 sessionId+harnessId。池达到 6 时找非 running/awaiting 且未标 background 候选。正常 prompt 结束后多数 handle 仍留在池内。`:2619–2620` 有 reload 时仍.dispose。 | **进程并非每次 Prompt 后被杀。** LRU、恢复、配置 reload、账号退出、全局关闭等才是重要可复现分支。无候选时池可增长。保活需要显式、可诊断的原因，不应只改 TTL。 |
| S08 | `strict-acp-adapter.ts:1770–1838` 只显式处理 `session/request_permission`，key 为 `acp_req_<id>`。先执行 `agy-driver.ts:304–335`，**若没有当前 turn 或实际请求 sessionId 非当前根，直接回 cancelled**，后续 `interaction_*` 解析及 `approval.requested` 不运行。未知 Request 只记诊断。`:1699–1740` 未匹配答案时可能选首项。 | AGY 晚审批可能直接取消。Child 请求同样可能被挡在路由之前。E08 验证取消路径，真机是否收到同样的 raw 请求仍待证。需区分未知目标与有证据的 child、固定选项和可编码表单。 |
| S09 | `harnesses/agy/agy-child-work.ts:22–123` 按 `brain/<parent>/.system_generated/subagents/<id>.json` 探查，读 256 KiB，详情首选同名 JSONL，找不到回退父路径 transcript。`AgyStudioBlocks.tsx:77–122` 读取工具调用 ID 作为 record ID。`server/app.ts:2600–2632` 用当前 adapter context 查询。 | 缺少 child→parent 链和 tool→child 证明。父 transcript fallback 存在错误标注风险。本机 App 文件为 `conversationId/state/spawnStepIndex`，且本次样本无同目录 JSONL。导入/隔离/profile 选择要随绑定而变。 |
| S10 | `harnesses/agy/agy-turn-outcome.ts:15–111` 只读会话 DB，比较 prompt 前后 step index，识别 type 17、quota/reset。`harnesses/history-scanner.ts:75,83–185,515–610` 针对 CLI/桌面数据分区解析 history，`session/resume` 和 load 与历史读取分开。 | 可保持版本化有限修复。错误记录与 active segment 必须有关联和界限。历史段不能触发实时审批、stop、任务完成或额度状态推断。 |
| S11 | `harnesses/agy/agy-launch-context.ts:89–188` 设置 CLI/Profile、清除宿主 auth env、官方参数；`agy-profile-manager.ts:47–84,99–171,176–362` realpath、ACL、配置准备及 skills/rules 同步。`agy-auth-service.ts:16–104,131,255,384,507` 校验官方 OAuth URL/回填，负责登录和退出。`core/failover-service.ts:264` 对选中的同 AGY driver fallback 做防轮换。 | 真实 OAuth 隔离仍分平台和方法。新路由必须继承已确认的 profile 和 source，继续由官方 CLI 管凭据。盘点所有自动入口的 consumer dispatch，还需覆盖 auto switch、插件动作与 HM Orchestrator。 |

表中未加目录的 `strict-acp-adapter.ts` 位于 `packages/daemon/src/harnesses/acp/`，`harnesses/`、`core/` 和 `server/` 均在 `packages/daemon/src/`。`AgyStudioBlocks.tsx` 位于 `packages/web/src/components/agy/`。

## 命令、持久化与前端

| ID | 基线位置及实际行为 | 影响 |
| --- | --- | --- |
| S12 | `core/harness-commands.ts:11–33,40–79` 有内置命令和 query 工具。`agy-commands.ts:43–149` 的 usage/skills 独立 print JSON，工作命令用 stream-json 或 compact print，把当前 native ID 用作 `--conversation` 并仅取最终 JSON result。`strict-acp-adapter.ts:1463–1532` 当 `input.cliCommand` 与 flavor 允许则另起 CLI，可能更新 handle 的 native ID。 | 独立查询适用，工作流经该路会失去 ACP 实时信号，也可能使仍在线 ACP 与返回 ID 不一致。现有 `goal` 明确经 `session-manager.ts:1543–1551` 的 rawCommand 路径。已证明的风险与未来 Swarm/Boost 等新入口分开跟踪。 |
| S13 | `strict-acp-adapter.ts:1941–1987` 解析并推送 `available_commands_update`。`session-manager.ts:1397–1422` 合并 adapter cache 与静态目录，`1487–1582` 仍用内置 switch。`packages/protocol/src/remote-v1.ts:86–95` 的公共请求校验只准八个已有名字。 | 新广告命令可以出现在列表，却会被现有 POST enum 拒绝。全实例缓存可能串 session 选项。`session-manager.ts:1561` 的 skills 查询未传 session 的 harnessId，工具默认回落到 'agy'，应测试多 Profile。 |
| S14 | `session-manager.ts:2580–2637` flush，expire 会话审批，结算会话内 running items、写 completed、删除 active meta、更新 binding seq、idle，触发 checkpoint、Attention 与 HM Orchestrator idle。`:2735–2910,2974–3055` 晚事件仍可进入 coalescer/Canonical/Approval。 | 完成过早且收口范围过大。正常 HM turn 和 native 切片要隔离，同时避免在晚帧上给 Task Ledger、Handoff、Orchestrator 伪造一次用户 turn。 |
| S15 | `db/sqlite.ts:231–500` 有 sessions、session_events、bindings、session_runs、session_turn_items、approvals、outbox、subagent_runs。`:2149–2227` 启动事务里将本地 orphan run/item interrupted、清理 process-bound 效果、过期审批；`session-manager.ts:188–198` 再把运行/审批会话设 idle。 | HM 本地恢复可继续执行，AGY 原生持久工作需要独立 reconcile。未验证的 work 应是 unknown，原连接审批不可复活。保留历史记录与旧版本回读。 |
| S16 | `packages/protocol/src/canonical.ts:34,507–561,762` 为 SessionStatus、CanonicalEvent 与 TurnBlock。`core/event-bus.ts:6–57` 同会话和全局发布隔离订阅者错误。`core/task-ledger-service.ts:196,1039–1088` 根据已结算 turn 与工具提取验证摘要。 | 新的 native state 独立投影。保持旧 event schema、checkpoint 与任务依据；版本化 opt-in 发布和迁移，禁止离线猜进度。 |
| S17 | `core/orchestrator-service.ts:316,381,521,826,845,1054` 创建 HM subagent run 或派发普通 turn，有 task cascade 与 parent 汇总唤醒。`core/handoff-snapshot.ts:25–63` 使用 HM 结构化上下文及 redaction，`session-manager.ts:1830–1895,2604–2617` 管 binding 与 seq 水位。 | 原生 child 不新增 HM 派发或聚合 prompt。手动 Handoff 可在清楚的边界继续。后台 native 事件不能被当成已注入到另一 Harness 的用户轮次。 |
| S18 | `session-manager.ts:2151–2241,2974–3055` 审批 DB、全局 ID+live handle map、120s 本地计时、会话级 pending 状态。`server/app.ts:2416` 复用运行时答复入口。 | 状态、过期范围和 RPC 发送竞态需要分 generation/目标实现。协议请求没有成功确认时，显示已提交或连接中断。 |
| S19 | `packages/web/src/stores/app-store.ts:368–512,1271,1344` 依据 seq 聚合 WS 与 REST，结束 turn 后刷新，`lib/projector.ts:534–614,909–950` 对 delta 查找或创建 turn，未见 ghost ID 筛选。`ChatStage.tsx:532–554,680,1758–1919` 以 session running/awaiting 推导 Stop 和发送，已完成只关闭对应 turn 的 block。 | 后到内容可能出现在孤立 turn/挂起 block，并与「已完成」共存。先修事件归属再做独立 Runtime Center。Store/reconnect 使用带快照水位的 native 独立投影。 |
| S20 | `components/agy/AgyComposerControls.tsx:5–80` 显示 Orchestrator、权限回退、steering、手动账户。`AgyStudioBlocks.tsx:9–155` 有 plan / child / background / artifact 卡。`AgyArtifactReviewPanel.tsx` 和 `AgySettingsSlot.tsx` 为只读 Artifact 和生态入口。 | 可重用 shared 卡与现有槽。缺模式选择、异步 task/child timeline、Workflow 专属 view 和有效的审批路由。现有 UI 静态测试不等同 native control。 |
| S21 | `server/app.ts:429–616,1378–1408,2400–2420,2600–2685` 有 Profile/auth 账户动作、命令、turn、RuntimeRequest、child/artifact/生态 API。现有 POST 命令 loopback，读取依据 session/adapter context。`agy-artifacts.ts` 读取已登记文件，`agy-ecosystem.ts` 做目录计数和能力快照。 | 版本化 native query 控制 profile 隔离与远端最小权限。预览任意 HTML/未审查路径及转义需复核，不发布绝对路径和 rawText 到插件广域事件。 |
| S22 | `packages/plugin-api/src/manifest.ts:5` API 4.0.0，`slots.ts:24–65,175–195` 有扩展位。`packages/web/src/slots/SandboxedPluginFrame.tsx:140,208,348` 有受限 bridge、browser preview 订阅与 `sandbox="allow-scripts"`。`packages/daemon/src/plugin-host/runtime/map-event.ts` 白名单投影，`docs/plugin-api/slots.md` 第一方可注册 React。 | 内建 AGY workspace 可复用 slots。第三方 iframe 仅有声明式受限可见能力，对实时 ACP、宿主管理权限和 AGY 内嵌 Browser 不是现成桥。本次审计与基线文件为准。 |
| S23 | `packages/daemon/tests/agy-replay-protocol.test.ts:37–73,216–340` stage fixture 与 mock server 回放。另有 auth/usage、config、launch context、lifecycle、Strict ACP、Session 核心、handoff、plugin/event 等；`packages/web/tests/phase-agy-ui.test.tsx` 检查现有 AGY UI。 | 保留原测试。当前无可对照的真实 late wake、两并行 finite、native 子审批路由与全新流程真机轨迹。[基线](01_Baseline.md) · [证据](06_Protocol_Evidence.md) |
| S24 | `core/orchestrator-service.ts:251–262,298–324,372–387,1028–1057` 验证注册实例与权限上限，然后创建子会话、发送任务或完成汇总消息，这些位置未按 AGY authMethod 过滤目标。`core/failover-service.ts:255–282` 同 AGY→AGY 有专门限制，其他来源到 AGY 仍需检查上层分发。 | 现有同类型防轮换不能替代统一的 consumer AGY 请求来源控制。目标注册、手动切换、自动派发和原生 AGY 内部委派要在集成测试中分别验证，此处是静态路径证据。 |

`web/src` 省略部分位于 `packages/web/src/`。本文的 `Sxx` 为矩阵、任务和测试中的源码证据编号。

## 离线复现的范围

[E08](06_Protocol_Evidence.md#合成输入复现当前适配器行为) 使用已构建的 Agy Flavor 和 Strict ACP Adapter，合成有限 A/B 未完成时的 early Prompt response。观察到本地过早完成，A 完成即释放总 lease，晚消息进入 `turn_bg`，晚审批回 cancelled。该实验复现了本地数据流，真实用户场景仍要捕获本机 1.5.16 的实际帧。
