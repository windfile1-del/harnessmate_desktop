# 插件开发任务说明书 03 · ACP & Antigravity Adapter（含 ACP Registry）

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | ACP & Antigravity Adapter · `hm.adapter.acp` |
| **功能定位** | 提供严格遵循 Agent Client Protocol (ACP) 规范的通用驱动，同时承载第一方 **Google Antigravity (`agy`)** 增强风味以及动态 **ACP Registry** 代理发现/安装能力（支持 Gemini CLI、Kiro、Copilot ACP、Devin ACP、Kimi ACP、OpenCode ACP 等一切标准 ACP 代理） |
| **参考来源 (T3 Code)** | `t3code/packages/provider-acp/src/server/{AcpSessionRuntime,adapter,clientPolicy,clientTerminals,mcpOverAcpBridge,runtimeModel}.ts`、`packages/provider-acp-registry/src/server/*`、`apps/server/src/provider/acp/Antigravity*.ts` |
| **HarnessMate 当前状态** | 已有 `packages/daemon/src/harnesses/acp-adapter.ts`（1,142 行）、`agy-commands.ts`、`plugin-mcp-stdio.ts` 及 `core.harness.agy` / `core.harness.acp`；**缺口**：`probe()` 违规调用 `session/new`、通用 ACP 与 AGY 逻辑混写在同一文件、客户端模拟伪造缺失权限模式、缺少 ACP Registry 动态发现与 `sessionLoadReplayIdleGap` 静默就绪判定 |
| **插件类型** | Harness Adapter Plugin（内置第一方，运行态 `kernel`） |
| **开发难度** | **高**（风险点：各家 ACP 实现参差不齐、严格规范与第一方 AGY 增强的边界隔离、Windows 路径与编码） |
| **开发优先级** | **P0**（Phase 1A） |

---

## 1. 职责范围

### 明确负责
- **严格分层双驱动导出**：
  1. `driverId = "acp"`（严格标准 ACP 驱动 + ACP Registry 代理实例）：**绝不加入任何厂商特定 hack**，按 `initialize` 协商出的真实能力自然降级；
  2. `driverId = "agy"`（第一方 Antigravity 增强风味，复用底层 `AcpSessionRuntime`）：承载 AGY 专属逻辑（`--app-data-dir` 桌面数据目录定位、`authenticateEagerly`、`_meta.antigravity.tier` 识别、AGY CLI 辅助命令 `/usage`/`/goal`/`/skills` 及桌面历史读取）。
- **被动探活修复**：`probePassive()` 仅检查二进制存在、版本与本地缓存，**绝不在后台探活中调用 `session/new`**；实时模型与 `configOptions` 仅在显式 `refreshCatalog()` 或首次会话打开时懒加载广告（Lazy Config Advertisement）。
- **ACP 协议完整治理**：支持 `initialize`、`session/new`、`session/load` / `session/resume`（含 `sessionLoadReplayIdleGap = 2s` 回放静默就绪检测，防止部分 ACP 代理永不回复 `session/load` 响应）、`session/set_config_option`、`session/prompt`（优先 `embeddedContext` 用户内嵌资源块）、`session/cancel`、`request_permission` 透传原生选项 ID、`mcpOverAcpBridge`（复用 `plugin-mcp-stdio.ts`）与可选客户端托管终端。
- **权限模式诚实声明**：若 ACP 代理原生不提供某权限模式，显式标注 `enforcement: 'client_guard'`（客户端策略护栏），绝不欺骗上层冒充原生沙箱。
- **ACP Registry 集成**：支持浏览、验证摘要并注册标准 ACP Registry 清单中的兼容代理（如 Gemini CLI ACP、Kiro ACP 等），一键创建实例。

### 明确不负责
- 不在通用 `acp` 驱动中为非第一方厂商添加 `if (agentId === 'xxx')` 特殊逻辑；
- 不维护非 ACP 协议（如 OpenCode HTTP/SSE、DeepSeek 原生 API）的适配。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**：仅依赖 Core Runtime（`HarnessInstanceRegistry`、`CommandOutputHub`、`PluginMcpLease`）。
- **调用的 SDK 接口**：`ctx.harnesses.registerDriver`（注册 `agy` 与 `acp` 两个驱动）、`ctx.net.fetch`（仅用于用户显式拉取 ACP Registry 索引，需受控域名白名单）。
- **对外能力**：
  - `agy` 驱动：`historyInjectionMode: 'acp_embedded_resource'`、`pluginMcpTransport: 'acp'`、动态 `OptionDescriptor[]`（自动映射 `configOptions`）；
  - `acp` 驱动：根据每个代理握手返回的 `agentCapabilities` 动态上报 `HarnessCapabilitiesV2`；
  - 导出 `acpRegistry.listCatalog()` / `acpRegistry.createInstance()` 供插件中心与设置页调用。

---

## 3. 事件协议与数据模型

- **发布事件**：全部标准 `NormalizedAdapterEventV2`，特别处理 `session/update` 中的 `agent_message_chunk`、`agent_thought_chunk`、`tool_call`、`tool_call_update`、`plan`（映射为 `todo_list`）、`available_commands_update` 与 `config_option_update`（懒广告动态刷新前端 `TraitsPicker`）。
- **实例配置 Schema**：
```ts
export interface AcpInstanceConfig {
  command: string;
  args: string[];
  flavor: 'strict_acp' | 'antigravity';
  registryAgentId?: string;          // 来自 ACP Registry 时记录
  appDataDir?: string;               // AGY 专属，决定 continuationKey
  authMethodId?: string;
  authenticateEagerly?: boolean;
  sessionLoadReplayIdleMs?: number;  // 默认 2000
  envWhitelist?: Record<string, string | { secretRef: string }>;
}
```

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展**：
  - `harness.settings`（key: `acp`）：提供“从 ACP Registry 搜索并添加代理”与“添加本地自定义 ACP 命令”两步向导；
  - `harness.settings`（key: `agy`）：展示 Antigravity 登录层级（Tier）、数据目录模式与原生命令支持状态；
  - `presentation`：AGY 使用 `var(--accent-indigo)`，通用 ACP 使用 `var(--accent-star)` 并允许实例自定义图标与强调色。
- **权限需求**：内置第一方驱动；访问远程 ACP Registry 需显式域名白名单，创建自定义本地 ACP 实例延续现有包摘要确认机制。
- **生命周期**：安装/启用注册驱动并加载已配置 ACP 实例；支持热增删单个 ACP 实例而不影响其他运行中实例；禁用/卸载终止全部子进程并清理临时 stdio MCP 桥进程。

---

## 5. 异常处理与降级机制

1. **`session/load` 永不响应但已回放完历史**：触发 `sessionLoadReplayIdleGap`（2s 静默）自动采纳会话就绪，同时记录诊断日志；
2. **`embeddedContext` 资源块不被某 ACP 代理接受**：自动降级为纯文本 `<harnessmate_handoff>` 用户消息信封；
3. **旧配置中存储了代理不再广告的 `configOption` 值**：静默跳过非法选项而不使整个 turn 失败（吸收 T3 Code `03_providers.md#L71-L73` 教训）；
4. **认证失效**：捕获 ACP `auth_required` 错误码，标记实例 `health: 'unauthenticated'` 并引导用户执行对应认证命令。

---

## 6. 测试方案与验收标准

- **单元测试**：`parseAcpModelCatalog`、`configOptions` 懒广告合并、`sessionLoadReplayIdleGap` 定时器状态机、AGY 与严格 ACP 隔离校验。
- **集成/回放测试**：使用模拟 ACP stdio 服务器验证：`initialize -> session/new -> prompt -> request_permission -> cancel`、`embeddedContext` 交接与降级、AGY 桌面历史导入、动态添加 2 个自定义 ACP 实例并行运行。
- **验收标准**：
  1. `AcpAdapter.probePassive()` 零触发 `session/new`，耗时 < 250ms；
  2. 通用 `acp` 驱动源码中不含任何 `antigravity` / `agy` 分支判断；
  3. 可在不修改主程序的情况下通过 ACP Registry 或本地配置接入 Gemini CLI ACP 等标准代理并完成与 Codex 的跨引擎交接。
