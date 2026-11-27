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
The final samples live in `D:/HarnessMate/b3-tmp/w3/formal-performance`.
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

After all product processes have closed, `run-rollback.ps1` copies the B2 first
sample's data into a new rollback directory, starts the real B3 EXE to read the
old history and write one new offline round, then starts the real B2 EXE to
compare both sessions' full event digests, sequences, exports and ledger reads.
It refuses to overwrite an existing rollback destination. Only copies are used.

For standard tests, use a D: temporary root **outside any Git working tree**.
Putting `TEMP` inside this repository invalidates fixtures that expect their
new temporary directories to be non-Git workspaces.

All fixture traffic is offline. It is not evidence of a real provider account,
real CLI dialogue, real approval execution or a Windows notification banner.

`b2-pages-browser.mjs` runs the current build with fixed usage/MCP backends in
an actual Edge browser. It clicks policy and config controls, then disables
the default providers and verifies external usage/MCP pages render data from
their own instance routes. This is a browser/mock-backend layer, not a packaged
Electron or real-account write check.

`product-terminal.mjs <port> <data-dir> <output-root>` instead connects to an
already-running portable EXE. It checks the native OS shell and terminal chips,
then fills an external terminal to 65,536 bytes and verifies continued WS
output, context and resubscription. `composer.mjs <port> <debug-port> <output-root>`
uses that result to check model/mode controls, plugin development toggle,
terminal reference submission, Enter, Windows clipboard and Markdown download.
All profiles, outputs and download paths are on D:.
Restore and focus the isolated product window before running `composer.mjs`;
Windows clipboard writes reject hidden/unfocused documents. The script waits
for that prerequisite and checks the clipboard using explicit UTF-8 output.
Each session downloads to a fresh subdirectory to avoid matching an old export.
