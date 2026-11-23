export function upgradeV3(manifest: Record<string, unknown>): Record<string, unknown> {
  const { entry, ...fields } = manifest;
  return { ...fields, apiVersion: 4, engines: { pluginApi: '^4.0' }, main: entry };
}
