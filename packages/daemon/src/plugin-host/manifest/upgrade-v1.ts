import { PluginApiError } from '@harnessmate/plugin-api';

export function upgradeV1(manifest: Record<string, unknown>): Record<string, unknown> {
  const contributes = manifest.contributes as Record<string, unknown> | undefined;
  if (contributes?.projections || contributes?.dataPanels || contributes?.actions || contributes?.programs) {
    throw new PluginApiError('E_INVALID_INPUT', 'V1 清单只能使用 V1 贡献点');
  }
  return { ...manifest, apiVersion: 2 };
}
