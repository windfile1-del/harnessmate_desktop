import type { ReactNode } from 'react';
import { createStore } from 'zustand';
import { ManagementStoreContext, type ManagementState } from '../../src/plugins/management/store';
export function withManagement(children: ReactNode) {
  const store=createStore(()=>({plugins:[],pluginCatalog:[],pluginsDir:'',harnesses:[],sessions:[],workspaces:[],selectedWorkspaceId:null,selectedSessionId:null,sessionBindingsBySession:{},pluginPermissionRevision:0} as unknown as ManagementState));
  return <ManagementStoreContext.Provider value={store}>{children}</ManagementStoreContext.Provider>;
}
