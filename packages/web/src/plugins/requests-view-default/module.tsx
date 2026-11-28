import { createRoot } from 'react-dom/client';
import { RequestQueue } from './main';
import { setRequestViewBridge } from './store';

export function mount({ container, bridge }: { container: HTMLElement; bridge: any }): () => void {
  setRequestViewBridge(bridge);
  const root = createRoot(container);
  root.render(<RequestQueue />);
  return () => {
    root.unmount();
    setRequestViewBridge(undefined);
  };
}
