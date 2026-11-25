# NP-17 Independent Acceptance Fixtures (`scripts/agy-np/e2e/fixtures/`)

All files in this directory are strictly sanitized (`zero real credentials`, `zero real host paths`, `zero private user prompts`) and completely separate from `packages/daemon/tests/fixtures/`.

| File | Provenance Category | Purpose |
| --- | --- | --- |
| `e2e-t01-t06-lifecycle.ndjson` | `synthetic` | Independent transport replay fixture validating `T02` + `T04` + `T06` finite vs daemon wakeups, `NP00_FINITE_DONE` / `NP01_DAEMON_READY` / `NP01_WAKE_CHECK` markers, and out-of-turn permission handling through `observatory/replay-runner.mjs`. |
| `e2e-legacy-1.5.14-compat.ndjson` | `synthetic` (`agy-1.5.14` shape aligned) | Independent 1.5.14 stage fixture verifying backwards compatibility via `observatory/migrator.mjs` + strict schema/leak validation. |
| `e2e-ui-four-states.json` | `synthetic` | Acceptance payload matrix covering all 4 UI states: `actionable`, `read_only`, `no_data`, `stale_request`. |
| `mock-acp-peer.mjs` | `synthetic` | Real stdio child-process ACP JSON-RPC 2.0 peer used by `run-acceptance.mjs` to exercise real daemon `AcpSessionHandle`, `AgyAdapter`, `AgyReactiveRuntimeController`, permissions/questions, `set_mode`, `plan`/`diff`, and cancellation. |
| `windows-comparison-checklist.json` | `live_raw` (unauthenticated `1.5.17`) + `[BLOCKED: U01]` slots | Structured Windows App (`2.35.1`) / IDE (`2.5.5`) / CLI (`1.5.17`) / Raw ACP / HarnessMate comparison checklist. |
