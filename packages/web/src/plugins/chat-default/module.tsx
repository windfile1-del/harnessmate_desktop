import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SlotRegistryProvider, SlotSessionProvider } from '../../slots/hooks';
import { ChatSlotSync } from './ChatSlotSync';
import { ChatStage } from './ChatStage';
import { startChatView, useAppStore } from './store';
import { setChatBridge, type PageBridge } from './transport';

function ChatModulePage({ bridge }: { bridge: PageBridge }) {
  const session = useAppStore((state) => state.sessions.find((item) => item.id === state.selectedSessionId) ?? null);
  useEffect(() => startChatView(bridge), [bridge]);
  return (
    <SlotRegistryProvider>
      <SlotSessionProvider session={session}>
        <ChatSlotSync />
        <ChatStage />
      </SlotSessionProvider>
    </SlotRegistryProvider>
  );
}

export function mount({ container, bridge }: { container: HTMLElement; bridge: PageBridge }): () => void {
  setChatBridge(bridge);
  const root = createRoot(container);
  root.render(<ChatModulePage bridge={bridge} />);
  return () => {
    root.unmount();
    setChatBridge(undefined);
  };
}
