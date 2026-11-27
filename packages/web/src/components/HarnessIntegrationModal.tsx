import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { ServiceResolutionV1 } from '../api/peer-contracts';
import { SandboxedPluginFrame } from '../slots/SandboxedPluginFrame';
import { useAppStore } from '../stores/app-store';
import { StudioHeader } from './StudioModalControls';

export function HarnessIntegrationModal({ kind, onClose }: {
  kind: 'usage' | 'mcp';
  onClose: () => void;
}) {
  const { session, selectedWorkspaceId, plugins, resolveService, compositionBindings, sessionBindings, workspaceBindings } =
    useAppStore(useShallow((store) => ({
      session: store.sessions.find(({ id }) => id === store.selectedSessionId) ?? null,
      selectedWorkspaceId: store.selectedWorkspaceId ?? undefined,
      plugins: store.plugins,
      resolveService: store.resolveService,
      compositionBindings: store.compositionBindings,
      sessionBindings: store.sessionBindingsBySession,
      workspaceBindings: store.workspaceBindingsByWorkspace,
    })));
  const sessionId = session?.id;
  const workspaceId = session?.workspaceId ?? selectedWorkspaceId;
  const contract = kind === 'usage' ? 'harness.usage.v1' : 'harness.mcp-config.v1';
  const title = kind === 'usage' ? '多账号与配额用量' : '跨 CLI MCP 管理';
  const pageId = kind === 'usage' ? 'account-usage' : 'mcp-config';
  const [resolution, setResolution] = useState<ServiceResolutionV1>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setResolution(undefined);
    setFailed(false);
    const controller = new AbortController();
    void resolveService(contract, { sessionId, workspaceId, signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setResolution(result); })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [contract, sessionId, workspaceId, plugins, resolveService, compositionBindings, sessionBindings, workspaceBindings]);

  const selected = resolution?.status === 'ready'
    ? plugins.find((plugin) => (plugin.instanceId ?? plugin.id) === resolution.instanceId && plugin.enabled)
    : undefined;
  const page = selected?.contributes.slots?.find((slot) => slot.slot === 'workspace.pages' && slot.id === pageId);
  if (selected && page) {
    return (
      <>
        <StudioHeader title={page.title} onClose={onClose} />
        <div style={{ height: 'min(70vh, 680px)' }}>
          <SandboxedPluginFrame
            key={`${resolution?.instanceId}:${sessionId ?? workspaceId ?? ''}`}
            pluginId={selected.id}
            instanceId={selected.instanceId ?? selected.id}
            pluginName={selected.name}
            revision={selected.runId ?? selected.packageDigest ?? selected.version}
            session={session}
            props={{ workspaceId, sessionId }}
            slot="workspace.pages"
            slotId={page.id}
            title={page.title}
            ui={page.ui}
            defaultHeight={page.height}
          />
        </div>
      </>
    );
  }
  return (
    <>
      <StudioHeader title={title} onClose={onClose} />
      <div className="px-5 py-4 text-[12px] text-[var(--text-secondary)]">
        {resolution?.status === 'ready' ? '所选插件实例未提供此页面。'
          : resolution || failed ? '当前作用域的服务不可用。' : '正在读取插件实例…'}
      </div>
    </>
  );
}
