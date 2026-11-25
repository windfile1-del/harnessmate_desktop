import { useState } from 'react';
import { useAppStore } from '../../../../stores/app-store';
import { AgyNativeCommandPalette } from '../commands/AgyNativeCommandPalette';
import type { NativeCommandPaletteItem } from '../commands/command-catalog';
import type { NativeWorkbenchViewProps } from '../shared';

const ARGUMENT_FIELDS: Readonly<Record<string, string | null>> = {
  query_usage: null,
  query_skills: null,
  inspect_models: null,
  set_model: 'modelId',
  set_effort: 'effort',
  set_permission_mode: 'mode',
  set_plan_mode: 'text',
};

export function RuntimeCommandPanel({
  session, projection, capabilities, onSubmitCommand, onRefresh,
}: Pick<NativeWorkbenchViewProps, 'session' | 'projection' | 'capabilities' | 'onSubmitCommand' | 'onRefresh'>) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<NativeCommandPaletteItem | null>(null);
  const [argument, setArgument] = useState('');
  const submission = useAppStore((state) => state.nativeRuntimeBySession[session.id]?.commandSubmission);
  const profileVerified = useAppStore((state) => state.agyAuthStates[session.harnessId]?.phase === 'authenticated');
  const argumentField = selection ? ARGUMENT_FIELDS[selection.actionKey] : undefined;
  const revision = projection?.capabilitiesRevision ?? 0;
  const canSubmit = Boolean(selection && argumentField !== undefined && projection?.status === 'attached' &&
    selection.snapshotRevision === revision && session.status === 'idle' &&
    submission?.phase !== 'submitting' &&
    (!argumentField || selection.actionKey === 'set_plan_mode' || argument.trim()));

  if (!onSubmitCommand) return null;

  return (
    <section aria-label="原生命令">
      <button type="button" aria-expanded={open} className="rounded-lg border px-2 py-1 text-sm"
        onClick={() => setOpen((value) => !value)}>
        原生命令
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <AgyNativeCommandPalette
            descriptors={capabilities}
            catalogRevision={revision}
            profileVerified={profileVerified}
            onRefreshCapabilities={onRefresh}
            onSelectCommand={setSelection}
            onClose={() => setOpen(false)}
          />
          {selection && (
            <form className="space-y-2" onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmit || !projection) return;
              void onSubmitCommand({
                capabilityId: selection.capabilityId,
                actionKey: selection.actionKey,
                expectedBinding: projection.binding,
                expectedCapabilitiesRevision: selection.snapshotRevision,
                args: argumentField && argument.trim() ? { [argumentField]: argument.trim() } : {},
              });
            }}>
              <div>{selection.title}</div>
              {argumentField && (
                <input className="w-full rounded-lg border bg-transparent px-2 py-1"
                  aria-label="命令参数" placeholder={selection.argumentHint} value={argument}
                  onChange={(event) => setArgument(event.target.value)} />
              )}
              {argumentField === undefined && <p>请在官方客户端使用此入口。</p>}
              {selection.snapshotRevision !== revision && <p>能力目录已更新，请重新选择命令。</p>}
              <button type="submit" className="rounded-lg border px-2 py-1 disabled:opacity-50" disabled={!canSubmit}>
                执行命令
              </button>
            </form>
          )}
          {submission?.message && <p className="whitespace-pre-wrap text-sm" role="status">{submission.message}</p>}
        </div>
      )}
    </section>
  );
}
