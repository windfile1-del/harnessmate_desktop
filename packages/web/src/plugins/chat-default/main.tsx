import { createRoot } from 'react-dom/client';
import { useEffect } from 'react';
import { ChatStage } from './ChatStage';
import { startChatView, useAppStore } from './store';
import { SlotRegistryProvider, SlotSessionProvider } from '../../slots/hooks';
import { PluginSlotSync } from '../../slots/PluginSlotSync';
import '../../styles/theme.css';
import { registerAgyNativeRuntimeView } from '../../components/agy/native/runtime';
import { registerSubagentManagerView } from '../../components/agy/native/child/register';
import { registerSwarmStudioView } from '../../components/agy/native/swarm/register';
import { registerBoostStudioView } from '../../components/agy/native/boost/register';
import { registerTeamworkStudioView } from '../../components/agy/native/teamwork/register';
import { registerDynamicWorkflowStudioView } from '../../components/agy/native/workflow';
import { registerNativeTasksView } from '../../components/agy/native/tasks/register';

function Page() {
  const session = useAppStore(state=>state.sessions.find(item=>item.id===state.selectedSessionId) ?? null);
  useEffect(startChatView, []);
  const nativeEnabled = useAppStore(state => state.agyNativeWorkbenchEnabled);
  useEffect(() => {
    if (!nativeEnabled) return;
    const dispose = [registerAgyNativeRuntimeView(), registerSubagentManagerView(), registerSwarmStudioView(),
      registerBoostStudioView(), registerTeamworkStudioView(), registerDynamicWorkflowStudioView(), registerNativeTasksView()];
    return () => dispose.reverse().forEach(fn => fn());
  }, [nativeEnabled]);
  return <SlotRegistryProvider><SlotSessionProvider session={session}><PluginSlotSync/><ChatStage/></SlotSessionProvider></SlotRegistryProvider>;
}
createRoot(document.getElementById('root')!).render(<Page/>);
