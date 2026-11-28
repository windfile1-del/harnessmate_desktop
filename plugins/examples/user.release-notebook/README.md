# Release notebook — real page/service development output

An ordinary code package, previously absent from HarnessMate, generated through the B5-W2 deterministic Harness fixture and the actual Builder pipeline. It contributes `workspace.pages/notes` and `example.release-notebook.v1` (`getInfo`, `read`); its sandbox page persists notes through the existing `storage:plugin` capability. There is no host business branch for this ID.

Run `pnpm build` then set TEMP/TMP to a D-drive directory and run:

```powershell
node scripts/b5-w2-ui-smoke.mjs D:/HarnessMate/b5-tmp/w2/ui-smoke
```

The evidence runner opens the real built application in hidden Electron, uses the development UI to request this output through a deterministic Harness adapter, runs four build/diagnostic phases, explicitly trusts and installs a dev revision, previews the page and exercises storage. The source files in this directory are the reproducible expected model output, not a substitute for the generation/build/install pipeline. This validates the offline workflow, not cloud model output quality.

For manual development choose the bound `developer.tools.v1` page, workspace/Harness and a page/service requirement; review generated files, choose DevMode, then install. The returned `dirPath` is editable. Save `index.mjs` or `ui/index.html` to trigger the existing watcher. Choose a service binding to this instance (the preview page needs no service binding). Existing storage permission must be granted through the permissions editor; this example does not bypass it.

Alternative direct install: preview this directory in management/recovery, review digest/permissions, confirm code trust and install. Bind `example.release-notebook.v1` if consuming its service. Disable retains saved notes; bad source revisions preserve last-good runtime. Use previous revision or restore a composition as appropriate. No host rebuild/new process is required for these JS contributions.
