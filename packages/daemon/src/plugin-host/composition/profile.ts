import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dump, load, JSON_SCHEMA } from 'js-yaml';
import { z } from 'zod';
import { PluginApiError } from '@harnessmate/plugin-api';
import { TRIAGE_INBOX_PLUGIN_ID } from '@harnessmate/protocol';

const identifier = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,95}$/);
const entrySchema = z.object({
  id: identifier,
  name: identifier.optional(),
  disabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
}).strict();
const entriesSchema = z.array(entrySchema).max(512).superRefine((entries, ctx) => {
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    ctx.addIssue({ code: 'custom', message: '组合条目 ID 重复' });
  }
});
const profileSchema = z.object({ bundles: z.array(identifier).max(32) }).strict();

type LayerEntry = z.infer<typeof entrySchema>;
const recoverySchema = profileSchema.extend({ patch: entriesSchema });
export interface CompositionEntry {
  id: string;
  name: string;
  disabled: boolean;
  config: Record<string, unknown>;
  sources: string[];
}
export interface PluginProfile {
  bundles: string[];
  entries: CompositionEntry[];
}

function readFile(file: string, maxBytes = 512 * 1024): string | undefined {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size > maxBytes) throw new PluginApiError('E_LIMIT_EXCEEDED', `组合文件过大 · ${path.basename(file)}`);
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

function parseYaml(content: string): LayerEntry[] {
  const parsed = load(content, { schema: JSON_SCHEMA });
  const seen = new Set<object>();
  const encoded = JSON.stringify(parsed ?? [], (_, value: unknown) => {
    if (value && typeof value === 'object') {
      if (seen.has(value)) throw new PluginApiError('E_INVALID_INPUT', '组合配置使用独立的值，不能引用 YAML 锚点');
      seen.add(value);
    }
    return value;
  });
  return entriesSchema.parse(JSON.parse(encoded));
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

const defaultBundle = 'harnessmate-core';
const OPTIONAL_BUILTIN_PLUGINS = new Set<string>([
  'hm.plugin.multi-harness-orchestrator',
  'hm.plugin.context-compression',
  'hm.plugin.terminal-workspace',
  TRIAGE_INBOX_PLUGIN_ID,
]);
const stableIds: Record<string, string> = {
  'core.task-ledger': 'ledger', 'core.context-bridge': 'handoff', 'core.git-inspector': 'git',
  'core.account-usage': 'usage', 'core.harness.codex': 'harness-codex', 'core.harness.claude': 'harness-claude',
  'core.harness.agy': 'harness-agy', 'core.harness.acp': 'harness-acp',
};
const entryId = (name: string) => stableIds[name] ?? name;
const defaultBuiltinEntry = (name: string): LayerEntry =>
  OPTIONAL_BUILTIN_PLUGINS.has(name)
    ? { name, id: entryId(name), disabled: true }
    : { name, id: entryId(name) };

export class PluginComposition {
  private readonly profileFile: string;
  private readonly patchFile: string;
  private readonly recoveryFile: string;
  private readonly pendingRestoreFile: string;
  private bundles = [defaultBundle];
  private layers: Array<{ source: string; entries: LayerEntry[] }> = [];
  private patch: LayerEntry[] = [];

  constructor(private readonly directory: string, private readonly builtin: readonly string[]) {
    this.profileFile = path.join(directory, 'profile.json');
    this.patchFile = path.join(directory, 'patch.yml');
    this.recoveryFile = path.join(directory, 'plugin-composition.previous.json');
    this.pendingRestoreFile = path.join(directory, 'plugin-composition.restore.json');
    this.layers = [{ source: defaultBundle, entries: builtin.map(defaultBuiltinEntry) }];
  }

  reload(legacyDisabled: readonly string[], readOnly = false): void {
    if (!readOnly && fs.existsSync(this.pendingRestoreFile)) {
      this.applyRestore(this.readRecovery(this.pendingRestoreFile));
      return;
    }
    const profile = readFile(this.profileFile);
    const bundles = profile ? profileSchema.parse(JSON.parse(profile)).bundles : [defaultBundle];
    const layers = this.readLayers(bundles);
    const patchText = readFile(this.patchFile);
    const patch = patchText === undefined
      ? [...new Set(legacyDisabled)].map((name) => ({ id: entryId(name), disabled: true }))
      : parseYaml(patchText);
    if (!readOnly) {
      if (profile === undefined) writeAtomic(this.profileFile, JSON.stringify({ bundles }, null, 2) + '\n');
      if (patchText === undefined) writeAtomic(this.patchFile, dump(patch));
      if (!this.canRestore()) this.saveRecovery(bundles, patch);
    }
    this.bundles = bundles;
    this.layers = layers;
    this.patch = patch;
  }

  private readLayers(bundles: readonly string[]) {
    if (new Set(bundles).size !== bundles.length) throw new PluginApiError('E_CONFLICT', '组合包列表含有重复项');
    return bundles.map((bundle) => {
      if (bundle === defaultBundle) {
        return { source: bundle, entries: this.builtin.map(defaultBuiltinEntry) };
      }
      const content = readFile(path.join(this.directory, 'bundles', `${bundle}.yml`));
      if (content === undefined) throw new PluginApiError('E_SERVICE_UNAVAILABLE', `找不到组合包 ${bundle}`);
      return { source: bundle, entries: parseYaml(content) };
    });
  }

  canRestore(): boolean {
    return fs.existsSync(this.recoveryFile);
  }

  private saveRecovery(bundles: string[], patch: LayerEntry[]): void {
    writeAtomic(this.recoveryFile, JSON.stringify({ bundles, patch }));
  }

  private readRecovery(file: string): z.infer<typeof recoverySchema> {
    const text = readFile(file, 2 * 1024 * 1024);
    if (text === undefined) throw new PluginApiError('E_SERVICE_UNAVAILABLE', '没有可恢复的组合配置');
    return recoverySchema.parse(JSON.parse(text));
  }

  restore(disabledPlugins?: readonly string[]): void {
    const snapshot = disabledPlugins
      ? recoverySchema.parse({ bundles: [defaultBundle], patch: disabledPlugins.map((id) => ({ id, disabled: true })) })
      : this.readRecovery(this.recoveryFile);
    const layers = this.readLayers(snapshot.bundles);
    writeAtomic(this.pendingRestoreFile, JSON.stringify(snapshot));
    this.applyRestore(snapshot, layers);
  }

  private applyRestore(
    { bundles, patch }: z.infer<typeof recoverySchema>,
    layers = this.readLayers(bundles),
  ): void {
    writeAtomic(this.profileFile, JSON.stringify({ bundles }, null, 2) + '\n');
    writeAtomic(this.patchFile, dump(patch, { noRefs: true }));
    fs.rmSync(this.pendingRestoreFile);
    this.bundles = bundles;
    this.layers = layers;
    this.patch = patch;
  }

  private writePatch(patch: LayerEntry[]): void {
    entriesSchema.parse(patch);
    this.saveRecovery(this.bundles, this.patch);
    writeAtomic(this.patchFile, dump(patch, { noRefs: true }));
    this.patch = patch;
  }

  resolve(installed: readonly string[], patch = this.patch): PluginProfile {
    const entries = new Map<string, CompositionEntry>();
    const merge = ({ id, name, disabled, config }: LayerEntry, source: string) => {
      const previous = entries.get(id);
      entries.set(id, { id, name: name ?? previous?.name ?? id, disabled: disabled ?? previous?.disabled ?? false,
        config: { ...previous?.config, ...config }, sources: [...(previous?.sources ?? []), source] });
    };
    for (const { source, entries: layer } of this.layers) {
      for (const entry of layer) merge(entry, source);
    }
    const bound = new Set([...entries.values(), ...patch].map(({ name }) => name));
    for (const name of installed) if (!bound.has(name)) merge({ id: name, name }, '已安装');
    for (const entry of patch) merge(entry, 'patch.yml');
    const names = new Set<string>();
    const resolved = [...entries.values()].reverse().filter((entry) => {
      if (names.has(entry.name)) return false;
      names.add(entry.name);
      return true;
    }).reverse();
    return { bundles: [...this.bundles], entries: resolved };
  }

  setEnabled(name: string, enabled: boolean, installed: readonly string[]): void {
    const entry = this.resolve(installed).entries.find((item) => item.name === name);
    const id = entry?.id ?? entryId(name);
    const baseline = this.resolve(installed, []).entries.find((item) => item.id === id && item.name === name);
    const existing = this.patch.find((item) => item.id === id) ?? { id };
    const value = { ...existing };
    if (!entry) value.name = name;
    if ((baseline?.disabled ?? false) === !enabled) delete value.disabled;
    else value.disabled = !enabled;
    if (value.disabled === existing.disabled && value.name === existing.name) return;
    const patch = this.patch.filter((item) => item.id !== id);
    if (value.disabled !== undefined || value.name || value.config) patch.push(value);
    this.writePatch(patch);
  }

  removePlugin(name: string): void {
    const patch = this.patch.filter((entry) => entry.name !== name && entry.id !== name);
    if (patch.length === this.patch.length) return;
    this.writePatch(patch);
  }
}
