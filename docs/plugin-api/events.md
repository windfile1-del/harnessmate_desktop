# 公共事件

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

| 事件 | 分发 | 权限契约 | 生产方 | 内置消费方 |
| --- | --- | --- | --- | --- |
| `turn.started` | emit | `events:turn` | plugin-host/runtime/map-event.ts | — |
| `turn.completed` | emit | `events:turn` | plugin-host/runtime/map-event.ts | plugin-host/builtin/services.ts |
| `turn.failed` | emit | `events:turn` | plugin-host/runtime/map-event.ts | plugin-host/builtin/services.ts |
| `turn.cancelled` | emit | `events:turn` | plugin-host/runtime/map-event.ts | — |
| `message.user` | emit | `events:message` | plugin-host/runtime/map-event.ts | — |
| `message.assistant.completed` | emit | `events:message` | plugin-host/runtime/map-event.ts | — |
| `tool.completed` | emit | `events:tool` | plugin-host/runtime/map-event.ts | — |
| `approval.requested` | emit | `events:approval` | plugin-host/runtime/map-event.ts | — |
| `session.created` | serial | `session:read` | core/session-manager.ts | plugin-host/builtin/services.ts |
| `session.closing` | parallel | `session:read` | core/session-manager.ts | — |
| `plugin.state` | emit | — | plugin-host/runtime/lifecycle.ts | — |
| `handoff.compose` | waterfall | `handoff:section` | core/context-compiler.ts | — |
| `handoff.shouldOffer` | bail | `session:read` | core/session-manager.ts | — |
| `approval.annotate` | waterfall | `approvals:annotate` | core/session-manager.ts | — |
