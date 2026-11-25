# G2 · NP-04 至 NP-07 修复复验

日期 2026-11-25（Asia/Shanghai）。G1 固定基线 `b5d010ae74815a311d98090359b9d62894973024`。候选组合来自 NP-04 `7d2c0ac`、NP-05 `27b2caa`、NP-06 `829d3ba` 和 NP-07 `06d1fb0`。原始发现、源码定位和五条复现记录在 [联合审查](G2-intake-7d2c0ac-27b2caa-829d3ba-06d1fb0.md)。本轮处理 G2 六项阻塞。四份原交付保留为集成合并的父提交，联合修复源码为 `f895bf44ad5e850109ab8641fbfb81522214390f`。

| 编号 | 修复落点 | 复验 |
| --- | --- | --- |
| G2-01 | `wiring/routes.ts`、`requests/native-permission-router.ts`、`core/session-manager.ts` | 输入校验先于 CAS。固定选项误传表单返回 400，随后可正确提交。旧 UI 和原生入口使用同一 NP-07 原连接及共享收据，两个入口竞争只写一次。 |
| G2-02 | `runtime/controller.ts`、`wiring/registry.ts`、`wiring/composition.ts` | 绑定、代次、连接和有类型的 RPC ID 联合确定待回答项。公开投影用 HM 不透明 ID。合成 stdio 同时持有数字 `8101` 和字符串 `"8101"` 请求，逆序响应后仅释放匹配的保活项。 |
| G2-03 | `child/child-session-router.ts`、Web `native/child/child-tree.ts` | 同一 launch work 的候选可原地晋升，SQLite 复验该实体保持同一个 ID。已有确认身份时在树中收起同 launch 的冗余候选，保留其他未确证启动。正常启动发布根实体，断连发布 stale 状态。 |
| G2-04 | `commands/router.ts`、`core/harness-commands.ts`、`core/session-manager.ts` | 原生计划模式失败时返回确认结果，发送次数为零。提交任务前校验当前活跃句柄和已应用的原生模式。传统 `/skills` 解析当前会话 Profile，失效实例拒绝回落默认账号。 |
| G2-05 | `wiring/composition.ts`、`server/app.ts`、Web `App.tsx` 与 Runtime Center | 正常启动注册四个领域。主活动及子 Agent 走不同的时间线 reader。目录修订进入原生投影与事件流。工作台接入原生请求详情、结构化答复、命令目录与根会话 Stop。 |
| G2-06 | `strict-acp-adapter.ts`、`core/session-manager.ts`、`runtime/controller.ts` | 通用 Stop 发送原生请求并保留等待态，收到确认才结算。宽限期走 host 结算与 native unknown，独立后台工作不由该宽限期推定结束。同代旧连接帧和换代迟到帧受限。 |

## 验收证据

| 门禁 | 结果 |
| --- | --- |
| `pnpm build` | 通过。Vite 的 `app-features` 为 603.91 kB，超过既有 500 kB 提示阈值。 |
| `pnpm typecheck` | 通过。 |
| `pnpm contracts:check` | 通过。 |
| 全量 Vitest | Windows 按包依次运行，每包 `--maxWorkers=1`。Protocol 6/6、Web 85/85、Daemon 199/199，共 290/290。 |
| Git 补丁校验 | Git 规范化行尾后，69 个受改源码与测试文件的提交内容和已测候选一致。G1 至 G2 的 `git diff --check` 通过。 |

环境复验记录。受限运行中的 `taskkill /T` 拒绝访问，AGY 测试临时目录清理与 OpenCode 子进程退出受影响，两项在允许本机进程清理的复验中通过。默认并行 `pnpm test` 中，既有 Triage Inbox 的单条查询计时为 17.36 ms，高于 16 ms 阈值。按包单 worker 运行同一测试集通过，保留原有断言。
- 联合测试由 `createDaemon` 启动，经真实 Fastify、SQLite、HarnessMate SessionManager、AgyAdapter 与 stdio JSON-RPC 测试对端执行。验证时间线隔离、子 Agent 请求、固定选项和表单、断连、Stop 暂态及终态。独立 NP-04 用例覆盖早响应、双后台任务乱序完成、宽限超时与迟到事件。Web 采用组件测试和构建。
- 产品默认关闭。隔离环境可在启动 Daemon 前设置 `HARNESSMATE_AGY_NATIVE_RUNTIME=1`，前端沿用 `hm_agy_native_ui` 本地开关。ACP v2 Preview 关闭。默认关闭路径、其他 Harness、旧客户端契约和 Context Handoff 包含在全量回归中。

## 真实环境证据

U01 官方交互登录、Gemini 3.8 Flash 能力发现、20 秒真实唤醒、真实子 Agent 审批和官方客户端对照单独验收。能力矩阵维持已有真机证据等级。根会话 Stop 之外的独立工作、子 Agent 与工作流停止需要上游控制接口证据。原生计划任务的附件转送、真实账户原生命令及高级工作流入口仍需单独验收。G3 四份工作提示词见 [开工安排](../handoffs/G3_Launch_Plan.md)。
