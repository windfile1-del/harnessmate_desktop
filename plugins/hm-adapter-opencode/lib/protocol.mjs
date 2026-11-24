import { randomBytes } from 'node:crypto';

export const OPENCODE_DRIVER_ID = 'opencode';

export const OPENCODE_PRESENTATION = {
  shortLabel: 'OpenCode',
  accentColor: 'var(--accent-cyan)',
  softBg: 'rgba(6, 182, 212, 0.14)',
  tagline: 'OpenCode 2.x Server (HTTP REST + SSE)',
  iconSvg:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></svg>',
};

export const OPENCODE_DEFAULT_MODELS = [
  {
    id: 'opencode/default',
    displayName: 'OpenCode Default Agent',
    description: 'OpenCode 2.x 托管服务端默认路由模型',
    group: 'OpenCode',
    isDefault: true,
    defaultEffort: 'medium',
    supportedEfforts: ['none', 'low', 'medium', 'high'],
    inputModalities: ['text', 'image'],
  },
];

export const OPENCODE_DEFAULT_AGENTS = [
  { value: 'build', label: 'Build', description: '工程构建与代码改动 Agent' },
  { value: 'plan', label: 'Plan', description: '只读规划与方案设计 Agent' },
  { value: 'explore', label: 'Explore', description: '代码库深度检索 Agent' },
  { value: 'general', label: 'General', description: '通用问答与协作 Agent' },
];

export function buildOpenCodeOptionDescriptors(agents = OPENCODE_DEFAULT_AGENTS) {
  const list = Array.isArray(agents) && agents.length > 0 ? agents : OPENCODE_DEFAULT_AGENTS;
  return [
    {
      kind: 'select',
      key: 'agent',
      label: 'Agent',
      description: 'OpenCode 2.x 原生 Agent 角色档位',
      defaultValue: list[0]?.value ?? 'build',
      options: list.map((a) => ({
        value: String(a.value ?? a.id ?? 'build'),
        label: String(a.label ?? a.name ?? a.value ?? a.id ?? 'Agent'),
        ...(a.description ? { description: String(a.description) } : {}),
      })),
    },
  ];
}

export const OPENCODE_CAPABILITIES = {
  streaming: true,
  interactiveApproval: true,
  reasoningEfforts: ['none', 'low', 'medium', 'high'],
  permissionModes: ['manual', 'accept_edits', 'auto'],
  sessionResume: true,
  sessionFork: false,
  imageInput: true,
  subagents: false,
};

export const OPENCODE_CAPABILITIES_V2 = {
  ...OPENCODE_CAPABILITIES,
  transport: 'http_sse',
  historyInjectionMode: 'inline',
  supportsNativeRollback: false,
  supportsNativeFork: false,
  supportsActiveSteering: false,
  supportsUsageLimits: true,
  supportsDynamicOptions: true,
  nativeCommands: [],
  optionDescriptors: buildOpenCodeOptionDescriptors(),
};

export function normalizeOpenCodeConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {};
  const mode = cfg.mode === 'external_server' || cfg.mode === 'managed_local' ? cfg.mode : 'managed_local';
  const binaryPath = typeof cfg.binaryPath === 'string' && cfg.binaryPath.trim()
    ? cfg.binaryPath.trim()
    : 'opencode';
  const serverUrl = typeof cfg.serverUrl === 'string' && cfg.serverUrl.trim()
    ? cfg.serverUrl.trim().replace(/\/+$/, '')
    : undefined;
  const serverPasswordSecretRef =
    typeof cfg.serverPasswordSecretRef === 'string' && cfg.serverPasswordSecretRef.trim()
      ? cfg.serverPasswordSecretRef.trim()
      : 'opencode:server_password';
  const defaultAgent =
    typeof cfg.defaultAgent === 'string' && cfg.defaultAgent.trim()
      ? cfg.defaultAgent.trim()
      : 'build';
  const connectTimeoutMs =
    typeof cfg.connectTimeoutMs === 'number' && Number.isFinite(cfg.connectTimeoutMs) && cfg.connectTimeoutMs >= 200
      ? Math.floor(cfg.connectTimeoutMs)
      : 5_000;
  const subscriptionTimeoutMs =
    typeof cfg.subscriptionTimeoutMs === 'number' && Number.isFinite(cfg.subscriptionTimeoutMs) && cfg.subscriptionTimeoutMs >= 200
      ? Math.floor(cfg.subscriptionTimeoutMs)
      : 10_000;
  const silentStreamTimeoutMs =
    typeof cfg.silentStreamTimeoutMs === 'number' && Number.isFinite(cfg.silentStreamTimeoutMs) && cfg.silentStreamTimeoutMs >= 100
      ? Math.floor(cfg.silentStreamTimeoutMs)
      : 45_000;

  return {
    mode,
    binaryPath,
    ...(serverUrl ? { serverUrl } : {}),
    serverPasswordSecretRef,
    defaultAgent,
    connectTimeoutMs,
    subscriptionTimeoutMs,
    silentStreamTimeoutMs,
  };
}

/**
 * Generates an ephemeral 32-byte Base64Url server password and strips the legacy
 * `OPENCODE_SERVER_PASSWORD` variable so 1.x and 2.x credentials never collide.
 */
export function buildServerEnvironment(baseEnv = {}) {
  const env = { ...baseEnv };
  delete env.OPENCODE_SERVER_PASSWORD;
  const password = randomBytes(32).toString('base64url');
  env.OPENCODE_PASSWORD = password;
  return { env, password };
}

export function buildBasicAuthHeader(password) {
  if (!password) return undefined;
  return `Basic ${Buffer.from(`opencode:${password}`, 'utf8').toString('base64')}`;
}

export function sanitizeOpenCodeError(input, secrets = []) {
  let msg = input instanceof Error ? (input.message || input.name) : String(input ?? 'Unknown OpenCode error');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      msg = msg.split(secret).join('[REDACTED]');
      const basicToken = Buffer.from(`opencode:${secret}`, 'utf8').toString('base64');
      msg = msg.split(basicToken).join('[REDACTED]');
    }
  }
  msg = msg.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]');
  msg = msg.replace(/OPENCODE(?:_SERVER)?_PASSWORD=[^\s;'"]+/gi, 'OPENCODE_PASSWORD=[REDACTED]');
  return msg;
}

export function validateServerInfoResponse(status, headers = {}, bodyText = '') {
  if (status === 401 || status === 403) {
    const err = new Error('The OpenCode server rejected the server password.');
    err.code = 'auth_failed';
    throw err;
  }
  const lowerHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([k, v]) => [String(k).toLowerCase(), String(v)]),
  );
  const contentType = lowerHeaders['content-type'] || '';
  const trimmedBody = String(bodyText || '').trim();
  if (
    contentType.includes('text/html') ||
    /^<!doctype\s+html/i.test(trimmedBody) ||
    /^<html\b/i.test(trimmedBody)
  ) {
    const err = new Error('The server is not an OpenCode 2 server.');
    err.code = 'not_v2';
    throw err;
  }
  if (status < 200 || status >= 300) {
    const err = new Error(`OpenCode server returned HTTP ${status}`);
    err.code = status >= 500 ? 'provider_unavailable' : 'server_unreachable';
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmedBody);
  } catch {
    const err = new Error('The server is not an OpenCode 2 server.');
    err.code = 'not_v2';
    throw err;
  }
  const version = typeof parsed?.version === 'string' ? parsed.version : '';
  const isV2 = parsed?.apiVersion === 2 || /^2(\.|$)/.test(version) || parsed?.protocol === 'opencode-v2';
  if (!parsed || typeof parsed !== 'object' || !isV2) {
    const err = new Error('The server is not an OpenCode 2 server.');
    err.code = 'not_v2';
    throw err;
  }
  return {
    version: version || '2.0.0',
    apiVersion: 2,
    models: Array.isArray(parsed.models) ? parsed.models : null,
    agents: Array.isArray(parsed.agents) ? parsed.agents : null,
  };
}

const KNOWN_TERMINAL_TYPES = new Set([
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
]);

/**
 * Resilient forward-compatible SSE frame parser.
 * Never throws on malformed or future event payloads; synthesizes `unreadable.execution.ended`
 * for corrupted terminal events so turns never hang indefinitely.
 */
export function parseOpenCodeSseFrame(rawData) {
  let obj;
  try {
    obj = JSON.parse(String(rawData ?? ''));
  } catch {
    return { kind: 'unknown_ignored', type: null, sessionID: null };
  }
  if (!obj || typeof obj !== 'object') {
    return { kind: 'unknown_ignored', type: null, sessionID: null };
  }

  const type = typeof obj.type === 'string' ? obj.type : null;
  const rawPayload = obj.data && typeof obj.data === 'object' ? obj.data : obj.properties && typeof obj.properties === 'object' ? obj.properties : null;
  const sessionID =
    typeof obj.sessionID === 'string'
      ? obj.sessionID
      : (rawPayload && typeof rawPayload.sessionID === 'string'
        ? rawPayload.sessionID
        : (typeof obj.data?.sessionID === 'string' ? obj.data.sessionID : null));

  const payload = rawPayload ?? {};

  if (!type) {
    return { kind: 'unknown_ignored', type: null, sessionID };
  }

  const hasCorruptDataField = obj.data !== undefined && (obj.data === null || typeof obj.data !== 'object' || Array.isArray(obj.data));

  if (KNOWN_TERMINAL_TYPES.has(type)) {
    const isInvalidPayload = hasCorruptDataField || obj.corrupt === true || payload.corrupt === true;
    if (type === 'session.execution.succeeded' && !isInvalidPayload && (payload.stopReason === undefined || typeof payload.stopReason === 'string')) {
      return { kind: 'known', type, sessionID, data: payload };
    }
    if (type === 'session.execution.failed' && !isInvalidPayload && typeof payload.message === 'string') {
      return { kind: 'known', type, sessionID, data: payload };
    }
    if (type === 'session.execution.interrupted' && !isInvalidPayload) {
      return { kind: 'known', type, sessionID, data: payload };
    }
    return {
      kind: 'unreadable.execution.ended',
      originalType: type,
      sessionID,
      inferredStatus:
        type === 'session.execution.failed'
          ? 'failed'
          : type === 'session.execution.interrupted'
            ? 'cancelled'
            : 'completed',
    };
  }

  if (hasCorruptDataField) {
    if (/\.ended$|\.completed$|\.failed$|\.interrupted$/.test(type)) {
      return {
        kind: 'unreadable.execution.ended',
        originalType: type,
        sessionID,
        inferredStatus: type.includes('failed') ? 'failed' : type.includes('interrupted') ? 'cancelled' : 'completed',
      };
    }
    return { kind: 'unknown_ignored', type, sessionID };
  }

  switch (type) {
    case 'heartbeat':
    case 'ping':
      return { kind: 'known', type: 'heartbeat', sessionID, data: payload };
    case 'message.delta':
    case 'message.part.delta':
      if (typeof (payload.text ?? payload.delta) !== 'string') {
        return { kind: 'unknown_ignored', type, sessionID };
      }
      return { kind: 'known', type: 'message.delta', sessionID, data: payload };
    case 'message.completed':
      if (typeof payload.text !== 'string') {
        return { kind: 'unknown_ignored', type, sessionID };
      }
      return { kind: 'known', type: 'message.completed', sessionID, data: payload };
    case 'reasoning.delta':
    case 'reasoning.completed':
      if (typeof (payload.text ?? payload.delta) !== 'string') {
        return { kind: 'unknown_ignored', type, sessionID };
      }
      return { kind: 'known', type, sessionID, data: payload };
    case 'tool.call.started':
    case 'tool.call.delta':
    case 'tool.call.completed':
    case 'shell.job.output':
    case 'image.job.updated':
    case 'permission.requested':
    case 'usage.updated':
      return { kind: 'known', type, sessionID, data: payload };
    default:
      return { kind: 'unknown_ignored', type, sessionID };
  }
}

export function createOpenCodeSseStreamParser(onParsed) {
  let buffer = '';
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n').trim();
    dataLines = [];
    if (!raw || raw === '[DONE]') return;
    onParsed(parseOpenCodeSseFrame(raw));
  };

  return {
    push(chunk) {
      buffer += String(chunk ?? '');
      while (true) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          flush();
          continue;
        }
        if (line.startsWith(':')) continue;
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
      }
    },
    end() {
      if (buffer.trim()) {
        const rem = buffer.replace(/\r$/, '');
        buffer = '';
        if (rem.startsWith('data:')) {
          dataLines.push(rem.slice(5).replace(/^ /, ''));
        }
      }
      flush();
    },
  };
}

export const ALLOWED_IMAGE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

export const ALLOWED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
]);

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function validateImageJobPayload(payload = {}) {
  const mimeType = String(payload.mimeType || '').toLowerCase().trim();
  if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
    return {
      ok: false,
      reason: `Unsupported image MIME type: ${mimeType || 'unknown'} (only png/jpeg/webp/gif allowed)`,
    };
  }
  const sizeBytes = Number(payload.sizeBytes ?? 0);
  if (Number.isFinite(sizeBytes) && sizeBytes > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `Image exceeds maximum allowed size (${MAX_IMAGE_BYTES} bytes)`,
    };
  }
  const fileName = String(payload.fileName || payload.path || '');
  if (fileName) {
    const cleanName = fileName.split('?')[0].split('#')[0].toLowerCase();
    const dotIdx = cleanName.lastIndexOf('.');
    const ext = dotIdx >= 0 ? cleanName.slice(dotIdx) : '';
    if (ext && !ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
      return {
        ok: false,
        reason: `Disallowed image file extension: ${ext}`,
      };
    }
  }
  const dataUri = typeof payload.dataUri === 'string' ? payload.dataUri : '';
  if (dataUri) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(dataUri.trim());
    if (!match || match[1].toLowerCase() !== mimeType) {
      return { ok: false, reason: 'Invalid or mismatched image data URI' };
    }
    const approxBytes = Math.floor((match[2].length * 3) / 4);
    if (approxBytes > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `Image payload exceeds maximum size (${MAX_IMAGE_BYTES} bytes)` };
    }
  }
  return {
    ok: true,
    mimeType,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
  };
}

export function composeInlinePrompt(text, contextSync) {
  if (!contextSync?.deltaMarkdown) return text;
  return `${contextSync.deltaMarkdown}\n\n---\n\n${text}`;
}
