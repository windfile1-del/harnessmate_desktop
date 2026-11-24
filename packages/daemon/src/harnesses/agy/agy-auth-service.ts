import { type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AgyAccountIdentity, AgyAuthState } from '@harnessmate/protocol';
import { StdioJsonRpcClient } from '../jsonrpc.js';
import { killProcessTree, resolveBinary, spawnCliProcess } from '../process.js';
import { isAcpAuthRequiredError } from '../acp/strict-acp-adapter.js';
import type { AgyAdapter } from './agy-driver.js';
import { resolveManagedProfilePathSync } from './agy-profile-manager.js';

const LOGIN_FLOW_TTL_MS = 5 * 60_000;
const LOGIN_URL_WAIT_MS = 12_000;
const LOGIN_EXCHANGE_WAIT_MS = 20_000;
const OAUTH_URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2\/(?:v2\/)?auth\?[^\s"'<>]+/g;

function isAllowedRedirectUri(rawUri: string): boolean {
  try {
    const parsed = new URL(rawUri);
    if (parsed.origin === 'https://antigravity.google' && parsed.pathname === '/oauth-callback') {
      return true;
    }
    return (
      parsed.protocol === 'http:' &&
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    );
  } catch {
    return false;
  }
}

export function validateGoogleOAuthUrl(rawUrl: string): { url: string; state: string } {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('无效的 Google OAuth 登录链接');
  }
  if (parsed.protocol !== 'https:' || parsed.origin !== 'https://accounts.google.com') {
    throw new Error(`拒绝不受信任的 OAuth 主机: ${parsed.origin}`);
  }
  if (parsed.pathname !== '/o/oauth2/auth' && parsed.pathname !== '/o/oauth2/v2/auth') {
    throw new Error(`拒绝非预期 OAuth 路径: ${parsed.pathname}`);
  }
  if (parsed.searchParams.get('code_challenge_method') !== 'S256') {
    throw new Error('OAuth 登录链接缺少 PKCE S256 校验参数');
  }
  const challenge = parsed.searchParams.get('code_challenge')?.trim();
  const state = parsed.searchParams.get('state')?.trim();
  const redirectUri = parsed.searchParams.get('redirect_uri')?.trim();
  if (!challenge || !state) {
    throw new Error('OAuth 登录链接缺少 state 或 code_challenge 参数');
  }
  if (!redirectUri || !isAllowedRedirectUri(redirectUri)) {
    throw new Error(`拒绝不受信任的 OAuth redirect_uri: ${redirectUri ?? '(missing)'}`);
  }
  return { url: parsed.toString(), state };
}

export function parseAndValidateAgyLoginResponse(
  codeOrUrl: string,
  expectedState?: string,
): string {
  const trimmed = codeOrUrl.trim();
  if (!trimmed) {
    throw new Error('请粘贴官方授权回调 URL 或授权码');
  }
  if (/[\r\n\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error('授权输入包含非法控制字符');
  }

  if (/^https?:\/\//i.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error('回调 URL 格式无效');
    }
    const allowedOrigin =
      (parsed.origin === 'https://antigravity.google' && parsed.pathname === '/oauth-callback') ||
      (parsed.protocol === 'http:' &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'));
    if (!allowedOrigin) {
      throw new Error(`拒绝非官方或非回环的回调 URL: ${parsed.origin}${parsed.pathname}`);
    }
    const errParam = parsed.searchParams.get('error');
    if (errParam) {
      throw new Error(`Google OAuth 返回错误: ${errParam}`);
    }
    if (expectedState && parsed.searchParams.get('state') !== expectedState) {
      throw new Error('OAuth state 校验不匹配，请重新发起官方登录');
    }
    if (!parsed.searchParams.get('code')?.trim()) {
      throw new Error('回调 URL 中缺少授权 code 参数');
    }
    return trimmed;
  }

  if (/\s/.test(trimmed)) {
    throw new Error('授权码不能包含空白字符');
  }
  return trimmed;
}

export function computeAccountFingerprint(rawIdentifier: string): string {
  return crypto
    .createHash('sha256')
    .update(`google-account\0${rawIdentifier.trim().toLowerCase()}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
}

interface ActiveLoginFlow {
  flowId: string;
  instanceId: string;
  child: ChildProcess;
  expectedState: string;
  authorizationUrl: string;
  expiresAt: number;
  ttlTimer: NodeJS.Timeout;
  closed: Promise<{ exitCode: number | null; stderr: string; stdout: string }>;
}

export interface AgyAuthServiceDeps {
  getAdapter: (instanceId: string) => AgyAdapter | undefined;
  stopInstanceSessions: (instanceId: string) => Promise<void>;
  onIdentityUpdated?: (instanceId: string, identity: AgyAccountIdentity) => void;
  onUsageCacheInvalidate?: (instanceId: string) => void;
  onStateChanged?: (state: AgyAuthState) => void;
}

export class AgyAuthService {
  private readonly states = new Map<string, AgyAuthState>();
  private readonly activeFlows = new Map<string, ActiveLoginFlow>();

  constructor(private readonly deps: AgyAuthServiceDeps) {}

  getState(instanceId: string): AgyAuthState {
    const cached = this.states.get(instanceId);
    if (cached) return cached;

    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) {
      return {
        instanceId,
        phase: 'idle',
        flowId: null,
        authorizationUrl: null,
        expiresAt: null,
        message: null,
      };
    }

    const profile = adapter.getProfile();
    const ctx = adapter.getLaunchContextSync();
    const hasToken =
      profile.isolationMode === 'profile_isolated' && profile.authMethod === 'oauth-personal'
        ? ctx.hasLocalTokenFile()
        : Boolean(profile.identity?.verifiedAt);

    return {
      instanceId,
      phase: hasToken ? 'authenticated' : profile.isolationMode === 'profile_isolated' ? 'unauthenticated' : 'idle',
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: null,
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      identity: profile.identity ?? null,
    };
  }

  async startLogin(instanceId: string): Promise<AgyAuthState> {
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) {
      throw new Error(`未找到 AGY 实例: ${instanceId}`);
    }
    const profile = adapter.getProfile();
    if (profile.authMethod !== 'oauth-personal') {
      throw new Error(
        `认证模式 "${profile.authMethod}" 不支持 \`agy acp --login\` 交互式 code-paste 登录；请配置 API Key / 企业环境变量或使用官方 CLI 登录。`,
      );
    }

    await this.cancelFlowIfAny(instanceId);
    await this.deps.stopInstanceSessions(instanceId);

    this.setState(instanceId, {
      instanceId,
      phase: 'starting',
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: '正在启动官方 Google OAuth 登录流程…',
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      identity: profile.identity ?? null,
    });

    const ctx = await adapter.getLaunchContext();
    const binary = await resolveBinary('agy', ctx.binaryPath);
    if (!binary) {
      return this.failState(instanceId, '未找到 agy CLI 可执行文件');
    }

    const builtEnv = ctx.buildEnv({ stripDisplay: true });
    const args = ctx.buildAcpArgs({ login: true });
    const cwd = fs.existsSync(ctx.runtimeTempDir) ? ctx.runtimeTempDir : process.cwd();
    const child = spawnCliProcess(binary, args, {
      cwd,
      env: builtEnv.env,
      unsetEnv: builtEnv.unsetEnv,
    });

    let stdoutAll = '';
    let stderrAll = '';
    const closed = new Promise<{ exitCode: number | null; stderr: string; stdout: string }>(
      (resolve) => {
        child.once('close', (exitCode) => {
          resolve({ exitCode, stderr: stderrAll, stdout: stdoutAll });
        });
        child.once('error', (err) => {
          stderrAll += `\n${err.message}`;
          resolve({ exitCode: -1, stderr: stderrAll, stdout: stdoutAll });
        });
      },
    );

    const extracted = await new Promise<{ url: string; state: string }>((resolve, reject) => {
      let settled = false;
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(waitTimer);
        void killProcessTree(child);
        reject(err);
      };
      const inspectOutput = (chunk: string) => {
        if (settled) return;
        const matches = chunk.match(OAUTH_URL_RE) ?? [];
        for (const candidate of matches) {
          const cleaned = candidate.replace(/[.,;)]+$/, '');
          try {
            const valid = validateGoogleOAuthUrl(cleaned);
            settled = true;
            clearTimeout(waitTimer);
            resolve(valid);
            return;
          } catch {
            // Try next URL match if multiple URLs appear
          }
        }
      };

      const waitTimer = setTimeout(() => {
        fail(
          new Error(
            stderrAll.trim() || stdoutAll.trim() || '等待官方 `agy acp --login` 输出 Google OAuth URL 超时',
          ),
        );
      }, LOGIN_URL_WAIT_MS);
      waitTimer.unref?.();

      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
        stdoutAll += chunk;
        inspectOutput(stdoutAll);
      });
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
        stderrAll += chunk;
        inspectOutput(stderrAll);
      });
      void closed.then(({ exitCode, stderr, stdout }) => {
        if (!settled) {
          fail(
            new Error(
              stderr.trim() ||
                stdout.trim() ||
                `agy acp --login 在返回授权链接前退出 (code=${exitCode ?? 'null'})`,
            ),
          );
        }
      });
    }).catch((err) => {
      this.failState(instanceId, err instanceof Error ? err.message : String(err));
      throw err;
    });

    const flowId = crypto.randomUUID();
    const expiresAt = Date.now() + LOGIN_FLOW_TTL_MS;
    const ttlTimer = setTimeout(() => {
      const current = this.activeFlows.get(instanceId);
      if (current && current.flowId === flowId) {
        this.activeFlows.delete(instanceId);
        void killProcessTree(current.child);
        this.setState(instanceId, {
          instanceId,
          phase: 'cancelled',
          flowId: null,
          authorizationUrl: null,
          expiresAt: null,
          message: '官方 Google OAuth 登录会话已超时自动关闭，请重新发起登录。',
          isolationMode: profile.isolationMode,
          authMethod: profile.authMethod,
          identity: profile.identity ?? null,
        });
      }
    }, LOGIN_FLOW_TTL_MS);
    ttlTimer.unref?.();

    this.activeFlows.set(instanceId, {
      flowId,
      instanceId,
      child,
      expectedState: extracted.state,
      authorizationUrl: extracted.url,
      expiresAt,
      ttlTimer,
      closed,
    });

    return this.setState(instanceId, {
      instanceId,
      phase: 'waiting_code',
      flowId,
      authorizationUrl: extracted.url,
      expiresAt,
      message: '请在浏览器完成 Google 授权后，将回调 URL 或授权码粘贴回此处。',
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      identity: profile.identity ?? null,
    });
  }

  async respondLogin(
    instanceId: string,
    flowId: string,
    codeOrUrl: string,
  ): Promise<AgyAuthState> {
    const flow = this.activeFlows.get(instanceId);
    if (!flow || flow.flowId !== flowId) {
      throw new Error('登录流程已过期或不存在，请重新点击登录');
    }
    if (Date.now() > flow.expiresAt) {
      await this.cancelFlowIfAny(instanceId);
      throw new Error('登录流程已超时，请重新点击登录');
    }

    const validated = parseAndValidateAgyLoginResponse(codeOrUrl, flow.expectedState);
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) {
      await this.cancelFlowIfAny(instanceId);
      throw new Error(`未找到 AGY 实例: ${instanceId}`);
    }
    const profile = adapter.getProfile();

    this.setState(instanceId, {
      instanceId,
      phase: 'verifying',
      flowId,
      authorizationUrl: flow.authorizationUrl,
      expiresAt: flow.expiresAt,
      message: '正在提交授权码并校验账号会话状态…',
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      identity: profile.identity ?? null,
    });

    clearTimeout(flow.ttlTimer);
    this.activeFlows.delete(instanceId);

    try {
      flow.child.stdin?.write(`${validated}\n`, 'utf8');
      flow.child.stdin?.end();
    } catch (err) {
      void killProcessTree(flow.child);
      return this.failState(
        instanceId,
        `向 agy 登录进程写入授权码失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const closeRes = await Promise.race([
      flow.closed,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOGIN_EXCHANGE_WAIT_MS)),
    ]);

    if (!closeRes) {
      await killProcessTree(flow.child);
      return this.failState(instanceId, '官方 Google OAuth 换取凭据超时，请重试');
    }
    if (closeRes.exitCode !== 0) {
      return this.failState(
        instanceId,
        closeRes.stderr.trim() ||
          closeRes.stdout.trim() ||
          `官方登录失败 (exit=${closeRes.exitCode ?? 'null'})`,
      );
    }

    adapter.invalidateProbeCache();
    let tierName: string | null = profile.identity?.tierName ?? null;
    try {
      const snap = await adapter.probeAcpSessionMetadata(undefined, true);
      if (snap.tierName) {
        tierName = snap.tierName;
      }
    } catch (err) {
      if (isAcpAuthRequiredError(err)) {
        return this.failState(instanceId, 'OAuth 进程已结束但 ACP 校验仍提示未登录，请检查授权重试');
      }
      // Best-effort ACP verify (e.g., transient RPC error after login): proceed if token file exists on isolated profile
    }

    const identity: AgyAccountIdentity = {
      accountFingerprint:
        profile.identity?.accountFingerprint ??
        computeAccountFingerprint(`${instanceId}:${adapter.getLaunchContextSync().geminiDir}`),
      emailLabel: profile.identity?.emailLabel ?? profile.displayName,
      tierName,
      tierId: profile.identity?.tierId ?? null,
      verifiedAt: Date.now(),
    };
    adapter.updateProfileIdentity(identity);
    this.deps.onIdentityUpdated?.(instanceId, identity);
    this.deps.onUsageCacheInvalidate?.(instanceId);

    return this.setState(instanceId, {
      instanceId,
      phase: 'authenticated',
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: 'Google 账号登录成功',
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      identity,
    });
  }

  async cancelLogin(instanceId: string, flowId?: string): Promise<AgyAuthState> {
    const flow = this.activeFlows.get(instanceId);
    if (flow && (!flowId || flow.flowId === flowId)) {
      clearTimeout(flow.ttlTimer);
      this.activeFlows.delete(instanceId);
      await killProcessTree(flow.child);
    }
    const adapter = this.deps.getAdapter(instanceId);
    const profile = adapter?.getProfile();
    return this.setState(instanceId, {
      instanceId,
      phase: 'cancelled',
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: '已取消官方登录流程',
      isolationMode: profile?.isolationMode,
      authMethod: profile?.authMethod,
      identity: profile?.identity ?? null,
    });
  }

  async logout(
    instanceId: string,
    opts?: { confirmSharedKeyring?: boolean },
  ): Promise<AgyAuthState> {
    const adapter = this.deps.getAdapter(instanceId);
    if (!adapter) {
      throw new Error(`未找到 AGY 实例: ${instanceId}`);
    }
    const profile = adapter.getProfile();
    if (profile.isolationMode === 'official_default' && !opts?.confirmSharedKeyring) {
      throw new Error(
        '该实例使用本机共享凭据模式 (official_default)，登出将影响本地 Antigravity IDE/CLI；请传入 confirmSharedKeyring: true 明确确认后再登出。',
      );
    }

    await this.cancelFlowIfAny(instanceId);
    await this.deps.stopInstanceSessions(instanceId);

    const ctx = await adapter.getLaunchContext();
    const binary = await resolveBinary('agy', ctx.binaryPath);
    if (binary) {
      const built = ctx.buildEnv();
      const child = spawnCliProcess(binary, ctx.buildAcpArgs(), {
        cwd: fs.existsSync(ctx.runtimeTempDir) ? ctx.runtimeTempDir : process.cwd(),
        env: built.env,
        unsetEnv: built.unsetEnv,
      });
      const rpc = new StdioJsonRpcClient(child, {
        onNotification: () => {},
        onServerRequest: (req) => rpc.respondError(req.id, -32601, 'Not supported during logout'),
        onDiagnostic: () => {},
        onExit: () => {},
      });
      try {
        await rpc.request(
          'initialize',
          {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'harnessmate-auth', version: '0.3.0' },
          },
          6000,
        );
        await rpc.request('logout', {}, 6000).catch(() => {});
      } catch {
        // Fallback to local profile token cleanup below
      } finally {
        await rpc.dispose();
      }
    }

    if (profile.isolationMode === 'profile_isolated') {
      for (const tokenFileName of ['antigravity-oauth-token', 'oauth_creds.json']) {
        const safePath = resolveManagedProfilePathSync(
          ctx.geminiDir,
          [ctx.appDataDirName, tokenFileName],
          'file',
        );
        if (safePath) {
          fs.rmSync(safePath.path, { force: true });
        }
      }
    }

    const clearedIdentity: AgyAccountIdentity = {
      accountFingerprint: null,
      emailLabel: profile.displayName,
      tierName: null,
      tierId: null,
      verifiedAt: null,
    };
    adapter.invalidateProbeCache();
    adapter.updateProfileIdentity(clearedIdentity);
    this.deps.onIdentityUpdated?.(instanceId, clearedIdentity);
    this.deps.onUsageCacheInvalidate?.(instanceId);

    return this.setState(instanceId, {
      instanceId,
      phase: 'unauthenticated',
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message: '已安全登出当前账号',
      isolationMode: profile.isolationMode,
      authMethod: profile.authMethod,
      identity: clearedIdentity,
    });
  }

  async dispose(): Promise<void> {
    const flows = Array.from(this.activeFlows.values());
    this.activeFlows.clear();
    await Promise.all(
      flows.map(async (f) => {
        clearTimeout(f.ttlTimer);
        await killProcessTree(f.child);
      }),
    );
  }

  private async cancelFlowIfAny(instanceId: string): Promise<void> {
    const existing = this.activeFlows.get(instanceId);
    if (!existing) return;
    clearTimeout(existing.ttlTimer);
    this.activeFlows.delete(instanceId);
    await killProcessTree(existing.child);
  }

  private failState(instanceId: string, message: string): AgyAuthState {
    const adapter = this.deps.getAdapter(instanceId);
    const profile = adapter?.getProfile();
    return this.setState(instanceId, {
      instanceId,
      phase: 'failed',
      flowId: null,
      authorizationUrl: null,
      expiresAt: null,
      message,
      isolationMode: profile?.isolationMode,
      authMethod: profile?.authMethod,
      identity: profile?.identity ?? null,
    });
  }

  private setState(instanceId: string, state: AgyAuthState): AgyAuthState {
    this.states.set(instanceId, state);
    this.deps.onStateChanged?.(state);
    return state;
  }
}
