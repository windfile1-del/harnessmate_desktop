# 宿主服务与配置

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

第一方服务按名称注册。第三方 V4 隔离插件可在声明 `service:provide:<name>` 或 `harness:driver:register` 并获授权后提供公共契约、`harness.driver.<driverId>.v1` 同类驱动或自定义命名空间服务。`harness.agy` 原生驱动暂保留至第四批，公开契约见下表。

- `approval-center`
- `approval.policy.v1`
- `attachments`
- `browser.v1`
- `checkpoints`
- `compressor`
- `failover`
- `filePreview.v1`
- `files`
- `git`
- `git.checkpoint.v1`
- `git.workspace.v1`
- `handoff`
- `harness.acp`
- `harness.agy`
- `harness.claude`
- `harness.codex`
- `harness.driver.acp.v1`
- `harness.driver.agy.v1`
- `harness.driver.claude.v1`
- `harness.driver.codex.v1`
- `harness.driver.v1`
- `harness.mcp-config.v1`
- `harness.model-catalog.v1`
- `harness.usage.v1`
- `history.import.v1`
- `history.source.v1`
- `hm.session-data.v1`
- `ledger`
- `native-commands`
- `orchestrator`
- `rules`
- `session-search`
- `session.attachments.v1`
- `session.collaboration.v1`
- `session.compression.v1`
- `session.data.v1`
- `session.failover.v1`
- `session.handoff.v1`
- `session.inbox.v1`
- `session.ledger.v1`
- `session.model-tools.v1`
- `session.notifications.v1`
- `session.orchestration.v1`
- `session.runtime.v1`
- `session.search.v1`
- `session.snooze.v1`
- `session.studio.v1`
- `session.summary.v1`
- `terminal`
- `terminal-workspace`
- `terminal.runner.v1`
- `terminal.workspace.v1`
- `triage-inbox`
- `usage`
- `workspace.files.v1`
- `workspace.rules.v1`

## 交接配置

```ts
z.object({
  budgetTokens: z.number().int().min(2_000).max(48_000).default(12_000),
  autoAttach: z.boolean().default(true),
}).strict()
```
