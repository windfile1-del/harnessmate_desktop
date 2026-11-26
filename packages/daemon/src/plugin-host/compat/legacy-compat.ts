import type { FilePreviewRequest, FilePreviewResult } from '@harnessmate/plugin-api';
import type { PluginManager } from '../../plugins/plugin-manager.js';

/**
 * Legacy compatibility adapters for P1/P2 interfaces (`filePreviewProvider` and `browser-authorize`)
 * backed by the unified peer plugin assembly catalog and capability bindings.
 */
export async function renderLegacyFilePreview(
  pluginManager: PluginManager,
  workspaceId: string,
  request: FilePreviewRequest,
): Promise<(FilePreviewResult & { pluginId: string; pluginName: string }) | null> {
  const legacyId = pluginManager.filePreviewProviderId;
  if (!legacyId) return null;
  const view = await pluginManager.renderPeerFilePreview(workspaceId, request, {
    explicitInstanceId: legacyId,
    requireExplicitMatch: true,
  });
  return view.preview;
}

export function authorizeLegacyPluginBrowserView(
  pluginManager: PluginManager,
  pluginId: string,
  runId: string,
): { ok: true } | { ok: false; status: 403 | 409; code: 'E_PERMISSION_DENIED' | 'E_STALE_RUN'; error: string } {
  return pluginManager.authorizeInstanceView(pluginId, runId, 'browser:preview');
}
