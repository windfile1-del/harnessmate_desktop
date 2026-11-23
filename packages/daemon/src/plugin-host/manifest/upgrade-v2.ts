import { PluginApiError } from '@harnessmate/plugin-api';

export function upgradeV2(manifest: Record<string, unknown>): Record<string, unknown> {
  const contributes = manifest.contributes as Record<string, unknown> | undefined;
  if (contributes?.actions || contributes?.programs) {
    throw new PluginApiError('E_INVALID_INPUT', '插件动作与处理程序需要 V3 或更新的清单');
  }
  return { ...manifest, apiVersion: 3 };
}
