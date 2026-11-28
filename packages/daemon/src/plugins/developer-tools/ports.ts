import type { HarnessAdapter } from '../../harnesses/types.js';
import type { InstalledPluginInfo, InstallPluginRequest, PluginManifest } from '@harnessmate/protocol';
export interface AuthoringRegistry { get(id: string): Pick<HarnessAdapter, 'createSession'> | undefined }
export interface DeveloperKernelPort {
  getAuthoringBase(id: string, digest: string): Promise<PluginManifest> | PluginManifest;
  validateManifest(manifest: PluginManifest): Promise<void> | void;
  linkDevPlugin(dir: string, trustedId?: string): Promise<InstalledPluginInfo[]>;
  isTrustedDevSource(dir: string, id: string): Promise<boolean>;
  installPlugin(request: InstallPluginRequest): Promise<InstalledPluginInfo[]>;
}
