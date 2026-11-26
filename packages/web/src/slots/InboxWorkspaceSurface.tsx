import type { UpdateSessionTriageRequest } from '@harnessmate/protocol';
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { daemonApi } from '../api/client';
import { getPluginInstanceId, resolveServiceSelectionClientSide } from '../api/peer-contracts';
import { sortTriage } from '../lib/triage';
import { useAppStore } from '../stores/app-store';
import { BoundSessionSurface, useBoundSessionPlugin } from './BoundSessionSurface';

export function InboxWorkspaceSurface({ instanceId }: { instanceId: string }) {
  const state = useAppStore(useShallow((store) => ({
    sessions: store.sessions,
    triage: store.triageBySession,
    plugins: store.plugins,
    sessionBindings: store.sessionBindingsBySession,
    workspaceBindings: store.workspaceBindingsByWorkspace,
    compositionBindings: store.compositionBindings,
    compositionEntries: store.compositionEntries,
  })));
  const plugin = state.plugins.find((candidate) => getPluginInstanceId(candidate) === instanceId);
  const snooze = useBoundSessionPlugin('session.snooze.v1', null);
  const entries = useMemo(() => sortTriage(state.sessions.filter((session) => {
    if (session.status === 'archived') return false;
    const selection = resolveServiceSelectionClientSide({
      contract: 'session.inbox.v1',
      plugins: state.plugins,
      sessionBindings: state.sessionBindings[session.id],
      workspaceBindings: state.workspaceBindings[session.workspaceId],
      compositionBindings: state.compositionBindings,
      compositionEntries: state.compositionEntries,
    });
    return selection.status === 'ready' && selection.instanceId === instanceId;
  }), state.triage).map(({ session, group }) => ({
    session: { id: session.id, title: session.title }, state: state.triage[session.id], group,
  })), [state, instanceId]);
  return (
    <BoundSessionSurface
      plugin={plugin}
      session={null}
      surface="session-inbox"
      props={{ entries, snoozeAvailable: Boolean(snooze) }}
      onAction={async (action, params, signal) => {
        const target = entries.find(({ session }) => session.id === params.sessionId);
        if (!target) throw new Error('会话不属于当前收件箱');
        if (action === 'update') {
          await daemonApi.updateSessionTriage(target.session.id, params.patch as UpdateSessionTriageRequest, { instanceId, signal });
        } else if (action === 'viewed') {
          await daemonApi.markSessionViewed(target.session.id, {
            throughTurnSeq: target.state?.latestTurnSeq,
            observedUpdatedAt: target.state?.meta.updatedAt,
          }, signal, instanceId);
        } else {
          throw new Error('此收件箱不支持该操作');
        }
        if (!signal.aborted) await useAppStore.getState().refreshTriage(false, signal);
        return { ok: true };
      }}
    />
  );
}
