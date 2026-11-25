# G2 · NP-04 至 NP-07 联合审查

审查日期 2026-11-25（Asia/Shanghai）。四份交付均来自 `agy-np-g1 @ b5d010ae74815a311d98090359b9d62894973024`。文件范围互不重叠，各分支 `git diff --check` 通过。用固定提交组装 D 盘审查快照，集成分支仍指向 G1。

| 工作包 | 受审交付 HEAD | 交付报告 |
| --- | --- | --- |
| NP-04 Reactive Runtime | `7d2c0ac236dad49b7ec8ba9c824f7366c8aa43c3` | `np04_reactive_runtime:docs/phase-agy-native-parity/handoffs/NP-04-report.md` |
| NP-05 Child Identity | `27b2caadb08e97db84e4dca81a25cd1c7b7a2c1c` | `np05_native_child_agent_routing:docs/phase-agy-native-parity/handoffs/NP-05-report.md` |
| NP-06 Command Router | `829d3ba4d1fe973fbbb5b500606af7bcc798515b` | `np06_native_command_router:docs/phase-agy-native-parity/handoffs/NP-06-report.md` |
| NP-07 Approvals | `06d1fb0fc765935490337b4f18833afb261f6ac5` | `native_approvals_elicitation_routing:docs/phase-agy-native-parity/handoffs/NP-07-report.md` |

**结论：四项交付已收到，G2 尚未通过。** 申请合入前，先关闭下列跨模块阻塞，再用实际启动入口完成联合复验。

### 联合门禁

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 通过。Vite 报告 `app-features` 为 602.16 kB，超过现有 500 kB 提示阈值 |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 通过。含插件契约检查，Protocol 6 项、Daemon 194 项、Web 85 项，共 285 项 |

285 项为交付快照已有测试。下列五项定向复现单独执行。

### 合入阻塞

| 编号 | 发现与证据 | 修复验收 |
| --- | --- | --- |
| G2-01 | **P1 · 原生与旧审批入口使用不同的授权流程。** `packages/daemon/src/harnesses/agy/native/wiring/routes.ts:950` 只对固定 permission 阻止表单，随后先占用 CAS，再交 NP-07 校验。对固定选项 question 提交表单实测 HTTP 500，回执变为 `delivery_unknown`，随后正确选项返回 409，wire 响应 0 次。旧入口 `packages/daemon/src/core/session-manager.ts:2012` 占用同一 CAS 后走旧 handle 映射，实测旧 UI 记录已解决，native 回执留在 `claimed`，wire 响应 0 次。 | NP-07 与共享 owner 统一验证、CAS 和原连接回复。无效输入返回 400 并保留 pending，随后正确选项写入一次。旧与新入口并发仍只写一次，终态与界面一致。 |
| G2-02 | **P1 · 审批回复后，运行时仍保活并等待。** `packages/daemon/src/harnesses/agy/native/runtime/controller.ts:1308` 用 `wire_req:<typed RPC ID>` 记原始待处理请求，`:667` 尝试用 opaque approval ID 清除。NP-07 在 `packages/daemon/src/harnesses/agy/native/requests/native-permission-router.ts:1280` 发布的事件也只有 approval ID。实测 NP-07 写入一次且队列已空，NP-04 仍返回 `pending_request:wire_req:n:41`。 | NP-04/07 以内存的绑定、代次、连接和原类型 RPC ID 对账，公开投影仅使用 opaque ID。成功、拒绝、过期、断连和换代都释放对应等待，其他请求继续独立持有。验证同序数字与字符串 ID 和双请求逆序。 |
| G2-03 | **P1 · 子 Agent 确认后，投影仍显示旧占位。** `packages/daemon/src/harnesses/agy/native/child/child-session-router.ts:2305` 在内存删掉 unresolved candidate，随后只 upsert 新 Agent。实测经真实 SQLite，内存仅留 confirmed Agent，快照同时保留旧候选和新 Agent。`packages/web/src/components/agy/native/child/child-tree.ts:218` 会展示旧候选。 | NP-05 统一晋升时的实体身份，或通过共享 owner 提供原子替换与增量删除。验证初始快照、WS 增量、断线重取和同角色双启动。每个已确认启动仅展示一个 Agent，独立无证据的启动仍可追踪。 |
| G2-04 | **P1 · 计划模式被拒绝后仍发出任务。** `packages/daemon/src/harnesses/agy/native/commands/router.ts:821` 忽略模式配置结果，更新目录后继续 dispatch。实测配置回调返回 `applied: false`、`effectiveValue: manual`，仍发出 `/plan <task>` 并返回 `accepted`。另有 `packages/daemon/src/core/session-manager.ts:1589` 的旧 `/skills` 调用缺少当前 `harnessId`。 | NP-06 按官方会话确认的配置结果更新目录。计划模式失败时不发送 Prompt，回执说明实际范围与模式。共享 owner 将旧 `/skills` 路径接到按会话查询，覆盖双 Profile 与失效实例。 |
| G2-05 | **P1 · 正常启动路径缺少组合接线。** `packages/daemon/src/server/app.ts:245` 只创建 registry，现有各域端到端用例仍在各自用例中调用 `registerModules`。registry 在 `packages/daemon/src/harnesses/agy/native/wiring/registry.ts:121` 只有一个 timeline reader 槽位。依次注册 NP-04 与 NP-05 会覆盖前一个。Web 侧两个工作台注册函数也只有测试调用。 | 共享 owner 负责统一启动、按 activity/agent 分发时间线、用当前绑定连接真实 ChildScopeResolver 和审批、订阅能力目录、接入前端用到的详情和动作。用官方启动入口的合成 peer 验证两类时间线和工作台。 |
| G2-06 | **P1 · 通用 Stop 先于原生确认完成宿主结算。** `packages/daemon/src/core/session-manager.ts:1973` 发通知和 interrupt 后立即结算宿主运行，`packages/daemon/src/harnesses/acp/strict-acp-adapter.ts:1791` 在送出取消通知后立即清空当前 turn 并发出 `turn.cancelled`。NP-04 的宽限状态机因此无法控制这条主入口。 | NP-04 与共享 owner 区分请求已发送、目标终止已确认和超时未知。覆盖正在等待的 turn、按目标停止、多任务未受影响及 Stop 后下一轮的迟到帧。仅声明经证据支持的控制范围。 |

### 复验顺序

1. NP-05 修正投影晋升，NP-06 修正配置失败与回执。两项可在各自分支独立修复和复验。
2. 共享 owner 单独接入 NP-04/07 的审批状态对账、双入口 CAS 和 Stop。接线同时纳入 NP-05 的作用域解析、NP-06 的目录和按 Profile 查询、工作台注册与详情。
3. 用默认关闭与显式开启两套配置分别运行端到端。开启时从实际启动入口连接本机模拟 ACP 对端，验证早响应、后台活动、固定选项问题、Stop、恢复后的快照和 WS。关闭时检查既有 AGY、其他 Harness、Context Handoff 和 Plugin SDK。以下一轮交付 SHA 重审。
4. 真实窗口仍使用 U01 专用 Profile 的 Gemini 3.8 Flash 一次发现与一次 20 秒复现。原生唤醒、已确认 child 协议身份、脱轮次审批、Stop 和官方客户端对照分别记录取证结果。[U01 执行说明](../handoffs/G0_Test_Profile.md)

### 定向复现

候选快照 `D:/HarnessMate/agy-np-worktrees/tmp/g2-review-46cb417a`。以下审查用例断言当前异常，五项均成功复现。它们留在 D 盘临时副本。转入正式回归时反转断言，检查修复后预期行为。

~~~powershell
Set-Location 'D:\HarnessMate\agy-np-worktrees\tmp\g2-review-46cb417a'
$env:TEMP = 'D:\HarnessMate\agy-np-worktrees\tmp'
$env:TMP = $env:TEMP
$env:TMPDIR = $env:TEMP
pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np07-native-requests.test.ts -t 'G2 review reproduction'
pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np05-child-routing.test.ts -t 'real SQLite AgyNativeRuntimeRegistry'
pnpm --filter @harnessmate/daemon exec vitest run tests/agy-np06-command-router.test.ts -t 'G2 review reproduction'
~~~

证据来自源码、合成调用、真实本机 Fastify 和 SQLite。U01 等待授权采集，能力矩阵保留现有真机等级。
