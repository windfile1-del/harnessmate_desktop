# NP-02 独立评审 · e58948f

评审日期 2026-11-25（Asia/Shanghai）。结论 **修改后复验，G1 契约暂不冻结**。基线 G0 `a01280176348974a0ddc00fd491afddc1d985c9e`，源码审计基线 `0409bc8a4ea85d05ef6b0ee85fc2d0b980f06039`。审查 `np02_shared_contracts_persistence @ e58948f7e55cb152cd8cbd44392fef5302936b4e`，代码 `a701cf780665e13d20cbc20600e650a924780811`。该分支的 `docs/phase-agy-native-parity/handoffs/NP-02-report.md` 保留作者的提交与验证记录。

## 合并前需修复

### R1 · P1 · 写入未按当前 binding 和 generation 隔离

`packages/daemon/src/harnesses/agy/native/wiring/persistence.ts:455` 只按 runtimeId 读取 binding，未在事务内比较 generation 或所属 session/instance。`:723` 又用调用者的 generation 写回当前记录。独立内存 SQLite 用例先替换 generation，再用旧 binding 提交 `native.runtime.changed`。旧事件写入 seq 2，快照回退到旧 generation，Registry 缓存仍指向新 generation。

`persistence.ts:843` 在新代快照中包含旧代 pending 审批，`:1124` 的 CAS 只比较收据自身 generation，没有核对当前绑定。独立用例换代后仍看到旧 request ID，调用旧 generation 的 CAS 返回 claimed。实体、关系、capability snapshot 的读取也需明确旧代属于历史或 stale 的规则。`packages/daemon/src/core/session-manager.ts:2346` 只在同次调用仍有旧内存 entry 时请求换代。关闭/回收后新句柄、重启后的第一次连接，需有独立的 generation 规则。

在同一事务中校验 runtime/session/instance/generation，绑定推进由专用入口负责。拒绝过期或跨绑定的事件、收据和 mutationKey 重放，旧审批要失效，历史保持可读并明确来源。用重启、回收重连、Profile 切换、旧事件和迟到审批覆盖 SQL、Registry 缓存、REST/WS 一致性。

### R2 · P1 · 并发同键请求会重复执行，控制授权未形成闭环

`packages/daemon/src/harnesses/agy/native/wiring/routes.ts:463` 和 `:554` 只在重放且已有 response 时提前返回。原请求在执行中时，后续同键请求也会进入执行 port。用 Fastify 注入同一个 inspect 请求，把第一次执行挂起，再发送同键请求，两次都进入命令桩，最终均返回 200。异常后的未完成收据也需要明确后续处理。

`routes.ts:482` 的控制路径在进入 port 前校验了 generation 和数据形状，未检查目标归属、revision 是否有效或 descriptor 是否开放该 control。独立 fixture 的 descriptor 为 control `not_tested`，提交不存在的 work 目标仍进入 stub port 并返回 200。`:614` 至 `:643` 的审批路由只对查得到的请求核对 option。缺少匹配 pending 时当前仍调用 port。需要明确并验收最终权威由哪个模块承担，包含旧与新审批入口共用 CAS 的路径。

只有成功取得首次执行权的请求进入 port。进行中返回可重试状态或复用原结果，副作用已发但回执未知时保留不确定状态。控制和审批在唯一权威校验实际 binding、连接、当前 descriptor、target revision 和选项后才写 wire。复验同键并发、异 payload、异常重试、断连、过期和所有入口。

### R3 · P1 · WS 单页回放误报完成，换绑定后有静默路径

`packages/daemon/src/harnesses/agy/native/wiring/ws-feed.ts:200` 单次读取最多 500 条，`:249` 忽略 `hasMore` 发 `native_replay_complete`。独立本机 loopback WS 用例预存 501 条，客户端只收到 500 条回放后就收到 complete，下一条 live 到达仍缺第 501 条。`:177` 静默忽略不同 runtimeId，导致 Profile 变化后旧订阅无法仅依靠服务端通知完成重同步。REST replay 在 `persistence.ts:979` 按 runtimeId 读事件，读页可能包含不同 generation。当前契约需说明跨代历史与当前订阅的关系。

在有界范围内回放完整连续前缀才宣告完成，或显式返回缺口/分页续读状态。处理 runtime 和 generation 变化、cursor 失效、回放期间 live 到达，以及连接慢于生产时的有界缓存。用 501+ 事件、旧游标、更换 runtime/代次和慢消费者复验。Upgrade 入口也应对路径解析失败返回受控错误，并统一 REST/WS 的 AGY session 范围。

### R4 · P1 · Feature-Off 和数据出口边界需要明确

`packages/daemon/src/core/session-manager.ts:2337` 会在 feature-off 为普通 AGY 句柄分配 native binding 并接 hooks，只检查迁移读写版本兼容。原生事务异常可从这一路径影响旧会话。打开过 native 后关闭门控的快照依然投影已有数据，`registry.ts:427` 可返回历史的 available 描述，读取 port 在 `routes.ts:206` 与 `:303` 仍可被调用。独立 fixture 的 gate 关闭时快照仍返回旧 runtime 状态和 seq 2，与报告里的 Known Empty 语义有差异。

`packages/protocol/src/agy-native-v1.ts:1130` 的 workflow `items` 接受任意嵌套记录，`routes.ts:323` 直接序列化读取 port 返回的数据。独立校验确认任意 debug 字段及虚构本机路径能通过此出口 schema。现有证据仅为合成类型反例。`routes.ts:468` 和 `:558` 也直接持久化和输出命令/控制 port 的响应。命令入口签发 `human_direct`，而 `session-manager.ts:1624` 在没有 provenance 时跳过校验。签发和验证边界应明确哪些内部或外部调用来源已被可验证入口认定，不能把请求发起途径等同于人工确认。

确认关闭门控后的历史只读策略。原生观察缺失、关闭或失败时旧会话保持可用，保留的旧数据明确标记过期与不可控制。各端点用经过校验的公开 DTO，按类型明确定义 workflow 资源字段和摘要。对比启动前关闭、运行后关门控、缺表/IO 故障、已有历史及自动/手动发起路径。第三方插件签名、RPC 观测和原生动作边界仍沿用 [决策](../15_Decision_Log.md)。

### R5 · P1 · 生命周期 port 需要明确 held 退出和审批故障语义

`packages/daemon/src/harnesses/acp/strict-acp-adapter.ts:1662` 在旧轮 guard 前调用结算 hook，held 后直接 return 并保留 currentTurnId。`packages/daemon/src/core/session-manager.ts:2650` 也可丢弃旧的 `turn.completed`，当前 port 声明未提供可调用的延迟结算出口。推断尚需 NP-04 在现有共享边界内接通释放路径。结算 hook 在成功路径抛出时可能进入 failure 回调再调用一次； `registry.ts:279` 起的审批/结算调用也应定义异常、默认回执和单次写入语义。当前审批 ingress 有 replay/live 区分，权限回调需要同样的可验证作用域。

NP-02 与 NP-04/07 冻结带 captured binding、turn 和原始 RPC 的保留、释放、断连、取消合约。以合成 peer 验证 held 后可以通过公共 port 完成一次结算，旧轮结果只更新旧观察记录，hook 异常留下明确结果，审批在断连和 replay 情况不能转成新 live 许可。验收通过后领域实现再接入。

### R6 · G1 联审 · 观测与 Web 的可消费版本仍需对齐

`packages/protocol/src/agy-native-v1.ts:1356` 的采集 metadata 定义使用字符串 protocol、`in/out/internal`，且严格对象不包含 NP-01 的 `layer/provenance/correlation`。对 NP-01 已交付无身份 Windows 证据检验，9 条记录中 0 条直接通过。明确这是何种 envelope，提供统一 schema 或版本化映射，并让 NP-01 的脱敏捕获通过跨包夹具。当前 raw tap 仅为候选接入点。

后端 snapshot 是直接 projection，events 用顶层 `runtimeId/generation`，timeline 用 `entries`，WS 为专用路径。NP-03 stub 当前期待 `projection` 包装、`binding` 和 `items` 等不同形状。审批与能力字段也有差异。报告所称 v1.0.0 作为候选修订保留，NP-02/03 清点接口差异，用真实 daemon 启动但 stub AGY 的契约测试打通 Known Empty、分页/WS、审批收据与禁用行为。避免让两份独立类型继续并行演化。

## 门禁与后续

- 23 个文件在 NP-02 所有权范围内。分支干净，`git diff --check a012801 HEAD` 通过。无 Web 或公开 Plugin SDK 文件变更。
- 独立全量复跑 `pnpm test` 退出 0，插件契约及 197 项测试通过（protocol 5、daemon 142、web 50）。`pnpm typecheck` 独立复跑通过 6 个 workspace 包。构建通过来自作者门禁记录。
- 独立反例使用内存 SQLite、Fastify inject、本机 loopback WS 和公开脱敏夹具。命令与控制只调用 stub，期间未启动 AGY、使用账号或接触生产数据库。当前真机能力等级沿用 G0。
- NP-02 在原分支追加修复并提交新 HEAD，按 R1–R6 复验。NP-01 采集 schema 和 NP-03 前端契约可先对齐候选接口。G1 同时检查 [依赖图](../10_Task_Dependency_Graph.md) 中的 NP-01、NP-03a 条件，再向 NP-04–07 发出稳定基线。
