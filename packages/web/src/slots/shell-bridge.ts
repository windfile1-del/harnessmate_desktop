import { useAppStore } from '../stores/app-store';

// Layout/management and the Batch 4 native workbench remain shell owned.
// Events, turn projection, drafts and composer state are deliberately absent.
export const shellFields = ['theme', 'connected', 'sidebarCollapsed', 'inspectorOpen', 'inspectorTab',
  'selectedWorkspaceId', 'selectedSessionId', 'sessions', 'harnesses', 'workspaces', 'plugins',
  'slashCommands', 'compositionEntries', 'compositionBindings', 'workspaceBindingsByWorkspace',
  'sessionBindingsBySession', 'pluginPermissionRevision', 'focusedTurn', 'accountUsage', 'failoverPolicy',
  'agyNativeWorkbenchEnabled', 'agyAuthStates', 'nativeRuntimeBySession'] as const;

export function shellSnapshot() {
  const state = useAppStore.getState();
  return Object.fromEntries(shellFields.map((field) => [field, state[field]]));
}

const shellActions = new Set(['setSidebarCollapsed', 'setInspectorOpen', 'setInspectorTab', 'openModal',
  'openPluginPanel', 'selectSession', 'openSessionSearch', 'openSessionSearchPage', 'openHistoryImportPage',
  'setNativeWorkbenchRoute', 'hydrateNativeRuntime', 'submitNativeCommand', 'dispatchNativeControl',
  'loadNativeTimeline', 'loadNativeWorkflowResource', 'setNativeAgentMode']);
for (const action of ['refreshAll', 'focusCheckpointDiff', 'openSubagentMergeReview']) shellActions.add(action);

export function invokeShell(name: string, args: unknown[]) {
  if (!shellActions.has(name)) throw new Error(`此操作不属于宿主界面: ${name}`);
  const action = useAppStore.getState()[name as keyof ReturnType<typeof useAppStore.getState>];
  if (typeof action !== 'function') throw new Error('界面操作不可用');
  return (action as (...args: unknown[]) => unknown)(...args);
}
