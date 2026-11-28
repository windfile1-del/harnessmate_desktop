import type { DaemonPersistedConfig } from '../config.js';
/** B4 input/output adapter. Runtime ownership is a generic instance-keyed map. */
export function migrateLegacyPluginConfig(config: DaemonPersistedConfig): void {
  const owned = config.pluginConfig ??= {};
  const legacy = { custom: config.customAcpHarnesses ?? [], instances: config.harnessInstances ?? [], profiles: config.agyProfiles ?? [], binaries: config.binaryOverrides ?? {} };
  for (const [id, binaryPath] of Object.entries(legacy.binaries)) {
    const target = owned['harness-' + id] ??= {};
    if (target.binaryPath === undefined) target.binaryPath = binaryPath;
  }
  for (const instance of legacy.instances) {
    const owner = 'harness-' + instance.driverId;
    const target = owned[owner] ??= {};
    const instances = target.instances as typeof legacy.instances | undefined;
    if (!instances) target.instances = legacy.instances.filter(i => i.driverId === instance.driverId);
  }
  const acp = owned['harness-acp'] ??= {};
  const agy = owned['harness-agy'] ??= {};
  if (acp.customHarnesses === undefined) acp.customHarnesses = legacy.custom;
  if (agy.profiles === undefined) agy.profiles = legacy.profiles;
  Object.defineProperties(config, {
    customAcpHarnesses: { configurable: true, enumerable: false, get: () => owned['harness-acp']?.customHarnesses ?? [], set: value => { (owned['harness-acp'] ??= {}).customHarnesses = value; } },
    agyProfiles: { configurable: true, enumerable: false, get: () => owned['harness-agy']?.profiles ?? [], set: value => { (owned['harness-agy'] ??= {}).profiles = value; } },
    harnessInstances: { configurable: true, enumerable: false, get: () => Object.entries(owned).filter(([id]) => id.startsWith('harness-')).flatMap(([, c]) => (c.instances as typeof legacy.instances | undefined) ?? []),
      set: (value: typeof legacy.instances) => { for (const key of Object.keys(owned)) if (key.startsWith('harness-')) delete owned[key]!.instances; for (const item of value) { const target = owned['harness-' + item.driverId] ??= {}; (target.instances as typeof value | undefined ?? (target.instances = []) as typeof value).push(item); } } },
    binaryOverrides: { configurable: true, enumerable: false, get: () => Object.fromEntries(Object.entries(owned).filter(([id, c]) => id.startsWith('harness-') && typeof c.binaryPath === 'string').map(([id, c]) => [id.slice(8), c.binaryPath as string])),
      set: (value: Record<string, string>) => { for (const [id, entry] of Object.entries(owned)) if (id.startsWith('harness-') && !Object.hasOwn(value, id.slice(8))) delete entry.binaryPath; for (const [id, binaryPath] of Object.entries(value)) (owned['harness-' + id] ??= {}).binaryPath = binaryPath; } },
  });
}
export function withB4ConfigMirror(config: DaemonPersistedConfig) {
  return { ...config, customAcpHarnesses: config.customAcpHarnesses, harnessInstances: config.harnessInstances,
    agyProfiles: config.agyProfiles, binaryOverrides: config.binaryOverrides };
}
