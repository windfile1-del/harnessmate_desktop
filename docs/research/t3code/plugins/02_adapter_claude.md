# 插件开发任务说明书 02 · Claude Code Adapter

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | Claude Code Adapter · `hm.adapter.claude` |
| **功能定位** | 以标准 `HarnessDriverV2` 协议托管 Anthropic Claude Code CLI / Agent SDK，支持多网关/多账号配置隔离、细粒度工具审批与 `AskUserQuestion`、原生 `--resume` / `forkSession`、Prompt Cache TTL 与自动压缩阈值遥测、进程组级孤儿进程防护 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`（15,495 行）、`ClaudeTaskOutputTail.ts`、`claudeWorkflowProgress.ts`、`provider/ClaudeTurnTokenUsage.ts`、`provider/Drivers/ClaudeHome.ts` |
| **HarnessMate 当前状态** | 已有 `packages/daemon/src/harnesses/claude-adapter.ts`（761 行）及 `core.harness.claude` 内置服务，已支持 `-p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --system-prompt-snapshot off`；**缺口**：网关分组硬编码（`Magpie/WorkBuddy`）、无多实例独立 `CLAUDE_CONFIG_DIR` 隔离、无 Prompt Cache TTL 与 `autoCompactThreshold` 计算、无 `AskUserQuestion`/原生 Fork、无进程组守卫 |
| **插件类型** | Harness Adapter Plugin（内置第一方，运行态 `kernel`） |
| **开发难度** | **高**（风险点：Claude CLI 版本参数变化、`--system-prompt-snapshot` 兼容性、后台子 Agent 与工作流事件追踪） |
| **开发优先级** | **P0**（Phase 1A） |

---

## 1. 职责范围

### 明确负责
- 注册 `driverId = "claude"` 驱动，支持多实例配置（原生 Anthropic OAuth 账号、第三方兼容网关 `ANTHROPIC_BASE_URL`、独立 `CLAUDE_CONFIG_DIR`）；
- 被动探活（二进制路径 + `--version` + 读取该实例对应 `settings.json` 与认证状态，**不启动会话**）并移除代码内硬编码的私有网关分组名（改为可配置分组规则）；
- 托管双向 `stream-json` 控制协议（或可选 `@anthropic-ai/claude-agent-sdk` 查询通道），支持：
  - 系统侧仅注入固定一句交接连续性提示（`--system-prompt-snapshot off --append-system-prompt ...`），用户交接内容严格走用户通道；
  - `control_request` / `canUseTool` 双向审批、结构化 `AskUserQuestion` 提问与 MCP Elicitation；
  - 精确解析 `usage.cache_creation`（`ephemeral_5m` / `ephemeral_1h`）推算 Prompt Cache 过期时间，并按 `window - 33_000` 推算 `autoCompactThreshold`；
  - 解析带 `signature` 的 `thinking` 块并标记 `redactedSignature: true`（供交接编译器识别不可迁移）；
  - 跨平台进程树/进程组守卫，退出时 100% 回收所有孙进程；
  - 通过 `runNativeCommand('compact' | 'usage' | 'plugin' | 'skills' | 'skill', args)` 封装 Claude 原生命令；
  - 通过 `--mcp-config` 挂载 HarnessMate 会话级 HTTP MCP 租约（含 `hm_session_read`）。

### 明确不负责
- 不尝试将 Claude `thinking.signature` 或内部 KV Cache 迁移至其他引擎；
- 不在 Core 数据库中直接写入会话或审批记录；
- 不把不受信任的用户历史或插件文本注入 `--append-system-prompt`。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**：仅依赖 Core Runtime（`HarnessInstanceRegistry`、`CommandOutputHub`、`PluginMcpLease`）。
- **调用的 SDK 接口**：`ctx.harnesses.registerDriver(driver)`、`ctx.effect(...)`、`ctx.logger`。
- **对外能力**：
  - 声明 `HarnessCapabilitiesV2`：`historyInjectionMode: 'system_append_plus_inline'`、`supportsNativeResume: true`、`supportsNativeFork: true`、`supportsNativeCompaction: true`、`supportsStructuredQuestions: true`、`supportsPromptCacheMetrics: true`、`pluginMcpTransport: 'http'`；
  - 输出动态 `ProviderOptionDescriptor[]`（`effort`、`thinking`、`contextWindow`、`fastMode`）；
  - 注册扩展块 `ext:claude.cache_metrics`。

---

## 3. 事件协议与数据模型

- **发布归一化事件**：`native_session_ready`、`model.confirmed`、`turn.started`、`turn_item.updated`（`assistant_text`、`reasoning`、`tool_call`、`command_execution`、`file_change`、`user_question`、`subagent_run`、`compaction_divider`）、`command_output.delta`、`runtime_request.updated`、`usage.updated`（含 `cachedInputTokens`, `promptCacheTtlMs`, `promptCacheExpiresAt`, `autoCompactThreshold`）、`turn.terminal`（精确区分 `usage_limit`、`conversation_not_found`、`root_bypass_refused`）。
- **实例配置 Schema**：
```ts
export interface ClaudeInstanceConfig {
  binaryPath?: string;
  configDir?: string;               // 对应 CLAUDE_CONFIG_DIR，决定 continuationKey
  apiBaseUrl?: string;              // 可选兼容网关 URL
  authTokenRef?: { secretRef: string };
  modelGroupRules?: Array<{ prefix: string; groupLabel: string }>; // 替代硬编码分组
  mcpRegistrationTimeoutMs?: number;// 默认 90_000
}
```

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展**：
  - `presentation`：`shortLabel: 'Claude'`、`accentColor: 'var(--accent-clay)'`、SVG 图标；
  - 动态 `OptionDescriptor[]` 驱动 `TraitsPicker`（Effort / Context Window / Fast Mode）；
  - `harness.settings`（key: `claude`）：展示登录状态、网关地址配置、自定义模型分组编辑与 `--system-prompt-snapshot` 能力探测结果。
- **权限需求**：内置第一方驱动；独立分发需 `harness:driver:register`、`process:spawn:claude`。
- **生命周期**：启用注册驱动并被动探活；配置更改（非展示字段）在空闲时优雅关闭旧热进程；禁用/卸载时按进程树彻底终止所有托管 `claude` 进程并释放 MCP 租约。

---

## 5. 异常处理与降级机制

1. **`No conversation found with session ID` 恢复失败**：标记 `E_NATIVE_SESSION_LOST`，触发 Core 自动切全新原生会话并执行 `full_thread_summary` 恢复；
2. **提示词消费前拒绝（`refusedBeforePrompt`）**：如参数错误、MCP 注册超时或 CLI 未接起 turn 即退出，显式标记 `refusedBeforePrompt: true` 使 Core 回滚 `handoff.delivery` 避免上下文丢失；
3. **Root 用户拒绝 `--dangerously-skip-permissions`**：识别 stderr 明确报错并建议切换 `manual/accept_edits`；
4. **`--system-prompt-snapshot` 旧版 CLI 不支持**：探活 `--help` 检测标志位，若不支持则自动降级为纯用户侧信封，绝不崩溃。

---

## 6. 测试方案与验收标准

- **单元测试**：`claudeProviderTurnTokenUsage` 含 5m/1h Prompt Cache TTL 与 `autoCompactThreshold` 计算、`mergeClaudeStreamUsage`、`refusedBeforePrompt` 分类、自定义模型分组匹配。
- **录制回放测试**：回放真实 `stream-json` 夹具覆盖：`streaming_thinking_and_tools`、`can_use_tool_approval`、`ask_user_question`、`turn_interrupt_mid_tool`、`rate_limit_event`、`resume_not_found_fallback`。
- **验收标准**：
  1. `claude-adapter.ts` 中私有网关硬编码（`Magpie/WorkBuddy`）完全移除并配置化；
  2. 多实例（官方账号 + 网关实例）并行运行时环境变量严格隔离，无凭据串漏；
  3. Prompt Cache 过期时间与自动压缩阈值准确同步到上下文仪表与 Handoff 预算器；
  4. 中断运行中 Bash 工具后 3 秒内无残留子进程。
