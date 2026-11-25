import { safeLabel } from './sanitizer.mjs';

const REASON_SAFE_RE = /^[a-zA-Z0-9._-]{1,48}$/;

function sanitizeToken(value, fallback = 'none', maxLen = 40) {
  if (value === undefined || value === null || value === '') return fallback;
  const cleaned = String(value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, maxLen);
  return cleaned && REASON_SAFE_RE.test(cleaned) ? cleaned : fallback;
}

/**
 * Generates a copy-safe, PII-free diagnostic code consumable by NP-03 UI and issue reports.
 * Format: AGY-DIAG-v1:<captureId>:<scenario>:<connectionId>:<ingressOrdinal>:<layer>:<reasonCode>
 */
export function formatDiagnosticCode({
  captureId,
  scenario,
  connectionId,
  ingressOrdinal = 0,
  layer = 'raw',
  reasonCode = 'observed',
}) {
  const parts = [
    'AGY-DIAG-v1',
    sanitizeToken(captureId, 'cap', 40),
    sanitizeToken(scenario, 'scn', 24),
    sanitizeToken(connectionId, 'conn-1', 24),
    String(Number.isInteger(ingressOrdinal) && ingressOrdinal >= 0 ? ingressOrdinal : 0),
    sanitizeToken(layer, 'raw', 16),
    sanitizeToken(reasonCode, 'observed', 36),
  ];
  return parts.join(':');
}

export function parseDiagnosticCode(code) {
  if (typeof code !== 'string') return null;
  const parts = code.split(':');
  if (parts.length !== 7 || parts[0] !== 'AGY-DIAG-v1') return null;
  const ordinal = Number(parts[4]);
  if (!Number.isInteger(ordinal) || ordinal < 0) return null;
  return {
    version: 'v1',
    captureId: parts[1],
    scenario: parts[2],
    connectionId: parts[3],
    ingressOrdinal: ordinal,
    layer: parts[5],
    reasonCode: parts[6],
  };
}

function summarizeLayerRecord(rec) {
  if (!rec) return null;
  const shape = rec.shape ?? {};
  const parts = [rec.messageKind];
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

function classifyRowAttribution(row) {
  const { raw, normalized, native_canonical: canonical, ui } = row.layers;
  if (!raw && (normalized || canonical || ui)) {
    return { status: 'synthetic_or_local_only', reasonCode: 'no_raw_frame' };
  }
  if (raw?.messageKind === 'malformed_line') {
    return { status: 'transport_malformed', reasonCode: 'malformed_stdout_line' };
  }
  if (raw?.messageKind === 'timeout') {
    return { status: 'transport_timeout', reasonCode: 'rpc_timeout' };
  }
  if (raw?.messageKind === 'process_exit') {
    return { status: 'process_exit', reasonCode: 'process_exited' };
  }
  if (raw?.messageKind === 'server_request' && !normalized) {
    return { status: 'dropped_before_adapter', reasonCode: 'server_request_not_normalized' };
  }
  if (normalized?.label.includes('slot=turn_bg') || normalized?.label.includes('slot=turn_unknown')) {
    return { status: 'adapter_misattributed_placeholder', reasonCode: 'placeholder_turn_slot' };
  }
  if (raw && !normalized && (raw.messageKind === 'rpc_notification' || raw.messageKind === 'server_request')) {
    return { status: 'raw_only_unmapped', reasonCode: 'raw_not_normalized' };
  }
  if (normalized && !canonical) {
    return { status: 'normalized_not_persisted', reasonCode: 'missing_canonical_event' };
  }
  if (canonical && !ui) {
    return { status: 'canonical_not_projected', reasonCode: 'missing_ui_projection' };
  }
  if (raw && normalized && canonical && ui) {
    return { status: 'four_layer_aligned', reasonCode: 'aligned' };
  }
  return { status: 'partial_observation', reasonCode: 'partial_layers' };
}

/**
 * Builds a comparable four-layer summary table (raw / normalized / native_canonical / ui)
 * plus a safe, copy-ready NP-03 diagnostic bundle.
 */
export function buildFourLayerSummary(records) {
  const first = records[0] ?? null;
  const captureId = first?.captureId ?? 'unknown-capture';
  const scenario = first?.scenario ?? 'unknown';
  const source = first?.source ?? 'synthetic';
  const protocol = first?.protocol ?? null;
  const cliVersion = first?.cliVersion ?? null;

  const grouped = new Map();
  const layerCounts = { raw: 0, normalized: 0, native_canonical: 0, ui: 0 };
  const stderrCounts = {};
  const anomalies = [];
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
    const ordinal = Number.isInteger(rec.correlation?.ingressOrdinal) ? rec.correlation.ingressOrdinal : 0;
    // Key by connection + ingressOrdinal when > 0 so all 4 layers for the same ingress frame align on one row.
    // Outbound / lifecycle / ordinal=0 records group by seq to preserve timeline order.
    const rowKey = ordinal > 0 ? `${conn}#${ordinal}` : `${conn}#seq-${rec.seq}`;

    let row = grouped.get(rowKey);
    if (!row) {
      row = {
        key: rowKey,
        connectionId: conn,
        generation: rec.correlation?.generation ?? null,
        ingressOrdinal: ordinal,
        firstSeq: rec.seq,
        monotonicMs: rec.monotonicMs,
        aliases: {},
        layers: {
          raw: null,
          normalized: null,
          native_canonical: null,
          ui: null,
        },
      };
      grouped.set(rowKey, row);
    }

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

    if (!row.layers[rec.layer]) {
      row.layers[rec.layer] = summarizeLayerRecord(rec);
    }
  }

  const rows = [...grouped.values()]
    .sort((a, b) => a.firstSeq - b.firstSeq)
    .map((row) => {
      const attribution = classifyRowAttribution(row);
      const diagnosticCode =
        row.layers.ui?.diagnosticCode ??
        row.layers.native_canonical?.diagnosticCode ??
        row.layers.normalized?.diagnosticCode ??
        row.layers.raw?.diagnosticCode ??
        formatDiagnosticCode({
          captureId,
          scenario,
          connectionId: row.connectionId,
          ingressOrdinal: row.ingressOrdinal,
          layer: row.layers.ui
            ? 'ui'
            : row.layers.native_canonical
              ? 'native_canonical'
              : row.layers.normalized
                ? 'normalized'
                : 'raw',
          reasonCode: attribution.reasonCode,
        });

      if (
        attribution.status !== 'four_layer_aligned' &&
        attribution.status !== 'partial_observation'
      ) {
        anomalies.push({
          rowKey: row.key,
          status: attribution.status,
          reasonCode: attribution.reasonCode,
          diagnosticCode,
        });
      }

      return {
        ...row,
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
      ingressOrdinal: 0,
      layer: 'raw',
      reasonCode: 'empty',
    });

  return {
    schemaVersion: 1,
    captureId,
    scenario,
    source,
    cliVersion,
    protocol,
    totalRecords: records.length,
    layerCounts,
    stderrCounts,
    droppedTotal,
    anomalyCount: anomalies.length,
    anomalies: anomalies.slice(0, 50),
    rows,
    np03DiagnosticInput: {
      schemaVersion: 1,
      copyableDiagnosticCode: primaryDiagnosticCode,
      captureId,
      scenario,
      provenance: source,
      cliVersion,
      protocol,
      layerCoverage: layerCounts,
      anomalySummary: anomalies.slice(0, 10).map((a) => ({
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
    `- **Source / Provenance**: \`${summary.source}\` | **CLI**: \`${summary.cliVersion ?? 'unknown'}\` | **Protocol**: \`${summary.protocol ?? 'unknown'}\``,
    `- **Copyable Diagnostic Code (NP-03)**: \`${summary.np03DiagnosticInput.copyableDiagnosticCode}\``,
    `- **Layer Counts**: raw=${summary.layerCounts.raw}, normalized=${summary.layerCounts.normalized}, native_canonical=${summary.layerCounts.native_canonical}, ui=${summary.layerCounts.ui} | **Dropped**: ${summary.droppedTotal}`,
    '',
    '| Ordinal | ms | Aliases | Raw Transport | Normalized Adapter | Native Canonical | UI Projection | Attribution | Diagnostic Code |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  const escapeCell = (val) => String(val ?? '—').replace(/\|/g, '\\|');
  for (const row of summary.rows) {
    const aliasText = Object.entries(row.aliases)
      .map(([k, v]) => `${k.replace(/Alias$/, '')}=${v}`)
      .join(', ') || '—';
    header.push(
      `| ${row.connectionId}#${row.ingressOrdinal} | ${row.monotonicMs} | ${escapeCell(aliasText)} | ${escapeCell(row.layers.raw?.label)} | ${escapeCell(row.layers.normalized?.label)} | ${escapeCell(row.layers.native_canonical?.label)} | ${escapeCell(row.layers.ui?.label)} | ${escapeCell(row.attributionStatus)} | \`${row.diagnosticCode}\` |`,
    );
  }
  return `${header.join('\n')}\n`;
}
