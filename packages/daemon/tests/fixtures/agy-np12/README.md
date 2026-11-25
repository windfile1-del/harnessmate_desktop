# NP-12 Offline Fixtures (`agy-np12`)

All fixtures in this directory are deterministic `synthetic` test captures (zero long-lived real schedules, zero real credentials, zero real workspace paths) used to verify NP-12 (`T09`, `T14`) without running live long-duration cron tasks during exploration.

| File | Scenario | Verification Category | Notes |
| --- | --- | --- | --- |
| `t09-oneshot-post-turn-wake.ndjson` | T09 One-shot schedule + ended user turn + post-turn wake | `synthetic` | Proves `blocking=detached`, separate occurrence `WorkId`, and distinct wake `ActivityId` (`turnId: null`, `origin: 'native_task'`). |
| `t09-early-cancel-and-goal-lifecycle.ndjson` | T09 Early cancel (`manage_task` kill) + Goal launch/verify/replace/stop | `synthetic` | Proves early cancellation preserves read-only history, Goal replacement marks old Goal `superseded`, and unapproved paths are rejected. |
| `t09-simulated-cron-multi-occurrence.ndjson` | T09 Simulated multi-occurrence cron + missing `nextAt`/timezone | `synthetic` | Proves 2 simulated cron ticks create 2 distinct `WorkId`s + 2 distinct wake `ActivityId`s without guessing `nextAt` or host timezone. |
| `t14-disconnect-restart-recovery.ndjson` | T14 Disconnect -> `stale` + NP-15 scope/dedupe reconciliation | `synthetic` | Proves expired history stays `preserved_read_only`, armed schedule becomes `stale`, cross-scope rebind is blocked, and same-scope recovery deduplicates occurrences. |
