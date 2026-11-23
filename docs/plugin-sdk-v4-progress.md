# 插件 SDK V4 开发计划与进度

以《插件 SDK V4（设计草案 · 第三版）》第 20 节为实施顺序。每项以代码和回归验证为完成依据。

| 阶段 | 交付与验收 | 状态 |
| --- | --- | --- |
| P0 | AGY/ACP 用户侧交接、参考式文本、安装包摘要确认、斜杠字面替换、单次超时隔离 | 已实现 |
| P1 | 独立 API 和 SDK、逐级清单迁移、服务依赖与生命周期、公共事件映射及契约检查、V1–V4 回归 | 已实现 |
| P2 | 组合与覆盖层、插件中心组合视图、第一方服务和 adapter、交接段落与可审计快照 | 已实现 |
| P3 | 隔离级进程、RPC、第三方服务提供方、公共服务权限与授权迁移、实例标识跨进程校验 | 已实现 |
| P4 | 类型化 UI 插槽、面板迁移、第三方 iframe | 已实现 |
| P5 | 开发模式、脚手架、日志面板及远程索引和签名 | 已实现 |

## P0 交接与安装边界

- AGY 和 ACP 优先使用用户消息的内嵌资源，缺少能力时使用用户消息信封。Codex 和 Claude 的系统侧通道只用于固定的一句交接说明。
- JavaScript、ACP 启动配置和 MCP 预设的确认绑定包摘要。包含 ACP 启动配置或 MCP 预设的旧版本需要重新预览确认。已按摘要信任的 V1 JavaScript 可以继续加载。
- V1 `beforeTurn` 结果显示为可选文本。原生消息使用用户确认的文本，或沿用原文和由用户主动触发的斜杠模板。单次脚本超时只拒绝当前调用。仍未返回的调用达到上限时，热重载可重建 Worker。
- 本机 `claude --help` 列出了 `--system-prompt-snapshot <on|off>`。该参数用于需要附加固定交接说明的 Claude 会话。

## P1 运行时与兼容

- 独立的 `@harnessmate/plugin-api` 和 `@harnessmate/plugin-sdk` 使用 API 版本 `4.0.0`。清单读取沿相邻代际转换，保留原始文件与包摘要。
- 第一方服务按名称注册。缺依赖时进入 `PENDING`，依赖移除时按逆序清理，恢复后重新启动。旧生命周期上下文不能操作新实例。
- V1 的轮次观察使用公共 DTO 的兼容视图。V2 面板与 V3 动作、模型工具继续按原有授权运行，V4 声明式清单可组合这些能力。
- `pnpm contracts:generate` 生成[事件矩阵](plugin-api/events.md)、[服务和配置目录](plugin-api/services.md)、[API 报告](plugin-api/plugin-api.api.md)和[清单 Schema](plugin-api/manifest-v4.schema.json)。`pnpm test` 会检查产物一致性和公共包依赖边界。

## P2 配置与交接

- 在应用数据目录中，`profile.json` 的 `bundles` 按顺序列出组合包。自定义组合作为 `bundles/<包 ID>.yml` 加载。`patch.yml` 按条目 ID 叠加 `disabled` 与 `config`，初次加载时转入旧版启停设置。
- 内置条目 `ledger`、`handoff`、`git`、`usage`、`harness-codex`、`harness-claude`、`harness-agy`、`harness-acp` 对应实际注册的服务。插件中心「查看完整组合」显示覆盖来源、配置和状态。
- 交接模块将工作区状态、账本、早期摘要和近期对话分别渲染。额外段落经追加接口进入用户通道。账本和交接服务可独立启停，交接项支持 `budgetTokens` 和 `autoAttach`。
- `handoff.snapshot` 在发送前记录实际通道和内容。`handoff.snapshot_delivered` 记录传输路径提交结果，失败或取消的轮次不用于后续去重。聊天支持展开历史和移除本轮待发送交接，Markdown 导出保留发送记录。

## P3 隔离与权限

- 第三方 V4 `main` 代码插件通过独立子进程启动（`--permission --allow-fs-read=<插件包目录> --max-old-space-size=128`），环境变量白名单剥离 daemon token 与 CLI 凭据，禁止越权读盘、写盘、派生子进程及接触系统提示词通道。
- 双向 JSON-RPC over stdio 握手校验 `pluginApi` 与 `requires` 特性；每次启动分配唯一 `runId`，宿主与子进程双方校验实例标识，重启或升级后旧 `runId` 调用与回调均返回 `E_STALE_RUN`。
- 单次调用按类型设超时（命令/服务 10s、事件/钩子 2s、模型工具 30s），单次超时只返回 `E_TIMEOUT` 不终止进程；进程异常退出按指数退避重启，10 分钟内崩溃 5 次进入 `FAILED`。
- 第三方插件可通过 `provides` 注册带命名空间前缀的服务并在多进程间通过宿主代理互相调用；替换内置公共服务（`ledger`、`handoff`、`git`、`usage`、`notify`）需声明并获全局授权 `service:provide:<name>`，`harness.*`、`mcpHub`、`remote` 禁止第三方提供。
- 公共服务（`sessions`、`ledger`、`handoff`、`composer`、`approvals`、`tools`、`storage`、`fs`、`net`、`notify`、`clipboard`、`events`）统一按 V4 权限表校验，未授权返回 `E_PERMISSION_DENIED`。授权支持「覆盖后续版本」（权限未增加时升级自动沿用，新增权限需重新授权），并支持 V3 `tool:*` / `action:*` 向 `tools:model` / `session:command` 迁移。
- `approval.annotate` 风险标注与 `handoff.shouldOffer` 接力建议已接入 `SessionManager`，隔离插件的 `tools.register` 接入官方 MCP 工具租约并支持任意 JSON Schema。

## P4 类型化 UI 插槽

- `@harnessmate/plugin-api` 定义公共 UI 插槽目录（`session.header.title`、`sidebar.tools`、`composer.actions`、`inspector.tabs`、`statusbar.items`、`chat.node`、`tool.result`、`approval.detail`、`chat.message.wrapper`），支持 `single` / `list` / `keyed` / `chain` / `hoc` 五种基数和 `root` / `session` / `session-maybe` 三种作用域，`pnpm contracts:generate` 同步生成 [UI 插槽目录](plugin-api/slots.md)。
- 清单 `contributes.slots`（兼容 `inspector.tab` 别名）与隔离插件 `ctx.slots.register()` 统一接入类型化插槽注册表；组件不接触 `ctx`，仅接收 owner props 与标准 hooks（`useSession`、`useTurn`、`useSlotTheme`），卸载或停用时按 effect 自动撤销。
- 现有 V1 `panels` 与 V2 `dataPanels`（含 `sidebar_tool`、`composer_action`、`inspector_tab` 位置）全部经由 `PluginSlotSync` 迁入 `inspector.tabs`、`sidebar.tools`、`composer.actions` 插槽，审批风险标注迁入 `approval.detail` 链式插槽；每一项插槽内容独立包裹 `SlotErrorBoundary`，单点渲染异常隔离并通过 `reportRenderFailure` 上报至插件中心。
- 第三方 HTML 视图通过守护进程 `GET /api/v1/plugins/:id/ui-doc` 安全读取并内联包内相对 CSS/JS（拦截路径穿越、符号链接逃逸与外链资源），在严格 CSP 与 `sandbox="allow-scripts"`（无 `allow-same-origin`）沙箱 iframe 中渲染，自动注入并同步浅/深色主题 CSS 变量，经 `postMessage` 与 `POST /api/v1/plugins/:id/ui-message`（带 `runId` 过期校验）通信。

## P5 开发模式、脚手架、日志面板与签名索引

- **开发模式热重载**：`PluginDevWatcher` 仅在本机监听关联的本地源码目录（`POST /api/v1/plugins/dev/link`、`POST /api/v1/plugins/dev/:id/reload`、`DELETE /api/v1/plugins/dev/:id`），文件保存后自动按单插件粒度回滚旧实例 effect 并重启新 `runId`；插件中心标注「开发中」并支持手动重载与安全取消关联（不删除源码目录）。
- **插件脚手架**：`@harnessmate/plugin-sdk` 导出 `scaffoldPluginFiles`，提供 CLI `pnpm create:plugin`（支持 `isolated`、`ui-slot`、`service`、`declarative` 四种 V4 模板，以及 `keygen` / `sign` 发布者密钥生成与包签名）和守护进程 `POST /api/v1/plugins/scaffold`（可在插件中心一键生成并自动关联开发模式）。
- **插件日志面板**：守护进程合并宿主生命周期/热重载日志与隔离进程 `ctx.logger` 日志，提供 `GET/DELETE /api/v1/plugins/logs` 与 `GET/DELETE /api/v1/plugins/:id/logs`；插件中心新增「日志」标签页，支持按插件/级别/关键词过滤、自动刷新、复制与清空。
- **远程插件索引与发布者签名**：`PluginRegistryService` 支持多远程索引 URL（`https`/`http`/`file`）与受信任 Ed25519 发布者公钥环持久化，自动校验 `engines.pluginApi` 兼容性（标出「不兼容」并阻止安装）与 Ed25519 规范化摘要签名（拦截篡改包、无效签名及未信任发布者），支持 `mode: 'remote_index'` 事务性预览与安装。

## 0.5.0 验收记录

- `pnpm build`、`pnpm typecheck`、`pnpm test` 通过。共 34 项测试，含 1 项 protocol 测试、6 项 web 测试（含 P4 类型化 UI 插槽、错误隔离与沙箱 iframe 校验）及 27 项 daemon 测试（含 P3 隔离沙箱/权限、P4 沙箱 UI 资产与跨进程插槽消息桥接、P5 脚手架/开发模式热重载/统一日志/远程 Ed25519 签名索引）。
- 真实 stdio 传输配合模拟 CLI 覆盖 Codex、Claude 与 AGY 的交接、回退和发送记录。
- 契约检查 `pnpm contracts:check` 通过，`docs/plugin-api/*` 与公共包边界一致。
