import { PEER_CONTRACTS } from '@harnessmate/plugin-api';
import type { HarnessMateStore } from '../../db/sqlite.js';
import type { PluginComposition } from './profile.js';

export type BindingSource = 'session' | 'workspace' | 'composition' | 'default' | 'none';

export interface ResolvedCapabilityBinding {
  contract: string;
  instanceId: string | null;
  source: BindingSource;
}

export const DEFAULT_BUNDLED_PROVIDERS: Readonly<Record<string, string>> = {
  [PEER_CONTRACTS.browser]: 'hm.plugin.browser-desktop',
  [PEER_CONTRACTS.filePreview]: 'hm.plugin.file-preview-text',
  [PEER_CONTRACTS.approvalPolicy]: 'hm.plugin.approval-policy-default',
};

export function resolveCapabilityBinding(params: {
  contract: string;
  sessionId?: string;
  workspaceId?: string;
  store?: HarnessMateStore;
  composition: PluginComposition;
  isEntryInComposition: (instanceId: string) => boolean;
}): ResolvedCapabilityBinding {
  const { contract, sessionId, workspaceId, store, composition, isEntryInComposition } = params;

  if (store && sessionId) {
    const sessionBinding = store.getCapabilityBinding('session', sessionId, contract);
    if (sessionBinding?.instanceId) {
      return { contract, instanceId: sessionBinding.instanceId, source: 'session' };
    }
  }

  if (store && workspaceId) {
    const workspaceBinding = store.getCapabilityBinding('workspace', workspaceId, contract);
    if (workspaceBinding?.instanceId) {
      return { contract, instanceId: workspaceBinding.instanceId, source: 'workspace' };
    }
  }

  const compBinding = composition.contractBindings[contract];
  if (compBinding) {
    return { contract, instanceId: compBinding, source: 'composition' };
  }

  const fallback = DEFAULT_BUNDLED_PROVIDERS[contract];
  if (fallback && isEntryInComposition(fallback)) {
    return { contract, instanceId: fallback, source: 'default' };
  }

  return { contract, instanceId: null, source: 'none' };
}
