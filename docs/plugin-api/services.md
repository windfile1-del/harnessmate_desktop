# 宿主服务与配置

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

第一方服务按名称注册。第三方 V4 隔离插件可在声明 `service:provide:<name>` 并获授权后提供公共契约或自定义命名空间服务。`harness.*` 下的原生驱动注册保留给第一方，公开契约见下表。

- `approval-center`
- `approval.policy.v1`
- `browser.v1`
- `checkpoints`
- `compressor`
- `filePreview.v1`
- `git`
- `handoff`
- `harness.acp`
- `harness.agy`
- `harness.claude`
- `harness.codex`
- `harness.mcp-config.v1`
- `harness.model-catalog.v1`
- `harness.usage.v1`
- `history.import.v1`
- `history.source.v1`
- `ledger`
- `native-commands`
- `orchestrator`
- `session-search`
- `session.failover.v1`
- `session.model-tools.v1`
- `session.search.v1`
- `terminal-workspace`
- `triage-inbox`

## 交接配置

```ts
z.object({
  budgetTokens: z.number().int().min(2_000).max(48_000).default(12_000),
  autoAttach: z.boolean().default(true),
}).strict()
```
