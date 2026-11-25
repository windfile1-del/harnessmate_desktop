import { scanRecordForLeaks } from './sanitizer.mjs';

export const ALLOWED_PLATFORMS = new Set(['win32', 'darwin', 'linux', 'unknown']);
export const ALLOWED_ACCOUNT_CATEGORIES = new Set([
  'none',
  'dedicated_test_personal',
  'dedicated_test_business',
  'synthetic',
  'replay_sanitized',
]);
export const ALLOWED_SOURCES = new Set([
  'synthetic',
  'replay_with_provenance',
  'live_raw',
  'live_hm',
  'official_comparison',
]);
export const ALLOWED_PRODUCERS = new Set([
  'observatory_cli',
  'daemon_tap_callback',
  'replay_harness',
  'migrator',
]);
export const ALLOWED_LAYERS = new Set(['raw', 'normalized', 'native_canonical', 'ui']);
export const ALLOWED_DIRECTIONS = new Set(['outbound', 'inbound', 'internal', 'stderr', 'lifecycle']);
export const ALLOWED_MESSAGE_KINDS = new Set([
  'capture_meta',
  'capture_end',
  'cli_catalog',
  'rpc_request',
  'rpc_response',
  'rpc_error',
  'rpc_notification',
  'server_request',
  'malformed_line',
  'stderr_classified',
  'process_exit',
  'timeout',
  'drop_overflow',
  'adapter_normalized',
  'native_canonical',
  'ui_projection',
]);
export const ALLOWED_CHANNELS = new Set(['live', 'history_replay']);

const ALLOWED_TOP_KEYS = new Set([
  'schemaVersion',
  'captureId',
  'scenario',
  'platform',
  'cliVersion',
  'protocol',
  'accountCategory',
  'source',
  'observedAt',
  'producer',
  'seq',
  'monotonicMs',
  'layer',
  'direction',
  'messageKind',
  'latencyMs',
  'provenance',
  'correlation',
  'shape',
  'unknownKeys',
  'truncated',
  'droppedCount',
]);

const ALLOWED_CORRELATION_KEYS = new Set([
  'connectionId',
  'generation',
  'ingressOrdinal',
  'channel',
  'rpcIdAlias',
  'rpcIdType',
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
  'diagnosticCode',
]);

const ID_RE = /^[a-zA-Z0-9._:-]{1,96}$/;
const DIAG_CODE_RE = /^AGY-DIAG-v1:[a-zA-Z0-9._:-]{4,180}$/;
const CLI_VER_RE = /^[a-zA-Z0-9._+-]{1,48}$/;

export function validateCaptureRecord(record, index = 0) {
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, errors: [`record[${index}]: must be a JSON object`], leakFindings: [] };
  }

  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      errors.push(`record[${index}]: unexpected top-level property "${key}"`);
    }
  }

  if (record.schemaVersion !== 1) {
    errors.push(`record[${index}]: schemaVersion must be 1`);
  }
  if (typeof record.captureId !== 'string' || record.captureId.length < 4 || !ID_RE.test(record.captureId)) {
    errors.push(`record[${index}]: invalid captureId`);
  }
  if (typeof record.scenario !== 'string' || record.scenario.length < 2 || !ID_RE.test(record.scenario)) {
    errors.push(`record[${index}]: invalid scenario`);
  }
  if (!ALLOWED_PLATFORMS.has(record.platform)) {
    errors.push(`record[${index}]: invalid platform "${record.platform}"`);
  }
  if (record.cliVersion !== null && (typeof record.cliVersion !== 'string' || !CLI_VER_RE.test(record.cliVersion))) {
    errors.push(`record[${index}]: invalid cliVersion`);
  }
  if (record.protocol !== null && record.protocol !== 1 && record.protocol !== 2) {
    errors.push(`record[${index}]: protocol must be 1, 2, or null`);
  }
  if (!ALLOWED_ACCOUNT_CATEGORIES.has(record.accountCategory)) {
    errors.push(`record[${index}]: invalid accountCategory "${record.accountCategory}"`);
  }
  if (!ALLOWED_SOURCES.has(record.source)) {
    errors.push(`record[${index}]: invalid source "${record.source}"`);
  }
  if (!Number.isInteger(record.observedAt) || record.observedAt < 0) {
    errors.push(`record[${index}]: observedAt must be a non-negative integer`);
  }
  if (!ALLOWED_PRODUCERS.has(record.producer)) {
    errors.push(`record[${index}]: invalid producer "${record.producer}"`);
  }
  if (!Number.isInteger(record.seq) || record.seq < 1) {
    errors.push(`record[${index}]: seq must be an integer >= 1`);
  }
  if (typeof record.monotonicMs !== 'number' || !Number.isFinite(record.monotonicMs) || record.monotonicMs < 0) {
    errors.push(`record[${index}]: monotonicMs must be a finite number >= 0`);
  }
  if (!ALLOWED_LAYERS.has(record.layer)) {
    errors.push(`record[${index}]: invalid layer "${record.layer}"`);
  }
  if (!ALLOWED_DIRECTIONS.has(record.direction)) {
    errors.push(`record[${index}]: invalid direction "${record.direction}"`);
  }
  if (!ALLOWED_MESSAGE_KINDS.has(record.messageKind)) {
    errors.push(`record[${index}]: invalid messageKind "${record.messageKind}"`);
  }
  if (
    record.latencyMs !== undefined &&
    record.latencyMs !== null &&
    (typeof record.latencyMs !== 'number' || !Number.isFinite(record.latencyMs) || record.latencyMs < 0)
  ) {
    errors.push(`record[${index}]: latencyMs must be null or a finite number >= 0`);
  }

  const corr = record.correlation;
  if (!corr || typeof corr !== 'object' || Array.isArray(corr)) {
    errors.push(`record[${index}]: correlation must be an object`);
  } else {
    for (const k of Object.keys(corr)) {
      if (!ALLOWED_CORRELATION_KEYS.has(k)) {
        errors.push(`record[${index}]: unexpected correlation property "${k}"`);
      }
    }
    if (typeof corr.connectionId !== 'string' || corr.connectionId.length < 2 || !ID_RE.test(corr.connectionId)) {
      errors.push(`record[${index}]: invalid correlation.connectionId`);
    }
    if (!Number.isInteger(corr.ingressOrdinal) || corr.ingressOrdinal < 0) {
      errors.push(`record[${index}]: correlation.ingressOrdinal must be an integer >= 0`);
    }
    if (!ALLOWED_CHANNELS.has(corr.channel)) {
      errors.push(`record[${index}]: invalid correlation.channel "${corr.channel}"`);
    }
    if (
      corr.rpcIdType !== undefined &&
      corr.rpcIdType !== null &&
      corr.rpcIdType !== 'number' &&
      corr.rpcIdType !== 'string'
    ) {
      errors.push(`record[${index}]: invalid correlation.rpcIdType`);
    }
    if (
      corr.diagnosticCode !== undefined &&
      corr.diagnosticCode !== null &&
      (typeof corr.diagnosticCode !== 'string' || !DIAG_CODE_RE.test(corr.diagnosticCode))
    ) {
      errors.push(`record[${index}]: invalid correlation.diagnosticCode`);
    }
  }

  if (record.unknownKeys !== undefined) {
    if (!Array.isArray(record.unknownKeys) || record.unknownKeys.some((k) => typeof k !== 'string')) {
      errors.push(`record[${index}]: unknownKeys must be string[]`);
    }
  }
  if (record.droppedCount !== undefined && (!Number.isInteger(record.droppedCount) || record.droppedCount < 0)) {
    errors.push(`record[${index}]: droppedCount must be a non-negative integer`);
  }

  const leakFindings = scanRecordForLeaks(record);
  if (leakFindings.length > 0) {
    errors.push(`record[${index}]: secret/PII/path leak detected (${leakFindings.join(', ')})`);
  }

  return { valid: errors.length === 0, errors, leakFindings };
}

export function validateCaptureRecords(records) {
  const errors = [];
  const leakFindings = [];
  let prevSeq = 0;
  for (let i = 0; i < records.length; i++) {
    const res = validateCaptureRecord(records[i], i);
    if (!res.valid) errors.push(...res.errors);
    if (res.leakFindings.length > 0) {
      leakFindings.push({ index: i, findings: res.leakFindings });
    }
    const seq = records[i]?.seq;
    if (Number.isInteger(seq)) {
      if (seq <= prevSeq) {
        errors.push(`record[${i}]: seq (${seq}) must strictly increase after ${prevSeq}`);
      }
      prevSeq = seq;
    }
  }
  return {
    valid: errors.length === 0,
    recordCount: records.length,
    errors,
    leakFindings,
  };
}

export function parseAndValidateNdjson(ndjsonText) {
  const lines = String(ndjsonText ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const records = [];
  const parseErrors = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      records.push(JSON.parse(lines[i]));
    } catch (err) {
      parseErrors.push(`line[${i + 1}]: invalid JSON (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (parseErrors.length > 0) {
    return {
      valid: false,
      recordCount: records.length,
      records,
      errors: parseErrors,
      leakFindings: [],
    };
  }
  const validation = validateCaptureRecords(records);
  return { ...validation, records };
}
