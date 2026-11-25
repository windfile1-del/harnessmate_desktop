# G3 第一批联合审查 · NP-08 至 NP-11

审查日期 2026-11-25（Asia/Shanghai）。四份交付均直接从 `agy-np-g2 @ fdd1193cf2b36dbacf9ef9d4cba9f19dcc920a9c` 开工。各任务工作树干净。71 个文件一共覆盖四个独立模块、测试、夹具和交付报告，文件无重叠。联合审查快照是 `60c01f5927d6af5de40131d792598013436942cb`。

| 工作包 | 受审交付 HEAD | 交付范围 |
| --- | --- | --- |
| NP-08 Swarm | `007209d6584ce6de0aae663491cba6092e15ef4e` | 18 文件。Coordinator、Worker、Verifier、Board 与轨迹、T10 回放。 |
| NP-09 Boost | `d7bfd2c9373315640ca47066c9564f811eb1a1e5` | 15 文件。资格解析、阶段、验证与停止、T11 回放。 |
| NP-10 Teamwork | `fd13f84ee059725d6cccb35bb9d3987835ce0b97` | 17 文件。访谈、Prompt Artifact、里程碑、审计与角色、T12 回放。 |
| NP-11 Dynamic Workflow | `50e4c1686aa5b8ae7487abd18b5387b9cff291e7` | 21 文件。脚本审阅、执行图与降级时间线、日志和结果、T13 回放。 |

**审查状态**　四项领域交付已收到。连接归属和历史隔离修复后再联合接线与复验。四个 Studio、目录和资源读取属于预定的总指挥共享接入任务，范围按 [第一批开工安排](../handoffs/G3_Launch_Plan.md) 执行。本地集成仍以 G2 为产品源码基线。付费模式原生触发、协议字段和正式审批控制等待真实证据。

后续修复与第二批固定开工点见 [第一批修复复验](G3-wave1-verification.md)。以下保留交付入站时的结论。

## 待修复与联合接线

文件路径和行号以快照 `60c01f5` 为准。

| ID | 源码与复验 | 验收要求与负责人 |
| --- | --- | --- |
| G3-01 · 接线 | `packages/daemon/src/harnesses/agy/native/wiring/composition.ts:262` 维持高级工作流命令门控关闭。:298 仅注册时间线读取器。 `packages/web/src/App.tsx:83` 只注册 G2 Runtime Center 和 Subagent Manager。分支范围与所有权约定一致。 | 总指挥负责单一连接分发，按已归属 workflow kind 路由资源读取，在工作台注册四个 Studio。联合用例走正常启动入口，覆盖快照、WS、资源和禁用路径。保留生产默认关闭及无证据模式的控制门控。 |
| G3-02 · P1 | `packages/daemon/src/harnesses/agy/native/workflows/boost/observer.ts:457` 先把通用错误交拒绝分类，:876 直接结算当前 Boost。 `boost/resolver.ts:625` 将所有未分类 JSON-RPC 错误视为 `unknown_denial`。合成复验中，无关配置请求的 `-32602` 将已启动的 Boost 改写为 `failed`。 | NP-09 与命令接线 owner 先验证同一启动 RPC（保留数值/字符串 ID 类型）或经确认的 Boost 原生工作流 ID，再更新拒绝和资格。配置 RPC、普通工具与其他工作流错误不改变 Boost 状态。 |
| G3-03 · P1 | `packages/daemon/src/harnesses/agy/native/workflows/teamwork/observer.ts:564` 仅当 `not_advertised` 时拦截，`not_observed` 仍产生 queued 记录。:644 的目录处理发生在历史判断之前。合成复验无广告时返回 `accepted: true`，随后历史广告把活动目录改为 `advertised`。 | NP-10 与命令接线 owner 只接受当前活跃连接真实广告与显式命令。历史广告与历史 Artifact、里程碑保持只读。正常路径将已确认的 receipt 与当前 Artifact ID、请求 ID 关联。 |
| G3-04 · P1 | `packages/daemon/src/harnesses/agy/native/workflows/swarm/swarm-observer.ts:491` 只在连接 ID 非空时检查，:861 断线后清空 ID。 `packages/daemon/src/harnesses/agy/native/workflows/dynamic/observer.ts:408` 入站时直接取/建 scope，:833 的审批解析只凭 workflow/tool ID 查找。合成复验中两者断线后接收旧帧并显示 `finished`，Dynamic 将无关连接和原生会话解析为 `confirmed_workflow`。Boost 实测旧连接的取消帧把 stale 改为 cancelled。Teamwork 实测旧帧在断线后重新占用连接槽，并拒绝另一连接的帧。源位置为 `boost/observer.ts:975`、`teamwork/observer.ts:614` 与 `:1318`。 | 四个模式 owner 与总指挥在 attach、ingress、close、request resolver 使用同一活跃绑定、代次、connection 和原生会话/已证子会话映射。测试断连前后、同代换连接、旧代次、数值和字符串 RPC、跨 profile 及无上下文请求。拒绝旧帧不产生投影、持久化或授权副作用。 |
| G3-05 · P1 | `packages/daemon/src/harnesses/agy/native/workflows/dynamic/observer.ts:528` 将 replay 与 live 帧放入同一 workflow 记录，:633 直接更新状态。 `swarm/swarm-observer.ts:608` 记录 replay 诊断后沿用常规 mutator。Dynamic 实测旧 running 帧把已结束的 live 记录改为 running。Swarm 同样复现历史帧把终态改回 running。 | NP-11、NP-08 与 Recovery owner 保持 live 物化状态、审批路由及保活只由活跃 live 数据推进。历史通道只补只读轨迹。对同一原生 ID 的历史与 live 乱序单独验证。 |

## 联合门禁

| 门禁 | 联合快照结果 |
| --- | --- |
| `git diff --check` | 四个交付范围与联合范围通过 |
| `pnpm build`、`pnpm typecheck`、`pnpm contracts:check` | 全部通过 |
| 全量 Vitest | Windows 逐包使用 `--maxWorkers=1`。Protocol 6/6，Web 106/106，Daemon 221/221，共 333/333。包含 T10 至 T13 和既有跨 Harness 回归。 |
| 专项复现 | 8 组复现断言通过，分别见 G3-02 至 G3-05 |

联合测试执行的是交付快照内的现有测试。专项复现单独执行，验证接线前的失败场景。

独立复现使用在 D 盘快照中构建的 Daemon JavaScript 模块和 T10/T11/T12 的合成输入，观察了八组异常结果。执行 `pnpm build` 后，将 [复现探针](../evidence/G3-wave1-mode-review.probe.mjs) 放入联合快照的 `packages/daemon/tests/`，运行 `node packages/daemon/tests/G3-wave1-mode-review.probe.mjs`。该探针断言当前异常，修复回归需将断言反向。真机证据等级按既有矩阵执行。

## 合入顺序

1. 优先解决 G3-02 至 G3-05，先冻结同一连接 fence、工作流归属校验和事件来源的用例。
2. 总指挥接 G3-01，先加默认关闭的观察与只读资源路由，再分别复验四个 Studio 和兼容性。原生工作流触发、Board、细粒度控制和 Artifact 批准等待实录与授权。
3. NP-12 至 NP-15 可从已审 G2 分支继续。NP-14 对接 Teamwork 和 Dynamic 的 Artifact 读审，NP-12 与 NP-15 验证 occurrence 恢复和整代次隔离。详见 [第二批开工安排](../handoffs/G3_Wave2_Launch_Plan.md)。
