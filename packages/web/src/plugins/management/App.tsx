import { useState } from 'react';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { PluginStudioModal } from './PluginCenter';
import { HarnessCenterModal } from './HarnessSettings';
import { InstanceEditor } from './InstanceEditor';
import { SettingsView } from './SettingsView';
export function ManagementApp({ bridge }: { bridge: TrustedModulePageBridge }) {
  const [tab, setTab] = useState(['harnesses', 'settings', 'instances'].includes(String(bridge.props.managementTab)) ? String(bridge.props.managementTab) : 'plugins');
  const close = () => { void bridge.navigate({ target: { kind: 'page', pageId: '' } }); };
  return <main className="h-full overflow-auto bg-[var(--bg-surface)] text-[var(--text-primary)]" data-management-instance={bridge.instanceId}>
    <nav className="flex gap-4 border-b p-3">{[['plugins','插件中心'],['settings','设置'],['instances','实例与绑定'],['harnesses','CLI 引擎']].map(([id,label]) => <button key={id} onClick={() => setTab(id!)}>{label}</button>)}</nav>
    {tab === 'plugins' && <PluginStudioModal onClose={close} bridge={bridge} />}{tab === 'settings' && <SettingsView bridge={bridge} />}
    {tab === 'instances' && <InstanceEditor />}{tab === 'harnesses' && <HarnessCenterModal onClose={close} bridge={bridge} />}
  </main>;
}
