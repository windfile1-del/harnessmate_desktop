# 12 · 测试策略与 Windows 真机验收

[基线](01_Baseline.md) 已全量跑过。新测试分明标记 `synthetic`、`replay_with_provenance`、`live_raw`、`live_hm`、`official_comparison`。合成和回放验证生命周期逻辑，L2 需要真实触发证据。L3/L4 同时需要已证观察及相应的自动化或实际 UI 验收。L5 只用 [对照记录](#windows-对照记录)。

## 观测协议与复放

每次捕获至少识别 `schemaVersion, captureId, scenario, platform, cliVersion, protocol, accountCategory, source, observedAt, producer, seq, monotonicMs, direction, messageKind`。同一录制中保留每条连接、调用、native session、child、tool、background/workflow 的稳定短别名。记录外层 JSON-RPC 形状、字段名、分类与次序，相关联地记录 adapter、canonical、projection 以及浏览器错误。stderr 单独，允许哈希后的诊断形状。必须标明截断、数据缺失、采样阈值。无稳定 ID 的时候保留原始包序，不能按重复文本去重。

录制需要主动启用，运行在专用 workspace。发布只用 allowlist 重建的 NDJSON 或经过数据审查的最小 fixture。过滤 OAuth 网址参数、凭据头/cookie、账号、路径、代码、prompt 和 response 正文、审批内容、插件秘钥。可保留固定测试标记哈希、枚举和值的类型。脱敏后能复现 request/response 与关联场景。对真实日志的意外泄露用测试夹具捕获，原始文件不进入仓库。旧 `agy-1.5.14` fixture 保留，标清它合成的响应时序。

## 测试层次

| 层 | 重点与执行 |
| --- | --- |
| 单元 | patch merge、身份与 lineage、caps、已授权动作、RPC id 类型、proposal/actual 层次。合成的未知字段、null/omission、重复、冲突和非法输入 |
| 传输与真实回放 | stdin/stdout 乱序（多请求）、split/malformed 行、process exit、拒绝、late permission、bounded buffers、新旧 schema。不把测试服务器当 Google |
| Daemon 集成 | 真实 `SessionManager` / SQLite / API，唯一终态、transaction crash、事件发布、lease、隐私和 scope，warm pool at capacity、reload、两 instance 同名 native ID、恢复和 cancel |
| Web 集成 | snapshot/WS 断线、seq gap、render message route、child 审批、状态切换、focus、加载与虚拟化。支持 480px / 常见 Windows 桌面尺寸，纯 mock 不能验证真实 AGY |
| 跨 Harness | `pnpm test`、`pnpm typecheck`、`pnpm build`。Codex/Claude/Strict ACP/外置 Adapter，现有 Session/Checkpoint/Approval/Terminal/Plugin Contract/Context Handoff/Orchestrator，旧 AGY 1.5.14 回放。旧客户端看历史兼容 |
| 宿主及 L5 | Sig 有效的 Windows AGY，官方 CLI/App 同场景。写明构建、版本、正常与失败分支，Electron 装机/打包作为发布前独立范围 |

## 复现场景和必须记录的断言

| 用例 | 场景 | 必须看到或明确标缺 |
| --- | --- | --- |
| T01 | 单次正常 turn | ACP 握手、真实 available commands、模型 config、一次 prompt/error/stopReason、与 HM turn 对齐；无额外 prompt |
| T02 | 20s finite，之后只读工具与最后文本 | 时序至少含后台化、原生终态和之后新的 ACP 活动。复现 guide 见 [E07](06_Protocol_Evidence.md#授权后最小复现)。人工 follow-up 会使该次无效 |
| T03 | 5min finite、模拟 15min+、非零退出 | prompt 持久，非零与 timeout 各自保留真状态；连接异常转未知 |
| T04 | 两有限任务先 B 后 A，再加 1 个 daemon | B 终态不释放 A lease。daemon 不 hold，仍可单独观察真实状态 |
| T05 | 先后两次 wake 或晚完成工具行 | 新的原生 reply/请求建 activity，单纯旧工具结果更新旧项。usage-only 不重开会话 |
| T06 | 脱离原轮次的 permission/form | 发送方有据、展示与响应到相同原连接。过期、deny/allow_once、选项失效，旧 generation 阻断 |
| T07 | 真实 child 与 nested child；两相同 role launch | 工具 ID、parent/child/native Conversation 的映射有联合证据。child idle 不作 success。无字段始终 unresolved |
| T08 | 运行时 steering、队列 Send Now、晚响应与 Stop | 保持请求上下文。重放相同请求不再发送。Stop requested/confirmed 区分，后到帧不会转成新用户轮 |
| T09 | Schedule 一次/两次、早取消、重启 | 来源证明 deadline / occurrence，主轮次可结束，tick trigger 不用 HM scheduler |
| T10 | Swarm coordinator、Worker、Board、@mention | 只展示同一实际 run 能获得的 Board、worker 或权限。上游缺口以同场景截图和 raw 证明 |
| T11 | 一次低成本 Boost | 原生 trigger、可得角色/阶段、实际验证和失败。缺字段时不开 phase 展示 |
| T12 | Teamwork 访谈、批准/拒绝与首里程碑 | 记录表单与 Artifact action、项目 scope、已发原生里程碑。特殊审批无协议则由 App 手工执行，HM 最小视图可验证 |
| T13 | 动态 Workflow 串/并，结果失败或部分缺失 | original script review→phase→结果。无真实 DAG 时保持 timeline。不能执行另一个 Python 替身 |
| T14 | 取消、AGY crash、daemon crash、Windows 重启和前端刷新 | 无旧 pending RPC replay，scope 不串，reconciling/stale；只有安全的原生动作可操作 |
| T15 | Auth/账户使用、技能、额外目录与本地源 | 模拟两 Profile 匿名冲突 + 授权的单账户采样。path/reparse、未支持计划、ACP 新旧版本与 OIDC 手动会话 |
| T16 | 和官方 App/CLI 并行查看产物与 Browser/Review | 真实产物中的可用 content、操作经过明确 approval、路径限制，App-only 交互降级明示 |
| T17 | Consumer 自动派发、插件越权、跨 Profile/reset/恶意 Agent 内容 | 自动入口被边界拒绝，保留人手动选择及原生完整互动。所有输出/访问均受安全门控 |
| T18 | 高频丢帧和大历史 | 合成 10k events/100 agents/20 pending requests 压测，观察分页、p95、内存回收；低端负载设置对照基准 |

## 测试授权范围

首轮由用户确认使用 [D 盘专用个人测试 Profile](handoffs/G0_Test_Profile.md) 和 **Gemini 3.8 Flash**，执行 **一次能力发现与一次 20 秒有限后台 Prompt**。先从该 Profile 的实际 ACP 配置取模型 ID，未经对端确认模型时结束采样。空白探测和合成 replay 随时可跑。后续不同版本的运行、长脚本、带网络工具、多个账号、Boost/Teamwork/Swarm/大 Workflow 根据实际账户、模型和成本分别确认范围后再执行。原生 App/CLI 对照不登录或切换他人账号，不改变已使用的工作区和设置。授权记录只写账号类别和测试范围，不写实际账户。

优先对照 1.5.16 与执行当日的官方最新可用版。1.5.15 为版本分界对照，1.5.14 使用现有离线样本，旧版 1.5.10/11 可依赖上游报告直到获得可信官方二进制与专用环境。旧版不覆盖当前安装，需并排启用才做。客户端协议 preview 只在回放或确定支持的二进制测试。[CLI Releases](https://github.com/google-antigravity/antigravity-cli/releases)

## Windows 对照记录

每次对照由独立验收者固定 HM commit、官方二进制版本/签名、App/IDE 与 OS 版本、账号类别、模型、权限模式、路径副本与场景 Txx。依次运行 App、CLI、raw ACP、HarnessMate，记录可比的行为、事件时序和自己的证据 ID。App/CLI 对照不要求四端使用同一内部版本号，需写明实际分部版本。

Android/mobile 仅做已有客户端的兼容检查。包装、部署、远程消息和用户生产账号均需要相应明确授权。已验证操作可以按 L5 报告；来自协议缺口的能力写出 HM 可覆盖的部分，以及上游需提供什么信号。签名、独立审查提交、截图范围和日志脱敏复核在 [评审模板](reviews/README.md)。
