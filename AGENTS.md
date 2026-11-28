# HarnessMate Desktop — Agent Development Guide

This repository uses a minimal-kernel, peer-plugin architecture. All product UI and domain capabilities must be built as peer plugins using public contracts (`@harnessmate/plugin-api` / `@harnessmate/protocol`).

## Frontend Kernel & Application Entry Rules (Batch 5 W1+)

1. **Minimal Kernel Root (`packages/web/src/App.tsx`, `kernel/`, `stores/kernel-store.ts`)**:
   - `App.tsx` ONLY mounts the explicitly bound `application.view.v1` layout plugin through `ApplicationEntryHost`, runs `KernelSlotSync`, and installs `installKernelContributionRuntime()`.
   - NEVER import business/layout components (`Sidebar`, `InspectorDrawer`, `Modals`, `CommandPalette`, `TriageInbox`, `ChatStage`, `plugins/shell-default`) or `stores/app-store.ts` into `App.tsx`, `KernelRecoveryView.tsx`, `kernel/*`, `stores/kernel-store.ts`, `slots/TrustedPluginModuleHost.tsx`, `slots/SandboxedPluginFrame.tsx`, `slots/BoundSessionSurface.tsx`, `slots/KernelSlotSync.tsx`, `slots/shell-bridge.ts`, or `slots/sandbox-bridge-handler.ts`.
   - This invariant is enforced both at build time (`kernel-root-ownership-check` in `packages/web/vite.config.ts`) and in unit tests (`packages/web/tests/b5-w1-shell-decoupling.test.tsx`).

2. **Peer Application Layouts (`application.view.v1` + `application.shell`)**:
   - Default layout (`plugins/bundled/hm.plugin.shell-default`) and external layouts (such as `plugins/examples/hm.plugin.shell-lite`) load through the exact same `ApplicationEntryHost` loader (`TrustedPluginModuleHost` / `SandboxedPluginFrame`), sharing `window.__HARNESSMATE_PLUGIN_RUNTIME__`.
   - Do NOT add official ID whitelists, default-component branches, or implicit host layout fallbacks. When `application.view.v1` is unbound, disabled, unavailable, or fails to load/render, `ApplicationEntryHost` enters `KernelRecoveryView`.

3. **Navigation, Contributions & Surface Mounting**:
   - Use `bridge.navigation.navigate(...)` / `ui.navigate` (`NavigationRequestV1` -> `NavigationResultV1`) for cross-plugin navigation; layouts register handlers via `bridge.navigation.registerHandler(...)` and interpret `placement`.
   - Register pages, regions, commands, shortcuts, menus, tray actions, and settings via `bridge.contributions.register(...)`. All registrations are scoped to `{ instanceId, runId }` and auto-revoked on unload.
   - Shortcuts must respect IME composition (`isImeComposing`) and editable focus guards (`allowInInput`).
   - Application layout plugins mount child plugin views (`chat.view.v1`, `workspace.pages`, etc.) via `bridge.surfaces.mountBoundSurface(...)` and `bridge.surfaces.mountSlotItem(...)`.

4. **Standalone Recovery (`KernelRecoveryView`)**:
   - Must depend ONLY on `packages/web/src/kernel/recovery-client.ts` and minimal local state.
   - Must NEVER import `useAppStore`, `ModalHost`, `Sidebar`, or chat modules, and must remain operable without management/marketplace plugins.

5. **Transitional W2/W3 Adapters**:
   - Remaining transitional `shell-bridge` actions are explicitly tracked in `LEGACY_SHELL_BRIDGE_ADAPTERS` (`packages/web/src/slots/shell-bridge.ts`) and `docs/plugin-decoupling-batch-5/reports/W1.md`. Do not expand the permanent whitelist; migrate callers in W2/W3 and remove adapters as owners complete.

6. **Contracts & Temp Files**:
   - Any change under `packages/plugin-api/src` requires running `pnpm contracts:generate` and passing `pnpm contracts:check`.
   - Place all temporary files, test data directories, and caches on drive `D:` (e.g., `D:/HarnessMate/b5-tmp/`).
