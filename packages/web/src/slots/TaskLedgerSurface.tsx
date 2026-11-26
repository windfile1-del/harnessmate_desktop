import type { Session, UpdateTaskStateRequest } from '@harnessmate/protocol';
import { daemonApi } from '../api/client';
import { getPluginInstanceId } from '../api/peer-contracts';
import { useAppStore } from '../stores/app-store';
import { BoundSessionSurface, useBoundSessionPlugin } from './BoundSessionSurface';

export function TaskLedgerSurface({ session, plugin }: {
  session: Session;
  plugin: ReturnType<typeof useBoundSessionPlugin>;
}) {
  const summary = useBoundSessionPlugin('session.summary.v1', session);
  const version = useAppStore((state) => state.taskStateBySession[session.id]?.version);
  if (!plugin?.contributes.slots?.some(({ id }) => id === 'task-ledger')) {
    return <p className="p-3 text-sm text-[var(--text-muted)]">任务账本视图不可用</p>;
  }
  const instanceId = getPluginInstanceId(plugin);
  return (
    <BoundSessionSurface
      session={session}
      plugin={plugin}
      surface="task-ledger"
      defaultHeight={280}
      props={{ version, summaryAvailable: Boolean(summary) }}
      onAction={async (action, params, signal) => {
        if (action === 'get') return daemonApi.getTaskState(session.id, { instanceId, signal });
        if (action === 'save') {
          const result = await daemonApi.updateTaskState(session.id, params.patch as UpdateTaskStateRequest, { instanceId, signal });
          void useAppStore.getState().refreshTaskState(session.id);
          return result;
        }
        if (action === 'summarize' && summary) {
          const result = await daemonApi.summarizeTaskState(session.id, signal);
          void useAppStore.getState().refreshTaskState(session.id);
          return result;
        }
        if (action === 'openFile' && typeof params.path === 'string') {
          const { taskState } = await daemonApi.getTaskState(session.id, { instanceId, signal });
          if (signal.aborted || !(taskState.ledgerFilePath === params.path || taskState.touchedFiles.includes(params.path))) {
            throw new Error('账本中未找到该文件');
          }
          useAppStore.getState().openInspectorFile(session.id, params.path);
          return { ok: true };
        }
        throw new Error('此账本不支持该操作');
      }}
    />
  );
}
