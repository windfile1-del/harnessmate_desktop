# 12 · 关键架构决策记录（ADR）与开源许可合规边界

> 本文件记录 HarnessMate Desktop 架构演进中的 **12 项核心权衡决策**（每项均给出备选方案、选择理由、适用范围与未来重评条件），并明确 T3 Code（MIT）开源许可复用规范。

---

## 一、核心架构决策记录（ADR-01 ~ ADR-12）

### ADR-01：底层并发框架 — 保持 Node 24 + 原生 TS + Zod，不迁移 Effect-TS
- **备选方案**：(A) 全面迁移到 T3 Code 所用的 Effect-TS（`Effect / Layer / Schema / Stream`）；(B) 保持 HarnessMate 现有的 Node 24 + 原生 `async/await` + Zod + `node:sqlite`，仅吸收 T3 Code 的架构模式（Outbox / 单事务 / CAS / Coalescer）。
- **最终选择**：**方案 B**。
- **选择理由**：HarnessMate v0.6.0 已拥有 6 个成熟包、完整 Plugin SDK V4 和 36 项全绿测试，迁移 Effect-TS 将带来极高的心智门槛（显著削弱 AI Plugin Builder 与社区开发者编写插件的易用性）和数月零功能产出的重写停滞。
- **重新评估条件**：仅当未来需要跨多机分布式集群编排（对标 `effect/cluster`）时再局部评估工作流引擎选型。

### ADR-02：统一协议 vs 原生保真度 — 三层能力模型
- **备选方案**：(A) 强行拉齐为最低公共能力集；(B) 前后端按各家原生协议写特判分支；(C) 三层能力模型（L1 标准核心 + L2 12 维可选能力矩阵 + L3 `ext:<vendor>.*` 扩展通道与原始帧保留）。
- **最终选择**：**方案 C**。
- **选择理由**：A 会阉割 Codex `inject_items`/Steering、Claude Prompt Cache/Subagents 等高阶特性；B 会让核心代码随接入引擎数线性腐化；C 兼顾了时间线 95% 统一与 5% 高级专有能力零损失。
- **重新评估条件**：当某 `ext:<vendor>.*` 块被 ≥ 3 个主流 Harness 采用（例如 MCP Apps 或标准化思维预算），应将其晋升为 L1/L2 标准块。

### ADR-03：持久化存储 — 混合投影 + 有界事件日志 + 旁路 CommandOutputHub
- **备选方案**：(A) 纯原始事件日志（HM v0.6.0 现状，含全部 token/stdout delta）；(B) 仅保存每轮最终快照（无审计流、难做断线增量续传）；(C) 混合模型：单事务写物化 `session_turn_items` 投影 + 有界生命周期 `session_events` + 内存旁路 `CommandOutputHub`。
- **最终选择**：**方案 C**。
- **选择理由**：实测 Validation #2 证实方案 C 带来 **13.1x 行数缩减、22.6x 线缆缩减、16x–31x 冷开提速**，同时完整保留重连追帧、插件生命周期事件与审计可追溯性。
- **重新评估条件**：若未来单机需支持百万级事件实时分析，可进一步分离冷归档 SQLite 分库。

### ADR-04：Harness 身份路由 — 从单例 `kind` 升级为 Instance-First 多实例隔离
- **备选方案**：(A) 保持 `codex/claude/agy` 单例；(B) 借鉴 T3 Code `ProviderInstanceRegistry`，按 `instanceId + driverId + continuationKey` 隔离配置、密钥与会话池。
- **最终选择**：**方案 B**。
- **选择理由**：开发者普遍同时拥有个人号/企业号/网关代理/本地模型多套配置，单例模式必然导致凭据污染与配额混算。
- **重新评估条件**：无（长期基础不变式）。

### ADR-05：静态内置适配器 vs 运行时动态插件加载
- **备选方案**：(A) 像 T3 Code 一样将非 ACP 驱动全部静态编译进主程序，仅开放 ACP Registry；(B) 所有驱动均改为动态加载；(C) 混合架构：三大高频内置驱动（Codex / Claude / ACP+AGY）随包内置以保障开箱性能与稳定性，同时在 Plugin API v5 开放受控隔离进程 `harness:driver:register` 供第三方接入任意非 ACP Harness。
- **最终选择**：**方案 C**。
- **选择理由**：兼顾首启零配置体验与 HarnessMate“开放式 AI 开发工作平台 + AI 自主造插件”的长期核心定位。
- **重新评估条件**：若未来三大内置驱动更新节奏显著快于桌面壳发版频率，可进一步允许内置驱动独立热更新。

### ADR-06：跨 Harness 交接 — 混合四层推预算 + MCP 按需拉取
- **备选方案**：(A) 仅靠 LLM 每次切换生成交接摘要；(B) 仅做 T3 Code 式原始对话截选；(C) 混合四层（实时工作区锚点 + 确定性任务账本 + 预算截选近期原文 + `hm_session_read` MCP 按需回查），辅以可选 AI 压缩插件。
- **最终选择**：**方案 C**。
- **选择理由**：默认切换延迟 < 20ms、零额外 Token 费，不因摘要幻觉丢失文件路径/错误堆栈/用户铁律，又靠 MCP 回查消除了截断盲区。
- **重新评估条件**：当极少数目标引擎既窗口极小（< 16k）又不支持 MCP 时，引导用户启用可选的 `hm.plugin.context-compression` AI 摘要插件。

### ADR-07：往返切回（A→B→A）— 热复用优先 + 三重熔断自动新会话
- **备选方案**：(A) 每次切换一律开全新原生会话（浪费 Prompt Cache 与原生状态）；(B) 强行永远复用旧原生会话（易爆窗或因注入中途崩溃损坏会话）；(C) 优先复用热绑定发送 `delta_since_target_last_seen` + 工作区陈旧度宣告，但在“不确定 `pending` 投递 / 容量溢出 / 原生拒绝”三类条件下自动熔断切换新原生会话做全量同步。
- **最终选择**：**方案 C**。
- **选择理由**：最大化热切换速度与缓存命中率，同时用两阶段熔断兜底全部灾难性一致性边界。

### ADR-08：串行交接 vs 多 Harness 并行协作 — 严格双状态模型分离
- **备选方案**：(A) 在同一 `Session` 中允许多个引擎并发向同一目录写入；(B) 严禁并行；(C) 串行交接归属单一 `LogicalSession`，并行协作独立抽离为 `hm.plugin.multi-harness-orchestrator`（父子会话树 + 强制 Git Worktree 物理隔离 + 完成队列唤醒）。
- **最终选择**：**方案 C**。
- **选择理由**：共享目录并发写必然引发文件覆盖竞争与上下文错乱；物理 Worktree + 子会话隔离是唯一工程可靠的多引擎并行路径。

### ADR-09：集中式状态管理 vs 插件自治 — Core 单一事实源 + 插件钩子提案
- **备选方案**：(A) 允许插件直连 SQLite 维护私有会话副本；(B) Core 独占权威写路径，插件仅通过 SDK 读投影、注册服务、订阅事件及通过 `waterfall/bail` 钩子参与决策。
- **最终选择**：**方案 B**。
- **选择理由**：彻底杜绝多插件重复维护会话状态、状态漂移与数据库锁死。

### ADR-10：前端通用渲染 vs 专有 UI 扩展 — 核心归一化 + CSP 沙箱插槽
- **备选方案**：(A) 第三方插件直接注入 React 组件至主窗口 DOM（高 XSS/崩溃风险）；(B) 禁止插件自定义任何 UI；(C) 核心与第一方内置插件使用 React 渲染高频 16 类标准块，第三方插件通过 `chat.block` / `harness.settings` 等类型化插槽在 `sandbox="allow-scripts"` 严格 CSP iframe 中渲染并自动继承主题变量。
- **最终选择**：**方案 C**。
- **选择理由**：复用 HarnessMate P4 已验收的安全沙箱投资，实现安全边界、视觉统一与扩展自由的三赢。

### ADR-11：进程内插件 vs 进程外隔离 — 分层信任运行态
- **备选方案**：(A) 所有插件全进主进程；(B) 所有内置服务也拆为独立 OS 进程（增加 IPC 延迟与内存占用）；(C) 内置第一方核心插件运行于 `kernel` 态受统一生命周期托管，所有第三方代码插件与第三方 Harness Adapter 强制运行于 `--permission` 隔离 OS 子进程 + `runId` 防串话校验 + 环境变量白名单。
- **最终选择**：**方案 C**。
- **选择理由**：在不牺牲内置路径毫秒级响应的前提下，为开放插件生态与 AI 生成代码划定不可逾越的操作系统级安全围栏。

### ADR-12：开源许可合规边界（T3 Code MIT License）
- **核验事实**：`pingdotgg/t3code` 根目录 `LICENSE` 为标准 **MIT License (`Copyright (c) 2026 T3 Tools Inc.`)**。
- **合规策略**：
  1. **架构思想、协议设计、数据模型概念、交互范式**（如 Instance-First、两阶段不确定投递熔断、隐藏 Git Ref 检查点、50ms Delta 合批、MCP 按需回查）：不属于代码版权保护客体，可直接吸收并以 HarnessMate 原生技术栈（Node 24 + Zod + React 19）**独立洁净室实现**，无额外许可传播义务。
  2. **如未来决定直接复用 T3 Code 的某段具体纯函数或常量表**（如 `codexMultiFilePatch`、`handoffBudget` 计算片段、各 Provider SVG 图标路径）：必须在对应文件头及 HarnessMate 仓库根目录 `THIRD_PARTY_NOTICES.md` 中完整保留 `Copyright (c) 2026 T3 Tools Inc.` 与 MIT 许可全文；同时注意核验 `t3code/third-party-licenses.config.json`，**切勿误拷贝** T3 Code 依赖的非 MIT 第三方品牌图标或专有 SDK 代码。
  3. **严禁直接拷贝的内容**：T3 Code 品牌资产（Logo、域名 `t3.codes`）、T3 Connect 专有云服务配置与遥测端点。

---

## 二、独立架构审查结论（Independent Architecture Review）

在完成全套 13 份核心架构文档与 16 份独立插件任务说明书（共 29 份文档）初稿后，执行了系统性的八维独立审查与自动化跨文档校验，结论与已落地的修正如下：

| 审查维度 | 审查结论 | 核验依据与已修正问题 |
| --- | --- | --- |
| **1. 是否存在过度设计或无意义拆分** | **通过** | 已将初步候选清单中 22 项合理收口为“Core Runtime + 16 个高内聚插件”，明确拒绝引入 Effect-TS 框架重写、拒绝向插件开放裸 SQLite、拒绝拆分独立的会话/工作区/框架插件。 |
| **2. 是否存在多个插件重复维护同一套状态** | **通过** | 严格确立 Core Session Kernel 单一事实源（ADR-09）：原始消息、归一化 `TurnBlock`、交接审计 `session_handoffs`、检查点索引 `session_checkpoints` 与审批锁全部由 Core SQLite 唯一托管；插件仅存私有轻量配置/缓存。 |
| **3. 是否存在循环依赖** | **通过** | 16 个插件严格分层为无环 DAG（Core ← L1 ← L2 ← L3 ← L4）：`context-compression` 位于 L2 被 L3 `context-handoff` 可选消费，零反向依赖；启动期在 `PluginHost` 增设 `E_CIRCULAR_DEPENDENCY` 环检。 |
| **4. 是否破坏现有 Plugin SDK V4 架构** | **通过** | 100% 保留 V4 `4.0.0` 全部公共 API、9 插槽与 `upgrade-v1..v3` 升级链；本次审查核对 `packages/daemon/src/plugin-host/permissions/permissions.ts` 原码后，**已统一修正 10 份插件说明书中的权限标识符漂移**（统一对齐 V4 真实命名 `session:read`、`events:approval`、`tools:model`、`fs:workspace:read/write`、`net:<host>`，并补齐 V5 增量权限表与 `ctx.sessions.switchInstance` / `ctx.context.registerCompressor` 契约定义）。 |
| **5. 跨 Harness 上下文交接是否过于理想化** | **通过** | 明确诚实边界（05 号文档）：不承诺保留厂商私有推理链加密签名与原生内存态；通过“确定性工作区真值锚点 + 失败尝试账本 + 脱敏门控 + `delivery='pending'` 不确定熔断 + 容量溢出自动开新线程 + `hm_session_read` MCP 回查”在工程上实证可落地（`validate-handoff-protocol.mjs` 5/5 通过）。 |
| **6. 会话恢复与事件顺序是否一致** | **通过** | `validate-stream-replay.mjs` 实测验证了单事务物化投影 + 有界生命周期日志 + `CommandOutputHub` 旁路在乱序/重复/中途崩溃下的终态结算一致性，并带来 13.1x 存储缩减与 16x–31x 冷开提速。 |
| **7. 进程隔离、崩溃恢复与安全边界是否完备** | **通过** | `validate-plugin-harness-isolation.mjs` 在真实隔离进程上验证了环境密钥剥离、三层能力拦截（拒绝未声明的原生回滚）、`exit 137` 孤儿工具块宿主自动结算；所有插件严格无 `approvals:resolve` 自动审批权限；`.harnessmate/setup` 强制内容哈希人工信任确认。 |
| **8. 新增 Harness / 插件是否显著降低复杂度** | **通过** | 清除 `HarnessKindSchema`、`AdapterSessionHandle`、`UsageService`、`HARNESS_META` 硬编码后，标准 ACP 引擎零代码配置接入，非 ACP 引擎（如 `hm.adapter.deepseek` / `hm.adapter.opencode`）以独立隔离插件 + `ProviderOptionDescriptor` + `chat.block` 零改主程序前后端接入，并由 AI Plugin Builder v2 自动完成脚手架与回放测试自检。 |
| **9. 跨文档链接、格式与 Mermaid 语法校验** | **通过（已修复 3 项）** | 自动化脚本核验 29 份文档全部相对链接 0 失效；已修复 `00_INDEX.md` 中 ADR-09/11 摘要与 `12_Architecture_Decisions.md` 不一致、`00_INDEX.md` 中“12 组→13 组 SDK 域”笔误、`12_Architecture_Decisions.md` 中非标准 `{#adr-*}` 锚点及 `06_Frontend_Adaptation_Architecture.md` Mermaid 标签中的尖括号 `<vendor>`。 |
