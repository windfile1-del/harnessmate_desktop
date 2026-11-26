# 宿主服务与配置

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

第一方服务按名称注册；第三方 V4 隔离插件可在声明 `service:provide:<name>` 并获授权后替换公共服务（`ledger`、`handoff`、`git`、`usage`、`notify`），或提供带命名空间前缀的第三方服务。`harness.*` 仅允许第一方提供。

- `approval-center`
- `attachments`
- `checkpoints`
- `compressor`
- `failover`
- `files`
- `git`
- `git.checkpoint.v1`
- `git.workspace.v1`
- `handoff`
- `harness.acp`
- `harness.agy`
- `harness.claude`
- `harness.codex`
- `ledger`
- `native-commands`
- `orchestrator`
- `rules`
- `session-search`
- `session.attachments.v1`
- `session.inbox.v1`
- `session.ledger.v1`
- `session.notifications.v1`
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
