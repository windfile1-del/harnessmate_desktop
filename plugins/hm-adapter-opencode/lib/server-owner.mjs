import {
  buildBasicAuthHeader,
  buildServerEnvironment,
  sanitizeOpenCodeError,
  validateServerInfoResponse,
} from './protocol.mjs';

/**
 * In-memory lifecycle & routing owner for OpenCode Server instances.
 *
 * - `managed_local`: spawns ONE shared `opencode serve` lazily via `ctx.runtime.spawnCli`,
 *   injecting a fresh 32-byte Base64Url `OPENCODE_PASSWORD` and explicitly stripping
 *   legacy `OPENCODE_SERVER_PASSWORD`. Supports multiple concurrent workspace directories
 *   on that single process and tears down the child process tree cleanly on unload.
 * - `external_server`: connects via HTTP Basic Auth (`opencode:<secret>`) without
 *   owning the process; plugin disable/unload disconnects without killing the server.
 */
export class OpenCodeServerOwner {
  constructor(ctx, getConfig, onUnexpectedExit) {
    this.ctx = ctx;
    this.getConfig = getConfig;
    this.onUnexpectedExit = onUnexpectedExit;
    this.managed = null; // { processHandle, pid, baseUrl, password, startingPromise }
    this.externalValidated = null; // { url, serverInfo }
    this.startingPromise = null;
  }

  getSecretsForRedaction() {
    const out = [];
    if (this.managed?.password) out.push(this.managed.password);
    return out;
  }

  getStatusSnapshot() {
    const cfg = this.getConfig();
    if (cfg.mode === 'external_server') {
      return {
        mode: 'external_server',
        running: Boolean(this.externalValidated),
        baseUrl: cfg.serverUrl ?? null,
        pid: null,
      };
    }
    return {
      mode: 'managed_local',
      running: Boolean(this.managed?.baseUrl),
      baseUrl: this.managed?.baseUrl ?? null,
      pid: this.managed?.pid ?? null,
    };
  }

  async forget() {
    this.externalValidated = null;
    if (this.startingPromise) {
      await this.startingPromise.catch(() => {});
    }
    const current = this.managed;
    this.managed = null;
    if (current?.processHandle) {
      await current.processHandle.kill('SIGTERM').catch(() => {});
    }
  }

  async resolveExternalPassword(cfg) {
    if (!cfg.serverPasswordSecretRef) return '';
    try {
      return (await this.ctx.secrets.resolve(cfg.serverPasswordSecretRef)) ?? '';
    } catch {
      return '';
    }
  }

  async fetchJson(connection, pathname, init = {}, timeoutMs = 5_000) {
    const secrets = [...this.getSecretsForRedaction(), ...(connection.password ? [connection.password] : [])];
    const authHeader = buildBasicAuthHeader(connection.password);
    try {
      return await this.ctx.net.fetch(`${connection.baseUrl}${pathname}`, {
        method: init.method ?? 'GET',
        headers: {
          ...(authHeader ? { Authorization: authHeader } : {}),
          ...(init.headers || {}),
        },
        body: init.body,
        timeoutMs,
      });
    } catch (err) {
      const safeMsg = sanitizeOpenCodeError(err, secrets);
      const wrapped = new Error(safeMsg);
      wrapped.code = 'server_unreachable';
      throw wrapped;
    }
  }

  async probeServerInfo(connection, timeoutMs = 5_000) {
    const res = await this.fetchJson(connection, '/server/info', { method: 'GET' }, timeoutMs);
    return validateServerInfoResponse(res.status, res.headers, res.body);
  }

  async ensureConnection() {
    const cfg = this.getConfig();
    if (cfg.mode === 'external_server') {
      if (!cfg.serverUrl) {
        const err = new Error('OpenCode external_server mode requires serverUrl');
        err.code = 'server_unreachable';
        throw err;
      }
      const password = await this.resolveExternalPassword(cfg);
      const connection = {
        mode: 'external_server',
        baseUrl: cfg.serverUrl,
        password,
        authHeader: buildBasicAuthHeader(password),
      };
      if (
        !this.externalValidated ||
        this.externalValidated.url !== cfg.serverUrl ||
        this.externalValidated.password !== password
      ) {
        const info = await this.probeServerInfo(connection, cfg.connectTimeoutMs);
        this.externalValidated = { url: cfg.serverUrl, password, serverInfo: info };
      }
      return { ...connection, serverInfo: this.externalValidated.serverInfo };
    }

    if (this.managed?.baseUrl) {
      return {
        mode: 'managed_local',
        baseUrl: this.managed.baseUrl,
        password: this.managed.password,
        authHeader: buildBasicAuthHeader(this.managed.password),
        pid: this.managed.pid,
        serverInfo: this.managed.serverInfo,
      };
    }

    if (!this.startingPromise) {
      this.startingPromise = this.startManagedLocal(cfg).finally(() => {
        this.startingPromise = null;
      });
    }
    return this.startingPromise;
  }

  async startManagedLocal(cfg) {
    const { env, password } = buildServerEnvironment({});
    const spawned = await this.ctx.runtime.spawnCli({
      command: cfg.binaryPath || 'opencode',
      args: ['serve', '--hostname', '127.0.0.1', '--port', '0'],
      extraEnv: env,
      unsetEnv: ['OPENCODE_SERVER_PASSWORD'],
    });

    let stdoutBuf = '';
    let settled = false;
    let readyResolve;
    let readyReject;
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      readyReject(new Error('Timed out waiting for local opencode serve to report bound address'));
    }, Math.max(5_000, cfg.connectTimeoutMs || 5_000));

    spawned.onStdout((chunk) => {
      stdoutBuf += chunk;
      const match = /https?:\/\/(?:127\.0\.0\.1|localhost):\d+/i.exec(stdoutBuf);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        readyResolve(match[0]);
      }
    });

    spawned.onStderr((chunk) => {
      const safe = sanitizeOpenCodeError(chunk, [password]);
      if (safe.trim()) {
        this.ctx.logger.warn('opencode serve stderr', { message: safe.slice(0, 400) });
      }
    });

    spawned.onExit((info) => {
      if (this.managed?.processHandle === spawned) {
        this.managed = null;
        this.onUnexpectedExit?.(`Local opencode serve exited (code=${info.code ?? 'null'}, signal=${info.signal ?? 'null'})`);
      }
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        readyReject(new Error(`opencode serve exited before reporting URL (code=${info.code ?? 'null'})`));
      }
    });

    let baseUrl;
    try {
      baseUrl = await readyPromise;
    } catch (err) {
      await spawned.kill('SIGKILL').catch(() => {});
      throw new Error(sanitizeOpenCodeError(err, [password]));
    }

    const connection = {
      mode: 'managed_local',
      baseUrl,
      password,
      authHeader: buildBasicAuthHeader(password),
      pid: spawned.pid,
      processHandle: spawned,
    };

    const serverInfo = await this.probeServerInfo(connection, cfg.connectTimeoutMs);
    this.managed = { ...connection, serverInfo };
    return this.managed;
  }
}
