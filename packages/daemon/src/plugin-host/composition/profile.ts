import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { z } from 'zod';
import { PluginApiError } from '@harnessmate/plugin-api';

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/);
const contractName = z.string().min(1).max(100);
const entrySchema = z.object({
  id: identifier,
  name: identifier.optional(),
  disabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  bindings: z.record(contractName, identifier).optional(),
}).strict();
const entriesSchema = z.array(entrySchema).max(512).superRefine((entries, ctx) => {
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    ctx.addIssue({ code: 'custom', message: '组合条目 ID 重复' });
  }
});
const profileSchema = z.object({
  bundles: z.array(identifier).max(32),
  bindings: z.record(contractName, identifier).optional(),
  startPage: z.string().min(1).max(160).optional(),
  extensions: z.object({ filePreviewProvider: identifier.optional() }).strict().optional(),
}).strict();
type ProfileConfig = z.infer<typeof profileSchema>;

export type CompositionLayerEntry = z.infer<typeof entrySchema>;
type LayerEntry = CompositionLayerEntry;
const layerObjectSchema = z.object({
  entries: entriesSchema.optional(),
  bindings: z.record(contractName, identifier).optional(),
}).strict();
const distributionBundleSchema = z.object({
  entries: entriesSchema.optional(),
  bindings: z.record(contractName, identifier).optional(),
  optionalDisabled: z.array(identifier).max(128).optional(),
  stableIds: z.record(identifier, identifier).optional(),
}).strict();
type DistributionBundleData = z.infer<typeof distributionBundleSchema>;
const recoverySchema = profileSchema.extend({ patch: entriesSchema });
export interface CompositionEntry {
  id: string;
  name: string;
  disabled: boolean;
  config: Record<string, unknown>;
  bindings: Record<string, string>;
  sources: string[];
}
export interface PluginProfile extends ProfileConfig {
  entries: CompositionEntry[];
}

function resolveModuleDir(): string {
  try {
    if (typeof import.meta?.url === 'string' && import.meta.url) {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // fallback for CommonJS bundle (daemon.cjs)
  }
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

const MODULE_DIR = resolveModuleDir();
const REPO_ROOT = path.resolve(MODULE_DIR, '../../../..');

function readFile(file: string, maxBytes = 512 * 1024): string | undefined {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size > maxBytes) throw new PluginApiError('E_LIMIT_EXCEEDED', `组合文件过大 · ${path.basename(file)}`);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function encodeSafeJsonValue(parsed: unknown): unknown {
  const seen = new Set<object>();
  const encoded = JSON.stringify(parsed ?? [], (_, value: unknown) => {
    if (value && typeof value === 'object') {
      if (seen.has(value)) throw new PluginApiError('E_INVALID_INPUT', '组合配置使用独立的值，不能引用 YAML 锚点');
      seen.add(value);
    }
    return value;
  });
  return JSON.parse(encoded);
}

function parseYaml(content: string): LayerEntry[] {
  const parsed = load(content, { schema: JSON_SCHEMA });
  return entriesSchema.parse(encodeSafeJsonValue(parsed));
}

function parseLayerYaml(content: string): { entries: LayerEntry[]; bindings: Record<string, string> } {
  const parsed = encodeSafeJsonValue(load(content, { schema: JSON_SCHEMA }));
  if (Array.isArray(parsed)) {
    return { entries: entriesSchema.parse(parsed), bindings: {} };
  }
  const obj = layerObjectSchema.parse(parsed);
  return { entries: obj.entries ?? [], bindings: obj.bindings ?? {} };
}

function writeAtomic(file: string, content: string): void {
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staging, content, { flag: 'wx' });
    fs.renameSync(staging, file);
  } finally {
    fs.rmSync(staging, { force: true });
  }
}

export const defaultBundle = 'harnessmate-core';

function loadDistributionBundle(bundleName: string, extraDir?: string): DistributionBundleData {
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    extraDir ? path.join(extraDir, `${bundleName}.json`) : undefined,
    process.env.HARNESSMATE_BUNDLES_DIR
      ? path.join(process.env.HARNESSMATE_BUNDLES_DIR, `${bundleName}.json`)
      : undefined,
    resourcesPath ? path.join(resourcesPath, 'bundles', `${bundleName}.json`) : undefined,
    resourcesPath ? path.join(resourcesPath, 'daemon', `${bundleName}.json`) : undefined,
    path.join(MODULE_DIR, `${bundleName}.json`),
    path.join(REPO_ROOT, 'packages', 'daemon', 'src', 'plugin-host', 'composition', `${bundleName}.json`),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const text = readFile(candidate);
    if (text !== undefined) {
      return distributionBundleSchema.parse(JSON.parse(text));
    }
  }
  throw new PluginApiError('E_SERVICE_UNAVAILABLE', `找不到发行组合包 ${bundleName}`);
}

function sanitizeProfileForWrite(profile: ProfileConfig): ProfileConfig {
  const out: ProfileConfig = { bundles: [...profile.bundles] };
  if (profile.bindings && Object.keys(profile.bindings).length > 0) {
    out.bindings = { ...profile.bindings };
  }
  if (profile.startPage) {
    out.startPage = profile.startPage;
  }
  if (profile.extensions?.filePreviewProvider) {
    out.extensions = { filePreviewProvider: profile.extensions.filePreviewProvider };
  }
  return out;
}

export class PluginComposition {
  private readonly profileFile: string;
  private readonly patchFile: string;
  private readonly recoveryFile: string;
  private readonly pendingRestoreFile: string;
  private readonly distributionData: DistributionBundleData;
  private readonly stableIdMap: Record<string, string>;
  private profile: ProfileConfig = { bundles: [defaultBundle] };
  private layers: Array<{ source: string; entries: LayerEntry[]; bindings: Record<string, string> }> = [];
  private patch: LayerEntry[] = [];

  constructor(
    private readonly directory: string,
    private readonly builtin: readonly string[],
    private readonly distributionBundlesDir?: string,
  ) {
    this.profileFile = path.join(directory, 'profile.json');
    this.patchFile = path.join(directory, 'patch.yml');
    this.recoveryFile = path.join(directory, 'plugin-composition.previous.json');
    this.pendingRestoreFile = path.join(directory, 'plugin-composition.restore.json');
    this.distributionData = loadDistributionBundle(defaultBundle, distributionBundlesDir);
    this.stableIdMap = this.distributionData.stableIds ?? {};
    this.layers = [this.buildDefaultLayer(this.distributionData)];
  }

  private entryId(name: string): string {
    return this.stableIdMap[name] ?? name;
  }

  private buildDefaultLayer(dist: DistributionBundleData): {
    source: string;
    entries: LayerEntry[];
    bindings: Record<string, string>;
  } {
    const optionalSet = new Set(dist.optionalDisabled ?? []);
    const stableMap = dist.stableIds ?? {};
    const toEntryId = (name: string) => stableMap[name] ?? name;
    const entries: LayerEntry[] = this.builtin.map((name) =>
      optionalSet.has(name)
        ? { name, id: toEntryId(name), disabled: true }
        : { name, id: toEntryId(name) },
    );
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const override of dist.entries ?? []) {
      const existing = byId.get(override.id);
      if (existing) {
        Object.assign(existing, override);
      } else {
        entries.push(override);
        byId.set(override.id, override);
      }
    }
    return {
      source: defaultBundle,
      entries,
      bindings: { ...(dist.bindings ?? {}) },
    };
  }

  reload(legacyDisabled: readonly string[], readOnly = false): void {
    if (!readOnly && fs.existsSync(this.pendingRestoreFile)) {
      this.applyRestore(this.readRecovery(this.pendingRestoreFile));
      return;
    }
    const profileText = readFile(this.profileFile);
    const profile = profileText ? profileSchema.parse(JSON.parse(profileText)) : { bundles: [defaultBundle] };
    const layers = this.readLayers(profile.bundles);
    const patchText = readFile(this.patchFile);
    const patch = patchText === undefined
      ? [...new Set(legacyDisabled)].map((name) => ({ id: this.entryId(name), disabled: true }))
      : parseYaml(patchText);
    if (!readOnly) {
      if (profileText === undefined) this.writeProfile(profile);
      if (patchText === undefined) writeAtomic(this.patchFile, dump(patch));
      if (!this.canRestore()) this.saveRecovery(profile, patch);
    }
    this.profile = profile;
    this.layers = layers;
    this.patch = patch;
  }

  private readLayers(bundles: readonly string[]) {
    if (new Set(bundles).size !== bundles.length) throw new PluginApiError('E_CONFLICT', '组合包列表含有重复项');
    return bundles.map((bundle) => {
      if (bundle === defaultBundle) {
        const dist = loadDistributionBundle(defaultBundle, this.distributionBundlesDir);
        return this.buildDefaultLayer(dist);
      }
      const content = readFile(path.join(this.directory, 'bundles', `${bundle}.yml`));
      if (content === undefined) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `找不到组合包 ${bundle}`);
      const parsed = parseLayerYaml(content);
      return { source: bundle, entries: parsed.entries, bindings: parsed.bindings };
    });
  }

  canRestore(): boolean {
    return fs.existsSync(this.recoveryFile);
  }

  get isEmptyComposition(): boolean {
    return this.profile.bundles.length === 0
      && this.patch.every((entry) => entry.disabled === true);
  }

  private saveRecovery(profile: ProfileConfig, patch: LayerEntry[]): void {
    writeAtomic(this.recoveryFile, JSON.stringify({ ...sanitizeProfileForWrite(profile), patch }));
  }

  private writeProfile(profile: ProfileConfig): void {
    writeAtomic(this.profileFile, JSON.stringify(sanitizeProfileForWrite(profile), null, 2) + '\n');
  }

  get extensionBindings(): Readonly<NonNullable<ProfileConfig['extensions']>> | undefined {
    return this.profile.extensions;
  }

  get profileBindings(): Record<string, string> {
    return {
      ...(this.profile.extensions?.filePreviewProvider
        ? { 'filePreview.v1': this.profile.extensions.filePreviewProvider }
        : {}),
      ...(this.profile.bindings ?? {}),
    };
  }

  get layerBindings(): Record<string, string> {
    const merged: Record<string, string> = {};
    for (const layer of this.layers) {
      Object.assign(merged, layer.bindings);
    }
    return merged;
  }

  get contractBindings(): Record<string, string> {
    return {
      ...this.layerBindings,
      ...this.profileBindings,
    };
  }

  get startPage(): string | undefined {
    return this.profile.startPage;
  }

  setFilePreviewProvider(pluginId: string | null): void {
    if ((this.extensionBindings?.filePreviewProvider ?? null) === pluginId) return;
    const nextBindings = { ...(this.profile.bindings ?? {}) };
    if (pluginId) {
      nextBindings['filePreview.v1'] = pluginId;
    } else {
      delete nextBindings['filePreview.v1'];
    }
    const profile = profileSchema.parse(sanitizeProfileForWrite({
      ...this.profile,
      bindings: Object.keys(nextBindings).length > 0 ? nextBindings : undefined,
      extensions: pluginId ? { filePreviewProvider: pluginId } : undefined,
    }));
    this.saveRecovery(this.profile, this.patch);
    this.writeProfile(profile);
    this.profile = profile;
  }

  setContractBinding(contract: string, instanceId: string | null): void {
    const nextBindings = { ...(this.profile.bindings ?? {}) };
    if (instanceId) {
      nextBindings[contract] = instanceId;
    } else {
      delete nextBindings[contract];
    }
    const nextExtensions = contract === 'filePreview.v1'
      ? (instanceId ? { filePreviewProvider: instanceId } : undefined)
      : this.profile.extensions;
    const profile = profileSchema.parse(sanitizeProfileForWrite({
      ...this.profile,
      bindings: Object.keys(nextBindings).length > 0 ? nextBindings : undefined,
      extensions: nextExtensions,
    }));
    this.saveRecovery(this.profile, this.patch);
    this.writeProfile(profile);
    this.profile = profile;
  }

  setStartPage(startPage: string | null): void {
    const profile = profileSchema.parse(sanitizeProfileForWrite({
      ...this.profile,
      startPage: startPage ?? undefined,
    }));
    this.saveRecovery(this.profile, this.patch);
    this.writeProfile(profile);
    this.profile = profile;
  }

  private readRecovery(file: string): z.infer<typeof recoverySchema> {
    const text = readFile(file, 2 * 1024 * 1024);
    if (text === undefined) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '没有可恢复的组合配置');
    return recoverySchema.parse(JSON.parse(text));
  }

  restore(disabledPlugins?: readonly string[], options?: { empty?: boolean }): void {
    const snapshot = options?.empty
      ? recoverySchema.parse({ bundles: [], patch: [] })
      : disabledPlugins
        ? recoverySchema.parse({ bundles: [defaultBundle], patch: disabledPlugins.map((id) => ({ id, disabled: true })) })
        : this.readRecovery(this.recoveryFile);
    if (!options?.empty && !disabledPlugins && !this.canRestore()) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', '没有可恢复的组合配置');
    }
    if (options?.empty) {
      this.saveRecovery(this.profile, this.patch);
    }
    const layers = this.readLayers(snapshot.bundles);
    writeAtomic(this.pendingRestoreFile, JSON.stringify(snapshot));
    this.applyRestore(snapshot, layers);
  }

  private applyRestore(
    { patch, ...profile }: z.infer<typeof recoverySchema>,
    layers = this.readLayers(profile.bundles),
  ): void {
    const sanitized = sanitizeProfileForWrite(profile);
    this.writeProfile(sanitized);
    writeAtomic(this.patchFile, dump(patch, { noRefs: true }));
    fs.rmSync(this.pendingRestoreFile);
    this.profile = sanitized;
    this.layers = layers;
    this.patch = patch;
  }

  private writePatch(patch: LayerEntry[]): void {
    entriesSchema.parse(patch);
    this.saveRecovery(this.profile, this.patch);
    writeAtomic(this.patchFile, dump(patch, { noRefs: true }));
    this.patch = patch;
  }

  resolve(installed: readonly string[], patch = this.patch): PluginProfile {
    const entries = new Map<string, CompositionEntry>();
    const merge = ({ id, name, disabled, config, bindings }: LayerEntry, source: string) => {
      const previous = entries.get(id);
      entries.set(id, {
        id,
        name: name ?? previous?.name ?? id,
        disabled: disabled ?? previous?.disabled ?? false,
        config: { ...previous?.config, ...config },
        bindings: { ...previous?.bindings, ...bindings },
        sources: [...(previous?.sources ?? []), source],
      });
    };
    for (const { source, entries: layer } of this.layers) {
      for (const entry of layer) merge(entry, source);
    }
    const empty = this.profile.bundles.length === 0 && patch.every((entry) => entry.disabled === true);
    const bound = new Set([...entries.values(), ...patch].map(({ name }) => name).filter(Boolean) as string[]);
    for (const name of installed) {
      if (!bound.has(name) && !entries.has(name)) {
        merge({ id: name, name, ...(empty ? { disabled: true } : {}) }, '已安装');
      }
    }
    for (const entry of patch) merge(entry, 'patch.yml');
    const resolved = [...entries.values()];
    const bindings = this.contractBindings;
    return {
      bundles: [...this.profile.bundles],
      ...(Object.keys(bindings).length > 0 && { bindings }),
      ...(this.profile.startPage && { startPage: this.profile.startPage }),
      ...(this.extensionBindings && { extensions: { ...this.extensionBindings } }),
      entries: resolved,
    };
  }

  setEnabled(idOrName: string, enabled: boolean, installed: readonly string[]): void {
    const entries = this.resolve(installed).entries;
    const entry = entries.find((item) => item.id === idOrName) ?? entries.find((item) => item.name === idOrName);
    const id = entry?.id ?? this.entryId(idOrName);
    const name = entry?.name ?? idOrName;
    const baseline = this.resolve(installed, []).entries.find((item) => item.id === id);
    const existing = this.patch.find((item) => item.id === id) ?? { id };
    const value: LayerEntry = { ...existing };
    if (!entry) value.name = name;
    if ((baseline?.disabled ?? false) === !enabled) delete value.disabled;
    else value.disabled = !enabled;
    if (value.disabled === existing.disabled && value.name === existing.name) return;
    const patch = this.patch.filter((item) => item.id !== id);
    if (value.disabled !== undefined || value.name || value.config || value.bindings) patch.push(value);
    this.writePatch(patch);
  }

  upsertInstance(input: CompositionLayerEntry): void {
    const parsed = entrySchema.parse(input);
    const patch = this.patch.filter((item) => item.id !== parsed.id);
    patch.push(parsed);
    this.writePatch(patch);
  }

  removeInstance(instanceId: string): void {
    const patch = this.patch.filter((entry) => entry.id !== instanceId);
    if (patch.length === this.patch.length) return;
    this.writePatch(patch);
  }

  removePlugin(name: string): void {
    const patch = this.patch.filter((entry) => entry.name !== name && entry.id !== name);
    if (patch.length === this.patch.length) return;
    this.writePatch(patch);
  }
}
