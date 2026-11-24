import os from 'node:os';
import path from 'node:path';
import type {
  AgyAccountIdentity,
  AgyProfileConfig,
  DiscoveredCliSession,
  HarnessModelInfo,
  HarnessPresentationMeta,
  PermissionMode,
} from '@harnessmate/protocol';
import {
  AcpAdapter,
  type AcpAdapterOptions,
  type AcpFlavorPolicy,
  type AcpPermissionOption,
  type AcpSessionNewResult,
  pickAcpOption,
} from '../acp/strict-acp-adapter.js';
import { runAgyCommand } from '../agy-commands.js';
import {
  agyDataDirectory,
  type HistoryMessage,
  readAgyIndexedHistory,
  readAgyIndexedHistoryFromRoot,
} from '../history-scanner.js';
import { execCliQuick, resolveBinary } from '../process.js';
import type { HarnessDriverFactory } from '../registry.js';
import type { AdapterSessionConfig, AdapterUsageLimitResult } from '../types.js';
import {
  AGY_STRIP_ENV_KEYS,
  type AgyLaunchContext,
  createAgyLaunchContext,
  DEFAULT_AGY_APP_DATA_DIR_NAME,
} from './agy-launch-context.js';
import { prepareAgyProfile, resolveAgyProfileDirectories } from './agy-profile-manager.js';
import { probeAgyUsageViaCli } from './agy-usage.js';

export function classifyAgyModelGroup(modelId: string): string {
  if (modelId.startsWith('gemini-pro-orchestrator')) return 'Orchestrator (Planner + Executor)';
  if (modelId.startsWith('gemini-')) return 'Google Gemini';
  if (modelId.startsWith('claude-')) return 'Anthropic Claude (via AGY)';
  if (modelId.startsWith('gpt-')) return 'OpenAI (via AGY)';
  return 'Other Models';
}

export async function probeAgyModelsCli(
  binaryPath: string,
  env?: Record<string, string | undefined>,
  unsetEnv?: readonly string[],
): Promise<HarnessModelInfo[]> {
  const res = await execCliQuick(binaryPath, ['models'], 8000, { env, unsetEnv, input: '' });
  const models: HarnessModelInfo[] = [];
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('Fetching')) continue;
    const parts = line.split('\t');
    if (parts.length >= 2 && parts[0] && parts[1]) {
      const id = parts[0].trim();
      models.push({
        id,
        displayName: parts[1].trim(),
        group: classifyAgyModelGroup(id),
        isDefault: models.length === 0,
      });
    }
  }
  return models;
}

export class AntigravityAcpFlavorPolicy implements AcpFlavorPolicy {
  readonly flavor = 'antigravity' as const;
  readonly defaultDriverId = 'agy' as const;
  readonly permissionModes: PermissionMode[] = ['plan', 'manual', 'accept_edits', 'auto'];
  readonly presentation: HarnessPresentationMeta = {
    shortLabel: 'AGY',
    accentColor: 'var(--accent-indigo)',
    softBg: 'var(--accent-indigo-soft)',
    tagline: 'Antigravity · Native ACP',
  };
  readonly defaultNativeCommands: string[] = ['compact', 'usage', 'skills', 'goal'];

  constructor(private readonly getLaunchContextFn?: () => AgyLaunchContext | undefined) {}

  resolveContinuationKey(opts: AcpAdapterOptions): string | undefined {
    const appDataDir = opts.appDataDir?.trim();
    return appDataDir ? `agy:home:${path.resolve(appDataDir)}` : undefined;
  }

  buildLaunchArgs(
    baseArgs: readonly string[],
    source?: DiscoveredCliSession['source'],
    appDataDir?: string,
  ): string[] {
    const ctx = this.getLaunchContextFn?.();
    if (ctx) {
      return ctx.buildAcpArgs({ baseArgs, source });
    }
    const args = [...baseArgs];
    const resolvedDir = appDataDir?.trim() || (source ? agyDataDirectory(source) : undefined);
    if (resolvedDir) {
      args.push('--app-data-dir', resolvedDir);
    }
    return args;
  }

  async probeCliModels(
    binaryPath: string,
    env?: Record<string, string | undefined>,
    unsetEnv?: readonly string[],
  ): Promise<HarnessModelInfo[]> {
    const ctx = this.getLaunchContextFn?.();
    if (ctx) {
      if (
        ctx.isolationMode === 'profile_isolated' &&
        ctx.authMethod === 'oauth-personal' &&
        !ctx.hasLocalTokenFile()
      ) {
        return [];
      }
      const built = ctx.buildEnv({ extraEnv: env });
      return probeAgyModelsCli(binaryPath, built.env, built.unsetEnv);
    }
    return probeAgyModelsCli(binaryPath, env, unsetEnv);
  }

  readIndexedHistory(session: DiscoveredCliSession): HistoryMessage[] {
    const ctx = this.getLaunchContextFn?.();
    if (ctx && ctx.isolationMode === 'profile_isolated') {
      return readAgyIndexedHistoryFromRoot(ctx.appDataPath, session.nativeSessionId);
    }
    return readAgyIndexedHistory(session);
  }

  classifyModelGroup(modelId: string): string {
    return classifyAgyModelGroup(modelId);
  }

  extractTierName(sessRes: AcpSessionNewResult): string | null {
    const meta = sessRes?._meta as { antigravity?: { tier?: { name?: string } } } | undefined;
    return meta?.antigravity?.tier?.name ?? null;
  }

  resolveModeId(
    requested: string,
    advertised: Array<{ id: string; name?: string }> | undefined,
    permissionMode: PermissionMode,
  ): string {
    return (
      advertised?.find(({ id }) => id === requested)?.id ??
      (permissionMode !== 'plan'
        ? advertised?.find(({ id }) => id === 'accept-edits')?.id ?? requested
        : requested)
    );
  }

  shouldThrowOnModeError(permissionMode: PermissionMode, appliedModeId?: string): boolean {
    return permissionMode === 'plan' || appliedModeId === 'plan' || appliedModeId === 'auto';
  }

  canRunNativeCliCommand(): boolean {
    return true;
  }

  executeNativeCliCommand(
    binaryPath: string,
    config: AdapterSessionConfig,
    command: string,
    nativeSessionId: string | null,
    signal: AbortSignal,
    envOpts?: { env?: Record<string, string | undefined>; unsetEnv?: readonly string[]; appDataDir?: string },
  ): Promise<{ conversation_id?: string; response?: string }> {
    const ctx = this.getLaunchContextFn?.();
    return runAgyCommand(binaryPath, config, command, nativeSessionId, signal, {
      ...envOpts,
      launchContext: ctx,
    });
  }

  evaluatePermissionPolicy(
    params: Record<string, unknown>,
    options: AcpPermissionOption[],
    permissionMode: PermissionMode,
    currentTurnId: string | null,
    nativeSessionId: string | null,
  ): { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } } | null {
    if (!currentTurnId || (typeof params.sessionId === 'string' && params.sessionId !== nativeSessionId)) {
      return { outcome: { outcome: 'cancelled' } };
    }
    const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
    const kind = String(toolCall.kind ?? '').toLowerCase();
    const readOnly = kind === 'read' || kind === 'search';
    const edit = ['edit', 'write', 'create'].includes(kind);
    const allow =
      permissionMode === 'auto' ||
      (permissionMode === 'accept_edits' && (readOnly || edit)) ||
      (permissionMode === 'plan' && readOnly);
    const reject =
      permissionMode === 'plan' &&
      (edit || ['delete', 'move', 'execute', 'shell', 'terminal'].includes(kind));
    if (allow || reject) {
      const chosen = pickAcpOption(options, reject ? 'deny' : 'allow_once', true);
      if (chosen || reject) {
        return {
          outcome: chosen
            ? { outcome: 'selected', optionId: chosen.optionId }
            : { outcome: 'cancelled' },
        };
      }
    }
    return null;
  }
}

export interface AgyAdapterOptions {
  readonly profile: AgyProfileConfig;
  readonly profilesRootDir: string;
  readonly binaryOverride?: string;
  readonly envWhitelist?: Record<string, string>;
  readonly continuationKey?: string;
  readonly applyWindowsAcl?: boolean;
  readonly userHome?: string;
}

function resolveInitialGeminiDir(profile: AgyProfileConfig, profilesRootDir: string, userHome: string): string {
  if (profile.geminiDir?.trim()) {
    return path.resolve(profile.geminiDir.trim());
  }
  if (profile.isolationMode === 'profile_isolated') {
    return resolveAgyProfileDirectories(profilesRootDir, profile.instanceId).geminiDir;
  }
  return path.join(userHome, '.gemini');
}

function resolveInitialTempDir(profile: AgyProfileConfig, profilesRootDir: string): string {
  return resolveAgyProfileDirectories(profilesRootDir, profile.instanceId).runtimeTempDir;
}

function buildAgyAdapterOptions(opts: AgyAdapterOptions): {
  acpOpts: AcpAdapterOptions;
  initialContext: AgyLaunchContext;
} {
  const userHome = opts.userHome ?? os.homedir();
  const geminiDir = resolveInitialGeminiDir(opts.profile, opts.profilesRootDir, userHome);
  const appDataDirName = opts.profile.appDataDirName?.trim() || DEFAULT_AGY_APP_DATA_DIR_NAME;
  const runtimeTempDir = resolveInitialTempDir(opts.profile, opts.profilesRootDir);

  const initialContext = createAgyLaunchContext({
    instanceId: opts.profile.instanceId,
    isolationMode: opts.profile.isolationMode,
    authMethod: opts.profile.authMethod,
    binaryPath: opts.binaryOverride || 'agy',
    geminiDir,
    appDataDirName,
    runtimeTempDir,
    extraEnv: opts.envWhitelist,
  });

  const continuationKey =
    opts.continuationKey ??
    (opts.profile.isolationMode === 'profile_isolated'
      ? `agy:profile:${path.resolve(geminiDir)}`
      : `agy:default:${path.resolve(initialContext.appDataPath)}`);

  const acpOpts: AcpAdapterOptions = {
    id: opts.profile.instanceId,
    kind: 'agy',
    driverId: 'agy',
    continuationKey,
    displayName: opts.profile.displayName,
    description:
      opts.profile.description ?? 'Google Antigravity CLI via native Agent Client Protocol (ACP)',
    command: 'agy',
    args: ['acp', '--stdio'],
    binaryOverride: opts.binaryOverride ?? opts.profile.binaryPath,
    appDataDir: appDataDirName,
    authMethodId: opts.profile.authMethod,
    envWhitelist: opts.envWhitelist,
    unsetEnv: AGY_STRIP_ENV_KEYS,
    flavor: 'antigravity',
  };

  return { acpOpts, initialContext };
}

export class AgyAdapter extends AcpAdapter {
  private profileConfig: AgyProfileConfig;
  private readonly profilesRootDir: string;
  private readonly applyWindowsAcl?: boolean;
  private readonly userHome?: string;
  private launchContext: AgyLaunchContext;
  private profilePrepared = false;

  constructor(opts: AgyAdapterOptions) {
    const { acpOpts, initialContext } = buildAgyAdapterOptions(opts);
    const policy = new AntigravityAcpFlavorPolicy(() => this.launchContext);
    super({ ...acpOpts, flavorPolicy: policy });
    this.profileConfig = opts.profile;
    this.profilesRootDir = opts.profilesRootDir;
    this.applyWindowsAcl = opts.applyWindowsAcl;
    this.userHome = opts.userHome;
    this.launchContext = initialContext;
  }

  getProfile(): AgyProfileConfig {
    return this.profileConfig;
  }

  updateProfileIdentity(identity: AgyAccountIdentity): void {
    this.profileConfig = {
      ...this.profileConfig,
      identity,
    };
  }

  invalidateProbeCache(): void {
    this.cachedSessionProbe = null;
    this.authRequired = false;
  }

  getLaunchContextSync(binaryPathOverride?: string): AgyLaunchContext {
    if (binaryPathOverride && binaryPathOverride !== this.launchContext.binaryPath) {
      this.launchContext = createAgyLaunchContext({
        instanceId: this.launchContext.instanceId,
        isolationMode: this.launchContext.isolationMode,
        authMethod: this.launchContext.authMethod,
        binaryPath: binaryPathOverride,
        geminiDir: this.launchContext.geminiDir,
        appDataDirName: this.launchContext.appDataDirName,
        runtimeTempDir: this.launchContext.runtimeTempDir,
        extraEnv: this.envWhitelist,
      });
    }
    return this.launchContext;
  }

  ensureProfilePrepared(): void {
    if (this.profilePrepared) return;
    const prepared = prepareAgyProfile(this.profileConfig, {
      profilesRootDir: this.profilesRootDir,
      userHome: this.userHome,
      applyWindowsAcl: this.applyWindowsAcl,
    });
    this.launchContext = createAgyLaunchContext({
      instanceId: this.profileConfig.instanceId,
      isolationMode: this.profileConfig.isolationMode,
      authMethod: this.profileConfig.authMethod,
      binaryPath: this.launchContext.binaryPath,
      geminiDir: prepared.geminiDir,
      appDataDirName: prepared.appDataDirName,
      runtimeTempDir: prepared.runtimeTempDir,
      extraEnv: this.envWhitelist,
    });
    this.profilePrepared = true;
  }

  async getLaunchContext(binaryPathOverride?: string): Promise<AgyLaunchContext> {
    this.ensureProfilePrepared();
    const binaryPath =
      binaryPathOverride ?? (await resolveBinary(this.command, this.binaryOverride));
    return this.getLaunchContextSync(binaryPath ?? this.launchContext.binaryPath);
  }

  protected override buildSpawnEnv(): Record<string, string | undefined> | undefined {
    return this.launchContext.buildEnv({ extraEnv: this.envWhitelist }).env;
  }

  protected override getUnsetEnv(): readonly string[] | undefined {
    return this.launchContext.buildEnv({ extraEnv: this.envWhitelist }).unsetEnv;
  }

  protected override buildLaunchArgs(source?: DiscoveredCliSession['source']): string[] {
    return this.launchContext.buildAcpArgs({ baseArgs: this.args, source });
  }

  override async probePassive() {
    const info = await super.probePassive();
    if (
      info.health === 'ready' &&
      this.profileConfig.isolationMode === 'profile_isolated' &&
      this.profileConfig.authMethod === 'oauth-personal' &&
      !this.launchContext.hasLocalTokenFile()
    ) {
      return {
        ...info,
        health: 'unauthenticated' as const,
        healthMessage: 'AGY 隔离账号尚未登录，请在设置中完成官方 Google 登录',
      };
    }
    return info;
  }

  override async readUsageLimits(): Promise<AdapterUsageLimitResult> {
    const ctx = await this.getLaunchContext();
    return probeAgyUsageViaCli(ctx, {
      cwd: ctx.runtimeTempDir,
      fallbackTierName:
        this.cachedSessionProbe?.snapshot.tierName ?? this.profileConfig.identity?.tierName ?? null,
    });
  }

  override async createSession(config: AdapterSessionConfig) {
    this.ensureProfilePrepared();
    return super.createSession(config);
  }

  override async probeAcpSessionMetadata(binaryPathOverride?: string, forceRefresh = false) {
    this.ensureProfilePrepared();
    return super.probeAcpSessionMetadata(binaryPathOverride, forceRefresh);
  }

  override async readHistory(session: DiscoveredCliSession, cwd: string): Promise<HistoryMessage[]> {
    this.ensureProfilePrepared();
    return super.readHistory(session, cwd);
  }
}

export function createAgyDriverFactory(opts: {
  readonly profilesRootDir: string;
  readonly binaryOverride?: string;
  readonly getProfileConfig?: (instanceId: string) => AgyProfileConfig | undefined;
}): HarnessDriverFactory {
  return (instance) => {
    const storedProfile = opts.getProfileConfig?.(instance.instanceId);
    const hasCustomHome = Boolean(instance.homeDir?.trim());
    const profile: AgyProfileConfig = storedProfile ?? {
      instanceId: instance.instanceId,
      displayName: instance.displayName,
      description: instance.description,
      isolationMode:
        instance.instanceId === 'agy' && !hasCustomHome ? 'official_default' : 'profile_isolated',
      authMethod: 'oauth-personal',
      geminiDir: instance.homeDir?.trim() || undefined,
      appDataDirName: DEFAULT_AGY_APP_DATA_DIR_NAME,
      binaryPath: instance.binaryPath ?? opts.binaryOverride,
      defaults: {
        linkGlobalSkills: true,
        syncGlobalRules: true,
        additionalDirectories: [],
      },
      enabled: instance.enabled,
    };

    return new AgyAdapter({
      profile,
      profilesRootDir: opts.profilesRootDir,
      binaryOverride: instance.binaryPath ?? opts.binaryOverride,
      envWhitelist: instance.sanitizedEnv,
      continuationKey: instance.continuationKey,
    });
  };
}
