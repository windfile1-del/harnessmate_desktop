# 插件开发任务说明书 01 · OpenAI Codex Adapter

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | OpenAI Codex Adapter · `hm.adapter.codex` |
| **功能定位** | 以标准 `HarnessDriverV2` 协议托管 OpenAI Codex CLI（`codex app-server` 双向 JSON-RPC 2.0），支持多账号 `CODEX_HOME` 隔离、原生历史注入（`thread/inject_items`）、原生 Fork/回滚、运行中 Steering、目标模式 `/goal` 与后台终端进程回收 |
| **参考来源 (T3 Code)** | `t3code/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`（9,474 行）、`provider/Drivers/CodexDriver.ts`、`CodexHomeLayout.ts`、`CodexThreadRevert.ts`、`CodexToolPresentation.ts`、`CodexTurnTokenUsage.ts`、`packages/effect-codex-app-server/` |
| **HarnessMate 当前状态** | 已有 `packages/daemon/src/harnesses/codex-adapter.ts`（1,022 行）及 `core.harness.codex` 内置服务，已支持 `app-server --stdio`、`thread/inject_items`、审批与 `/goal`；**缺口**：单例无多账号 `CODEX_HOME` 隔离、`probe()` 冷启全量 app-server、接口向 Core 泄露 `runCodexGoal`/`codexInjectItems`、缺原生 Fork/回滚、缺 `thread/backgroundTerminals/terminate` 与 `invalid_encrypted_content` 分类 |
| **插件类型** | Harness Adapter Plugin（内置第一方，运行态 `kernel`，支持通过组合层配置开关与覆盖） |
| **开发难度** | **高**（风险点：Codex CLI 版本协议漂移、`thread/inject_items` 兼容性、Windows 进程树清理） |
| **开发优先级** | **P0**（Phase 1A） |

---

## 1. 职责范围

### 明确负责
- 注册 `driverId = "codex"` 驱动，管理多实例配置（如个人订阅、企业号、独立 `CODEX_HOME` 路径、自定义二进制路径与额外参数）；
- 被动探活（二进制路径 + `--version` + 本地 `config.toml` 默认模型读取，**绝不冷启会话**）与显式目录刷新（`model/list`、`account/read`、`account/rateLimits/read`）；
- 实现完整双向 JSON-RPC 会话：`initialize`（通告 `optOutNotificationMethods: ["turn/diff/updated"]`）、`thread/start` / `thread/resume`、`thread/inject_items`、`turn/start`、`turn/steer`、`turn/interrupt` + `thread/backgroundTerminals/terminate`、`thread/fork`、`thread/rollback`；
- 将 Codex 原始事件归一化为 `NormalizedAdapterEventV2`（含 50ms 文本增量合批、命令 stdout 直推 `CommandOutputHub`、多文件 patch 规范化 `diff --git` 头、`modelContextWindow` 与 `cachedInputTokens` 上报、`usage_limit` 错误分类）；
- 通过 `runNativeCommand('goal' | 'skills' | 'compact', args)` 封装 Codex 专有命令，消除 Core 层硬编码；
- 通过 `-c mcp_servers.harnessmate_session_tools.*` 注入 HarnessMate 会话级 MCP 租约。

### 明确不负责
- 不直接读写 Core SQLite 数据库或维护跨引擎会话状态；
- 不自行决定跨引擎交接策略或计算全局预算（仅接收 `PortableHistoryPayload` 执行 `injectHistory`）；
- 不模拟 Codex 原生未提供的权限模式；
- 不跨实例共享环境变量或泄露宿主环境中的 `OPENAI_API_KEY`。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**：仅依赖 Core Runtime（`HarnessInstanceRegistry`、`CommandOutputHub`、`PluginMcpLease`），**不依赖其他业务插件**。
- **调用的 SDK 接口**：`ctx.harnesses.registerDriver(driver)`、`ctx.effect(...)`、`ctx.logger`。
- **需新增/依赖的 SDK V5 能力**：`HarnessDriverV2`、`HarnessCapabilitiesV2`（声明 `historyInjectionMode: 'native_items'`、`supportsNativeFork: true`、`supportsNativeRollback: true`、`supportsActiveSteering: true`）、通用 `injectHistory(packet)` 与 `runNativeCommand(cmd, args)`。
- **对外能力**：向核心注册 `driverId: "codex"`；提供动态 `ProviderOptionDescriptor[]`（`reasoningEffort`、`serviceTier`）与扩展块 `ext:codex.mcp_app`、`ext:codex.goal_status`。

---

## 3. 事件协议与数据模型

- **发布（向上游 Session Kernel 发出归一化事件）**：`native_session_ready`、`model.confirmed`、`turn.started`、`turn_item.updated`（文本/推理/命令/文件变更/计划）、`command_output.delta`（直通 `CommandOutputHub`）、`runtime_request.updated`（命令/文件/补丁审批与 MCP Elicitation）、`usage.updated`（含 `modelContextWindow`、`cachedInputTokens`、`reasoningOutputTokens`）、`turn.terminal`（携带 `failureClass: 'usage_limit' | 'invalid_encrypted_content' | 'provider_error'`）。
- **实例配置 Schema（JSON Schema，持久化于用户配置与密钥存储）**：
```ts
export interface CodexInstanceConfig {
  binaryPath?: string;
  codexHome?: string;                // 独立账号目录，决定 continuationKey = `codex:home:${resolvedHome}`
  extraArgs?: string[];              // 默认 ['app-server', '--stdio']
  defaultServiceTier?: 'default' | 'fast';
  envWhitelist?: Record<string, string | { secretRef: string }>;
}
```
- **持久化方式**：不自建数据库表；实例配置由 Core `HarnessInstanceRegistry` 统一存储，密钥走 `secretRef` 引用。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展**：
  - 通过 `presentation` 声明视觉徽章（名称 `Codex`、SVG 图标、主题色 `var(--accent-emerald)`）；
  - 通过 `OptionDescriptor[]` 自动在 `TraitsPicker` 渲染推理强度与速度档位；
  - 注册 `harness.settings`（key: `codex`）插槽提供多账号 `CODEX_HOME` 检测与登录状态面板；
  - 注册 `chat.block`（key: `ext:codex.goal_status`）展示 `/goal` 进度条。
- **权限需求**：内置第一方受信任驱动；若作为独立包安装需全局权限 `harness:driver:register`、`process:spawn:codex`。
- **生命周期**：
  - **安装/启用**：注册 `codex` Driver 并触发一次**被动探活**；
  - **更新**：支持在不中断已有活跃会话的前提下热更新配置（显示名/颜色变更零重启；`codexHome` 或二进制变更仅影响后续新开会话或平滑重启）；
  - **禁用/卸载**：先向活跃轮次发出取消通知，终止全部托管 `codex app-server` 子进程树并回收 MCP 租约，再反注册驱动。

---

## 5. 异常处理与降级机制

1. **`thread/inject_items` 不支持或失败**：返回 `false` 交由 `Context Handoff` 无缝降级为 `inline` 上下文信封，绝不阻断轮次发送；
2. **`invalid_encrypted_content` 报错**：精确归类并上报 `failureClass: 'invalid_encrypted_content'`，触发核心自动切全新原生会话恢复；
3. **早停与超时强制终止**：`interrupt` 在收到 `turn/started` 前挂起等待，发出 `turn/interrupt` 后 10s 未终结向 UI 暴露 Force Stop；终结时主动枚举并清理 `thread/backgroundTerminals/terminate`；
4. **原生进程锁冲突**：识别 rollout 被外部 CLI 占用错误并抛出 `E_NATIVE_THREAD_IN_USE`，阻止静默分叉；
5. **非 JSON 前导噪声**：复用 `ResilientJsonLineParser` 将前导 stdout 行转入 `diagnostic.log`。

---

## 6. 测试方案与验收标准

- **单元测试**：多文件补丁 `diff --git` 规范化、Token 用量累加、`usage_limit` 与 `invalid_encrypted_content` 错误分类、选择过渡计划协商。
- **录制回放测试（强制）**：录制并回放真实 `codex app-server` NDJSON 夹具覆盖：`basic_turn`、`inject_items_handoff`、`approval_and_deny`、`turn_interrupt_mid_tool`、`usage_limit`、`fork_and_rollback`。
- **端到端测试**：配置两个不同 `CODEX_HOME` 实例并发运行互不串号；与 `hm.adapter.claude` 完成往返上下文交接。
- **验收标准**：
  1. `probePassive()` 耗时 < 300ms 且确认零创建 `codex app-server` 会话；
  2. `SessionManager` 与 `AdapterSessionHandle` 中所有 Codex 专属硬编码（`runCodexGoal`、`codexInjectItems`）完全清除；
  3. 6 组 NDJSON 回放夹具 100% 通过，模拟中途崩溃后无残留 `codex` 子进程。
