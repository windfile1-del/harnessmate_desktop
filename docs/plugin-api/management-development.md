# Public management and developer tools (B5 W2)

Both management and development tools are ordinary packages. The default composition explicitly binds `management.view.v1` and `developer.tools.v1`; external packages can provide the same names without an official ID, private registry or layout store. `plugins/examples/hm.plugin.management-lite` is a runnable replacement; `plugins/examples/user.release-notebook` is a runnable page/service output.

## Navigation and views

Use W1 `bridge.navigate({target:{kind:'page',contract:'management.view.v1'},context:{managementTab:'settings'}})`, or resolve the selected provider then navigate to its declared `workspace.pages` slot. The default shell carries arbitrary navigation context to the mounted page. No management fallback is created when a binding/provider is unavailable. Views use `bridge.surfaces` for settings slot mounts/diagnostics and `bridge.contributions.query({kind:'settings'})` / `execute(key)` for contributed settings navigation. Unmount releases the per-mount state and registrations.

The trusted module `bridge.call('transport.request', {path,method,body})` uses the existing local HTTP boundary; body is a JSON string. Backend trusted-local packages can use `ctx.runtime.requestHost({path:'/api/v1/...',method,body})` with structured JSON. This optional feature is `runtime.requestHost`; it is granted only to an active trusted-local instance/run, accepts local API paths, rejects traversal, and rechecks the run after an awaited response. It passes no host store or bearer credentials. `runtime.dataDirectory` is that instance's persistent directory. Trust retains its existing meaning: trusted-local code runs with current-user filesystem/network/process privileges. Ordinary restricted code and storage/workspace permissions keep their existing rules.

## Kernel management API

These mechanisms remain in the kernel, independent of any management UI:

| Method / path under `/api/v1` | Use |
| --- | --- |
| GET `/plugins`, `/plugins/composition`, `/plugins/services` | Instances, composition, providers |
| POST `/plugins/preview` then `/plugins/install` | Review source/digest and install; pass `expectedDigest`, optional `expectedInstalledDigest`, explicit first-source `trustCode` |
| PATCH `/plugins/:id` `{enabled}` | Enable/disable |
| POST `/plugins/:id/rollback` | Previous package/dev revision |
| PUT `/plugins/composition/bindings` `{contract,instanceId}` | Bind or clear (`null`) |
| PUT `/plugins/composition/instances` | Instance package, config and dependency bindings |
| POST `/plugins/composition/restore` `{source:'previous'|'builtin'|'empty'}` | Restore composition |
| GET `/plugins/settings`, `/plugins/:instanceId/settings` | Owner schema/version/config/custom view descriptors |
| PUT `/plugins/:instanceId/settings` | `{config,schemaVersion,expectedVersion}` with type/version validation and activation |
| GET/PUT `/plugins/host-config` | Generic startup port/data root; PUT returns concrete `launch.executable/args/env` for a new process |

Settings schema is declared in `contributes.settings` and versioned with `contributes.settingsVersion`. Scalar, object and array types are supported. For richer forms contribute a W1 `settings` action or an existing settings surface; the owner keeps domain validation and storage. All instances have an explicit complete JSON configuration editor, so third-party keys do not need adding to a central enum.

## Configuration mapping and rollback

`config.json.pluginConfig[instanceId]` is the canonical owner map. Explicit composition `entries[].config` overrides that base at activation. The settings editor reads the merged value; saving materializes it in the owner map and clears that instance's composition override, preserving its package, disabled flag and bindings. This avoids stale account arrays shadowing B4 compatibility writes. Composition restore rolls back composition/overrides, not arbitrary plugin data or canonical settings. Back up config for configuration rollback.

| B4 input | Owner |
| --- | --- |
| `binaryOverrides[driverId]` | `pluginConfig['harness-'+driverId].binaryPath` |
| `harnessInstances` | Owner `instances`, grouped by existing `driverId`, preserving IDs |
| `customAcpHarnesses` | `pluginConfig['harness-acp'].customHarnesses` |
| `agyProfiles` | `pluginConfig['harness-agy'].profiles` |
| Layout theme | Selected layout instance `theme` schema; generic theme application primitive |
| Port / data root | Host startup configuration; root selected by `HARNESSMATE_DATA_DIR` in a new process |
| Policies, terminal state, remote pairing | Existing owner views/services/data retained; no copied central configuration. Remote domain/lifecycle cleanup belongs to W3. |

Non-enumerable compatibility accessors keep old APIs reading/writing the owner map. Save emits B4 field mirrors for old binaries. No accounts/bindings/data are deleted by disable. This is format compatibility; a real B4 EXE data-copy acceptance is W3's responsibility.

## Lifecycle-owned developer routes and tasks

The backend package is built from `plugins/developer-tools/index.ts` into its ordinary package main; `apply(ctx)` constructs Authoring/Builder and registers routes. Disposal cancels sessions/verification subprocesses, removes service/routes and persists cancellation. The host does not construct either class.

Routes are relative to `/api/v1/plugin-instances/:selectedToolInstance/routes`:

| Route | Behavior |
| --- | --- |
| GET `/context` | SDK version/features, current providers and user-message brief |
| POST `/tasks` | `{taskId,kind:'generate'|'author',input,closePolicy:'cancel'|'background'}`; returns 202 task |
| GET `/tasks`, `/tasks/:id` | Reconnect/status and bounded persisted results/diagnostics |
| POST `/tasks/:id/cancel` | Idempotent cancellation |
| POST `/install` | Reviewed `draftId` or files, exact `expectedDigest`, `installMode:'dev_link'|'local_install'`, source trust |
| POST `/scaffold`, `/audit` | Templates and diagnostics owned by the tool instance |
| POST `/preview/program`, `/preview/replay` | Draft-only preview; replay reads the existing session projection API |

One generation runs per tool instance. Task IDs prevent duplicate generation after reconnect. Closing a page aborts polling; cancel mode also sends cancellation, background mode leaves the task discoverable. Explicit cancel and plugin disable always cancel. Process interruption/re-enable marks running tasks cancelled; completed reviewed files can be installed after reconnect without regenerating. The journal retains at most 60 records on disk. Installation re-materializes and verifies reviewed files before mutation. A new dev source requires consent; edits/reloads or reinstalling the same trusted real directory/ID reuse trust. A bad revision leaves the last good service active; stopping, previous revision and composition restore use the existing kernel mechanisms.

Developer mode appends `/context.userMessage` only to the selected development user turn. It never changes system instructions or adds context to normal turns. The tool also supplies this brief directly to generation. Available capabilities/features are discovered, not guessed.

## Executable development walkthrough

1. `pnpm build`; start the daemon/Web with an isolated D-drive data root. Open the capability-bound management page and AI development page. Select a real workspace/Harness and describe a page/service plugin.
2. Inspect all generated files and the four diagnostic phases: schema/structure, static audit, Node syntax, mock activation/CSP. Failed attempts are visible (maximum three automatic attempts); install is disabled until verified.
3. Choose DevMode, review trust, install. The result includes installed ID, source directory, activation status and contributed page IDs. Use the preview button, choose a service binding, then edit the returned source directory; the existing watcher hot-loads a fresh revision. Same-source reload requires no repeated trust prompt.
4. For an offline reproducible example run `node scripts/b5-w2-ui-smoke.mjs D:/HarnessMate/b5-tmp/w2/ui-smoke` after setting TEMP/TMP to D. This uses deterministic Harness output through the actual generation/build/install/UI paths; it does not test cloud model quality.
5. To recover from a disabled/broken manager, open `#kernel-recovery` (the fixed recovery link remains outside the layout). Preview/install a source, disable a bad instance, select bindings, roll back revisions or restore a combination. No full management view is imported.

Installing these JS packages hot-loads and returns `restartRequired:false`. Startup port/data-root changes return `restart_required` with actual executable/arguments/environment; exit the old process and run those parameters. Plugin revision rollback does not undo arbitrary external filesystem/network effects.
