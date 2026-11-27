# B3-W3 product checks

Run from the repository root on D:. Start the **portable EXE** with a fresh
`HARNESSMATE_PORT`, `HARNESSMATE_DATA_DIR`, `--user-data-dir` and
`--remote-debugging-port`. Set `TEMP` and `TMP` to D: before launching.
An existing daemon with the same version and port can be reused by Electron;
check that the port is unused before each launch.

```powershell
node scripts/b3-w3/setup.mjs 49771
node scripts/b3-w3/acceptance.mjs 49771 49772
node scripts/b3-w3/recovery.mjs 49771 49772
node scripts/b3-w3/performance.mjs 49771 49772 B3 .tmp/w3/performance/run.json
```

`setup.mjs` installs the offline fixed driver using preview/install/grant APIs.
It creates a workspace and a session through the public product routes. Set
`HARNESSMATE_REPLAY_WORKSPACE` to isolate each run's workspace files.
`acceptance.mjs` installs the external chat page, binds a second workspace,
uses actual DOM inputs/buttons, disables/restores the page while its round
continues, verifies draft recovery without another user message, switches to
the default page, uploads/sends a file and navigates a Windows file URI/line.
`recovery.mjs` enters the empty composition and restores the shipped composition
using the actual recovery button, without creating or losing sessions.

`run-performance.ps1` launches the specified B2 EXE and the copied B3 EXE in
six independent profiles, alternating B2/B3 three times. It is machine-specific:
review its D: paths before running. Do not run builds or tests concurrently.
Each sample imports exactly 10,000 fixture events, runs 60 seconds at 25 nominal
batches/second, starts two background sessions and keeps typing a draft.
The driver schedules against an absolute clock to avoid timer drift.

Raw measurements include event payloads, WS frames, bridge receive timestamps,
DOM updates followed by two animation frames, long tasks, heap snapshots and
subscription frames. They do **not** supply exact runtime-entry or post-commit
timestamps inside the immutable B2 binary. A driver-emission marker and an
event's `createdAt` must not be relabelled as those timestamps. DOM plus animation
frames is a rendering proxy, not a timestamp from the Windows compositor.
Internal queue depth is not exposed by the B2 binary. These limitations must
remain explicit when evaluating B3-A8; the performance budgets are unchanged.

All fixture traffic is offline. It is not evidence of a real provider account,
real CLI dialogue, real approval execution or a Windows notification banner.
