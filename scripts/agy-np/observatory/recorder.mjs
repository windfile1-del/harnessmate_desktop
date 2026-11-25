import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  AliasTable,
  classifyStderrLine,
  reconstructInboundFrame,
  reconstructOutboundFrame,
  safeFieldNames,
  safeLabel,
  scanRecordForLeaks,
} from './sanitizer.mjs';
import { formatDiagnosticCode } from './four-layer.mjs';

export const OBSERVATORY_SCHEMA_VERSION = 1;

export class ProtocolObservatoryRecorder {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.captureId =
      options.captureId ??
      `cap-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
    this.scenario = options.scenario ?? 'custom';
    this.platform = options.platform ?? (['win32', 'darwin', 'linux'].includes(process.platform) ? process.platform : 'unknown');
    this.cliVersion = options.cliVersion ?? null;
    this.protocol = options.protocol ?? null;
    this.accountCategory = options.accountCategory ?? 'none';
    this.source = options.source ?? 'synthetic';
    this.producer = options.producer ?? 'observatory_cli';
    this.provenance = options.provenance ?? undefined;

    this.maxRecords = options.maxRecords ?? 5_000;
    this.maxLineBytes = options.maxLineBytes ?? 16_384;
    this.maxPendingRequests = options.maxPendingRequests ?? 512;
    this.strictLeakGuard = options.strictLeakGuard !== false;

    this.aliases = options.aliases ?? new AliasTable({ salt: options.salt, testMarkers: options.testMarkers });
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
    this.overflowNotified = false;

    this.ingressOrdinals = new Map();
    this.pendingClientRequests = new Map();
    this.pendingServerRequests = new Map();
  }

  setCliVersion(version) {
    this.cliVersion = safeLabel(version) ?? this.cliVersion;
  }

  setProtocol(protocol) {
    if (protocol === 1 || protocol === 2) {
      this.protocol = protocol;
    }
  }

  nextIngressOrdinal(connectionId = 'conn-1') {
    const cur = this.ingressOrdinals.get(connectionId) ?? 0;
    const next = cur + 1;
    this.ingressOrdinals.set(connectionId, next);
    return next;
  }

  currentMonotonicMs(overrideMs) {
    if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs >= 0) {
      return Math.round(overrideMs * 100) / 100;
    }
    return Math.max(0, Math.round((this.nowMonotonic() - this.startMonotonic) * 100) / 100);
  }

  _pendingKey(connectionId, rpcId) {
    const idType = typeof rpcId === 'number' ? 'num' : 'str';
    return `${connectionId}::${idType}::${String(rpcId)}`;
  }

  _trackPending(map, key, value) {
    if (map.size >= this.maxPendingRequests) {
      // Evict oldest entry to keep memory strictly bounded
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
        this.droppedCount++;
      }
    }
    map.set(key, value);
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
    if (!this.enabled) return null;

    if (!bypassCap && this.records.length >= this.maxRecords) {
      this.droppedCount++;
      if (!this.overflowNotified) {
        this.overflowNotified = true;
        this._emit({
          layer: 'raw',
          direction: 'lifecycle',
          messageKind: 'drop_overflow',
          correlation: {
            connectionId: correlation?.connectionId ?? 'conn-1',
            ingressOrdinal: 0,
            channel: 'live',
          },
          shape: {
            reason: 'max_records_exceeded',
            maxRecords: this.maxRecords,
          },
          reasonCode: 'drop_overflow',
          bypassCap: true,
        });
      }
      return null;
    }

    const connId = this._normalizeConnId(correlation?.connectionId ?? 'conn-1');
    const ingressOrdinal = Number.isInteger(correlation?.ingressOrdinal) && correlation.ingressOrdinal >= 0
      ? correlation.ingressOrdinal
      : 0;
    const channel = correlation?.channel === 'history_replay' ? 'history_replay' : 'live';

    const corrOut = {
      connectionId: connId,
      ingressOrdinal,
      channel,
      ...(correlation?.generation ? { generation: correlation.generation } : {}),
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
          ingressOrdinal,
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
      seq: ++this.seq,
      monotonicMs: this.currentMonotonicMs(monotonicMs),
      layer,
      direction,
      messageKind,
      ...(latencyMs !== null && latencyMs !== undefined ? { latencyMs } : {}),
      ...(this.provenance ? { provenance: this.provenance } : {}),
      correlation: corrOut,
      shape,
      ...(unknownKeys.length > 0 ? { unknownKeys } : {}),
      ...(this.droppedCount > 0 ? { droppedCount: this.droppedCount } : {}),
    };

    let serialized = JSON.stringify(record);
    if (Buffer.byteLength(serialized, 'utf8') > this.maxLineBytes) {
      this.truncatedCount++;
      record.truncated = true;
      record.shape = {
        truncatedReason: 'max_line_bytes_exceeded',
        originalBytes: Buffer.byteLength(serialized, 'utf8'),
        maxLineBytes: this.maxLineBytes,
        shapeKeys: safeFieldNames(shape, 32),
      };
      serialized = JSON.stringify(record);
    }

    if (this.strictLeakGuard) {
      const leaks = scanRecordForLeaks(record);
      if (leaks.length > 0) {
        this.leakBlockedCount++;
        record.shape = {
          redactedByLeakGuard: true,
          leakCategories: leaks,
        };
        record.correlation.diagnosticCode = formatDiagnosticCode({
          captureId: this.captureId,
          scenario: this.scenario,
          connectionId: connId,
          ingressOrdinal,
          layer,
          reasonCode: 'leak_guard_redacted',
        });
        serialized = JSON.stringify(record);
      }
    }

    this.records.push(record);

    // Non-blocking, fail-isolated sink delivery so observatory never impacts production business logic
    try {
      if (this.sink) {
        this.sink(record, serialized);
      }
      if (this.outputFile) {
        fs.appendFileSync(this.outputFile, `${serialized}\n`, 'utf8');
      }
    } catch {
      this.sinkErrorCount++;
    }

    return record;
  }

  _normalizeConnId(rawConnId) {
    if (typeof rawConnId === 'string' && /^conn-\d+$/.test(rawConnId)) {
      return rawConnId;
    }
    return this.aliases.alias('conn', rawConnId) ?? 'conn-1';
  }

  recordCaptureMeta(details = {}, opts = {}) {
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'capture_meta',
      correlation: {
        connectionId: opts.connectionId ?? 'conn-1',
        generation: opts.generation,
        ingressOrdinal: 0,
        channel: 'live',
      },
      shape: {
        profileSource: safeLabel(details.profileSource),
        mode: safeLabel(details.mode),
        requestedProtocol: details.requestedProtocol ?? undefined,
        redactionPolicy: 'allowlist_v1',
        ...(details.notes ? { notes: safeLabel(details.notes) } : {}),
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: 'capture_start',
    });
  }

  recordCliCatalog(details = {}, opts = {}) {
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'cli_catalog',
      correlation: {
        connectionId: opts.connectionId ?? 'conn-1',
        ingressOrdinal: 0,
        channel: 'live',
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
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const ms = this.currentMonotonicMs(opts.monotonicMs);
    const reconstructed = reconstructOutboundFrame(frame, this.aliases);

    let latencyMs = null;
    if (reconstructed.messageKind === 'rpc_request' && frame?.id !== undefined && frame?.id !== null) {
      this._trackPending(this.pendingClientRequests, this._pendingKey(connId, frame.id), {
        method: frame.method,
        sentAtMs: ms,
      });
    } else if (
      (reconstructed.messageKind === 'rpc_response' || reconstructed.messageKind === 'rpc_error') &&
      frame?.id !== undefined &&
      frame?.id !== null
    ) {
      const key = this._pendingKey(connId, frame.id);
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
        generation: opts.generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel: opts.channel ?? 'live',
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
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const ms = this.currentMonotonicMs(opts.monotonicMs);
    const ingressOrdinal = Number.isInteger(opts.ingressOrdinal)
      ? opts.ingressOrdinal
      : this.nextIngressOrdinal(connId);

    let requestMethod;
    let latencyMs = null;
    const hasId = frame && frame.id !== undefined && frame.id !== null;
    const hasMethod = frame && typeof frame.method === 'string';

    if (hasId && !hasMethod) {
      const key = this._pendingKey(connId, frame.id);
      const pending = this.pendingClientRequests.get(key);
      if (pending) {
        this.pendingClientRequests.delete(key);
        requestMethod = pending.method;
        latencyMs = Math.max(0, Math.round((ms - pending.sentAtMs) * 100) / 100);
      }
    } else if (hasId && hasMethod) {
      this._trackPending(this.pendingServerRequests, this._pendingKey(connId, frame.id), {
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
        generation: opts.generation,
        ingressOrdinal,
        channel: opts.channel ?? 'live',
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
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const ingressOrdinal = Number.isInteger(opts.ingressOrdinal)
      ? opts.ingressOrdinal
      : this.nextIngressOrdinal(connId);
    const text = String(rawLine ?? '');
    return this._emit({
      layer: 'raw',
      direction: 'inbound',
      messageKind: 'malformed_line',
      correlation: {
        connectionId: connId,
        generation: opts.generation,
        ingressOrdinal,
        channel: opts.channel ?? 'live',
      },
      shape: {
        stream: opts.stream === 'stderr' ? 'stderr' : 'stdout',
        byteLength: Buffer.byteLength(text, 'utf8'),
        startsWithBrace: text.trim().startsWith('{'),
        shapeHash: this.aliases.shapeHash(text),
      },
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: 'malformed_line',
    });
  }

  recordStderrLine(line, opts = {}) {
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const classified = classifyStderrLine(line, this.aliases);
    return this._emit({
      layer: 'raw',
      direction: 'stderr',
      messageKind: 'stderr_classified',
      correlation: {
        connectionId: connId,
        generation: opts.generation,
        ingressOrdinal: 0,
        channel: opts.channel ?? 'live',
      },
      shape: classified,
      monotonicMs: opts.monotonicMs,
      observedAt: opts.observedAt,
      reasonCode: `stderr_${classified.category}`,
    });
  }

  recordTimeout(details = {}, opts = {}) {
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'timeout',
      correlation: {
        connectionId: connId,
        generation: opts.generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel: opts.channel ?? 'live',
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
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'process_exit',
      correlation: {
        connectionId: connId,
        generation: opts.generation,
        ingressOrdinal: 0,
        channel: opts.channel ?? 'live',
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
    });
  }

  recordNormalizedEvent(event, opts = {}) {
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const ev = event && typeof event === 'object' ? event : {};
    const turnIdRaw = typeof ev.turnId === 'string' ? ev.turnId : opts.turnId;
    const isPlaceholderTurn = turnIdRaw === 'turn_bg' || turnIdRaw === 'turn_unknown';
    const turnAlias = turnIdRaw
      ? isPlaceholderTurn
        ? turnIdRaw
        : this.aliases.alias('turn', turnIdRaw)
      : null;

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
        generation: opts.generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel: opts.channel ?? 'live',
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
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const ev = event && typeof event === 'object' ? event : {};
    return this._emit({
      layer: 'native_canonical',
      direction: 'internal',
      messageKind: 'native_canonical',
      correlation: {
        connectionId: connId,
        generation: opts.generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel: opts.channel ?? 'live',
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
    const connId = this._normalizeConnId(opts.connectionId ?? 'conn-1');
    const p = projection && typeof projection === 'object' ? projection : {};
    return this._emit({
      layer: 'ui',
      direction: 'internal',
      messageKind: 'ui_projection',
      correlation: {
        connectionId: connId,
        generation: opts.generation,
        ingressOrdinal: Number.isInteger(opts.ingressOrdinal) ? opts.ingressOrdinal : 0,
        channel: opts.channel ?? 'live',
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
    return this._emit({
      layer: 'raw',
      direction: 'lifecycle',
      messageKind: 'capture_end',
      correlation: {
        connectionId: opts.connectionId ?? 'conn-1',
        generation: opts.generation,
        ingressOrdinal: 0,
        channel: 'live',
      },
      shape: {
        reason: safeLabel(details.reason) ?? 'completed',
        promptSent: Boolean(details.promptSent),
        stderrBytes: Number.isInteger(details.stderrBytes) ? details.stderrBytes : 0,
        totalRecordsBeforeEnd: this.records.length,
        droppedCount: this.droppedCount,
        truncatedCount: this.truncatedCount,
        sinkErrorCount: this.sinkErrorCount,
        leakBlockedCount: this.leakBlockedCount,
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
    return {
      enabled: this.enabled,
      captureId: this.captureId,
      recordCount: this.records.length,
      droppedCount: this.droppedCount,
      truncatedCount: this.truncatedCount,
      sinkErrorCount: this.sinkErrorCount,
      leakBlockedCount: this.leakBlockedCount,
    };
  }
}

/**
 * Callback seam proving the opt-in daemon tap contract proposed to NP-02.
 * All callbacks are synchronous, bounded, redacted, and never feed back into production business events.
 */
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
    onStderrLine: ({ connectionId, generation, line, monotonicMs }) =>
      safeRun(() => recorder.recordStderrLine(line, { connectionId, generation, monotonicMs })),
    onTimeout: ({ connectionId, generation, method, rpcId, sessionId, timeoutMs, scope, forced, monotonicMs }) =>
      safeRun(() =>
        recorder.recordTimeout(
          { method, rpcId, sessionId, timeoutMs, scope, forced },
          { connectionId, generation, monotonicMs },
        ),
      ),
    onProcessExit: ({ connectionId, generation, exitCode, signal, reason, monotonicMs }) =>
      safeRun(() =>
        recorder.recordProcessExit({ exitCode, signal, reason }, { connectionId, generation, monotonicMs }),
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
