import type { NavigationResultV1 } from '@harnessmate/protocol';
import { contributionRegistry } from '../kernel/contribution-registry';
import { layoutBridge, type PublishedLayoutState } from '../kernel/layout-bridge';
import { navigationBus } from '../kernel/navigation-bus';
import { useKernelStore } from '../stores/kernel-store';

/**
 * Kernel-owned fields always available in snapshots regardless of which layout is active.
 */
export const kernelShellFields = [
  'theme',
  'connected',
  'plugins',
  'compositionEntries',
  'compositionBindings',
  'workspaceBindingsByWorkspace',
  'sessionBindingsBySession',
  'pluginPermissionRevision',
] as const;

/**
 * Layout-published presentation fields forwarded to nested child plugin surfaces.
 * Populated dynamically by whichever `application.view.v1` layout is active
 * (e.g. `hm.plugin.shell-default` or external `hm.plugin.shell-lite`).
 */
export const layoutShellFields = [
  'sidebarCollapsed',
  'inspectorOpen',
  'inspectorTab',
  'selectedWorkspaceId',
  'selectedSessionId',
  'sessions',
  'harnesses',
  'workspaces',
  'slashCommands',
  'focusedTurn',
] as const;

/**
 * Transitional domain fields still read by B4/W2/W3 surfaces until their respective
 * batches complete full frontend state migration.
 */
export const legacyDomainShellFields = [
  'accountUsage',
  'failoverPolicy',
  'agyNativeWorkbenchEnabled',
  'agyAuthStates',
  'nativeRuntimeBySession',
] as const;

export const shellFields = [
  ...kernelShellFields,
  ...layoutShellFields,
  ...legacyDomainShellFields,
] as const;

export interface LegacyShellAdapterMeta {
  readonly action: string;
  readonly callers: readonly string[];
  readonly owner: 'W2' | 'W3';
  readonly removeWhen: string;
}

/**
 * Explicit registry of transitional shell actions remaining for W2/W3 migration.
 * Navigation, panel opening, and layout toggles are routed through the public
 * NavigationBus and UiContributionRegistry instead of private app-store mutations.
 */
export const LEGACY_SHELL_BRIDGE_ADAPTERS: readonly LegacyShellAdapterMeta[] = [
  {
    action: 'openModal',
    callers: ['hm.plugin.chat-default', 'hm.plugin.agy-workbench-default'],
    owner: 'W2',
    removeWhen: 'W2 migrates Settings, Plugin Center, and Management modals to public UI contributions/pages.',
  },
  {
    action: 'refreshAll',
    callers: ['hm.plugin.chat-default', 'hm.plugin.requests-view-default'],
    owner: 'W3',
    removeWhen: 'W3 completes domain service refresh events and removes centralized refreshAll.',
  },
  {
    action: 'focusCheckpointDiff',
    callers: ['hm.plugin.chat-default'],
    owner: 'W3',
    removeWhen: 'W3 moves Git checkpoint diff navigation to git.checkpoint.v1 + ui.navigate.',
  },
  {
    action: 'openSubagentMergeReview',
    callers: ['hm.plugin.chat-default'],
    owner: 'W3',
    removeWhen: 'W3 moves orchestrator merge-back modal to session.orchestration.v1 + ui.navigate.',
  },
  {
    action: 'setNativeWorkbenchRoute',
    callers: ['hm.plugin.agy-workbench-default'],
    owner: 'W3',
    removeWhen: 'AGY workbench owns route state locally and notifies layout via public navigation/presentation.',
  },
  {
    action: 'hydrateNativeRuntime',
    callers: ['hm.plugin.agy-workbench-default'],
    owner: 'W3',
    removeWhen: 'AGY workbench subscribes directly to agy.runtime.v1 without shell relay.',
  },
  {
    action: 'submitNativeCommand',
    callers: ['hm.plugin.agy-workbench-default'],
    owner: 'W3',
    removeWhen: 'AGY workbench invokes agy.runtime.v1 directly.',
  },
  {
    action: 'dispatchNativeControl',
    callers: ['hm.plugin.agy-workbench-default'],
    owner: 'W3',
    removeWhen: 'AGY workbench invokes agy.runtime.v1 directly.',
  },
  {
    action: 'loadNativeTimeline',
    callers: ['hm.plugin.agy-workbench-default'],
    owner: 'W3',
    removeWhen: 'AGY workbench invokes agy.runtime.v1 directly.',
  },
  {
    action: 'loadNativeWorkflowResource',
    callers: ['hm.plugin.agy-workbench-default'],
    owner: 'W3',
    removeWhen: 'AGY workbench invokes agy.runtime.v1 directly.',
  },
  {
    action: 'setNativeAgentMode',
    callers: ['hm.plugin.agy-workbench-default'],
    owner: 'W3',
    removeWhen: 'AGY workbench invokes agy.runtime.v1 directly.',
  },
];

const legacyAdapterNames = new Set(LEGACY_SHELL_BRIDGE_ADAPTERS.map((entry) => entry.action));

export function shellSnapshot(): Record<string, unknown> {
  const kernel = useKernelStore.getState();
  const layout = layoutBridge.getState();
  const out: Record<string, unknown> = {};
  for (const field of kernelShellFields) {
    out[field] = kernel[field];
  }
  for (const field of layoutShellFields) {
    out[field] = layout[field];
  }
  for (const field of legacyDomainShellFields) {
    out[field] = layout[field];
  }
  return out;
}

export function subscribeShellState(listener: (patch: Record<string, unknown>) => void): () => void {
  const unsubKernel = useKernelStore.subscribe((state, previous) => {
    const patch: Record<string, unknown> = {};
    let changed = false;
    for (const field of kernelShellFields) {
      if (state[field] !== previous[field]) {
        patch[field] = state[field];
        changed = true;
      }
    }
    if (changed) listener(patch);
  });

  const unsubLayout = layoutBridge.subscribe((patch: PublishedLayoutState) => {
    const filtered: Record<string, unknown> = {};
    let changed = false;
    for (const field of [...layoutShellFields, ...legacyDomainShellFields]) {
      if (Object.hasOwn(patch, field)) {
        filtered[field] = patch[field];
        changed = true;
      }
    }
    if (changed) listener(filtered);
  });

  return () => {
    unsubKernel();
    unsubLayout();
  };
}

function unwrapNavigation(result: Promise<NavigationResultV1>): Promise<NavigationResultV1> {
  return result;
}

/**
 * Compatibility dispatcher for `shell.invoke`.
 * Routes layout/navigation actions to the public NavigationBus and UiContributionRegistry;
 * delegates explicitly listed W2/W3 transitional adapters to the active layout only if present.
 */
export function invokeShell(name: string, args: unknown[]) {
  switch (name) {
    case 'selectSession': {
      const sessionId = typeof args[0] === 'string' ? args[0] : null;
      return unwrapNavigation(
        navigationBus.navigate({
          target: { kind: 'session' },
          context: { sessionId },
          placement: 'primary',
        }),
      );
    }
    case 'setSidebarCollapsed': {
      const collapsed = Boolean(args[0]);
      return contributionRegistry.execute('layout.setSidebarCollapsed', { args: { collapsed } });
    }
    case 'setInspectorOpen': {
      const open = Boolean(args[0]);
      return contributionRegistry.execute('layout.setInspectorOpen', { args: { open } });
    }
    case 'setInspectorTab': {
      const tab = typeof args[0] === 'string' ? args[0] : '';
      return unwrapNavigation(
        navigationBus.navigate({
          target: { kind: 'panel', pageId: tab },
          context: { tab },
          placement: 'side',
        }),
      );
    }
    case 'openPluginPanel': {
      const panelKey = typeof args[0] === 'string' ? args[0] : '';
      return unwrapNavigation(
        navigationBus.navigate({
          target: { kind: 'panel', pageId: 'plugins', slotId: panelKey },
          context: { panelKey },
          placement: 'side',
        }),
      );
    }
    case 'openSessionSearch': {
      const query = typeof args[0] === 'string' ? args[0] : '';
      return unwrapNavigation(
        navigationBus.navigate({
          target: { kind: 'page', contract: 'session.search.v1', pageId: 'session-search' },
          context: { query },
          placement: 'primary',
        }),
      );
    }
    case 'openSessionSearchPage': {
      const opts = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
      return unwrapNavigation(
        navigationBus.navigate({
          target: {
            kind: 'page',
            contract: 'session.search.v1',
            pageId: 'session-search',
            instanceId: typeof opts.instanceId === 'string' ? opts.instanceId : undefined,
          },
          context: opts,
          placement: 'primary',
        }),
      );
    }
    case 'openHistoryImportPage': {
      const opts = (args[0] && typeof args[0] === 'object' ? args[0] : {}) as Record<string, unknown>;
      return unwrapNavigation(
        navigationBus.navigate({
          target: {
            kind: 'page',
            contract: 'history.import.v1',
            pageId: 'history-import',
            instanceId: typeof opts.instanceId === 'string' ? opts.instanceId : undefined,
          },
          context: opts,
          placement: 'primary',
        }),
      );
    }
    case 'openModal': {
      const modal = typeof args[0] === 'string' ? args[0] : null;
      const presetHarnessId = typeof args[1] === 'string' ? args[1] : null;
      return unwrapNavigation(
        navigationBus.navigate({
          target: { kind: 'modal', pageId: modal ?? '' },
          context: { modal, presetHarnessId },
          placement: 'modal',
        }),
      );
    }
    default: {
      if (!legacyAdapterNames.has(name)) {
        throw new Error(`此操作不属于公开界面能力: ${name}`);
      }
      const delegated = layoutBridge.invokeLegacyAction(name, args);
      if (!delegated.handled) {
        throw Object.assign(new Error(`当前活动布局未提供兼容操作: ${name}`), {
          code: 'E_SERVICE_UNAVAILABLE',
        });
      }
      return delegated.result;
    }
  }
}
