# 插件 SDK V4 开发计划与进度

以《插件 SDK V4（设计草案 · 第三版）》第 20 节为实施顺序。每项以代码和回归验证为完成依据。

| 阶段 | 交付与验收 | 状态 |
| --- | --- | --- |
| P0 | AGY/ACP 用户侧交接、参考式文本、安装包摘要确认、斜杠字面替换、单次超时隔离 | 已实现 |
| P1 | 独立 API 和 SDK、逐级清单迁移、服务依赖与生命周期、公共事件映射及契约检查、V1–V4 回归 | 已实现 |
| P2 | 组合与覆盖层、插件中心组合视图、第一方服务和 adapter、交接段落与可审计快照 | 已实现 |
| P3 | 隔离级进程、RPC、第三方服务提供方、公共服务权限与授权迁移、实例标识跨进程校验 | 待开发 |
| P4 | 类型化 UI 插槽、面板迁移、第三方 iframe | 待开发 |
| P5 | 开发模式、脚手架、日志面板及远程索引和签名 | 待开发 |

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

## 0.5.0 验收记录

- `pnpm build`、`pnpm typecheck`、`pnpm test` 通过。共 22 项测试，含 19 项 daemon 测试。
- 真实 stdio 传输配合模拟 CLI 覆盖 Codex、Claude 与 AGY 的交接、回退和发送记录。
- Chromium 验证组合来源、依赖等待以及依赖恢复后启用。
- Windows x64 便携包构建通过。包内 Electron 守护进程通过 V4 安装、依赖停用与恢复和前端资源加载检查。

第三方 V4 代码入口 `main`、公共服务替换权限与跨进程调用属于 P3。审批注解与接力建议的事件契约已保留，业务生产方将在相应服务开放时接入。
