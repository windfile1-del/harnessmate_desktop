import { useEffect } from 'react';
import { ApplicationEntryHost } from './kernel/ApplicationEntryHost';
import { installKernelContributionRuntime } from './kernel/contribution-registry';
import { SlotRegistryProvider } from './slots/hooks';
import { KernelSlotSync } from './slots/KernelSlotSync';
import { ensureSharedPluginRuntime } from './slots/shared-runtime';
import { useKernelStore } from './stores/kernel-store';

ensureSharedPluginRuntime();

/**
 * Minimal kernel application root.
 * Mounts only the active `application.view.v1` plugin selected by composition,
 * manages generic slot/contribution lifecycles, and transitions to `KernelRecoveryView`
 * on empty composition, unbound/disabled entry, or load/render failures.
 */
export function App() {
  const initKernel = useKernelStore((state) => state.initKernel);

  useEffect(() => {
    void initKernel();
  }, [initKernel]);

  useEffect(() => installKernelContributionRuntime(), []);

  return (
    <SlotRegistryProvider>
      <KernelSlotSync />
      <ApplicationEntryHost />
      <a href="#kernel-recovery" aria-label="打开内核恢复" className="fixed bottom-1 right-2 z-50 rounded bg-[var(--bg-surface)] px-2 text-xs text-[var(--text-muted)]">恢复</a>
    </SlotRegistryProvider>
  );
}
