import { safeLabel } from './sanitizer.mjs';

const REASON_SAFE_RE = /^[a-zA-Z0-9._-]{1,48}$/;

function sanitizeToken(value, fallback = 'none', maxLen = 36) {
  if (value === undefined || value === null || value === '') return fallback;
  const cleaned = String(value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, maxLen);
  return cleaned && REASON_SAFE_RE.test(cleaned) ? cleaned : fallback;
}

/**
 * Generates a unique, copy-safe, PII-free diagnostic code consumable by NP-03 UI and issue reports.
 * Format:
 *   AGY-DIAG-v1:<captureId>:<scenario>:<connectionId>:<generation>:<channel>:<ingressOrdinal>:s<seq>:<layer>:<reasonCode>
 */
export function formatDiagnosticCode({
  captureId,
  scenario,
  connectionId,
  generation = 'gen-0',
  channel = 'live',
  ingressOrdinal = 0,
  seq = 0,
  layer = 'raw',
  reasonCode = 'observed',
}) {
  const parts = [
    'AGY-DIAG-v1',
    sanitizeToken(captureId, 'cap', 36),
    sanitizeToken(scenario, 'scn', 24),
    sanitizeToken(connectionId, 'conn-1', 20),
    sanitizeToken(generation ?? 'gen-0', 'gen-0', 20),
    channel === 'history_replay' ? 'replay' : 'live',
    String(Number.isInteger(ingressOrdinal) && ingressOrdinal >= 0 ? ingressOrdinal : 0),
    `s${Number.isInteger(seq) && seq >= 0 ? seq : 0}`,
    sanitizeToken(layer, 'raw', 16),
    sanitizeToken(reasonCode, 'observed', 32),
  ];
  return parts.join(':');
}

export function parseDiagnosticCode(code) {
  if (typeof code !== 'string') return null;
  const parts = code.split(':');
  if (parts.length !== 10 || parts[0] !== 'AGY-DIAG-v1') return null;
  const ordinal = Number(parts[6]);
  const seqMatch = /^s(\d+)$/.exec(parts[7]);
  if (!Number.isInteger(ordinal) || ordinal < 0 || !seqMatch) return null;
  return {
    version: 'v1',
    captureId: parts[1],
    scenario: parts[2],
    connectionId: parts[3],
    generation: parts[4],
    channel: parts[5] === 'replay' ? 'history_replay' : 'live',
    ingressOrdinal: ordinal,
    seq: Number(seqMatch[1]),
    layer: parts[8],
    reasonCode: parts[9],
  };
}

function summarizeLayerRecord(rec) {
  if (!rec) return null;
  const shape = rec.shape ?? {};
  const parts = [rec.messageKind];
  if (rec.direction === 'outbound' && rec.messageKind === 'rpc_response') {
    parts.push('outbound_reply');
  }
  if (shape.method) parts.push(shape.method);
  if (shape.responseForMethod) parts.push(`reply:${shape.responseForMethod}`);
  if (shape.updateType) parts.push(shape.updateType);
  if (shape.eventType) parts.push(shape.eventType);
  if (shape.canonicalType) parts.push(shape.canonicalType);
  if (shape.uiStatus) parts.push(`ui:${shape.uiStatus}`);
  if (shape.status) parts.push(`status=${shape.status}`);
  if (shape.stopReason) parts.push(`stop=${shape.stopReason}`);
  if (shape.permissionOutcome) parts.push(`outcome=${shape.permissionOutcome}`);
  if (shape.category) parts.push(`cat=${shape.category}`);
  if (shape.reason) parts.push(`reason=${shape.reason}`);
  if (shape.turnSlot) parts.push(`slot=${shape.turnSlot}`);
  return {
    seq: rec.seq,
    monotonicMs: rec.monotonicMs,
    direction: rec.direction,
    messageKind: rec.messageKind,
    latencyMs: rec.latencyMs ?? null,
    label: parts.join(' · '),
    diagnosticCode: rec.correlation?.diagnosticCode ?? null,
  };
}

function combineLayerEvents(events) {
  if (!events || events.length === 0) return null;
  const primary = events[0];
  if (events.length === 1) {
    return { ...primary, eventCount: 1, events };
  }
  return {
    ...primary,
    eventCount: events.length,
    label: events.map((e) => e.label).join(' ; '),
    diagnosticCode: events[events.length - 1].diagnosticCode ?? primary.diagnosticCode,
    events,
  };
}

function classifyRowAttribution(row, scopeContext) {
  const rawEvents = row.layerEvents.raw;
  const normEvents = row.layerEvents.normalized;
  const canonEvents = row.layerEvents.native_canonical;
  const uiEvents = row.layerEvents.ui;

  const hasRaw = rawEvents.length > 0;
  const hasNorm = normEvents.length > 0;
  const hasCanon = canonEvents.length > 0;
  const hasUi = uiEvents.length > 0;

  if (!hasRaw && (hasNorm || hasCanon || hasUi)) {
    return { status: 'synthetic_or_local_only', reasonCode: 'no_raw_frame' };
  }
  if (rawEvents.some((e) => e.messageKind === 'malformed_line')) {
    return { status: 'transport_malformed', reasonCode: 'malformed_stdout_line' };
  }
  if (rawEvents.some((e) => e.messageKind === 'timeout')) {
    return { status: 'transport_timeout', reasonCode: 'rpc_timeout' };
  }
  if (rawEvents.some((e) => e.messageKind === 'process_exit')) {
    return { status: 'process_exit', reasonCode: 'process_exited' };
  }
  if (rawEvents.some((e) => e.messageKind === 'drop_overflow')) {
    return { status: 'observation_interrupted', reasonCode: 'recorder_drop_overflow' };
  }

  const isServerRequest = rawEvents.some((e) => e.messageKind === 'server_request');
  const hasCancelledReply = rawEvents.some(
    (e) => e.direction === 'outbound' && e.messageKind === 'rpc_response' && e.label.includes('outcome=cancelled'),
  );
  const isNotification = rawEvents.some((e) => e.messageKind === 'rpc_notification');

  if (normEvents.some((e) => e.label.includes('slot=turn_bg') || e.label.includes('slot=turn_unknown'))) {
    return { status: 'adapter_misattributed_placeholder', reasonCode: 'placeholder_turn_slot' };
  }

  // Only attribute missing downstream layer to a drop when that downstream layer was actually observed in this scope!
  if (isServerRequest && !hasNorm) {
    if (!scopeContext.observedLayers.normalized) {
      return { status: 'layer_not_captured', reasonCode: 'normalized_layer_not_captured' };
    }
    if (scopeContext.observationInterrupted) {
      return { status: 'observation_interrupted', reasonCode: 'observation_incomplete' };
    }
    return hasCancelledReply
      ? { status: 'dropped_before_adapter', reasonCode: 'server_request_cancelled_before_adapter' }
      : { status: 'dropped_before_adapter', reasonCode: 'server_request_not_normalized' };
  }

  if (isNotification && !hasNorm) {
    if (!scopeContext.observedLayers.normalized) {
      return { status: 'layer_not_captured', reasonCode: 'normalized_layer_not_captured' };
    }
    if (scopeContext.observationInterrupted) {
      return { status: 'observation_interrupted', reasonCode: 'observation_incomplete' };
    }
    return { status: 'raw_only_unmapped', reasonCode: 'raw_not_normalized' };
  }

  if (hasNorm && !hasCanon) {
    if (!scopeContext.observedLayers.native_canonical) {
      return { status: 'layer_not_captured', reasonCode: 'canonical_layer_not_captured' };
    }
    return { status: 'normalized_not_persisted', reasonCode: 'missing_canonical_event' };
  }

  if (hasCanon && !hasUi) {
    if (!scopeContext.observedLayers.ui) {
      return { status: 'layer_not_captured', reasonCode: 'ui_layer_not_captured' };
    }
    return { status: 'canonical_not_projected', reasonCode: 'missing_ui_projection' };
  }

  if (hasRaw && hasNorm && hasCanon && hasUi) {
    return { status: 'four_layer_aligned', reasonCode: 'aligned' };
  }

  if (!scopeContext.observedLayers.normalized && hasRaw) {
    return { status: 'layer_not_captured', reasonCode: 'raw_only_capture' };
  }

  return { status: 'partial_observation', reasonCode: 'partial_layers' };
}

/**
 * Builds a comparable four-layer summary table scoped by
 * `connectionId + generation + channel + ingressOrdinal`, preserving multiple events and
 * outbound replies per ingress frame, and distinguishing uncaptured layers from drops.
 */
export function buildFourLayerSummary(records) {
  const first = records[0] ?? null;
  const captureId = first?.captureId ?? 'unknown-capture';
  const scenario = first?.scenario ?? 'unknown';
  const source = first?.source ?? 'synthetic';
  const cliVersion = first?.cliVersion ?? null;

  // Derive requested vs negotiated protocol accurately (avoid misreading v2 request as negotiated v2)
  const metaRec = records.find((r) => r.messageKind === 'capture_meta');
  const initReply = records.find(
    (r) => r.messageKind === 'rpc_response' && r.shape?.responseForMethod === 'initialize',
  );
  const requestedProtocol =
    typeof metaRec?.shape?.requestedProtocol === 'number' ? metaRec.shape.requestedProtocol : null;
  const negotiatedProtocol =
    typeof initReply?.shape?.protocolVersion === 'number'
      ? initReply.shape.protocolVersion
      : (records.findLast((r) => r.protocol !== null && r.protocol !== undefined)?.protocol ?? null);

  const endRec = records.findLast((r) => r.messageKind === 'capture_end');
  const exitRec = records.findLast((r) => r.messageKind === 'process_exit');

  const grouped = new Map();
  const scopeLayerPresence = new Map();
  const layerCounts = { raw: 0, normalized: 0, native_canonical: 0, ui: 0 };
  const stderrCounts = {};
  let droppedTotal = 0;

  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.layer in layerCounts) layerCounts[rec.layer]++;
    if (typeof rec.droppedCount === 'number') {
      droppedTotal = Math.max(droppedTotal, rec.droppedCount);
    }
    if (rec.messageKind === 'stderr_classified') {
      const cat = safeLabel(rec.shape?.category) ?? 'unknown';
      stderrCounts[cat] = (stderrCounts[cat] ?? 0) + 1;
    }

    const conn = rec.correlation?.connectionId ?? 'conn-1';
    const generation = rec.correlation?.generation ?? 'gen-0';
    const channel = rec.correlation?.channel === 'history_replay' ? 'history_replay' : 'live';
    const scopeKey = `${conn}|${generation}|${channel}`;

    let presence = scopeLayerPresence.get(scopeKey);
    if (!presence) {
      presence = {
        observedLayers: { raw: false, normalized: false, native_canonical: false, ui: false },
        observationInterrupted: false,
      };
      scopeLayerPresence.set(scopeKey, presence);
    }
    if (rec.layer in presence.observedLayers) {
      presence.observedLayers[rec.layer] = true;
    }
    if (rec.messageKind === 'drop_overflow' || rec.messageKind === 'timeout' || rec.truncated === true) {
      presence.observationInterrupted = true;
    }

    const ordinal = Number.isInteger(rec.correlation?.ingressOrdinal) ? rec.correlation.ingressOrdinal : 0;
    const rowKey = ordinal > 0 ? `${scopeKey}#${ordinal}` : `${scopeKey}#seq-${rec.seq}`;

    let row = grouped.get(rowKey);
    if (!row) {
      row = {
        key: rowKey,
        scopeKey,
        connectionId: conn,
        generation,
        channel,
        ingressOrdinal: ordinal,
        firstSeq: rec.seq,
        lastSeq: rec.seq,
        monotonicMs: rec.monotonicMs,
        aliases: {},
        layerEvents: {
          raw: [],
          normalized: [],
          native_canonical: [],
          ui: [],
        },
      };
      grouped.set(rowKey, row);
    }
    row.lastSeq = Math.max(row.lastSeq, rec.seq);

    const aliasFields = [
      'rpcIdAlias',
      'sessionAlias',
      'childAlias',
      'toolAlias',
      'taskAlias',
      'workflowAlias',
      'approvalAlias',
      'turnAlias',
      'activityAlias',
      'workAlias',
      'agentAlias',
    ];
    for (const f of aliasFields) {
      if (rec.correlation?.[f] && !row.aliases[f]) {
        row.aliases[f] = rec.correlation[f];
      }
    }

    if (rec.layer in row.layerEvents) {
      row.layerEvents[rec.layer].push(summarizeLayerRecord(rec));
    }
  }

  const anomalies = [];
  const rows = [...grouped.values()]
    .sort((a, b) => a.firstSeq - b.firstSeq)
    .map((row) => {
      const scopeContext = scopeLayerPresence.get(row.scopeKey) ?? {
        observedLayers: { raw: true, normalized: false, native_canonical: false, ui: false },
        observationInterrupted: false,
      };
      const layers = {
        raw: combineLayerEvents(row.layerEvents.raw),
        normalized: combineLayerEvents(row.layerEvents.normalized),
        native_canonical: combineLayerEvents(row.layerEvents.native_canonical),
        ui: combineLayerEvents(row.layerEvents.ui),
      };
      const attribution = classifyRowAttribution(row, scopeContext);
      const primaryLayer = layers.ui
        ? 'ui'
        : layers.native_canonical
          ? 'native_canonical'
          : layers.normalized
            ? 'normalized'
            : 'raw';
      const diagnosticCode =
        layers.ui?.diagnosticCode ??
        layers.native_canonical?.diagnosticCode ??
        layers.normalized?.diagnosticCode ??
        layers.raw?.diagnosticCode ??
        formatDiagnosticCode({
          captureId,
          scenario,
          connectionId: row.connectionId,
          generation: row.generation,
          channel: row.channel,
          ingressOrdinal: row.ingressOrdinal,
          seq: row.lastSeq,
          layer: primaryLayer,
          reasonCode: attribution.reasonCode,
        });

      const nonAnomalyStatuses = new Set([
        'four_layer_aligned',
        'partial_observation',
        'layer_not_captured',
      ]);
      if (!nonAnomalyStatuses.has(attribution.status)) {
        anomalies.push({
          rowKey: row.key,
          status: attribution.status,
          reasonCode: attribution.reasonCode,
          diagnosticCode,
        });
      }

      return {
        key: row.key,
        connectionId: row.connectionId,
        generation: row.generation,
        channel: row.channel,
        ingressOrdinal: row.ingressOrdinal,
        firstSeq: row.firstSeq,
        lastSeq: row.lastSeq,
        monotonicMs: row.monotonicMs,
        aliases: row.aliases,
        layers,
        attributionStatus: attribution.status,
        reasonCode: attribution.reasonCode,
        diagnosticCode,
      };
    });

  const primaryDiagnosticCode =
    anomalies[0]?.diagnosticCode ??
    rows[rows.length - 1]?.diagnosticCode ??
    formatDiagnosticCode({
      captureId,
      scenario,
      connectionId: 'conn-1',
      generation: 'gen-0',
      channel: 'live',
      ingressOrdinal: 0,
      seq: 0,
      layer: 'raw',
      reasonCode: 'empty',
    });

  return {
    schemaVersion: 1,
    toolVersion: '0.2.0',
    captureId,
    scenario,
    source,
    cliVersion,
    requestedProtocol,
    negotiatedProtocol,
    protocol: negotiatedProtocol,
    endReason: endRec?.shape?.reason ?? null,
    promptSent: typeof endRec?.shape?.promptSent === 'boolean' ? endRec.shape.promptSent : false,
    exitCode: typeof exitRec?.shape?.exitCode === 'number' ? exitRec.shape.exitCode : null,
    truncatedCount: typeof endRec?.shape?.truncatedCount === 'number' ? endRec.shape.truncatedCount : 0,
    totalRecords: records.length,
    layerCounts,
    observedLayers: {
      raw: layerCounts.raw > 0,
      normalized: layerCounts.normalized > 0,
      native_canonical: layerCounts.native_canonical > 0,
      ui: layerCounts.ui > 0,
    },
    stderrCounts,
    droppedTotal,
    anomalyCount: anomalies.length,
    anomalies: anomalies.slice(0, 50),
    rows,
    np03DiagnosticInput: {
      schemaVersion: 1,
      toolVersion: '0.2.0',
      copyableDiagnosticCode: primaryDiagnosticCode,
      captureId,
      scenario,
      provenance: source,
      cliVersion,
      requestedProtocol,
      negotiatedProtocol,
      protocol: negotiatedProtocol,
      layerCoverage: layerCounts,
      anomalySummary: anomalies.slice(0, 10).map((a) => ({
        rowKey: a.rowKey,
        status: a.status,
        reasonCode: a.reasonCode,
        diagnosticCode: a.diagnosticCode,
      })),
    },
  };
}

export function renderFourLayerMarkdownTable(summary) {
  const header = [
    `# Four-Layer Correlation Summary · ${summary.scenario} (${summary.captureId})`,
    '',
    `- **Tool Version**: \`${summary.toolVersion ?? '0.2.0'}\` | **Source / Provenance**: \`${summary.source}\` | **CLI**: \`${summary.cliVersion ?? 'unknown'}\``,
    `- **Protocol**: requested=\`${summary.requestedProtocol ?? 'n/a'}\`, negotiated=\`${summary.negotiatedProtocol ?? 'unknown'}\` | **End Reason**: \`${summary.endReason ?? 'n/a'}\` | **Prompt Sent**: \`${summary.promptSent}\` | **Exit Code**: \`${summary.exitCode ?? 'n/a'}\``,
    `- **Copyable Diagnostic Code (NP-03)**: \`${summary.np03DiagnosticInput.copyableDiagnosticCode}\``,
    `- **Layer Counts**: raw=${summary.layerCounts.raw}, normalized=${summary.layerCounts.normalized}, native_canonical=${summary.layerCounts.native_canonical}, ui=${summary.layerCounts.ui} | **Dropped**: ${summary.droppedTotal}`,
    '',
    '| Scope / Ordinal | ms | Aliases | Raw Transport | Normalized Adapter | Native Canonical | UI Projection | Attribution | Diagnostic Code |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  const escapeCell = (val) => String(val ?? '—').replace(/\|/g, '\\|');
  for (const row of summary.rows) {
    const aliasText =
      Object.entries(row.aliases)
        .map(([k, v]) => `${k.replace(/Alias$/, '')}=${v}`)
        .join(', ') || '—';
    const scopeLabel = `${row.connectionId}/${row.generation}/${row.channel === 'history_replay' ? 'replay' : 'live'}#${row.ingressOrdinal}`;
    header.push(
      `| ${escapeCell(scopeLabel)} | ${row.monotonicMs} | ${escapeCell(aliasText)} | ${escapeCell(row.layers.raw?.label)} | ${escapeCell(row.layers.normalized?.label)} | ${escapeCell(row.layers.native_canonical?.label)} | ${escapeCell(row.layers.ui?.label)} | ${escapeCell(row.attributionStatus)} | \`${row.diagnosticCode}\` |`,
    );
  }
  return `${header.join('\n')}\n`;
}
