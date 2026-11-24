# 插件开发任务说明书 04 · DeepSeek Harness Adapter（第三方隔离非 ACP 标杆）

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | DeepSeek Harness Adapter · `hm.adapter.deepseek` |
| **功能定位** | 作为 HarnessMate Desktop **首个第三方隔离进程非 ACP Harness Adapter 标杆插件**，演示如何在**零修改主程序前后端代码**的前提下，接入 DeepSeek CLI / DeepSeek Agent HTTP-SSE 运行时，并完整保留其专有能力（思维链预算控制、FIM/深度思考开关与专有 UI 卡片） |
| **参考来源 (T3 Code)** | 借鉴 `t3code/packages/provider-pi/`（最小独立 Provider 包结构：`client.ts` + `server.ts` + `settings.ts`）与 `t3code/packages/provider-core/src/server/ProviderAdapter.ts` 能力契约，结合 HarnessMate 独有的 V5 进程外插件架构原创设计 `[HarnessMate 原创设计]` |
| **HarnessMate 当前状态** | **缺失**（当前仅支持内置 Codex/Claude/AGY 及标准 ACP；本插件同时作为验证 Plugin SDK V5 开放驱动能力的黄金验收标杆） |
| **插件类型** | Harness Adapter Plugin（可选第三方 / 官方商店独立包，运行态 `isolated` 隔离子进程） |
| **开发难度** | **中**（风险点：跨进程 JSON-RPC 流式背压控制、本地工具执行沙箱边界、CLI 与 API 直连双模式切换） |
| **开发优先级** | **P2**（Phase 3A，依赖 Phase 1C Plugin SDK V5） |

---

## 1. 职责范围

### 明确负责
- 通过 Plugin SDK V5 `ctx.harnesses.registerDriver()` 注册 `driverId = "deepseek"`，支持两种后端运行模式：
  1. **CLI 模式**：通过 `ctx.runtime.spawnCli()` 托管本机 DeepSeek Harness CLI（stdio JSON 行协议）；
  2. **API Agent 模式**（可选）：通过 `ctx.net.fetch`（限定 `api.deepseek.com` 或用户授权网关）直连 DeepSeek Reasoner/Chat 流式 SSE，结合宿主工作区受控工具执行循环；
- 声明真实三层能力矩阵：不支持原生 `injectHistory`（走 `inline_only` 交接通道）、不支持原生 `rollback`（让核心检查点在触碰文件前安全拦截）、支持流式思考与动态 `reasoningBudget`；
- 透传专有扩展块 `ext:deepseek.reasoning_budget`（展示思考 token 占比与预算消耗），并自带严格 CSP 沙箱 HTML 渲染视图。

### 明确不负责
- 不修改 HarnessMate 核心 Daemon、Protocol 或 Web 主程序源码；
- 不绕过宿主 `ApprovalBroker` 自行静默执行危险 shell 或写盘操作；
- 不持久化聊天历史或任务账本（全部由 Core Session Kernel 托管）。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**：仅依赖 Core Runtime + `@harnessmate/plugin-api` (`^5.0.0`)，**零其他插件依赖**。
- **调用的 SDK 接口**：
  - `ctx.harnesses.registerDriver(driver)`（V5 新增）
  - `ctx.runtime.spawnCli(spec)`（CLI 模式，V5 新增）
  - `ctx.net.fetch(url, init)`（API 模式，V4 已有）
  - `ctx.slots.register({ slot: 'chat.block', key: 'ext:deepseek.reasoning_budget', ui: 'ui/reasoning-card.html' })`（V5 新增）
  - `ctx.slots.register({ slot: 'harness.settings', key: 'deepseek', ui: 'ui/settings.html' })`（V5 新增）
  - `ctx.storage.plugin`（缓存模型目录，不存明文密钥）
- **对外能力**：向全局注册 `driverId: "deepseek"`、动态 `OptionDescriptor[]`（`reasoningBudget: low|medium|high`、`deepThink: boolean`）与自定义消息块渲染器。

---

## 3. 事件协议与数据模型

- **发布事件**（经隔离进程 JSON-RPC 通知发往宿主 `IsolatedHarnessHost`）：`turn.started`、`message.assistant.delta`（50ms 合批）、`thinking.delta`、`tool.call.started/completed`、`approval.requested`、`extension.block`（`type: 'ext:deepseek.reasoning_budget'`）、`usage.updated`（含 `modelContextWindow: 64_000 | 128_000`）、`turn.terminal`。
- **实例配置 Schema**：
```ts
export interface DeepSeekInstanceConfig {
  mode: 'cli' | 'api_compatible';
  cliCommand?: string;              // 默认 'deepseek-code'
  apiBaseUrl?: string;              // 默认 'https://api.deepseek.com'
  apiKeyRef?: { secretRef: string };
  defaultModel: 'deepseek-reasoner' | 'deepseek-chat' | string;
  contextWindowTokens?: number;     // 默认 64_000（准确输入 Handoff 容量预算器）
}
```

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展**：
  - `ui/reasoning-card.html` 挂载至 `chat.block`（`key: 'ext:deepseek.reasoning_budget'`），自动继承宿主浅/深色 CSS 变量，展示思考 Token 占比条与推理深度标签；插件禁用时主界面自动降级为通用折叠 JSON 卡片；
  - `ui/settings.html` 挂载至 `harness.settings`（`key: 'deepseek'`），提供 CLI/API 模式切换与连通性测试按钮；
  - `presentation`：`shortLabel: 'DeepSeek'`、`accentColor: '#4D6BFE'`、自定义 SVG 图标。
- **权限需求**（必须在 `manifest.json` 声明并经 Ed25519 签名或显式高危确认）：
  - `harness:driver:register`（全局，高风险）
  - `process:spawn:deepseek-code`（全局，高风险，CLI 模式）
  - `net:api.deepseek.com`（工作区/全局，中风险，API 模式）
  - `storage:plugin`（全局，低风险）
- **生命周期**：
  - **安装**：校验 Ed25519 签名与 `engines.pluginApi: "^5.0.0"`，展示高风险权限审阅弹窗；
  - **启用**：启动 `--permission` 隔离子进程并完成 `harness.handshake`，前端 `HarnessSwitcher` 立即出现 DeepSeek；
  - **禁用/卸载**：宿主终止隔离子进程与所有托管 CLI 子进程，通过 `Disposer` 自动撤销 `driver` 与全部 UI 插槽注册，历史会话中已产生的 DeepSeek 消息依然完整可读（自定义块平滑降级）。

---

## 5. 异常处理与降级机制

1. **子进程崩溃 / OOM（超过 128MB 堆限）**：宿主 `ProcessSupervisor` 立即结算全部运行中工具为 `interrupted` 并按指数退避重启（10 分钟内 5 次转 `FAILED`），不影响 Codex/Claude 等其他会话；
2. **上下文窗口较小（64k）导致跨引擎交接溢出**：向 Core 诚实上报 `modelContextWindow: 64_000`，由 `hm.plugin.context-handoff` 自动按预算裁剪并触发新原生会话降级；
3. **API 限流（HTTP 429）**：归一化上报 `failureClass: 'usage_limit'` + `resetAt`，无缝衔接 `hm.plugin.usage-failover` 一键切换至 Claude/Codex 重试；
4. **单次 RPC 超时**：不杀进程，仅向当前调用返回 `E_TIMEOUT` 并允许用户重试。

---

## 6. 测试方案与验收标准

- **单元测试**：SSE 分片解析、`ext:deepseek.reasoning_budget` 构造、429 限流错误分类、`capabilities` 诚实声明校验。
- **隔离进程集成测试**（参照 `d:\HarnessMate\t3code-research-de702563\validation\validate-plugin-harness-isolation.mjs`）：
  - 验证环境变量白名单剥离宿主密钥；
  - 验证不支持原生回滚时核心前置拦截；
  - 验证模拟子进程 `exit 137` 崩溃后宿主正确终态结算。
- **端到端跨引擎测试**：在未修改主程序代码的前提下安装 `hm.adapter.deepseek`，执行 `Codex -> DeepSeek -> Claude` 三引擎连续接力并验证自定义 UI 卡片在浅/深主题下正常渲染。
- **验收标准**：
  1. 主程序代码改动量为 **0 行**即可完成安装、模型选择、动态 Trait 切换、对话与自定义块展示；
  2. 插件卸载后，旧会话时间线零报错且 `ext:deepseek.reasoning_budget` 正常降级为可读摘要卡；
  3. 隔离进程严格运行在 `--permission` 下，任何越权读盘/写盘尝试均被 Node 权限模型拦截。
