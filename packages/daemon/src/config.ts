import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AgyProfileConfig,
  CustomAcpHarnessConfig,
  HarnessInstanceConfig,
} from '@harnessmate/protocol';

export interface DaemonPersistedConfig {
  desktopId: string;
  desktopName: string;
  port: number;
  lanEnabled: boolean;
  localToken: string;
  customAcpHarnesses: CustomAcpHarnessConfig[];
  harnessInstances: HarnessInstanceConfig[];
  agyProfiles: AgyProfileConfig[];
  binaryOverrides: Record<string, string>;
  disabledPlugins: string[];
}

export interface DaemonRuntimePaths {
  dataDir: string;
  configPath: string;
  dbPath: string;
  pluginsDir: string;
  attachmentsDir: string;
  agyProfilesDir: string;
  webDistDir: string | null;
}

export function resolveRuntimePaths(dataDirOverride?: string): DaemonRuntimePaths {
  const dataDir =
    dataDirOverride ??
    process.env.HARNESSMATE_DATA_DIR ??
    path.join(os.homedir(), '.harnessmate-desktop');
  const pluginsDir = path.join(dataDir, 'plugins');
  const attachmentsDir = path.join(dataDir, 'attachments');
  const agyProfilesDir = path.join(dataDir, 'agy-profiles');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(pluginsDir, { recursive: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });

  const webDistEnv = process.env.HARNESSMATE_WEB_DIST;
  const webDistDir = webDistEnv && fs.existsSync(webDistEnv) ? webDistEnv : null;

  return {
    dataDir,
    configPath: path.join(dataDir, 'config.json'),
    dbPath: path.join(dataDir, 'harnessmate.db'),
    pluginsDir,
    attachmentsDir,
    agyProfilesDir,
    webDistDir,
  };
}

export function loadOrCreateConfig(configPath: string, portOverride?: number): DaemonPersistedConfig {
  const defaults: DaemonPersistedConfig = {
    desktopId: `hm-desk-${crypto.randomBytes(6).toString('hex')}`,
    desktopName: os.hostname() || 'HarnessMate Desktop',
    port: portOverride ?? Number(process.env.HARNESSMATE_PORT ?? 4789),
    lanEnabled: process.env.HARNESSMATE_LAN_ENABLED === '1',
    localToken: crypto.randomBytes(24).toString('hex'),
    customAcpHarnesses: [],
    harnessInstances: [],
    agyProfiles: [],
    binaryOverrides: {},
    disabledPlugins: [],
  };

  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<DaemonPersistedConfig>;
      const merged: DaemonPersistedConfig = {
        ...defaults,
        ...raw,
        port: portOverride ?? raw.port ?? defaults.port,
        customAcpHarnesses: Array.isArray(raw.customAcpHarnesses) ? raw.customAcpHarnesses : [],
        harnessInstances: Array.isArray(raw.harnessInstances) ? raw.harnessInstances : [],
        agyProfiles: Array.isArray(raw.agyProfiles) ? raw.agyProfiles : [],
        binaryOverrides:
          raw.binaryOverrides && typeof raw.binaryOverrides === 'object' ? raw.binaryOverrides : {},
        disabledPlugins: Array.isArray(raw.disabledPlugins) ? raw.disabledPlugins : [],
      };
      saveConfig(configPath, merged);
      return merged;
    } catch {
      // Corrupt config fallback
    }
  }

  saveConfig(configPath, defaults);
  return defaults;
}

export function saveConfig(configPath: string, config: DaemonPersistedConfig): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmpPath, configPath);
}

export function discoverNetworkAddresses(): {
  lanAddresses: string[];
  tailscaleAddresses: string[];
} {
  const lanAddresses: string[] = [];
  const tailscaleAddresses: string[] = [];
  const interfaces = os.networkInterfaces();

  for (const [ifName, addrs] of Object.entries(interfaces)) {
    if (!addrs) continue;
    const isTailscaleIf = /tailscale|utun|wg/i.test(ifName);
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.address.startsWith('100.') || isTailscaleIf) {
        if (!tailscaleAddresses.includes(addr.address)) {
          tailscaleAddresses.push(addr.address);
        }
      } else if (
        addr.address.startsWith('192.168.') ||
        addr.address.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(addr.address)
      ) {
        if (!lanAddresses.includes(addr.address)) {
          lanAddresses.push(addr.address);
        }
      }
    }
  }

  return { lanAddresses, tailscaleAddresses };
}
