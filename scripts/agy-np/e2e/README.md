# NP-17 Independent E2E Integration & Acceptance Suite (`scripts/agy-np/e2e/`)

Standalone, non-invasive integration and acceptance harness for **HarnessMate Desktop — Antigravity (AGY) Native Parity**.

> [!IMPORTANT]
> Run this suite against a compiled candidate. The independent runner and fixtures live here. Its Web test lives in the regular Web suite.

## Contents

- `run-acceptance.mjs`: Runs end-to-end verification directly against compiled `packages/daemon/dist/**` and `packages/protocol/dist/**` over real Fastify HTTP + real WebSocket (`ws`) + SQLite (`node:sqlite`) + child stdio ACP processes + Observatory validators + optional clean unauthenticated `agy.exe` probe:
  - **Suite A (Feature-ON E2E)**: Real HTTP/WS auth (`Bearer` + `Origin`/`Host`), T01–T05 reactive turn settlement with finite background tasks and detached daemons, T06–T08 permission/question routing & idempotent command/control (`set_plan_mode`, fail-closed non-plan workflow routing), SQLite persistence & DTO redaction checks, production wiring boundary probes (NP-13/NP-14/NP-15).
  - **Suite B (Gate-OFF / Rollback & Schema Compatibility)**: Reboots daemon with `DEFAULT_AGY_NATIVE_FEATURE_FLAGS` (`enabled: false`) on a pre-populated native DB, verifies `503 NATIVE_RUNTIME_DISABLED`, verifies all pre-existing sessions/events/blocks/approvals remain readable (`200`), tests forward schema version `99` fail-closed isolation (`compatible: false, newerThanReader: true`), and runs a post-rollback regression turn.
  - **Suite C (Cross-Harness & Ecosystem Regression)**: Verifies Codex, Claude, Context Handoff ledger compatibility, and clean/legacy fixture compatibility (`agy-1.5.14` migration + T01–T06 replay).
  - **Suite D (Live Clean `agy.exe` Probe, when present)**: Executes Observatory clean unauthenticated v1 + v2 downgrade probes against official Windows `agy.exe` (zero credentials, scratch & temp strictly under `D:\HarnessMate\...`) and validates zero-leak compliance.
- `packages/web/tests/agy-np17-ui-four-states.test.tsx`: Verifies the four required UI experience states (`actionable`, `read_only`, `no_data`, `stale_request`) across `AgyWorkbenchShell`, `NativeRequestCard`, `CapabilityUnavailable`, `AgyArtifactReviewWorkspace`, and `AgyNativeSettingsWorkspace`, plus production wiring observations in `PluginSlotSync`.
- `fixtures/`: Sanitized independent fixtures and the Windows App / IDE / CLI / ACP / HarnessMate comparison checklist.

## Usage (After `pnpm build`)

```powershell
$env:TEMP = 'D:\HarnessMate\np17-temp'
$env:TMP = 'D:\HarnessMate\np17-temp'
$env:TMPDIR = 'D:\HarnessMate\np17-temp'

# 1. Backend / Protocol / Daemon / Rollback / Regression / Clean CLI E2E
node scripts/agy-np/e2e/run-acceptance.mjs --out-dir D:\HarnessMate\np17-temp\e2e-run --skip-live-cli

# 2. UI 4-State Experience Verification (actionable / read_only / no_data / stale_request)
pnpm --filter @harnessmate/web exec vitest run tests/agy-np17-ui-four-states.test.tsx
```

The default runs offline. For the optional clean probe, pass `--agy-path <absolute official agy.exe path>` and choose `--out-dir` under `D:\HarnessMate\np00-research`. The runner records the probe in that run directory with an isolated temporary profile.

## Post-NP-16 & U01 Re-Run Checklist

When re-running on the commander's frozen post-NP-16 SHA:
1. Run `pnpm install --frozen-lockfile --offline --store-dir D:\HarnessMate\agy-np-pnpm-store` and `pnpm build`.
2. Execute both commands above and inspect `<out-dir>/np17-acceptance-summary.json`.
3. Once U01 completes interactive OAuth in `D:\HarnessMate\agy-np-test-profile\gemini` and side-by-side Windows App (`2.35.1`) / CLI (`1.5.17`) testing with Gemini 3.8 Flash, update `fixtures/windows-comparison-checklist.json` or record live captures via `scripts/agy-np/observatory/cli.mjs record`.
