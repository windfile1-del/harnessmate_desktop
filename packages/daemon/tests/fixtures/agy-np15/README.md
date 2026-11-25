# NP-15 Offline Fixtures (Sanitized)

These fixtures support deterministic unit, protocol compatibility, and recovery testing for **NP-15 (Session Recovery & Protocol Compatibility)**.

## Files & Provenance

1. `v1-v2-negotiation-and-replay.ndjson`
   - **Sources**:
     - `E02` (`windows-1.5.16-clean-v1.ndjson`) & `windows-1.5.17-clean-v1.ndjson` (`live_raw` unauthenticated Windows AGY CLI 1.5.16 / 1.5.17 handshake shapes, including camelCase + snake_case capability aliases and `-32000 Authentication required`).
     - `E03` (`windows-1.5.16-request-v2.ndjson`) & `windows-1.5.17-request-v2.ndjson` (`live_raw` v2 request -> v1 downgrade).
     - `synthetic` controlled ACP v2 Preview handshake, `replayFrom`, `state_update`, `replay_complete`, `prompt_accepted`, and negative frames (`protocolVersion: 99`, v2 frame on v1 wire).
   - **Redaction**: Zero OAuth tokens, real profile paths, workspace paths, or real user prompts.

2. `t09-t14-recovery-scenarios.ndjson`
   - **Sources**: `synthetic` + `replay_with_provenance` (aligned with `12_Test_Strategy.md` T09, T14, T15 and `08_Shared_Contracts.md`).
   - Covers `session/load` history replay with an embedded `session/request_permission` (must be blocked), v1 `session/resume` live reattach, and T09 schedule occurrence frames (`DurationSeconds`, `CronExpression`) for cross-generation deduplication and unverified stale fallback.
