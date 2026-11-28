import { createRoot } from 'react-dom/client';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { createManagementStore, ManagementStoreContext } from '../management/store';
import { DeveloperToolsApp } from './App';
export function mount({ container, bridge }: { container: HTMLElement; bridge: TrustedModulePageBridge }) {
  const owner = createManagementStore(bridge, bridge.instanceId); const root = createRoot(container);
  root.render(<ManagementStoreContext.Provider value={owner.store}><DeveloperToolsApp bridge={bridge} /></ManagementStoreContext.Provider>);
  return () => { owner.dispose(); root.unmount(); };
}
