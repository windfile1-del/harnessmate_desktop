import { createRoot } from 'react-dom/client';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { createManagementStore, ManagementStoreContext } from './store';
import { ManagementApp } from './App';
export function mount({ container, bridge }: { container: HTMLElement; bridge: TrustedModulePageBridge }) {
  const owner = createManagementStore(bridge); const root = createRoot(container);
  const disposers = [bridge.contributions.register({ id: 'settings', kind: 'settings', title: '设置', execute: () => bridge.navigate({ target: { kind: 'page', instanceId: bridge.instanceId, pageId: bridge.slotId }, context: { managementTab: 'settings' } }) })];
  root.render(<ManagementStoreContext.Provider value={owner.store}><ManagementApp bridge={bridge} /></ManagementStoreContext.Provider>);
  return () => { owner.dispose(); root.unmount(); for (const d of disposers) d(); };
}
