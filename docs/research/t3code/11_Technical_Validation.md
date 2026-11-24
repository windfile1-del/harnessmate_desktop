# 11 · 实证技术验证报告、通信数据分析与风险登记

> **验证原则**：所有验证代码均放置于独立调研目录 `d:\HarnessMate\t3code-research-de702563\validation\`，零改动 `d:\HarnessMate\harnessmate_desktop` 任何业务源码；所有数据均为本机实测输出，未验证假设明确标注。

---

## 一、验证资产与实测结果总览

| 验证项 | 位置 / 命令 | 执行环境 | 实测结果 |
| --- | --- | --- | --- |
| **V1 · HarnessMate v0.6.0 基线回归** | `pnpm --dir d:\HarnessMate\harnessmate_desktop test` | Windows · Node 24 · Vitest 3.2.7 | **36/36 通过**（`protocol`: 1，`web`: 7，`daemon`: 28；`pnpm contracts:check` 通过，总耗时 ~21s） |
| **V2 · T3 Code 真实协议录制帧核验** | `t3code/apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/{codex,claude}_transcript.ndjson` | 源码逐帧解析 | 实证 Codex App Server 与 Claude Agent SDK 的真实协议差异、思维签名不可迁移性与后台进程清理链路 |
| **V3 · 跨 Harness 上下文交接原型验证** | `d:\HarnessMate\t3code-research-de702563\validation\validate-handoff-protocol.mjs` (`node --test`) | Node 24 + `node:sqlite` | **5/5 用例通过**（总耗时 ~25ms）：验证冷交接脱敏、往返增量+文件陈旧度、崩溃 `pending` 熔断、32k 溢出自动切新会话 + MCP 拉取、运行态前置门控 |
| **V4 · 混合投影存储性能与重放验证** | `d:\HarnessMate\t3code-research-de702563\validation\validate-stream-replay.mjs` (`node --test`) | Node 24 + `node:sqlite` | **2/2 用例通过**：50 轮/5,250 事件基准实测 **13.1x SQLite 行数缩减、22.6x 线缆快照缩减、16x–31x 冷开提速**，乱序/重复/未知块降级 100% 确定性还原 |
| **V5 · 隔离进程第三方 Harness Adapter 验证** | `d:\HarnessMate\t3code-research-de702563\validation\validate-plugin-harness-isolation.mjs` (`node --test`) | Node 24 真实子进程 stdio JSON-RPC | **2/2 用例通过**：验证三层能力协商、无回滚能力前置拦截、专有块 `ext:deepseek.reasoning_budget` 透传、子进程 `exit 137` 崩溃后宿主自动终态结算悬挂工具 |

---

## 二、真实通信协议帧分析（基于 T3 Code 录制夹具）`[T3 Code 已验证实现]`

### 2.1 Codex App Server (`codex.app-server` v0.156.1)
核验自 `turn_interrupt_mid_tool/codex_transcript.ndjson`（42 帧）：
- **能力通告与降噪**：第 2 帧 `initialize` 显式声明 `optOutNotificationMethods: ["turn/diff/updated"]` 抑制冗余 Diff 广播，并通告 `extensions["io.modelcontextprotocol/ui"]` 支持 MCP App。
- **精细上下文遥测**：第 36 帧 `thread/tokenUsage/updated` 提供 `last.totalTokens: 17953`、`cachedInputTokens: 11008`、`reasoningOutputTokens: 25`、`modelContextWindow: 258400`——可直接输入 HarnessMate 容量预算器。
- **强进程清理**：第 34 帧 `item/started(commandExecution)` 返回 `processId: "87302"`；第 35 帧中断 `turn/interrupt` 后，第 38 帧主动下发 `thread/backgroundTerminals/terminate(processId: "87302")`，避免后台命令变成孤儿进程。

### 2.2 Claude Agent SDK (`claude-agent-sdk.query` v0.2.111)
核验自 `turn_interrupt_mid_tool/claude_transcript.ndjson`（11 帧）：
- **加密签名思维块不可迁移实证**：第 7 帧 `assistant` 返回 `{ type: "thinking", thinking: "...", signature: "ErcCClsIDRgC..." }`；该签名绑定 Anthropic 服务端校验，证明任何企图将某厂商 `thinking` 块原样注入另一厂商的做法在协议层面必然失效。
- **分桶 Prompt Cache 遥测**：第 7–8 帧 `usage.cache_creation` 细分为 `{ ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 2377 }` 及 `cache_read_input_tokens: 9455`，为 HarnessMate 计算 Prompt Cache 过期倒计时与节省成本提供精准依据。

---

## 三、独立原型实测数据详表

执行命令：
```powershell
node --test d:\HarnessMate\t3code-research-de702563\validation\validate-handoff-protocol.mjs `
            d:\HarnessMate\t3code-research-de702563\validation\validate-stream-replay.mjs `
            d:\HarnessMate\t3code-research-de702563\validation\validate-plugin-harness-isolation.mjs
```
**汇总结果**：`tests 9 | pass 9 | fail 0 | duration_ms 465.58`。

### 3.1 混合持久化投影 vs 原始 Delta 事件日志实测基准（50 轮 · 60 文本 delta/轮 · 40 命令块/轮 = 5,250 原始事件）

| 指标 | 方案 A：原始 Delta 落库（HM v0.6.0 现状） | 方案 B：合批投影 + 旁路 CommandOutputHub（设计方案） | 改善倍率 |
| --- | --- | --- | --- |
| SQLite 总写入行数 | `5,250` 行 | `150` 投影行 + `250` 生命周期行 = **`400` 行** | **13.1x 行数缩减** |
| SQLite 存储字节（JSON 载荷） | `692,393 B` (~676 KB) | `59,591 B` (~58 KB) | **11.6x 体积缩小** |
| 写入耗时（单事务批写） | `14.49 – 16.74 ms` | `2.32 – 3.05 ms` | **5.5x – 6.2x 更快** |
| 冷打开会话重建耗时 | `14.15 – 21.82 ms` | `0.69 – 0.88 ms` | **16.1x – 31.6x 更快** |
| WS 冷开快照线缆传输量 | `692,393 B` | `30,641 B`（含 `outputOmitted: true` 裁剪） | **22.6x 流量缩减** |
| 50 轮最终语义一致性 | 基准 | **100% 逐字段严格相等（`assert.deepEqual`）** | 无损 |

### 3.2 跨 Harness 交接与隔离插件实证结论
- **敏感信息脱敏（V3 Scenario A）**：在 shell 输出混入 `API_KEY=...`、`sk-proj-...`、`Authorization: Bearer ...` 与带签名的 `reasoning` 块后，交接编译器成功脱敏 3 处凭据并完全剔除 `reasoning` 块，且用户原始请求逐字未变。
- **往返增量与文件陈旧度（V3 Scenario B）**：Codex → Claude（修改 `src/parser.ts`）→ 切回 Codex 时，成功复用原 Codex 原生会话，仅注入 Claude 的 2 条增量项，并自动触发 `workspaceStale = true` 告警。
- **崩溃熔断（V3 Scenario B2）**：模拟 `injectHistory` 中途抛出 `E_PROCESS_CRASH_MID_INJECT`，数据库中滞留 `delivery_status = 'pending'`；二次重试时自动检出不确定投递，强制开启新原生会话做 `full_thread_summary`，杜绝重复注入或静默丢历史。
- **容量溢出自动新开 + MCP 按需回查（V3 Scenario C）**：在 40 轮超长历史 + 32k 窗口模型（热会话已占 20k）条件下，自动触发 `overflowFallback = true` 开新原生会话，按预算截选近期与首轮内容并附带 `hm_session_read` 指针，实测通过 `omittedItemIds[0]` 100% 还原被省略轮次原文。
- **隔离进程第三方 Adapter（V5）**：在环境变量剥离（仅保留 `PATH`）的真实子进程中验证了三层能力握手、不支持回滚时前置拒绝（`E_CAPABILITY_UNSUPPORTED`）以及子进程 `exit 137` 崩溃后宿主自动将 `tc_1` 结算为 `interrupted`。

---

## 四、尚未验证的假设与潜在工程风险登记册

本调研坚持实事求是，明确列出**本次未实机验证的假设**及后续开发阶段必须补齐的真机验证项：

| 风险 ID | 未验证假设 / 潜在风险 | 影响面 | 缓解与后续实机验证方案 |
| --- | --- | --- | --- |
| **R-01** | **本机未直接运行 T3 Code 的完整集成测试套件**（仅克隆源码，未对 33k 文件仓库执行重型 `pnpm install` + 真实 API key 测试） | T3 Code 某些边缘运行行为依赖源码静态阅读与录制夹具推断 | 关键协议帧已直接核验 T3 Code 官方录制的真实 NDJSON 夹具；HarnessMate 落地时对每个真实 CLI 单独录制自有回放夹具 |
| **R-02** | **真实闭源 CLI 版本协议漂移**（如 Codex `thread/inject_items`、Claude `--system-prompt-snapshot`、AGY ACP 版本更新导致参数不兼容） | 跨引擎原生注入或恢复突然失效 | 吸收 T3 Code `model-manifest.json` 兼容策略与最低版本声明；所有高阶原生特性均保留 `inline` 降级通道 |
| **R-03** | **Windows 下 Node `--permission` 沙箱与 `spawnCli` 进程树回收差异**（Windows 无 POSIX 进程组，需 Job Object 或 `taskkill /T /F`） | 第三方 Adapter 派生子进程在 Windows 上退出残留 | Phase 0/1 在 Windows 实机验证 `packages/daemon/src/harnesses/process.ts` 的 `killProcessTree` 配合 `ctx.runtime.spawnCli` |
| **R-04** | **正则脱敏器的误杀与漏杀权衡**（高熵随机字符串、自定义私有密钥格式、Base64 编码密钥） | 误杀测试 Fixture 或漏传私有 Token | 提供可配置脱敏规则白名单 + 熵检测可选开关 + 交接抽屉脱敏提示 + `handoff.onRedact` 插件扩展 |
| **R-05** | **多 Harness 并行 Worktree 合并冲突复杂度**（场景 D 中多个引擎同时改公共类型文件或 `package.json`） | 自动合并失败或引入隐藏回归 | 默认仅自动创建隔离 Worktree，**绝不静默强制合并主分支**；合入前执行 `git merge-tree` 干跑冲突检测并强制人工/主 Agent 审查 |
| **R-06** | **长会话下 FTS5 索引写入与 SQLite WAL 体积增长** | 数千会话高频写入产生磁盘碎片与锁争用 | 异步批量更新 FTS5（仅在轮次完成时索引最终文本，不索引流式增量）并定期执行 `PRAGMA wal_checkpoint(TRUNCATE)` |
