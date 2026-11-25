import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanRecordForLeaks } from './sanitizer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CAPTURE_V1_SCHEMA_PATH = path.join(__dirname, 'schema', 'capture-v1.schema.json');
export const CAPTURE_V1_SCHEMA = JSON.parse(fs.readFileSync(CAPTURE_V1_SCHEMA_PATH, 'utf8'));

function matchesJsonType(value, expectedType) {
  if (expectedType === 'null') return value === null;
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  if (expectedType === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (expectedType === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (expectedType === 'string') return typeof value === 'string';
  if (expectedType === 'boolean') return typeof value === 'boolean';
  return false;
}

/**
 * Single-source JSON Schema Draft 2020-12 subset evaluator driven directly by
 * `schema/capture-v1.schema.json`.
 * Emits ONLY sanitized error codes (`<path>: <reasonCode>`) — never echoes raw invalid values
 * or untrusted property names.
 */
function validateAgainstSchema(value, schema, fieldPath, errors) {
  if (!schema || typeof schema !== 'object') return;

  if ('const' in schema && value !== schema.const) {
    errors.push(`${fieldPath}: invalid_const`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${fieldPath}: invalid_enum`);
    return;
  }

  if (schema.type !== undefined) {
    const allowedTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
    const typeOk = allowedTypes.some((t) => matchesJsonType(value, t));
    if (!typeOk) {
      errors.push(`${fieldPath}: invalid_type`);
      return;
    }
  }

  if (value === null || value === undefined) return;

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${fieldPath}: min_length_violation`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${fieldPath}: max_length_violation`);
    }
    if (typeof schema.pattern === 'string') {
      const re = new RegExp(schema.pattern);
      if (!re.test(value)) {
        errors.push(`${fieldPath}: pattern_mismatch`);
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) {
      errors.push(`${fieldPath}: minimum_violation`);
    }
    if (typeof schema.maximum === 'number' && value > schema.maximum) {
      errors.push(`${fieldPath}: maximum_violation`);
    }
  }

  if (Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validateAgainstSchema(value[i], schema.items, `${fieldPath}[${i}]`, errors);
    }
  }

  if (typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties ?? {};
    if (Array.isArray(schema.required)) {
      for (const reqKey of schema.required) {
        if (!(reqKey in value) || value[reqKey] === undefined) {
          errors.push(`${fieldPath}.${reqKey}: missing_required_property`);
        }
      }
    }

    let extraPropCount = 0;
    for (const key of Object.keys(value)) {
      if (key in props) {
        validateAgainstSchema(value[key], props[key], `${fieldPath}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        extraPropCount++;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateAgainstSchema(value[key], schema.additionalProperties, `${fieldPath}.<dynamic>`, errors);
      }
    }
    if (extraPropCount > 0) {
      errors.push(`${fieldPath}: additional_property_not_allowed(count=${extraPropCount})`);
    }
  }
}

export function validateCaptureRecord(record, index = 0) {
  const errors = [];
  validateAgainstSchema(record, CAPTURE_V1_SCHEMA, `record[${index}]`, errors);

  const leakFindings = record && typeof record === 'object' ? scanRecordForLeaks(record) : [];
  if (leakFindings.length > 0) {
    errors.push(`record[${index}]: leak_detected(${leakFindings.join(',')})`);
  }

  return {
    valid: errors.length === 0,
    errors,
    leakFindings,
  };
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
        errors.push(`record[${i}].seq: non_monotonic_seq`);
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
    } catch {
      parseErrors.push(`line[${i + 1}]: invalid_json`);
    }
  }
  if (parseErrors.length > 0) {
    return {
      valid: false,
      recordCount: records.length,
      records: [],
      errors: parseErrors,
      leakFindings: [],
    };
  }
  const validation = validateCaptureRecords(records);
  return { ...validation, records: validation.valid ? records : [] };
}
