import os from 'node:os';
import path from 'node:path';
import type {
  AgyAuthMethod,
  AgyIsolationMode,
  DiscoveredCliSession,
} from '@harnessmate/protocol';
import { resolveManagedProfilePathSync } from './agy-profile-manager.js';

export const DEFAULT_AGY_APP_DATA_DIR_NAME = 'antigravity-cli';
export const AGY_SSH_COMPAT_CONNECTION = '127.0.0.1 0 127.0.0.1 0';

export const AGY_STRIP_ENV_KEYS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_CLOUD_QUOTA_PROJECT',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GCLOUD_PROJECT',
  'CLOUDSDK_CORE_PROJECT',
  'AGY_ACP_CCPA_PROJECT',
  'AGY_ACP_ENABLE_OAUTH',
  'GEMINI_HOME',
  'AGY_ACP_FORCE_FILE_STORAGE',
  'AGY_CLI_DISABLE_AUTO_UPDATE',
  'BROWSER',
  'PYTHONUNBUFFERED',
  'ELECTRON_RUN_AS_NODE',
  'CHROME_CRASHPAD_PIPE_NAME',
  'HARNESSMATE_LOCAL_TOKEN',
  'HARNESSMATE_SESSION_MCP_TOKEN',
  'HARNESSMATE_DATA_DIR',
] as const;

const STRIP_ENV_UPPER = new Set<string>(AGY_STRIP_ENV_KEYS.map((k) => k.toUpperCase()));

export interface AgyLaunchContext {
  readonly instanceId: string;
  readonly isolationMode: AgyIsolationMode;
  readonly authMethod: AgyAuthMethod;
  readonly binaryPath: string;
  readonly geminiDir: string;
  readonly appDataDirName: string;
  readonly appDataPath: string;
  readonly tokenFilePath: string;
  readonly runtimeTempDir: string;
  readonly platform: NodeJS.Platform;

  buildEnv(opts?: {
    baseEnv?: NodeJS.ProcessEnv;
    extraEnv?: Record<string, string | undefined>;
    stripDisplay?: boolean;
    apiKey?: string;
  }): { env: Record<string, string | undefined>; unsetEnv: string[] };

  buildAcpArgs(opts?: {
    baseArgs?: readonly string[];
    login?: boolean;
    additionalDirectories?: readonly string[];
    sandbox?: boolean;
    logFile?: string;
    source?: DiscoveredCliSession['source'];
  }): string[];

  buildCliArgs(subArgs: readonly string[]): string[];

  hasLocalTokenFile(): boolean;
}

export interface CreateAgyLaunchContextOptions {
  readonly instanceId: string;
  readonly isolationMode: AgyIsolationMode;
  readonly authMethod: AgyAuthMethod;
  readonly binaryPath: string;
  readonly geminiDir: string;
  readonly appDataDirName?: string;
  readonly runtimeTempDir?: string;
  readonly platform?: NodeJS.Platform;
  readonly extraEnv?: Record<string, string | undefined>;
}

/**
 * Creates a unified launch context shared across ACP runtime, `--login`,
 * `/usage`, `/skills`, `models`, and profile history readers so every invocation
 * runs inside the exact same account boundary.
 */
export function createAgyLaunchContext(opts: CreateAgyLaunchContextOptions): AgyLaunchContext {
  const platform = opts.platform ?? process.platform;
  const geminiDir = path.resolve(opts.geminiDir);
  const appDataDirName = opts.appDataDirName?.trim() || DEFAULT_AGY_APP_DATA_DIR_NAME;
  const appDataPath = path.join(geminiDir, appDataDirName);
  const tokenFilePath = path.join(appDataPath, 'antigravity-oauth-token');
  const runtimeTempDir = opts.runtimeTempDir
    ? path.resolve(opts.runtimeTempDir)
    : path.join(os.tmpdir(), 'hm-agy-tmp', opts.instanceId.replace(/[^a-z0-9_-]/gi, '_'));

  return {
    instanceId: opts.instanceId,
    isolationMode: opts.isolationMode,
    authMethod: opts.authMethod,
    binaryPath: opts.binaryPath,
    geminiDir,
    appDataDirName,
    appDataPath,
    tokenFilePath,
    runtimeTempDir,
    platform,

    buildEnv(envOpts) {
      const baseEnv = envOpts?.baseEnv ?? process.env;
      const unsetSet = new Set<string>(AGY_STRIP_ENV_KEYS);
      if (envOpts?.stripDisplay) {
        unsetSet.add('DISPLAY');
        unsetSet.add('WAYLAND_DISPLAY');
      }

      const env: Record<string, string | undefined> = {
        AGY_CLI_DISABLE_AUTO_UPDATE: '1',
      };

      if (opts.isolationMode === 'profile_isolated') {
        env.GEMINI_HOME = geminiDir;
        env.AGY_ACP_FORCE_FILE_STORAGE = '1';
        if (platform === 'win32') {
          env.TEMP = runtimeTempDir;
          env.TMP = runtimeTempDir;
        } else {
          env.TMPDIR = runtimeTempDir;
        }

        // Only personal Google accounts support SSH file-storage + `--login`.
        // Never inject SSH_CONNECTION for oauth-business or official_default.
        if (opts.authMethod === 'oauth-personal') {
          env.SSH_CONNECTION = baseEnv.SSH_CONNECTION || AGY_SSH_COMPAT_CONNECTION;
        }

        if (opts.authMethod === 'gemini-api-key' && envOpts?.apiKey) {
          env.GEMINI_API_KEY = envOpts.apiKey;
        } else if (opts.authMethod === 'agent-platform' && envOpts?.apiKey) {
          env.GOOGLE_API_KEY = envOpts.apiKey;
        }
      }

      for (const src of [opts.extraEnv, envOpts?.extraEnv]) {
        if (!src) continue;
        for (const [key, value] of Object.entries(src)) {
          if (!key || STRIP_ENV_UPPER.has(key.toUpperCase())) continue;
          if (envOpts?.stripDisplay && (key.toUpperCase() === 'DISPLAY' || key.toUpperCase() === 'WAYLAND_DISPLAY')) {
            continue;
          }
          env[key] = value;
        }
      }

      return { env, unsetEnv: Array.from(unsetSet) };
    },

    buildAcpArgs(acpOpts) {
      const args: string[] = acpOpts?.login
        ? ['acp']
        : acpOpts?.baseArgs
          ? [...acpOpts.baseArgs]
          : ['acp', '--stdio'];

      if (opts.isolationMode === 'profile_isolated') {
        args.push('--gemini-dir', geminiDir, '--app-data-dir', appDataDirName);
      } else if (acpOpts?.source === 'agy_desktop') {
        args.push('--app-data-dir', 'antigravity');
      }

      if (acpOpts?.sandbox) {
        args.push('--sandbox');
      }
      if (acpOpts?.additionalDirectories) {
        for (const dir of acpOpts.additionalDirectories) {
          const trimmed = dir.trim();
          if (trimmed) args.push('--add-dir', trimmed);
        }
      }
      if (acpOpts?.logFile?.trim()) {
        args.push('--log-file', acpOpts.logFile.trim());
      }
      if (acpOpts?.login) {
        args.push('--login');
      }
      return args;
    },

    buildCliArgs(subArgs) {
      // Top-level `agy` rejects `--app-data-dir` and `--gemini-dir` (exit code 2).
      // Isolation for subcommands relies on `GEMINI_HOME` from `buildEnv()`.
      return [...subArgs];
    },

    hasLocalTokenFile() {
      return (
        resolveManagedProfilePathSync(
          geminiDir,
          [appDataDirName, 'antigravity-oauth-token'],
          'file',
        ) !== undefined
      );
    },
  };
}
