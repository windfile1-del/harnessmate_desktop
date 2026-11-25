import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  AliasTable,
  classifyStderrLine,
  clampRawText,
  reconstructInboundFrame,
  reconstructOutboundFrame,
  safeFieldNames,
  safeLabel,
  safeMetaToken,
  safeProvenance,
  safeVersion,
} from './sanitizer.mjs';
import { formatDiagnosticCode } from './four-layer.mjs';
import { validateCaptureRecord } from './schema-validator.mjs';

export const OBSERVATORY_SCHEMA_VERSION = 1;

const ALLOWED_PLATFORMS = new Set(['win32', 'darwin', 'linux', 'unknown']);
const ALLOWED_ACCOUNT_CATEGORIES = new Set([
  'none',
  'dedicated_test_personal',
  'dedicated_test_business',
  'synthetic',
  'replay_sanitized',
]);
const ALLOWED_SOURCES = new Set([
  'synthetic',
  'replay_with_provenance',
  'live_raw',
  'live_hm',
  'official_comparison',
]);
const ALLOWED_PRODUCERS = new Set([
  'observatory_cli',
  'daemon_tap_callback',
  'replay_harness',
  'migrator',
]);

export class ProtocolObservatoryRecorder {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;

    const defaultCaptureId = `cap-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
    const capRes = safeMetaToken(options.captureId ?? defaultCaptureId, defaultCaptureId);
    const scenRes = safeMetaToken(options.scenario ?? 'custom', 'redacted_scenario');
    const provRes = safeProvenance(options.provenance);

    this.captureId = capRes.value;
    this.scenario = scenRes.value;
    this.platform = ALLOWED_PLATFORMS.has(options.platform)
      ? options.platform
      : ['win32', 'darwin', 'linux'].includes(process.platform)
        ? process.platform
        : 'unknown';
    this.cliVersion = safeVersion(options.cliVersion);
    this.protocol = options.protocol === 1 || options.protocol === 2 ? options.protocol : null;
    this.accountCategory = ALLOWED_ACCOUNT_CATEGORIES.has(options.accountCategory)
      ? options.accountCategory
      : 'none';
    this.source = ALLOWED_SOURCES.has(options.source) ? options.source : 'synthetic';
    this.producer = ALLOWED_PRODUCERS.has(options.producer) ? options.producer : 'observatory_cli';
    this.provenance = provRes.value;

    this.maxRecords = options.maxRecords ?? 5_000;
    this.maxLineBytes = options.maxLineBytes ?? 16_384;
    this.maxPendingRequests = options.maxPendingRequests ?? 512;
    this.maxQueuedWriteLines = options.maxQueuedWriteLines ?? 512;
    this.maxQueuedWriteBytes = options.maxQueuedWriteBytes ?? 256 * 1024;
    this.strictLeakGuard = options.strictLeakGuard !== false;

    this.aliases =
      options.aliases ??
      new AliasTable({
        salt: options.salt,
        testMarkers: options.testMarkers,
        maxAliasesPerNamespace: options.maxAliasesPerNamespace,
        maxTotalAliases: options.maxTotalAliases,
      });
    this.startMonotonic = options.nowMonotonic ? options.nowMonotonic() : performance.now();
    this.nowMonotonic = options.nowMonotonic ?? (() => performance.now());
    this.nowEpoch = options.nowEpoch ?? (() => Date.now());

    this.sink = options.sink ?? null;
    this.outputFile = options.outputFile ?? null;
    this.records = [];
    this.seq = 0;

    this.droppedCount = 0;
    this.truncatedCount = 0;
    this.sinkErrorCount = 0;
    this.leakBlockedCount = 0;
    this.validationBlockedCount = 0;
    this.metadataSanitizedCount = (capRes.sanitized ? 1 : 0) + (scenRes.sanitized ? 1 : 0) + (provRes.sanitized ? 1 : 0);
    this.dropReasons = {
      max_records: 0,
      max_pending_requests: 0,
      alias_overflow: 0,
      line_truncated: 0,
      leak_blocked: 0,
      validation_blocked: 0,
      sink_error: 0,
      io_queue_overflow: 0,
    };

    this.saturated = false;
    this.overflowNotified = false;

    this.ingressOrdinals = new Map();
    this.pendingClientRequests = new Map();
    this.pendingServerRequests = new Map();

    // Non-blocking bounded async IO queue for file output
    this._writeQueue = [];
    this._queuedWriteBytes = 0;
    this._draining = false;
    this._drainPromise = null;
  }

  setCliVersion(version) {
    const safe = safeVersion(version);
    if (safe) this.cliVersion = safe;
  }

  setProtocol(protocol) {
    if (protocol === 1 || protocol === 2) {
      this.protocol = protocol;
    }
  }

  _scopeKey(connectionId, generation, channel) {
    return `${connectionId}::${generation ?? 'gen-0'}::${channel === 'history_replay' ? 'history_replay' : 'live'}`;
  }

  nextIngressOrdinal(connectionId = 'conn-1', generation = null, channel = 'live') {
    if (!this.enabled) return 0;
    const key = this._scopeKey(connectionId, generation, channel);
    const cur = this.ingressOrdinals.get(key) ?? 0;
    const next = cur + 1;
    if (this.ingressOrdinals.size >= 512 && !this.ingressOrdinals.has(key)) {
      const oldest = this.ingressOrdinals.keys().next().value;
      if (oldest !== undefined) this.ingressOrdinals.delete(oldest);
    }
    this.ingressOrdinals.set(key, next);
    return next;
  }

  currentMonotonicMs(overrideMs) {
    if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs >= 0) {
      return Math.round(overrideMs * 100) / 100;
    }
    return Math.max(0, Math.round((this.nowMonotonic() - this.startMonotonic) * 100) / 100);
  }

  _pendingKey(connectionId, generation, channel, rpcId) {
    const idType = typeof rpcId === 'number' ? 'num' : 'str';
    return `${this._scopeKey(connectionId, generation, channel)}::${idType}::${String(rpcId).slice(0, 256)}`;
  }

  _trackPending(map, key, value) {
    if (map.size >= this.maxPendingRequests) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
        this.droppedCount++;
        this.dropReasons.max_pending_requests++;
      }
    }
    map.set(key, value);
  }

  _checkEarlyDrop(bypassCap, opts = {}) {
    if (!this.enabled) return true;
    if (bypassCap) return false;
    if (this.records.length < this.maxRecords) return false;

    this.saturated = true;
    this.droppedCount++;
    this.dropReasons.max_records++;
    if (!this.overflowNotified) {
      this.overflowNotified = true;
      this._emit({
        layer: 'raw',
        direction: 'lifecycle',
        messageKind: 'drop_overflow',
        correlation: {
          connectionId: 'conn-1',
          generation: opts.generation ? safeMetaToken(opts.generation, 'gen-redacted').value : null,
          ingressOrdinal: 0,
          channel: opts.channel === 'history_replay' ? 'history_replay' : 'live',
        },
        shape: {
          reason: 'max_records_exceeded',
          maxRecords: this.maxRecords,
        },
        reasonCode: 'drop_overflow',
        bypassCap: true,
      });
    }
    return true;
  }

  _normalizeConnId(rawConnId) {
    if (typeof rawConnId === 'string' && /^conn-\d+$/.test(rawConnId)) {
      return rawConnId;
    }
    return this.aliases.alias('conn', rawConnId) ?? 'conn-1';
  }

  _normalizeGeneration(rawGen) {
    if (rawGen === undefined || rawGen === null || rawGen === '') return null;
    const res = safeMetaToken(String(rawGen), 'gen-redacted');
    if (res.sanitized) this.metadataSanitizedCount++;
    return res.value;
  }

  _enqueueFileWrite(serializedLine) {
    if (!this.outputFile) return;
    const line = `${serializedLine}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (
      this._writeQueue.length >= this.maxQueuedWriteLines ||
      this._queuedWriteBytes + bytes > this.maxQueuedWriteBytes
    ) {
      this.droppedCount++;
      this.dropReasons.io_queue_overflow++;
      return;
    }
    this._writeQueue.push(line);
    this._queuedWriteBytes += bytes;
    if (!this._draining) {
      this._draining = true;
      this._drainPromise = this._drainFileQueue();
    }
  }

  async _drainFileQueue() {
    try {
      while (this._writeQueue.length > 0) {
        const batch = this._writeQueue.splice(0, 64).join('');
        this._queuedWriteBytes = Math.max(0, this._queuedWriteBytes - Buffer.byteLength(batch, 'utf8'));
        try {
          await fs.promises.appendFile(this.outputFile, batch, 'utf8');
        } catch {
          this.sinkErrorCount++;
          this.dropReasons.sink_error++;
        }
      }
    } finally {
      this._draining = false;
    }
  }

  async flush() {
    if (this._drainPromise) {
      await this._drainPromise;
    }
    while (this._writeQueue.length > 0) {
      this._draining = true;
      this._drainPromise = this._drainFileQueue();
      await this._drainPromise;
    }
  }

  _emit({
    layer,
    direction,
    messageKind,
    correlation,
    shape = {},
    unknownKeys = [],
    latencyMs = null,
    monotonicMs,
    observedAt,
    reasonCode,
    bypassCap = false,
  }) {
    if (this._checkEarlyDrop(bypassCap, correlation)) return null;

    const connId = this._normalizeConnId(correlation?.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(correlation?.generation);
    const ingressOrdinal =
      Number.isInteger(correlation?.ingressOrdinal) && correlation.ingressOrdinal >= 0
        ? correlation.ingressOrdinal
        : 0;
    const channel = correlation?.channel === 'history_replay' ? 'history_replay' : 'live';
    const nextSeq = this.seq + 1;

    const corrOut = {
      connectionId: connId,
      ...(generation ? { generation } : {}),
      ingressOrdinal,
      channel,
      ...(correlation?.rpcIdAlias ? { rpcIdAlias: correlation.rpcIdAlias } : {}),
      ...(correlation?.rpcIdType ? { rpcIdType: correlation.rpcIdType } : {}),
      ...(correlation?.sessionAlias ? { sessionAlias: correlation.sessionAlias } : {}),
      ...(correlation?.childAlias ? { childAlias: correlation.childAlias } : {}),
      ...(correlation?.toolAlias ? { toolAlias: correlation.toolAlias } : {}),
      ...(correlation?.taskAlias ? { taskAlias: correlation.taskAlias } : {}),
      ...(correlation?.workflowAlias ? { workflowAlias: correlation.workflowAlias } : {}),
      ...(correlation?.approvalAlias ? { approvalAlias: correlation.approvalAlias } : {}),
      ...(correlation?.turnAlias ? { turnAlias: correlation.turnAlias } : {}),
      ...(correlation?.activityAlias ? { activityAlias: correlation.activityAlias } : {}),
      ...(correlation?.workAlias ? { workAlias: correlation.workAlias } : {}),
      ...(correlation?.agentAlias ? { agentAlias: correlation.agentAlias } : {}),
      diagnosticCode:
        correlation?.diagnosticCode ??
        formatDiagnosticCode({
          captureId: this.captureId,
          scenario: this.scenario,
          connectionId: connId,
          generation: generation ?? 'gen-0',
          channel,
          ingressOrdinal,
          seq: nextSeq,
          layer,
          reasonCode: reasonCode ?? messageKind,
        }),
    };

    const record = {
      schemaVersion: OBSERVATORY_SCHEMA_VERSION,
      captureId: this.captureId,
      scenario: this.scenario,
      platform: this.platform,
      cliVersion: this.cliVersion,
      protocol: this.protocol,
      accountCategory: this.accountCategory,
      source: this.source,
      observedAt: Number.isInteger(observedAt) ? observedAt : this.nowEpoch(),
      producer: this.producer,
      seq: nextSeq,
      monotonicMs: this.currentMonotonicMs(monotonicMs),
      layer,
      direction,
      messageKind,
      ...(latencyMs !== null && latencyMs !== undefined ? { latencyMs } : {}),
      ...(this.provenance ? { provenance: this.provenance } : {}),
      correlation: corrOut,
      shape: shape && typeof shape === 'object' && !Array.isArray(shape) ? shape : {},
      ...(unknownKeys.length > 0 ? { unknownKeys } : {}),
      ...(this.droppedCount > 0 ? { droppedCount: this.droppedCount } : {}),
    };

    let serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxLineBytes) {
      this.truncatedCount++;
      this.dropReasons.line_truncated++;
      record.truncated = true;
      record.shape = {
        truncatedReason: 'max_line_bytes_exceeded',
        originalBytes: Buffer.byteLength(serialized, 'utf8'),
        maxLineBytes: this.maxLineBytes,
        shapeKeys: safeFieldNames(shape, 32),
      };
      serialized = JSON.stringify(record);
    }

    // Hard validate-before-emit trust boundary (schema + zero-leak scan on the ENTIRE record)
    const validation = validateCaptureRecord(record, nextSeq - 1);
    if (!validation.valid) {
      if (validation.leakFindings.length > 0) {
        this.leakBlockedCount++;
        this.dropReasons.leak_blocked++;
      } else {
        this.validationBlockedCount++;
        this.dropReasons.validation_blocked++;
      }
      this.droppedCount++;
      // Never deliver any invalid or leaking record to records[], sink, or file!
      return null;
    }

    this.seq = nextSeq;
    this.dropReasons.alias_overflow = this.aliases.overflowCount;
    this.records.push(record);

    // Non-blocking, fail-isolated delivery
    if (this.sink) {
      try {
        this.sink(record, serialized);
      } catch {
        this.sinkErrorCount++;
        this.dropReasons.sink_error++;
      }
    }
    if (this.outputFile) {
      this._enqueueFileWrite(serialized);
    }

    return record;
  }

  recordCaptureMeta(details = {}, opts = {}) {
    if (!this.enabled) return null;
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'capture_meta',
      correlation: {
        connectionId: opts.connectionId ?? 'conn-1',
        generation: opts.generation,
        ingressOrdinal: 0,
        channel: opts.channel ?? 'live',
      },
      shape: {
        profileSource: safeLabel(details.profileSource),
        mode: safeLabel(details.mode),
        requestedProtocol: details.requestedProtocol === 1 || details.requestedProtocol === 2 ? details.requestedProtocol : undefined,
        redactionPolicy: 'allowlist_v1',
        ...(details.notes ? { notes: safeLabel(details.notes) } : {}),
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: 'capture_start',
      bypassCap: true,
    });
  }

  recordCliCatalog(details = {}, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'cli_catalog',
      correlation: {
        connectionId: opts.connectionId ?? 'conn-1',
        generation: opts.generation,
        ingressOrdinal: 0,
        channel: opts.channel ?? 'live',
      },
      shape: {
        command: safeLabel(details.command),
        exitCode: typeof details.exitCode === 'number' ? details.exitCode : null,
        timeout: Boolean(details.timeout),
        authorizationPrompt: Boolean(details.authorizationPrompt),
        stdoutLines: Number.isInteger(details.stdoutLines) ? details.stdoutLines : 0,
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: 'cli_catalog',
    });
  }

  recordOutboundFrame(frame, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    const ms = this.currentMonotonicMs(opts.monotonicMs);
    const reconstructed = reconstructOutboundFrame(frame, this.aliases);

    let latencyMs = null;
    if (reconstructed.messageKind === 'rpc_request' && frame?.id !== undefined && frame?.id !== null) {
      this._trackPending(this.pendingClientRequests, this._pendingKey(connId, generation, channel, frame.id), {
        method: frame.method,
        sentAtMs: ms,
      });
    } else if (
      (reconstructed.messageKind === 'rpc_response' || reconstructed.messageKind === 'rpc_error') &&
      frame?.id !== undefined &&
      frame?.id !== null
    ) {
      const key = this._pendingKey(connId, generation, channel, frame.id);
      const pending = this.pendingServerRequests.get(key);
      if (pending) {
        this.pendingServerRequests.delete(key);
        latencyMs = Math.max(0, Math.round((ms - pending.receivedAtMs) * 100) / 100);
      }
    }

    return this._emit({
      layer: 'raw',
      direction: 'outbound',
      messageKind: reconstructed.messageKind,
      latencyMs,
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel,
        rpcIdAlias: reconstructed.rpcIdAlias,
        rpcIdType: reconstructed.rpcIdType,
        sessionAlias: reconstructed.sessionAlias,
        approvalAlias:
          reconstructed.messageKind === 'rpc_response' && frame?.id !== undefined
            ? this.aliases.alias('req', frame.id)
            : null,
        turnAlias: opts.turnId ? this.aliases.alias('turn', opts.turnId) : null,
      },
      shape: reconstructed.shape,
      unknownKeys: reconstructed.unknownKeys,
      monotonicMs: ms,
      observedAt: opts.observedAt,
      reasonCode: reconstructed.shape.method ?? reconstructed.messageKind,
    });
  }

  recordInboundFrame(frame, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    const ms = this.currentMonotonicMs(opts.monotonicMs);
    const ingressOrdinal = Number.isInteger(opts.ingressOrdinal)
      ? opts.ingressOrdinal
      : this.nextIngressOrdinal(connId, generation, channel);

    let requestMethod;
    let latencyMs = null;
    const hasId = frame && frame.id !== undefined && frame.id !== null;
    const hasMethod = frame && typeof frame.method === 'string';

    if (hasId && !hasMethod) {
      const key = this._pendingKey(connId, generation, channel, frame.id);
      const pending = this.pendingClientRequests.get(key);
      if (pending) {
        this.pendingClientRequests.delete(key);
        requestMethod = pending.method;
        latencyMs = Math.max(0, Math.round((ms - pending.sentAtMs) * 100) / 100);
      }
    } else if (hasId && hasMethod) {
      this._trackPending(this.pendingServerRequests, this._pendingKey(connId, generation, channel, frame.id), {
        method: frame.method,
        receivedAtMs: ms,
      });
    }

    const reconstructed = reconstructInboundFrame(frame, this.aliases, { requestMethod });
    if (reconstructed.shape.agentVersion) this.setCliVersion(reconstructed.shape.agentVersion);
    if (reconstructed.shape.protocolVersion === 1 || reconstructed.shape.protocolVersion === 2) {
      this.setProtocol(reconstructed.shape.protocolVersion);
    }

    return this._emit({
      layer: 'raw',
      direction: 'inbound',
      messageKind: reconstructed.messageKind,
      latencyMs,
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal,
        channel,
        ...reconstructed.correlation,
      },
      shape: reconstructed.shape,
      unknownKeys: reconstructed.unknownKeys,
      monotonicMs: ms,
      observedAt: opts.observedAt,
      reasonCode: reconstructed.shape.updateType ?? reconstructed.shape.method ?? reconstructed.messageKind,
    });
  }

  recordMalformedLine(rawLine, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    const ingressOrdinal = Number.isInteger(opts.ingressOrdinal)
      ? opts.ingressOrdinal
      : this.nextIngressOrdinal(connId, generation, channel);
    const rawStr = typeof rawLine === 'string' ? rawLine : String(rawLine ?? '');
    const { text: bounded, truncated } = clampRawText(rawStr);
    return this._emit({
      layer: 'raw',
      direction: 'inbound',
      messageKind: 'malformed_line',
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal,
        channel,
      },
      shape: {
        stream: opts.stream === 'stderr' ? 'stderr' : 'stdout',
        byteLength: Buffer.byteLength(rawStr, 'utf8'),
        startsWithBrace: bounded.trim().startsWith('{'),
        ...(truncated ? { lineTruncated: true } : {}),
        shapeHash: this.aliases.shapeHash(bounded),
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: 'malformed_line',
    });
  }

  recordStderrLine(line, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    const classified = classifyStderrLine(line, this.aliases);
    return this._emit({
      layer: 'raw',
      direction: 'stderr',
      messageKind: 'stderr_classified',
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal: 0,
        channel,
      },
      shape: classified,
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: `stderr_${classified.category}`,
    });
  }

  recordTimeout(details = {}, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'timeout',
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel,
        rpcIdAlias: details.rpcId !== undefined ? this.aliases.alias('rpc', details.rpcId) : null,
        rpcIdType: details.rpcId !== undefined ? (typeof details.rpcId === 'number' ? 'number' : 'string') : null,
        sessionAlias: details.sessionId ? this.aliases.alias('sess', details.sessionId) : null,
      },
      shape: {
        method: safeLabel(details.method) ?? 'unknown',
        timeoutMs: typeof details.timeoutMs === 'number' ? details.timeoutMs : null,
        scope: safeLabel(details.scope) ?? 'rpc_request',
        forced: Boolean(details.forced),
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: 'timeout',
    });
  }

  recordProcessExit(details = {}, opts = {}) {
    if (!this.enabled) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'process_exit',
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal: 0,
        channel,
      },
      shape: {
        exitCode: typeof details.exitCode === 'number' ? details.exitCode : null,
        signal: safeLabel(details.signal) ?? null,
        reason: safeLabel(details.reason) ?? 'process_exit',
        pendingClientRequests: this.pendingClientRequests.size,
        pendingServerRequests: this.pendingServerRequests.size,
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: details.exitCode && details.exitCode !== 0 ? `exit_code_${details.exitCode}` : 'process_exit',
      bypassCap: Boolean(opts.bypassCap),
    });
  }

  recordNormalizedEvent(event, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    const ev = event && typeof event === 'object' ? event : {};
    const turnIdRaw = typeof ev.turnId === 'string' ? ev.turnId : opts.turnId;
    const isPlaceholderTurn = turnIdRaw === 'turn_bg' || turnIdRaw === 'turn_unknown';
    const turnAlias = turnIdRaw ? (isPlaceholderTurn ? turnIdRaw : this.aliases.alias('turn', turnIdRaw)) : null;

    const nativeReqId = ev.nativeRequestId ?? opts.nativeRequestId;
    const rpcIdFromNativeReq =
      typeof nativeReqId === 'string' && nativeReqId.startsWith('acp_req_')
        ? nativeReqId.slice('acp_req_'.length)
        : nativeReqId;

    return this._emit({
      layer: 'normalized',
      direction: 'internal',
      messageKind: 'adapter_normalized',
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel,
        sessionAlias: opts.sessionId ? this.aliases.alias('sess', opts.sessionId) : null,
        childAlias: opts.childSessionId ? this.aliases.alias('child', opts.childSessionId) : null,
        toolAlias: ev.toolCallId ? this.aliases.alias('tool', ev.toolCallId) : null,
        taskAlias: opts.taskId ? this.aliases.alias('task', opts.taskId) : null,
        approvalAlias: rpcIdFromNativeReq ? this.aliases.alias('req', rpcIdFromNativeReq) : null,
        turnAlias,
        activityAlias: opts.activityId ? this.aliases.alias('act', opts.activityId) : null,
        workAlias: opts.workId ? this.aliases.alias('work', opts.workId) : null,
        agentAlias: opts.agentId ? this.aliases.alias('agent', opts.agentId) : null,
      },
      shape: {
        eventType: safeLabel(ev.type) ?? 'unknown',
        ...(isPlaceholderTurn ? { turnSlot: turnIdRaw } : {}),
        ...(ev.blockType ? { blockType: safeLabel(ev.blockType) } : {}),
        ...(ev.status ? { status: safeLabel(ev.status) } : {}),
        ...(ev.stopReason ? { stopReason: safeLabel(ev.stopReason) } : {}),
        ...(ev.kind ? { requestKind: safeLabel(ev.kind) } : {}),
        ...(typeof opts.backgroundLease === 'boolean' ? { backgroundLease: opts.backgroundLease } : {}),
        ...(typeof ev.text === 'string' ? { textCharCount: ev.text.length } : {}),
        ...(ev.text ? { testMarkers: this.aliases.correlateMarkerText(ev.text) ?? undefined } : {}),
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: isPlaceholderTurn ? `placeholder_${turnIdRaw}` : (safeLabel(ev.type) ?? 'normalized'),
    });
  }

  recordNativeCanonicalEvent(event, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    const ev = event && typeof event === 'object' ? event : {};
    return this._emit({
      layer: 'native_canonical',
      direction: 'internal',
      messageKind: 'native_canonical',
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel,
        sessionAlias: opts.sessionId ? this.aliases.alias('sess', opts.sessionId) : null,
        childAlias: opts.childSessionId ? this.aliases.alias('child', opts.childSessionId) : null,
        toolAlias: opts.toolCallId ? this.aliases.alias('tool', opts.toolCallId) : null,
        taskAlias: opts.taskId ? this.aliases.alias('task', opts.taskId) : null,
        workflowAlias: opts.workflowId ? this.aliases.alias('wf', opts.workflowId) : null,
        approvalAlias: opts.approvalId ? this.aliases.alias('req', opts.approvalId) : null,
        turnAlias: opts.turnId ? this.aliases.alias('turn', opts.turnId) : null,
        activityAlias: opts.activityId ? this.aliases.alias('act', opts.activityId) : null,
        workAlias: opts.workId ? this.aliases.alias('work', opts.workId) : null,
        agentAlias: opts.agentId ? this.aliases.alias('agent', opts.agentId) : null,
      },
      shape: {
        canonicalType: safeLabel(ev.type) ?? 'unknown',
        nativeSeq: Number.isInteger(ev.seq) ? ev.seq : undefined,
        hmAnchorSeq: Number.isInteger(ev.hmAnchorSeq) ? ev.hmAnchorSeq : undefined,
        state: safeLabel(ev.state),
        blocking: safeLabel(ev.blocking),
        receiptState: safeLabel(ev.receiptState),
        settlementDecision: safeLabel(ev.settlementDecision),
        leaseReasons: Array.isArray(ev.leaseReasons)
          ? ev.leaseReasons.map((r) => safeLabel(r)).filter(Boolean).slice(0, 16)
          : undefined,
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: safeLabel(ev.type) ?? 'native_canonical',
    });
  }

  recordUiProjection(projection, opts = {}) {
    if (this._checkEarlyDrop(false, opts)) return null;
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const generation = this._normalizeGeneration(opts.generation);
    const channel = opts.channel === 'history_replay' ? 'history_replay' : 'live';
    const p = projection && typeof projection === 'object' ? projection : {};
    return this._emit({
      layer: 'ui',
      direction: 'internal',
      messageKind: 'ui_projection',
      correlation: {
        connectionId: connId,
        generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel,
        sessionAlias: opts.sessionId ? this.aliases.alias('sess', opts.sessionId) : null,
        childAlias: opts.childSessionId ? this.aliases.alias('child', opts.childSessionId) : null,
        toolAlias: opts.toolCallId ? this.aliases.alias('tool', opts.toolCallId) : null,
        taskAlias: opts.taskId ? this.aliases.alias('task', opts.taskId) : null,
        workflowAlias: opts.workflowId ? this.aliases.alias('wf', opts.workflowId) : null,
        approvalAlias: opts.approvalId ? this.aliases.alias('req', opts.approvalId) : null,
        turnAlias: opts.turnId ? this.aliases.alias('turn', opts.turnId) : null,
        activityAlias: opts.activityId ? this.aliases.alias('act', opts.activityId) : null,
        workAlias: opts.workId ? this.aliases.alias('work', opts.workId) : null,
        agentAlias: opts.agentId ? this.aliases.alias('agent', opts.agentId) : null,
      },
      shape: {
        uiStatus: safeLabel(p.status),
        asOfSeq: Number.isInteger(p.asOfSeq) ? p.asOfSeq : undefined,
        activeWorkCount: Number.isInteger(p.activeWorkCount) ? p.activeWorkCount : undefined,
        pendingRequestCount: Number.isInteger(p.pendingRequestCount) ? p.pendingRequestCount : undefined,
        visibleBlockType: safeLabel(p.visibleBlockType),
        uiErrorCode: safeLabel(p.errorCode),
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: safeLabel(p.errorCode) ?? safeLabel(p.status) ?? 'ui_projection',
    });
  }

  recordCaptureEnd(details = {}, opts = {}) {
    if (!this.enabled) return null;
    this.dropReasons.alias_overflow = this.aliases.overflowCount;
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'capture_end',
      correlation: {
        connectionId: opts.connectionId ?? 'conn-1',
        generation: opts.generation,
        ingressOrdinal: 0,
        channel: opts.channel ?? 'live',
      },
      shape: {
        reason: safeLabel(details.reason) ?? 'completed',
        outcome: safeLabel(details.outcome) ?? undefined,
        negotiatedProtocol: this.protocol,
        promptSent: Boolean(details.promptSent),
        stderrBytes: Number.isInteger(details.stderrBytes) ? details.stderrBytes : 0,
        totalRecordsBeforeEnd: this.records.length,
        droppedCount: this.droppedCount,
        truncatedCount: this.truncatedCount,
        sinkErrorCount: this.sinkErrorCount,
        leakBlockedCount: this.leakBlockedCount,
        validationBlockedCount: this.validationBlockedCount,
        dropReasons: { ...this.dropReasons },
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: safeLabel(details.reason) ?? 'capture_end',
      bypassCap: true,
    });
  }

  toNdjson() {
    return `${this.records.map((r) => JSON.stringify(r)).join('\n')}\n`;
  }

  getStats() {
    this.dropReasons.alias_overflow = this.aliases.overflowCount;
    return {
      enabled: this.enabled,
      captureId: this.captureId,
      recordCount: this.records.length,
      allocatedAliases: this.aliases.totalAllocated,
      pendingClientRequests: this.pendingClientRequests.size,
      pendingServerRequests: this.pendingServerRequests.size,
      droppedCount: this.droppedCount,
      truncatedCount: this.truncatedCount,
      sinkErrorCount: this.sinkErrorCount,
      leakBlockedCount: this.leakBlockedCount,
      validationBlockedCount: this.validationBlockedCount,
      metadataSanitizedCount: this.metadataSanitizedCount,
      dropReasons: { ...this.dropReasons },
    };
  }
}

export function createDaemonTapCallbacks(recorder) {
  if (!recorder || !recorder.enabled) {
    return {
      enabled: false,
      onOutboundFrame: () => {},
      onInboundFrame: () => {},
      onMalformedLine: () => {},
      onStderrLine: () => {},
      onTimeout: () => {},
      onProcessExit: () => {},
      onNormalizedEvent: () => {},
      onNativeCanonicalEvent: () => {},
      onUiProjection: () => {},
    };
  }

  const safeRun = (fn) => {
    try {
      fn();
    } catch {
      recorder.sinkErrorCount++;
      recorder.dropReasons.sink_error++;
    }
  };

  return {
    enabled: true,
    onOutboundFrame: ({ connectionId, generation, ingressOrdinal, channel, frame, turnId, monotonicMs }) =>
      safeRun(() =>
        recorder.recordOutboundFrame(frame, { connectionId, generation, ingressOrdinal, channel, turnId, monotonicMs }),
      ),
    onInboundFrame: ({ connectionId, generation, ingressOrdinal, channel, frame, monotonicMs }) =>
      safeRun(() =>
        recorder.recordInboundFrame(frame, { connectionId, generation, ingressOrdinal, channel, monotonicMs }),
      ),
    onMalformedLine: ({ connectionId, generation, ingressOrdinal, channel, line, stream, monotonicMs }) =>
      safeRun(() =>
        recorder.recordMalformedLine(line, { connectionId, generation, ingressOrdinal, channel, stream, monotonicMs }),
      ),
    onStderrLine: ({ connectionId, generation, channel, line, monotonicMs }) =>
      safeRun(() => recorder.recordStderrLine(line, { connectionId, generation, channel, monotonicMs })),
    onTimeout: ({ connectionId, generation, channel, method, rpcId, sessionId, timeoutMs, scope, forced, monotonicMs }) =>
      safeRun(() =>
        recorder.recordTimeout(
          { method, rpcId, sessionId, timeoutMs, scope, forced },
          { connectionId, generation, channel, monotonicMs },
        ),
      ),
    onProcessExit: ({ connectionId, generation, channel, exitCode, signal, reason, monotonicMs }) =>
      safeRun(() =>
        recorder.recordProcessExit({ exitCode, signal, reason }, { connectionId, generation, channel, monotonicMs }),
      ),
    onNormalizedEvent: ({ connectionId, generation, ingressOrdinal, channel, event, aliases, backgroundLease, monotonicMs }) =>
      safeRun(() =>
        recorder.recordNormalizedEvent(event, {
          connectionId,
          generation,
          ingressOrdinal,
          channel,
          backgroundLease,
          monotonicMs,
          ...(aliases ?? {}),
        }),
      ),
    onNativeCanonicalEvent: ({ connectionId, generation, ingressOrdinal, channel, event, aliases, monotonicMs }) =>
      safeRun(() =>
        recorder.recordNativeCanonicalEvent(event, {
          connectionId,
          generation,
          ingressOrdinal,
          channel,
          monotonicMs,
          ...(aliases ?? {}),
        }),
      ),
    onUiProjection: ({ connectionId, generation, ingressOrdinal, channel, projection, aliases, monotonicMs }) =>
      safeRun(() =>
        recorder.recordUiProjection(projection, {
          connectionId,
          generation,
          ingressOrdinal,
          channel,
          monotonicMs,
          ...(aliases ?? {}),
        }),
      ),
  };
}
