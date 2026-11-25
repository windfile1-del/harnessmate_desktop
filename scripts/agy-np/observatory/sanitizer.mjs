import crypto from 'node:crypto';

export const OFFICIAL_AGY_COMMANDS = new Set([
  'add-dir', 'agents', 'artifact', 'automation', 'boost', 'browser', 'btw',
  'compact', 'config', 'context', 'diff', 'effort', 'fork', 'goal', 'grill-me',
  'hooks', 'learn', 'mcp', 'model', 'permissions', 'plan', 'plugin', 'projects',
  'resume', 'review', 'rewind', 'run-workflow', 'schedule', 'skills', 'swarm',
  'tasks', 'teamwork', 'usage',
]);

export const DEFAULT_TEST_MARKERS = [
  'NP00_FINITE_DONE',
  'NP01_FINITE_DONE',
  'NP01_WAKE_CHECK',
  'NP01_BG_A_DONE',
  'NP01_BG_B_DONE',
  'NP01_DAEMON_READY',
  'NP01_STEER_OK',
];

const SAFE_KEY_RE = /^[a-zA-Z0-9_.:-]{1,64}$/;
const SAFE_LABEL_RE = /^[a-zA-Z0-9_./ :-]{1,80}$/;
const PUBLIC_OPTION_RE =
  /^(default|auto|plan|manual|accept-edits|accept_edits|low|medium|high|extra|max|xhigh|allow_once|allow_always|reject_once|reject_always|cancelled|selected|end_turn|max_tokens|refusal|tool_use|gemini[\w.:-]*|claude[\w.:-]*|gpt[\w.:-]*|orchestrator[\w.:-]*|oauth-personal|oauth-business|gemini-api-key|agent-platform)$/i;

const KNOWN_TOP_LEVEL_RPC_KEYS = new Set(['jsonrpc', 'id', 'method', 'params', 'result', 'error']);
const KNOWN_UPDATE_KEYS = new Set([
  'sessionUpdate',
  'type',
  'status',
  'toolCallId',
  'sessionId',
  'childSessionId',
  'parentSessionId',
  'backgroundTaskId',
  'taskId',
  'workflowId',
  'title',
  'toolName',
  'kind',
  'content',
  'rawInput',
  'rawOutput',
  'availableCommands',
  'configOptions',
  'used',
  'size',
  'modes',
  'plan',
  '_meta',
]);

const LEAK_PATTERNS = [
  { name: 'oauth_query_secret', re: /[?&](?:code|access_token|refresh_token|id_token|state|client_secret)=[^\s&"']+/i },
  { name: 'bearer_token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  { name: 'google_oauth_token', re: /\bya29\.[A-Za-z0-9._-]{10,}/ },
  { name: 'google_api_key', re: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { name: 'openai_like_key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/ },
  { name: 'cookie_header', re: /\b(?:set-cookie|cookie)\s*:\s*[^;\r\n]{6,}/i },
  { name: 'email_address', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'windows_user_path', re: /[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\s"'`]+/i },
  { name: 'windows_drive_path', re: /\b[A-Za-z]:\\[^\s"'`]{3,}/ },
  { name: 'posix_home_path', re: /(?:^|[\s"'=])\/(?:Users|home|var\/folders|tmp)\/[^\s"'`]+/ },
  { name: 'hm_internal_token', re: /HARNESSMATE_(?:LOCAL|SESSION_MCP)_TOKEN\s*=\s*\S+/i },
];

export function safeLabel(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !SAFE_LABEL_RE.test(trimmed)) return undefined;
  if (scanTextForLeaks(trimmed).length > 0) return undefined;
  return trimmed;
}

export function safePublicOption(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 96) return undefined;
  return PUBLIC_OPTION_RE.test(trimmed) ? trimmed : undefined;
}

export function safeFieldNames(obj, maxKeys = 64) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj)
    .filter((key) => SAFE_KEY_RE.test(key))
    .sort()
    .slice(0, maxKeys);
}

export function describeValueType(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(${value.length})`;
  const t = typeof value;
  if (t === 'string') return `string(${value.length})`;
  if (t === 'number') return Number.isFinite(value) ? 'number' : 'nonfinite_number';
  if (t === 'boolean') return 'boolean';
  if (t === 'object') return `object(${Object.keys(value).length})`;
  return t;
}

export function describeFieldTypes(obj, maxKeys = 40) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  const out = {};
  for (const key of safeFieldNames(obj, maxKeys)) {
    out[key] = describeValueType(obj[key]);
  }
  return out;
}

export function extractUnknownKeys(obj, knownSet, maxKeys = 32) {
  return safeFieldNames(obj, 128)
    .filter((k) => !knownSet.has(k))
    .slice(0, maxKeys);
}

export function saltedHash(salt, value, hexLength = 12) {
  return crypto
    .createHmac('sha256', String(salt))
    .update(String(value))
    .digest('hex')
    .slice(0, hexLength);
}

export class AliasTable {
  constructor(options = {}) {
    this.salt = options.salt ?? crypto.randomBytes(16).toString('hex');
    this.testMarkers = new Set(options.testMarkers ?? DEFAULT_TEST_MARKERS);
    this.maps = new Map();
    this.counters = new Map();
  }

  alias(namespace, rawValue) {
    if (rawValue === undefined || rawValue === null || rawValue === '') return null;
    const typeTag = typeof rawValue === 'number' ? 'num' : 'str';
    const key = `${typeTag}:${String(rawValue)}`;
    let nsMap = this.maps.get(namespace);
    if (!nsMap) {
      nsMap = new Map();
      this.maps.set(namespace, nsMap);
    }
    let existing = nsMap.get(key);
    if (!existing) {
      const next = (this.counters.get(namespace) ?? 0) + 1;
      this.counters.set(namespace, next);
      existing = `${namespace}-${next}`;
      nsMap.set(key, existing);
    }
    return existing;
  }

  correlateMarkerText(text) {
    if (typeof text !== 'string' || !text) return null;
    const matched = [];
    for (const marker of this.testMarkers) {
      if (text.includes(marker)) {
        matched.push({
          marker,
          saltedTag: `salted:${saltedHash(this.salt, `marker:${marker}`, 12)}`,
        });
      }
    }
    return matched.length > 0 ? matched : null;
  }

  correlateFixedValue(namespace, value) {
    if (value === undefined || value === null || value === '') return null;
    return `salted:${saltedHash(this.salt, `${namespace}:${String(value)}`, 12)}`;
  }

  shapeHash(text) {
    // Normalize numbers, quoted strings, paths, and tokens into structural skeleton before hashing
    const normalized = String(text ?? '')
      .replace(/[A-Za-z]:\\[^\s"'`]+/g, '<WIN_PATH>')
      .replace(/\/(?:Users|home|tmp|var)\/[^\s"'`]+/g, '<POSIX_PATH>')
      .replace(/[?&](?:code|access_token|refresh_token|id_token|state)=[^\s&"']+/gi, '?<OAUTH_PARAM>')
      .replace(/\bBearer\s+\S+/gi, 'Bearer <REDACTED>')
      .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<EMAIL>')
      .replace(/\b\d+\b/g, '<N>')
      .slice(0, 512);
    return `shape:${saltedHash(this.salt, normalized, 16)}`;
  }
}

export function classifyStderrLine(line, aliases) {
  const raw = String(line ?? '');
  const trimmed = raw.trim();
  const byteLength = Buffer.byteLength(raw, 'utf8');
  let category = 'unknown';
  if (/authentication required|please sign in|unauthenticated|-32000/i.test(trimmed)) {
    category = 'auth_required';
  } else if (/https?:\/\/[^\s]*(?:oauth|accounts\.google\.com|auth)/i.test(trimmed)) {
    category = 'oauth_url_suppressed';
  } else if (/quota|rate.?limit|429|resource_exhausted/i.test(trimmed)) {
    category = 'rate_limit_or_quota';
  } else if (/^\s*at\s+\S+\s*\(|Error:|Exception:/i.test(trimmed)) {
    category = 'stack_trace';
  } else if (/EPIPE|ECONNRESET|EOF|stdin|stdout|broken pipe/i.test(trimmed)) {
    category = 'transport_error';
  } else if (/json-?rpc|protocol|parse|malformed/i.test(trimmed)) {
    category = 'protocol_warning';
  } else if (/warn|deprecated|notice/i.test(trimmed)) {
    category = 'process_warning';
  }
  return {
    category,
    byteLength,
    lineCharCount: trimmed.length,
    shapeHash: aliases.shapeHash(trimmed),
  };
}

export function classifyErrorShape(errorObj, aliases) {
  if (!errorObj || typeof errorObj !== 'object') return undefined;
  const msg = typeof errorObj.message === 'string' ? errorObj.message : '';
  return {
    code: typeof errorObj.code === 'number' ? errorObj.code : undefined,
    authenticationRequired: /authentication required|please sign in|unauthenticated/i.test(msg) || errorObj.code === -32000,
    quotaExhausted: /quota_exhausted|quota|rate.?limit|resource_exhausted/i.test(msg) || errorObj.code === -32008,
    methodNotFound: errorObj.code === -32601,
    hasData: errorObj.data !== undefined,
    dataKeys: safeFieldNames(errorObj.data),
    messageLength: msg.length,
    messageShapeHash: msg ? aliases.shapeHash(msg) : undefined,
  };
}

function summarizeConfigOptions(configOptions) {
  if (!Array.isArray(configOptions)) return undefined;
  return configOptions.slice(0, 32).map((opt) => {
    const flatOptions = Array.isArray(opt?.options)
      ? opt.options.flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]))
      : [];
    return {
      id: safeLabel(opt?.id),
      category: safeLabel(opt?.category),
      type: safeLabel(opt?.type),
      current: safePublicOption(opt?.currentValue),
      optionCount: flatOptions.length,
      publicValues: flatOptions
        .map((o) => safePublicOption(o?.value))
        .filter(Boolean)
        .slice(0, 32),
    };
  });
}

function extractMarkersFromUnknown(value, aliases) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return aliases.correlateMarkerText(value);
  if (typeof value !== 'object') return null;
  // Walk bounded strings only to detect fixed test markers without retaining raw content
  const found = new Map();
  const stack = [value];
  let visited = 0;
  while (stack.length > 0 && visited < 120) {
    const cur = stack.pop();
    visited++;
    if (typeof cur === 'string') {
      const m = aliases.correlateMarkerText(cur);
      if (m) {
        for (const item of m) found.set(item.marker, item);
      }
    } else if (Array.isArray(cur)) {
      for (let i = 0; i < Math.min(cur.length, 30); i++) stack.push(cur[i]);
    } else if (cur && typeof cur === 'object') {
      const vals = Object.values(cur);
      for (let i = 0; i < Math.min(vals.length, 30); i++) stack.push(vals[i]);
    }
  }
  return found.size > 0 ? [...found.values()] : null;
}

function classifyToolKindLabel(title, rawInput, kind) {
  const t = typeof title === 'string' ? title.trim() : '';
  const k = safeLabel(kind);
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};
  let detectedRole = 'generic_tool';
  if (/update_steps/i.test(t)) detectedRole = 'update_steps';
  else if (/invoke_subagent/i.test(t)) detectedRole = 'invoke_subagent';
  else if (/schedule/i.test(t) || 'CronExpression' in input || 'DurationSeconds' in input) detectedRole = 'schedule';
  else if (input.isBackground === true || input.IsDaemon === true || typeof input.backgroundTaskId === 'string') {
    detectedRole = input.IsDaemon === true ? 'daemon_command' : 'background_command';
  } else if (/^\/?goal\b/i.test(t)) detectedRole = 'goal';
  else if (typeof t === 'string' && /^interaction_/i.test(t)) detectedRole = 'interaction';
  return {
    toolKind: k,
    detectedRole,
    isDaemon: typeof input.IsDaemon === 'boolean' ? input.IsDaemon : undefined,
    isBackground: typeof input.isBackground === 'boolean' ? input.isBackground : undefined,
    hasDurationSeconds: typeof input.DurationSeconds === 'number',
    durationSeconds: typeof input.DurationSeconds === 'number' && Number.isFinite(input.DurationSeconds)
      ? input.DurationSeconds
      : undefined,
    hasCronExpression: typeof input.CronExpression === 'string',
  };
}

/**
 * Reconstructs an outbound JSON-RPC frame purely from allowlisted structural metadata.
 * Never copies user prompt text, paths, tokens, or raw arguments.
 */
export function reconstructOutboundFrame(frame, aliases) {
  const msg = frame && typeof frame === 'object' ? frame : {};
  const hasId = msg.id !== undefined && msg.id !== null;
  const hasMethod = typeof msg.method === 'string';
  const method = hasMethod ? safeLabel(msg.method) ?? 'unknown_method' : undefined;
  const rpcIdType = hasId ? (typeof msg.id === 'number' ? 'number' : 'string') : null;
  const rpcIdAlias = hasId ? aliases.alias(hasMethod ? 'rpc' : 'srvreq', msg.id) : null;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  let messageKind = 'rpc_notification';
  if (hasMethod && hasId) messageKind = 'rpc_request';
  else if (!hasMethod && hasId && msg.error) messageKind = 'rpc_error';
  else if (!hasMethod && hasId) messageKind = 'rpc_response';

  const sessionAlias = aliases.alias('sess', params.sessionId);
  const shape = {
    jsonrpc: msg.jsonrpc === '2.0' ? '2.0' : 'other',
    ...(method ? { method } : {}),
    paramKeys: safeFieldNames(params),
  };

  if (method === 'initialize') {
    shape.protocolVersion = typeof params.protocolVersion === 'number' ? params.protocolVersion : undefined;
    shape.clientName = safeLabel(params.clientInfo?.name);
    shape.clientVersion = safeLabel(params.clientInfo?.version);
    shape.clientCapabilityKeys = safeFieldNames(params.clientCapabilities);
  } else if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
    shape.hasCwd = typeof params.cwd === 'string' && params.cwd.length > 0;
    shape.mcpServerCount = Array.isArray(params.mcpServers) ? params.mcpServers.length : 0;
  } else if (method === 'session/set_mode') {
    shape.modeId = safePublicOption(params.modeId);
  } else if (method === 'session/set_config_option') {
    shape.configId = safeLabel(params.configId);
    shape.value = safePublicOption(params.value);
  } else if (method === 'session/prompt') {
    const blocks = Array.isArray(params.prompt) ? params.prompt : [];
    shape.promptBlockCount = blocks.length;
    shape.promptBlockTypes = blocks.map((b) => safeLabel(b?.type) ?? 'unknown').slice(0, 16);
    shape.totalTextChars = blocks.reduce((acc, b) => acc + (typeof b?.text === 'string' ? b.text.length : 0), 0);
    const markers = extractMarkersFromUnknown(blocks, aliases);
    if (markers) shape.testMarkers = markers;
  } else if (messageKind === 'rpc_response') {
    const result = msg.result && typeof msg.result === 'object' ? msg.result : {};
    shape.resultKeys = safeFieldNames(result);
    if (result.outcome && typeof result.outcome === 'object') {
      shape.permissionOutcome = safePublicOption(result.outcome.outcome);
      shape.selectedOptionAlias = result.outcome.optionId
        ? aliases.correlateFixedValue('option', result.outcome.optionId)
        : undefined;
      shape.selectedOptionPublic = safePublicOption(result.outcome.optionId);
    }
  } else if (messageKind === 'rpc_error') {
    shape.error = classifyErrorShape(msg.error, aliases);
  }

  return {
    messageKind,
    rpcIdAlias,
    rpcIdType,
    sessionAlias,
    shape,
    unknownKeys: extractUnknownKeys(msg, KNOWN_TOP_LEVEL_RPC_KEYS),
  };
}

/**
 * Reconstructs an inbound JSON-RPC frame purely from allowlisted structural metadata.
 * Preserves stable aliases for sessions, children, tools, tasks, workflows, and requests.
 */
export function reconstructInboundFrame(frame, aliases, context = {}) {
  const msg = frame && typeof frame === 'object' ? frame : {};
  const hasId = msg.id !== undefined && msg.id !== null;
  const hasMethod = typeof msg.method === 'string';
  const method = hasMethod ? safeLabel(msg.method) ?? 'unknown_method' : undefined;
  const rpcIdType = hasId ? (typeof msg.id === 'number' ? 'number' : 'string') : null;
  const rpcIdAlias = hasId ? aliases.alias(hasMethod ? 'srvreq' : 'rpc', msg.id) : null;

  let messageKind = 'rpc_notification';
  if (hasMethod && hasId) messageKind = 'server_request';
  else if (!hasMethod && hasId && msg.error) messageKind = 'rpc_error';
  else if (!hasMethod && hasId) messageKind = 'rpc_response';

  const unknownKeys = extractUnknownKeys(msg, KNOWN_TOP_LEVEL_RPC_KEYS);
  const correlation = {
    rpcIdAlias,
    rpcIdType,
    sessionAlias: null,
    childAlias: null,
    toolAlias: null,
    taskAlias: null,
    workflowAlias: null,
    approvalAlias: null,
  };

  const shape = {
    jsonrpc: msg.jsonrpc === '2.0' ? '2.0' : 'other',
    ...(method ? { method } : {}),
  };

  if (messageKind === 'rpc_error') {
    shape.error = classifyErrorShape(msg.error, aliases);
    if (context.requestMethod) shape.responseForMethod = safeLabel(context.requestMethod);
    return { messageKind, correlation, shape, unknownKeys };
  }

  if (messageKind === 'rpc_response') {
    const res = msg.result && typeof msg.result === 'object' ? msg.result : {};
    const forMethod = context.requestMethod;
    if (forMethod) shape.responseForMethod = safeLabel(forMethod);
    shape.resultKeys = safeFieldNames(res);

    if (forMethod === 'initialize' || 'protocolVersion' in res || 'agentCapabilities' in res) {
      shape.protocolVersion = typeof res.protocolVersion === 'number' ? res.protocolVersion : undefined;
      shape.agentName = safeLabel(res.agentInfo?.name);
      shape.agentVersion = safeLabel(res.agentInfo?.version);
      shape.authMethods = Array.isArray(res.authMethods)
        ? res.authMethods.map((m) => safePublicOption(m?.id) ?? safeLabel(m?.id)).filter(Boolean)
        : undefined;
      shape.capabilityKeys = safeFieldNames(res.agentCapabilities);
      shape.loadSession = typeof res.agentCapabilities?.loadSession === 'boolean'
        ? res.agentCapabilities.loadSession
        : undefined;
      shape.promptCapabilities = res.agentCapabilities?.promptCapabilities
        ? {
            image: Boolean(res.agentCapabilities.promptCapabilities.image),
            audio: Boolean(res.agentCapabilities.promptCapabilities.audio),
            embeddedContext: Boolean(res.agentCapabilities.promptCapabilities.embeddedContext),
          }
        : undefined;
      shape.sessionCapabilityKeys = safeFieldNames(res.agentCapabilities?.sessionCapabilities);
    }

    if (typeof res.sessionId === 'string') {
      correlation.sessionAlias = aliases.alias('sess', res.sessionId);
    }
    if (res.modes && typeof res.modes === 'object') {
      shape.currentMode = safePublicOption(res.modes.currentModeId);
      shape.availableModes = Array.isArray(res.modes.availableModes)
        ? res.modes.availableModes.map((m) => safePublicOption(m?.id)).filter(Boolean)
        : undefined;
    }
    if (Array.isArray(res.configOptions)) {
      shape.configOptions = summarizeConfigOptions(res.configOptions);
    }
    if (typeof res.stopReason === 'string') {
      shape.stopReason = safePublicOption(res.stopReason) ?? safeLabel(res.stopReason);
    }
    return { messageKind, correlation, shape, unknownKeys };
  }

  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  correlation.sessionAlias = aliases.alias('sess', params.sessionId);

  if (messageKind === 'server_request') {
    correlation.approvalAlias = aliases.alias('req', msg.id);
    const tc = params.toolCall && typeof params.toolCall === 'object' ? params.toolCall : {};
    correlation.toolAlias = aliases.alias('tool', tc.toolCallId);
    if (typeof params.childSessionId === 'string') {
      correlation.childAlias = aliases.alias('child', params.childSessionId);
    }
    const isInteraction = typeof tc.toolCallId === 'string' && tc.toolCallId.startsWith('interaction_');
    const options = Array.isArray(params.options) ? params.options : [];
    shape.paramKeys = safeFieldNames(params);
    shape.toolCallKeys = safeFieldNames(tc);
    shape.toolCallKind = safeLabel(tc.kind);
    shape.isInteraction = isInteraction;
    shape.optionCount = options.length;
    shape.optionKinds = options.map((o) => safePublicOption(o?.kind) ?? safeLabel(o?.kind) ?? 'unspecified').slice(0, 16);
    shape.optionIdHashes = options
      .map((o) => (typeof o?.optionId === 'string' ? aliases.correlateFixedValue('option', o.optionId) : null))
      .filter(Boolean)
      .slice(0, 16);
    shape.hasSecurityWarning = options.some((o) => typeof o?._meta?.['agy.security.warning'] === 'string');
    return { messageKind, correlation, shape, unknownKeys };
  }

  // Notification
  if (method === 'session/update') {
    const u = params.update && typeof params.update === 'object' ? params.update : {};
    const updateType = safeLabel(u.sessionUpdate ?? u.type) ?? 'unknown_update';
    const rawInput = u.rawInput && typeof u.rawInput === 'object' ? u.rawInput : undefined;
    const rawOutput = u.rawOutput;

    correlation.toolAlias = aliases.alias('tool', u.toolCallId);
    const childCandidate = u.childSessionId ?? (u.sessionId && u.sessionId !== params.sessionId ? u.sessionId : undefined);
    if (childCandidate) {
      correlation.childAlias = aliases.alias('child', childCandidate);
    }
    const taskCandidate = rawInput?.backgroundTaskId ?? u.backgroundTaskId ?? u.taskId;
    if (taskCandidate) {
      correlation.taskAlias = aliases.alias('task', taskCandidate);
    }
    if (u.workflowId || rawInput?.workflowId) {
      correlation.workflowAlias = aliases.alias('wf', u.workflowId ?? rawInput?.workflowId);
    }

    shape.updateType = updateType;
    shape.status = safeLabel(u.status);
    shape.updateKeys = safeFieldNames(u);
    if (rawInput) {
      shape.rawInputKeys = safeFieldNames(rawInput);
      shape.rawInputFieldTypes = describeFieldTypes(rawInput, 24);
    }
    if (rawOutput !== undefined) {
      shape.rawOutputType = describeValueType(rawOutput);
    }
    if (u.content && typeof u.content === 'object') {
      shape.contentType = safeLabel(u.content.type);
      if (typeof u.content.text === 'string') {
        shape.contentCharCount = u.content.text.length;
      }
    }
    if (updateType === 'tool_call' || updateType === 'tool_call_update') {
      Object.assign(shape, classifyToolKindLabel(u.title, rawInput, u.kind));
      shape.titleShapeHash = typeof u.title === 'string' ? aliases.shapeHash(u.title) : undefined;
    }
    if (updateType === 'available_commands_update' && Array.isArray(u.availableCommands)) {
      shape.commandCount = u.availableCommands.length;
      shape.officialCommands = u.availableCommands
        .map((c) => String(c?.name ?? '').replace(/^\//, ''))
        .filter((n) => OFFICIAL_AGY_COMMANDS.has(n));
    }
    if (updateType === 'config_option_update' && Array.isArray(u.configOptions)) {
      shape.configOptions = summarizeConfigOptions(u.configOptions);
    }
    if (updateType === 'usage_update') {
      shape.used = typeof u.used === 'number' && Number.isFinite(u.used) ? u.used : undefined;
      shape.size = typeof u.size === 'number' && Number.isFinite(u.size) ? u.size : undefined;
    }
    if (updateType === 'session_info_update') {
      shape.hasTitle = typeof u.title === 'string' && u.title.trim().length > 0;
      shape.titleCharCount = typeof u.title === 'string' ? u.title.length : 0;
    }

    const markers = extractMarkersFromUnknown([u.rawOutput, u.content, u.rawInput], aliases);
    if (markers) {
      shape.testMarkers = markers;
    }

    const updateUnknown = extractUnknownKeys(u, KNOWN_UPDATE_KEYS);
    for (const k of updateUnknown) {
      if (!unknownKeys.includes(`update.${k}`)) unknownKeys.push(`update.${k}`);
    }
    return { messageKind, correlation, shape, unknownKeys };
  }

  shape.paramKeys = safeFieldNames(params);
  shape.paramFieldTypes = describeFieldTypes(params, 24);
  return { messageKind, correlation, shape, unknownKeys };
}

export function scanTextForLeaks(text) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  if (!str) return [];
  const findings = [];
  for (const { name, re } of LEAK_PATTERNS) {
    if (re.test(str)) {
      findings.push(name);
    }
  }
  return findings;
}

export function scanRecordForLeaks(record) {
  return scanTextForLeaks(JSON.stringify(record));
}
