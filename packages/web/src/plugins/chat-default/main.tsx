import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SlotRegistryProvider, SlotSessionProvider } from '../../slots/hooks';
import '../../styles/theme.css';
import { ChatSlotSync } from './ChatSlotSync';
import { ChatStage } from './ChatStage';
import { startChatView, useAppStore } from './store';

function Page() {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === state.selectedSessionId) ?? null);
  useEffect(() => startChatView(), []);
  return (
    <SlotRegistryProvider>
      <SlotSessionProvider session={session}>
        <ChatSlotSync />
        <ChatStage />
      </SlotSessionProvider>
    </SlotRegistryProvider>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
