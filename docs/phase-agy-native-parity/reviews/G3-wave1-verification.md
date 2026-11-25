# G3 第一批修复复验 · NP-08 至 NP-11

验证日期 2026-11-26（Asia/Shanghai）。修复提交 `c6802f5c633446745b5265dfb5f877d134ca9306`。联合源码 `5711a8266bdca72fd34a5dd07f59aedfb108a237`，含四份领域交付与[原审查记录](G3-wave1-intake.md)。`agy-np-g3-wave1` 固定同一源码和第二批任务提示词。

| 审查项 | 修复及回归 |
| --- | --- |
| G3-01 联合接线 | `native/wiring/composition.ts` 汇聚已挂接的连接，在内部 `nativeWorkflowObservation` 门控下接入四个观察器、目录贡献和资源读取。资源先查当前绑定持久化投影，再按已存工作流类型选择读取器。Web `App.tsx` 在既有 AGY Workbench 门控内注册四个 Studio。 |
| G3-02 Boost 错误关联 | `boost/observer.ts` 将错误绑定到启动 RPC 的原始类型和 ID，或绑定到已经确认的 Boost 原生 workflow ID 与根会话。用例覆盖数值 9001、同值字符串和其他 RPC，配置错误无状态或资格副作用。 |
| G3-03 Teamwork 目录与审阅 | `teamwork/observer.ts` 要求当前连接的真实广告与显式命令。审阅要求当前 Artifact、确认的请求归属及相同请求 ID。响应写入需有收据和明确决策，选项名仅作显示或诊断。异步提交完成时重核连接及 Artifact revision。 |
| G3-04 当前连接与代次 | 四个观察器的活动写入来自显式挂接的绑定。断开后拒绝迟到帧，同代替换先退役旧连接。旧连接的迟到关闭不会失效新连接的审批回执。在 Dynamic 中仅把当前根会话和已有的独立 tool-to-workflow 映射用于确认请求归属，矛盾或缺失的 hint 保持未确认。 |
| G3-05 历史隔离 | Swarm、Boost、Teamwork、Dynamic 的 live 观察入口在变更状态前隔离历史帧。回归覆盖旧 frame 对同 scope 工作流、广告、Board、审批及去重的影响。既有只读资源仍按绑定读取，独立历史来源由 NP-15 对接。 |

## 测试与验收

- `pnpm build`、`pnpm typecheck`、`pnpm contracts:check`、`git diff --check` 通过。
- Windows Vitest 逐包 `--maxWorkers=1`。Protocol 6/6，Web 106/106，Daemon 223/223，共 335/335。覆盖 T10 至 T13、跨 Harness、G2 运行时与审批回归。
- Daemon 组合用例从 `createDaemon` 装配，使用合成 ACP 入口与本机真实 HTTP、WebSocket。校验默认关闭、显式开启、历史拒绝、SQLite 快照、live 事件、资源类型与缺失资源，以及同代换连接后的旧帧和迟到关闭。完整 T10 至 T13 的模式行为在独立合成回放中验收。
- Vite 构建成功并报告 `app-features` 产物超过 500 kB，打包性能纳入 NP-16 验证。

## 实机与后续

生产默认关闭工作流观察，高级工作流命令路由、Swarm Board、细粒度控制及 Artifact 批准仍待正式证据和独立接入。Dynamic 的合成转发问答先提供独立的工具映射，再测试数字和字符串 RPC。只有工作流提示的实机帧继续由既有 NP-07 规则处理。合成门禁不提升能力矩阵等级。U01 专用 Profile 的 Gemini 3.8 Flash 能力发现、一次 20 秒后台唤醒和 Windows 官方客户端对照仍待实测。[第二批开工安排](../handoffs/G3_Wave2_Launch_Plan.md)
