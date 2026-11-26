import semver from 'semver';
import { FILE_PREVIEW_PERMISSION, PLUGIN_API_VERSION, PLUGIN_MANIFEST_VERSION, PluginApiError, PluginManifestV4Schema,
  normalizePluginSlotKey, type PluginManifest, type PluginManifestV4 } from '@harnessmate/plugin-api';
import { upgradeV1 } from './upgrade-v1.js';
import { upgradeV2 } from './upgrade-v2.js';
import { upgradeV3 } from './upgrade-v3.js';

const upgrades: Readonly<Record<number, (manifest: Record<string, unknown>) => Record<string, unknown>>> = {
  1: upgradeV1, 2: upgradeV2, 3: upgradeV3,
};

export function normalizePluginManifest(manifest: PluginManifest): PluginManifestV4 {
  const generation = manifest.apiVersion ?? 1;
  if (generation > PLUGIN_MANIFEST_VERSION) {
    throw new PluginApiError('E_NOT_SUPPORTED', `此插件使用清单 V${generation}，当前最高支持 V${PLUGIN_MANIFEST_VERSION}`);
  }
  const { harnesses, mcpPresets, hooks, uiSlots } = manifest.contributes;
  if ((generation === 2 || generation === 3) && (manifest.entry || harnesses?.length || mcpPresets?.length || hooks?.length || uiSlots?.length)) {
    throw new PluginApiError('E_INVALID_INPUT', 'V2/V3 清单使用声明式扩展接口');
  }
  if (generation < PLUGIN_MANIFEST_VERSION && (manifest.main || manifest.engines || manifest.inject || manifest.optional
    || manifest.provides || manifest.dependencies || manifest.startPage || manifest.permissions || manifest.activationEvents || manifest.contributes.commands?.length
    || manifest.contributes.slots?.length || manifest.contributes.filePreview || manifest.contributes.settings)) {
    throw new PluginApiError('E_INVALID_INPUT', 'main、engines、插槽、权限与服务声明需要 V4 清单');
  }
  if (generation === PLUGIN_MANIFEST_VERSION && manifest.entry) {
    throw new PluginApiError('E_INVALID_INPUT', 'V4 清单使用 main 声明代码入口');
  }
  let normalized: Record<string, unknown> = manifest;
  for (let version = generation; version < PLUGIN_MANIFEST_VERSION; version++) {
    normalized = upgrades[version]!(normalized);
  }
  const parsed = PluginManifestV4Schema.safeParse(normalized);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PluginApiError('E_INVALID_INPUT', issue ? `${issue.path.join('.')} · ${issue.message}` : '清单无效');
  }
  const range = parsed.data.engines.pluginApi;
  if (!semver.validRange(range)) throw new PluginApiError('E_INVALID_INPUT', `无效的插件 API 版本范围 ${range}`);
  if (!semver.satisfies(PLUGIN_API_VERSION, range)) {
    throw new PluginApiError('E_NOT_SUPPORTED', `插件需要 API ${range}，当前 API 为 ${PLUGIN_API_VERSION}`);
  }
  if (parsed.data.contributes.filePreview && (!parsed.data.main || !parsed.data.permissions?.includes(FILE_PREVIEW_PERMISSION))) {
    throw new PluginApiError('E_INVALID_INPUT', '文件预览贡献需要 V4 代码入口及 file:preview 权限声明');
  }
  if (parsed.data.contributes.slots?.length) {
    parsed.data.contributes.slots = parsed.data.contributes.slots.map((entry) => ({
      ...entry,
      slot: normalizePluginSlotKey(entry.slot),
    }));
  }
  return parsed.data;
}
