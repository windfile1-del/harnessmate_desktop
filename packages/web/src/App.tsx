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
    </SlotRegistryProvider>
  );
}
