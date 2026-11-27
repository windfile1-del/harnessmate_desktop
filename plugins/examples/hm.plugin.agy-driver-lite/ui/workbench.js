(function () {
  const bridge = window.harnessMate;
  const idEl = document.getElementById('identity');
  const projEl = document.getElementById('projection');
  let currentSession = bridge?.session || null;
  let lastGeneration = null;

  async function refresh() {
    if (!bridge || !currentSession) {
      idEl.textContent = 'No active session selected.';
      return;
    }
    try {
      const idRes = await bridge.services.call(
        'agy.runtime.v1',
        'getProviderIdentity',
        [{ sessionId: currentSession.id }],
        { instanceId: bridge.instanceId, sessionId: currentSession.id },
      );
      idEl.textContent = JSON.stringify(idRes.value || {});
      const snapRes = await bridge.services.call(
        'agy.runtime.v1',
        'getSnapshot',
        [{ sessionId: currentSession.id }],
        { instanceId: bridge.instanceId, sessionId: currentSession.id },
      );
      const proj = snapRes?.value?.projection || null;
      lastGeneration = proj?.binding?.generation || null;
      projEl.textContent = JSON.stringify(proj, null, 2);
    } catch (err) {
      projEl.textContent = `Error: ${err && err.message ? err.message : String(err)}`;
    }
  }

  document.getElementById('btn-refresh')?.addEventListener('click', () => {
    void refresh();
  });

  document.getElementById('btn-swarm')?.addEventListener('click', async () => {
    if (!bridge || !currentSession) return;
    await bridge.services.call(
      'agy.runtime.v1',
      'submitCommand',
      [
        {
          sessionId: currentSession.id,
          bindingGeneration: lastGeneration,
          catalogRevision: 1,
          capabilityId: 'agy.lite.swarm',
          actionKey: 'launch',
          args: { objective: 'UI Triggered Swarm' },
          idempotencyKey: `ui_swarm_${Date.now()}`,
        },
      ],
      { instanceId: bridge.instanceId, sessionId: currentSession.id },
    );
    await refresh();
  });

  document.getElementById('btn-cancel')?.addEventListener('click', async () => {
    if (!bridge || !currentSession) return;
    await bridge.services.call(
      'agy.runtime.v1',
      'dispatchControl',
      [
        {
          sessionId: currentSession.id,
          generation: lastGeneration,
          target: { type: 'runtime', id: currentSession.id },
          action: 'cancel',
          idempotencyKey: `ui_cancel_${Date.now()}`,
        },
      ],
      { instanceId: bridge.instanceId, sessionId: currentSession.id },
    );
    await refresh();
  });

  if (bridge) {
    bridge.onContext((session) => {
      currentSession = session;
      void refresh();
    });
    void bridge.services
      .subscribe({ contract: 'agy.runtime.v1', instanceId: bridge.instanceId }, () => {
        void refresh();
      })
      .catch(() => {});
    void refresh();
  }
})();
