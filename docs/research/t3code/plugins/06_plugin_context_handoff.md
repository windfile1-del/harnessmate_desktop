# 插件开发任务说明书 06 · Context Handoff & Inspector

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Context Handoff & Inspector · `hm.plugin.context-handoff` |
| **功能定位** | 统筹 HarnessMate Desktop 跨引擎上下文交接协议 v2（冷切换、往返增量续接、超预算自动降级、出站前敏感脱敏、MCP 按需回查指引）并提供可视化交接预览与审计检视抽屉 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/orchestration-v2/ContextHandoffService.ts`、`ContextHandoffDelivery.ts`、`ProviderSwitchService.ts`、`ProviderSessionTransitionPolicy.ts`、`packages/provider-core/src/server/handoffBudget.ts`、`docs/user/portable-handoffs.md`（`[T3 Code 已验证实现]`）+ `[HarnessMate 原创设计]`（工作区真值锚点 + 敏感脱敏 + 账本联合编译） |
| **HarnessMate 当前状态** | **部分实现**：已有内置清单 `core.context-bridge`、核心服务 `packages/daemon/src/core/context-compiler.ts`、`handoff-snapshot.ts`（SHA-256 段落哈希 + 5 层预算编译）、`outbound-gate.ts` 及 V4 `handoff.*` 扩展点；**缺口**：缺多实例级水位线（`session_harness_bindings`）、缺中途崩溃“不确定交付（`delivery='pending'`）”防毒化守卫、缺目标预算溢出自动转新原生线程、缺出站前统一敏感脱敏管道（`handoff.onRedact`）、缺交接前可视化预览与审计表 `session_handoffs` |
| **插件类型** | Built-in Plugin（默认启用第一方核心业务插件，提供公共服务 `handoff`，允许高阶第三方策略经 hooks 扩展） |
| **开发难度与风险** | **高**（风险点：水位线错位导致重复注入或上下文丢失；脱敏误伤代码逻辑或漏脱敏导致跨厂商密钥泄露；异步工具未结算前强行切换导致状态分裂；多插件修改交接段落引入 Token 不可控膨胀） |
| **开发优先级** | **P0**（Phase 1B，跨 Harness 核心差异化壁垒） |

---

## 1. 职责范围

### 明确负责
- 监听并承接单会话内切换目标 `instanceId` / `driverId` 后的首次发轮次编译工作，按 05 号架构文档实现 **Handoff Protocol v2**：
  1. **切换前飞行检查（Pre-Handoff Guard）**：拦截存在未决审批、运行中工具或活跃轮次的切换请求，防止半截状态泄露；
  2. **模式自动裁决**：
     - 场景 A 首次冷切换 → `full_session_summary`；
     - 场景 B 切回既有原生会话且上次交付已确认（`delivery_status='confirmed'`）且预算内 → `delta_since_target_last_seen` + `Workspace Truth Diff`；
     - 上次交付处于不确定态（`delivery_status='pending'`，如注入后崩溃）→ **强制丢弃目标旧原生线程，转全新原生线程 + `full_session_summary`**（复用 T3 Code 经源码验证的安全守卫）；
     - 场景 C 目标模型剩余预算不足（估算字符 > 剩余上下文 × 安全系数）→ **自动放弃续接旧原生线程，转全新原生线程并按 5 块比例裁剪 + 附带 `hm_session_read` MCP 回查指引**；
  3. **五段式确定性交接包编译**（沿用并增强现有 `context-compiler.ts` + `handoff-snapshot.ts`）：`L0 Workspace Truth` → `L1 Task Ledger (含失败尝试与钉选约束)` → `L2 Portable Turn Digest` → `L3 Recent Window` → `L4 Pull-On-Demand MCP Guide`；
  4. **非可移植块过滤与统一敏感脱敏**：剔除 `reasoning`、未结算 `tool_call`、`system_notice` 及 `non_portable` 扩展块；串联内置规则与插件 `handoff.onRedact` 钩子对 API Key / Bearer Token / 私钥块 / 连接串执行不可逆脱敏并记录脱敏分类计数；
  5. **交付渠道自适应与原子确认**：按目标驱动能力协商 `native_items` → `embedded_context` → `inline` 降级通道；在 `session_handoffs` 表写入 `pending → confirmed | failed` 状态，仅在目标轮次启动确认后推进目标实例的 `last_seen_turn_seq` 水位线；
  6. **交接检视抽屉（Handoff Inspector）**：在切引擎前支持用户“只读预览”即将发送的交接包、Token 占比、脱敏报告及被省略的轮次范围，并可随时查看历史交接审计记录。

### 明确不负责
- 不直接创建或销毁底层 Harness CLI 进程，也不直接操作 SQLite 底层连接（读写审计记录经 Core `SessionKernel` 接口完成）；
- 不维护任务账本正文内容（只通过 `ctx.get('ledger')` 读取结构化账本）；
- 不直接执行 Git 命令（仅可选调用 `ctx.get('git')` 获取只读分支/HEAD/脏文件摘要）；
- 不负责场景 D 多引擎并行 Worktree 协作（归属 `hm.plugin.multi-harness-orchestrator`）；
- 绝不向任何 Harness 的 `System Prompt` 注入未审阅的第三方插件文本（所有交接段落走用户侧历史通道）。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**（DAG Layer 3，严格无环）：
  - 强依赖：Core Runtime、`hm.plugin.task-ledger`（`inject: ['ledger']`）；
  - 可选依赖：`hm.plugin.git-checkpoints`（`optional: ['git']`，缺省时仅保留工作区目录路径与时间戳）、`hm.plugin.context-compression`（`optional: ['compressor']`，缺省时退化为确定性骨架摘要，零外部 LLM 依赖）。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.get('ledger')`、`ctx.get('git')`、`ctx.storage.workspace`、`ctx.logger`；
  - V5 增量：`ctx.sessions.listItems()`、`ctx.sessions.getBindings()`、`ctx.sessions.postNotice()`、`ctx.capabilities.listHarnesses()`、Core 内部注册交接编译管线及读写 `session_handoffs` 审计接口。
- **对外暴露能力（`provides: ['handoff']`）**：
  - `handoff.preview(sessionId, targetInstanceId)`：纯只读生成本次交接方案（模式、通道、Token 预算拆分、脱敏摘要、完整预览文本），零副作用；
  - `handoff.compileAndStage(sessionId, targetInstanceId, opts)`：供 `SessionKernel` 与 `usage-failover` 在真正发起切换轮次时调用；
  - `handoff.onRedact(listener)` / `handoff.section(def)` / `handoff.onCompose(listener)` / `handoff.onShouldOffer(listener)`（完全向后兼容 V4 插件）。

---

## 3. 事件协议与数据模型

- **订阅事件**：`session.harness_switched`、`turn.started`（确认 `pending → confirmed` 并推进水位线）、`turn.completed`、`turn.failed`（回滚或标记 `delivery_status = 'failed'`）、`session.closing`。
- **发布事件**：`handoff.staged`、`handoff.delivered`、`handoff.redacted`、`handoff.fallback_fresh_session`。
- **核心数据模型（持久化由 Core `SessionKernel` 统一托管，写入 `session_handoffs` 与 `session_harness_bindings`）**：
```ts
export interface ContextHandoffPreviewV2 {
  mode: 'full_session_summary' | 'delta_since_target_last_seen';
  forceFreshNativeSession: boolean;
  freshSessionReason?: 'first_bind' | 'uncertain_previous_delivery' | 'context_budget_overflow' | 'workspace_diverged';
  deliveryChannel: 'native_items' | 'embedded_context' | 'inline';
  sourceInstanceId: string;
  targetInstanceId: string;
  coveredSeqRange: { fromSeq: number; toSeq: number };
  estimatedChars: number;
  budgetChars: number;
  sections: Array<{
    id: 'workspace_truth' | 'task_ledger' | 'portable_digest' | 'recent_window' | 'mcp_guide' | string;
    chars: number;
    truncated: boolean;
    contentHash: string; // 沿用 handoff-snapshot.ts SHA-256 段落哈希
  }>;
  redactionSummary: { totalRedactions: number; categories: string[] };
  mcpPullAvailable: boolean;
  renderedPayload: string;
}
```

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `composer_action`：切换引擎后在输入框上方展示轻量 **Handoff Pill**（显示 `冷交接 / 增量同步 / 自动新线程`、`预计 ~3.2k tokens`、`已脱敏 2 处`），点击打开预览；
  - `inspector_tab`（key: `handoff-inspector`）：**Context Handoff Inspector** 抽屉，包含两栏视图——（1）“下次交接实时预览”（五段折叠视图 + 开关某可选段落 + 强制全量/新原生会话开关）；（2）“交接历史审计时间线”（每次跨引擎切换的快照哈希、通道、状态、耗时与失败降级原因）；
  - `chat.block`（key: `ext:handoff.receipt`）：在对话时间线插入紧凑折叠胶囊（如 `已从 Codex 交接至 Claude · 增量 4 轮 · 脱敏 1 处 · 点击查看快照`）。
- **权限需求**：内置受信任核心插件，声明 `session:read`、`handoff:redact`、`workspace:git:read`（可选）。第三方挂载 `handoff.onRedact` 须显式申请 `handoff:redact`。
- **生命周期**：
  - **安装/启用**：接管原 `core.context-bridge` 标识（通过别名映射保证既有配置与 V4 插件 `inject: ['handoff']` 无缝兼容）；
  - **更新**：支持热更新脱敏正则库与预算比例参数，不中断运行中会话；
  - **禁用**：若用户显式停用本插件，切换引擎仍可执行但回退为“零上下文裸切换”并在 `SessionKernel` 发出醒目 `system_notice` 提示。

---

## 5. 异常处理、恢复与降级机制

1. **注入后、轮次确认前进程崩溃（Uncertain Delivery）**：`session_handoffs` 保持 `delivery_status = 'pending'`；应用重启后下次发消息命中该记录时，强制将 `forceFreshNativeSession = true`，绝不在状态不明的原生线程上叠加二次注入或缺失上下文；
2. **`native_items` 注入失败**：目标适配器 `injectHistory()` 抛出异常或返回 `false` 时，立即自动降级为 `inline` 信封重发，不中断用户当前轮次，同时记录 `deliveryChannel: 'inline'` 与降级原因；
3. **可选依赖插件不可用**：`git` 插件停用时跳过 `git status/diff` 仅注入目录路径；`context-compression` 停用或 LLM 压缩超时（> 8s）时无感回退至纯本地确定性剪裁，保障 P99 编译耗时 < 150ms；
4. **第三方 `handoff.section` / `handoff.onRedact` 异常或超长**：单插件钩子强制 2s 超时与单段字符硬顶（默认 4,000 chars）；若 `onRedact` 钩子抛错，**保守拦截外发（fail-closed）**并提示用户手动排查，防止未脱敏密钥泄露；
5. **非幂等并发切换**：按 `sessionId` 串行化交接状态机并校验 `runId`，快速连点切换引擎 A→B→C 时自动取消过期的 B 预览/暂存。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - 复刻并扩展 `d:\HarnessMate\t3code-research-de702563\validation\validate-handoff-protocol.mjs` 中的全部 5 组核心不变量；
  - 敏感脱敏回归测试（OpenAI `sk-*`、Anthropic `sk-ant-*`、JWT、AWS Key、PEM 私钥、含密码 URL、`handoff.onRedact` 抛错 fail-closed）；
  - 预算计算边界（模型窗口 32k / 128k / 200k / 1M，验证五段占比与截断顺序）。
- **集成测试**：
  - 真实 SQLite 持久化下模拟 `Codex → Claude → Codex` 往返交接 + 期间工作区文件变更，验证第二次回到 Codex 仅增量同步且注入 `Workspace Truth Diff`；
  - 模拟 `injectHistory` 写完后强杀进程，验证重启后触发 `uncertain_previous_delivery` 并安全开新原生会话。
- **端到端测试**：
  - UI 中切引擎 → 打开 Handoff Inspector 预览并关闭某非关键段落 → 发送轮次 → 时间线出现交接胶囊 → 目标引擎通过 `hm_session_read` 拉取被折叠的历史代码片段。
- **可验证验收标准**：
  1. 场景 A（冷切换）、场景 B（往返增量）、场景 B2（中断重启不确定交付防护）、场景 C（超预算自动新线程 + MCP 回查）4 组端到端用例 100% 通过；
  2. 含 10 类常见密钥样本的会话跨引擎交接，目标适配器收到的载荷中密钥明文检出率为 **0**；
  3. 确定性交接包编译耗时（50 轮会话）< 100ms，切回同一引擎无新变更时零冗余注入。
