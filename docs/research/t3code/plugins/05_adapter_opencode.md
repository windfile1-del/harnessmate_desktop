# 插件开发任务说明书 05 · OpenCode HTTP/SSE Adapter

| 属性 | 说明 |
| --- | --- |
| **插件名称 & Plugin ID** | OpenCode HTTP/SSE Adapter · `hm.adapter.opencode` |
| **功能定位** | 以第三方隔离 `HarnessDriverV2` 接入 OpenCode 2.x Server（支持本地按需拉起共享守护进程或连接远端自托管 Server），作为 HarnessMate Desktop 首个 **HTTP REST + SSE 传输模式** 的官方标杆适配器 |
| **参考来源 (T3 Code)** | `t3code/packages/provider-opencode/src/server/v2/OpenCode2Server.ts`、`OpenCode2Client.ts`、`OpenCode2Service.ts`、`adapter.ts`、`usageLimits.ts` 及 `OpenCodeServerOwner.ts`、`OpenCodeServerLedger.ts`、`versionProbe.ts`（`[T3 Code 已验证实现]`） |
| **HarnessMate 当前状态** | **完全缺失**（现有 `packages/daemon/src/harnesses/` 仅覆盖 stdio JSON-RPC、stream-json 与 stdio ACP，尚无 HTTP/SSE 传输与共享常驻服务复用范式） |
| **插件类型** | Harness Adapter Plugin（可选官方/社区隔离插件，运行态 `isolated`，基于 Node `--permission` 独立进程） |
| **开发难度与风险** | **中**（风险点：OpenCode 1.x 与 2.x 协议不兼容误识别；SSE 流静默假死；多工作区共享单进程时的凭据与目录路由隔离；插件卸载时误杀用户自托管外部 Server） |
| **开发优先级** | **P2**（Phase 3，作为 HTTP/SSE 类 Harness 与外接远端引擎的官方参考实现） |

---

## 1. 职责范围

### 明确负责
- 注册 `driverId = "opencode"` 驱动，支持两种运行模式：
  1. **托管本地 Server（Owned Mode）**：按需派生 `opencode serve`，由内存生成 32 字节 Base64Url 随机密码并注入 `OPENCODE_PASSWORD`（显式剔除继承的旧版 `OPENCODE_SERVER_PASSWORD`，避免 1.x/2.x 冲突），单进程复用服务全部工作区目录；
  2. **外部远端 Server（External Mode）**：连接用户已部署的 `serverUrl` + `secretRef` 密码，通过 HTTP Basic Auth（固定用户名 `opencode`）鉴权，**卸载时绝不终止外部进程**；
- 实现被动探活：本地模式仅检测二进制路径与 `--version`；外部模式对 `/server/info` 发单次 5s 超时只读探测（拒绝 1.x HTML 伪 200 响应），**绝不创建任何会话**；
- 在发轮次前先订阅易失 SSE 事件流（`events`），建立 **10s 订阅握手超时** 与 **45s 静默流断线探测**（借鉴 `OpenCode2Client.ts` 的 `SILENT_STREAM_TIMEOUT` / `SUBSCRIPTION_TIMEOUT`）；
- 对 OpenCode Server 未来新增、当前 Schema 无法解码的事件采用优雅降级：提取顶层 `{ type, data.sessionID }` 信封，即使具体载荷解码失败，若属于终态事件（`session.execution.succeeded | failed | interrupted`）仍发出合成终态事件，杜绝轮次永久挂起；
- 归一化消息、推理、工具调用、Shell 后台作业（`shellJobs`）、图像生成作业（`imageJobs` / `readImage`）与服务端配额接口（`usageLimits`）。

### 明确不负责
- 不负责跨引擎上下文编排或全局账本维护（交接仅支持 `inline` 信封并声明 `historyInjectionMode: 'inline'`）；
- 不修改核心 Daemon 任何代码或向宿主 SQLite 写入自有表；
- 不将 `OPENCODE_PASSWORD` 写入日志、异常消息或聊天时间线（所有认证错误统一映射为脱敏提示 `"The OpenCode server rejected the server password."`）；
- 不在未声明域名白名单的前提下访问任意第三方公网地址。

---

## 2. 依赖关系、SDK 接口与对外能力

- **依赖关系**：仅依赖 Core Runtime（`HarnessInstanceRegistry`、`CommandOutputHub`、密钥存储），**零跨插件依赖**（DAG Layer 1）。
- **调用的 SDK 接口**：
  - V4 既有：`ctx.logger`、`ctx.secrets.resolve(secretRef)`、`ctx.storage.plugin`、`ctx.effect(...)`；
  - V5 增量：`ctx.harnesses.registerDriver(driver)`、`ctx.runtime.spawnCli(spec)`（本地托管模式拉起 `opencode serve`）。
- **暴露给其他模块的能力**：
  - 向 `HarnessInstanceRegistry` 注册 `driverId: "opencode"`；
  - 声明三层能力：`transport: 'http-sse'`、`historyInjectionMode: 'inline'`、`supportsNativeFork: false`、`supportsNativeRollback: false`、`supportsActiveSteering: false`、`supportsUsageLimits: true`；
  - 输出动态 `ProviderOptionDescriptor[]`（`model` 目录动态拉自 Server、`agent` 模式选择器）及专有扩展块 `ext:opencode.image_job`。

---

## 3. 事件协议与数据模型

- **订阅**：核心经 Harness RPC v2 下发的控制指令（`probePassive`、`listModels`、`readUsageLimits`、`startOrResumeSession`、`sendTurn`、`interruptTurn`、`respondApproval`、`closeSession`、`dispose`）。
- **发布（归一化上游事件）**：`native_session_ready`、`model.confirmed`、`turn.started`、`turn_item.updated`（文本/推理/工具/Shell/图像作业）、`command_output.delta`（直推 `CommandOutputHub`）、`runtime_request.updated`、`usage.updated`、`turn.terminal`（含 `failureClass: 'auth_failed' | 'silent_stream' | 'server_unreachable' | 'provider_error'`）。
- **实例配置 Schema（JSON Schema，托管于 `HarnessInstanceRegistry`）**：
```ts
export interface OpenCodeInstanceConfig {
  mode: 'managed_local' | 'external_server';
  binaryPath?: string;                   // managed_local 使用，默认 PATH 解析 opencode
  serverUrl?: string;                    // external_server 必填，如 http://127.0.0.1:4096
  serverPasswordSecretRef?: string;      // external_server 密码引用，禁止明文落盘
  defaultAgent?: string;                 // OpenCode 原生 agent preset
  connectTimeoutMs?: number;             // 默认 5000
  silentStreamTimeoutMs?: number;        // 默认 45000
}
```
- **持久化方式**：无自建数据库表；本地托管进程的 PID/端口/租约表仅驻留内存（参考 `OpenCodeServerLedger` 内存账本），重启后重新探测或按需拉起；用户配置存入 `HarnessInstanceRegistry`，密钥仅存操作系统安全钥匙串（`secretRef`）。

---

## 4. UI 扩展、权限需求与生命周期

- **UI 扩展点与交互形式**：
  - `presentation`：名称 `OpenCode`、SVG 图标、主题色 `var(--accent-cyan)`；
  - `harness.settings`（key: `opencode`）：沙箱配置表单，支持切换“本机自动托管 / 连接外部 Server”、测试 `/server/info` 连通性与版本校验、展示托管守护进程健康状态；
  - `composer.traits`：由 `ProviderOptionDescriptor[]` 自动渲染 Agent 档位与模型选择器；
  - `chat.block`（key: `ext:opencode.image_job`）：展示 OpenCode 原生图像生成作业进度与受限图片预览（严格限制 MIME 白名单 `.png/.jpg/.jpeg/.webp/.gif` 与单图体积上限）。
- **权限需求**：
  - 全局高风险权限：`harness:driver:register`；
  - 条件权限：本地模式需 `process:spawn:opencode`；外部/本地 HTTP 通信需 `net:127.0.0.1`（或用户显式配置的远端 Host 白名单 `net:<host>`）；密钥读取需 `secrets:read:opencode`。
- **生命周期**：
  - **安装**：校验 Ed25519 签名（远程来源）与权限清单，完成 `manifest-v5` 验证；
  - **启用**：向宿主注册 `opencode` 驱动并执行一次被动版本/信息探活（不提前拉起无用的本地 Server）；
  - **更新**：修改 `serverUrl` 或密码时调用 `forget()` 丢弃旧已验证连接，下一轮自动重新握手；已有活跃轮次等待完成后切换；
  - **禁用/卸载**：先中断全部活跃 SSE 订阅并向运行中轮次发取消请求；若为 `managed_local` 模式则经宿主 `ProcessSupervisor` 终止托管 `opencode serve` 进程树，若为 `external_server` 模式仅断开连接绝不杀远端进程。

---

## 5. 异常处理、恢复与降级机制

1. **SSE 静默假死（`OpenCode2SilentStreamError`）**：超过 45s 未收到任何事件或心跳时主动断开 SSE，查询一次会话最终态接口（poll reconciliation）；若服务端已结束则补发真实终态，否则标记 `turn.terminal(status: 'failed', failureClass: 'silent_stream')` 并触发自动重连；
2. **协议前向不兼容（未知事件帧）**：解码失败的 SSE JSON 帧绝不击溃订阅流；先用轻量信封解析器提取 `type` 与 `sessionID`，遇终态事件合成 `unreadable.execution.ended` 收敛轮次状态，其余未知帧记入限频诊断日志；
3. **1.x Server 误连保护**：若 `/server/info` 返回 HTML 或非 2.x Schema，给出明确诊断 `"The server is not an OpenCode 2 server."`，阻止后续发送损坏会话；
4. **本地托管进程崩溃**：`processExit` 信号立即触发活跃会话错误收敛（宿主对遗留运行中工具块执行终态结算），并在下次发消息时惰性重建本地 Server；
5. **降级策略**：若图片读取或 `shellJobs` 端点返回 404（旧版 2.x Server），自动降级为忽略该可选能力而不阻断主对话。

---

## 6. 测试方案与可验证验收标准

- **单元测试**：
  - `serverEnvironment()` 剥离 `OPENCODE_SERVER_PASSWORD` 并注入内存随机 `OPENCODE_PASSWORD`；
  - 401/500/HTML 200/超时 错误文案脱敏（确认密码字符串零泄露）；
  - 未知 SSE 帧与 `unreadable.execution.ended` 终态兜底解析器。
- **集成测试（Mock HTTP + SSE Server）**：
  - 验证“先订阅 SSE 再 POST 发起轮次”顺序，防止竞态丢首个事件；
  - 验证 45s 静默流触发 `OpenCode2SilentStreamError` 后准确收敛轮次状态；
  - 验证单本地 Server 多工作区并发会话路由不串台。
- **端到端测试**：
  - 在 `managed_local` 与 `external_server` 两种模式下完成多轮对话、中途打断、插件热禁用与外部进程存活校验；
  - 与 `hm.adapter.codex` 双向执行跨引擎上下文交接（验证 `inline` 降级通道与 `hm_session_read` 回查）。
- **可验证验收标准**：
  1. 零修改 `packages/daemon` 或 `packages/web` 源码，仅通过安装该插件即可在 UI 中配置、探活并完整使用 OpenCode 2.x；
  2. 401 鉴权失败与异常栈中经正则断言零出现密码明文；
  3. 模拟 SSE 静默断流与未知新事件类型注入，前端无挂起气泡且 100% 正常结算终态；
  4. 禁用插件后本地托管模式零残留 `opencode` 子进程，外部模式目标 Server 保持存活。
