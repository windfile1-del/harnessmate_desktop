import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { ChatStage } from './ChatStage';
import { startChatView, useAppStore } from './store';
import { SlotRegistryProvider, SlotSessionProvider } from '../../slots/hooks';
import { PluginSlotSync } from '../../slots/PluginSlotSync';
import '../../styles/theme.css';

function Page() {
  const session = useAppStore(state=>state.sessions.find(item=>item.id===state.selectedSessionId) ?? null);
  useEffect(startChatView, []);
  return <SlotRegistryProvider><SlotSessionProvider session={session}><PluginSlotSync/><ChatStage/></SlotSessionProvider></SlotRegistryProvider>;
}
createRoot(document.getElementById('root')!).render(<Page/>);
