import type { InstalledPluginInfo } from '@harnessmate/protocol';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('deduplicates native notification handoffs across simultaneous events and renderer reload', async () => {
  const plugin: InstalledPluginInfo = {
    id: 'hm.plugin.desktop-notifications', name: 'Desktop notifications', version: '1.0.0',
    enabled: true, builtin: true, provides: ['session.notifications.v1'], permissions: [], contributes: {},
  };
  const state = {
    plugins: [plugin], sessionBindingsBySession: {}, workspaceBindingsByWorkspace: {}, compositionBindings: {},
  };
  const intent = { kind: 'snooze' as const, sessionId: 'session-1', identity: 'cycle-1' };
  const notice = { id: 'snooze:session-1:cycle-1', title: 'Reminder', body: 'Review the session' };
  const notify = vi.fn();
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { harnessMateBridge: { notify } });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });

  const { daemonApi } = await import('../src/api/client');
  const { showSessionNotification } = await import('../src/lib/desktop-notifications');
  const plan = vi.spyOn(daemonApi, 'planSessionNotification').mockResolvedValue({ notice });
  showSessionNotification({ ...state, plugins: [{ ...plugin, enabled: false }] }, undefined, intent);
  expect(plan).not.toHaveBeenCalled();
  showSessionNotification(state, undefined, intent);
  showSessionNotification(state, undefined, intent);
  await expect.poll(() => notify.mock.calls).toEqual([[notice.title, notice.body]]);
  expect(plan).toHaveBeenCalledTimes(1);

  vi.resetModules();
  const reloadedApi = await import('../src/api/client');
  const reloaded = await import('../src/lib/desktop-notifications');
  const reloadedPlan = vi.spyOn(reloadedApi.daemonApi, 'planSessionNotification').mockResolvedValue({ notice });
  reloaded.showSessionNotification(state, undefined, intent);
  await expect(reloadedPlan.mock.results[0]?.value).resolves.toEqual({ notice });
  expect(notify).toHaveBeenCalledTimes(1);
});
