# 宿主服务与配置

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

当前由第一方提供。外部 V4 声明式插件可将服务列为依赖。

- `failover`
- `git`
- `handoff`
- `harness.acp`
- `harness.agy`
- `harness.claude`
- `harness.codex`
- `ledger`
- `native-commands`
- `usage`

## 交接配置

```ts
z.object({
  budgetTokens: z.number().int().min(2_000).max(48_000).default(12_000),
  autoAttach: z.boolean().default(true),
}).strict()
```
