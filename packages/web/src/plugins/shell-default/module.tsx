import { createRoot } from 'react-dom/client';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { ShellDefaultApp } from './ShellDefaultApp';

export function mount({
  container,
  bridge,
}: {
  container: HTMLElement;
  bridge: TrustedModulePageBridge;
}): () => void {
  const root = createRoot(container);
  root.render(<ShellDefaultApp bridge={bridge} />);
  return () => {
    root.unmount();
  };
}
