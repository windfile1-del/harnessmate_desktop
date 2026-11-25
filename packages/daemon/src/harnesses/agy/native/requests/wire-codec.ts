import type {
  NativeRequestKind,
  ResolveNativeRequestInput,
  RiskLevel,
  RuntimeRequestKind,
  ToolKind,
} from '@harnessmate/protocol';
import {
  NativeRequestValidationError,
  type NativeElicitationFieldSchema,
  type NativeElicitationFormSpec,
  type NativeElicitationStringFormat,
  type NativeRequestOption,
  type NativeRequestOptionKind,
  type ParsedIncomingWireRequest,
} from './types.js';

export const JSON_RPC_METHOD_NOT_FOUND = -32601 as const;
export const JSON_RPC_INVALID_PARAMS = -32602 as const;

export const SUPPORTED_PERMISSION_METHOD = 'session/request_permission' as const;
export const SUPPORTED_ELICITATION_METHODS = new Set<string>([
  'elicitation/create',
  'session/elicitation/create',
]);

export type ParseWireRequestResult =
  | { readonly ok: true; readonly parsed: ParsedIncomingWireRequest }
  | {
      readonly ok: false;
      readonly rpcError: { readonly code: number; readonly message: string };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function mapToolKind(rawKind: string | undefined): ToolKind {
  switch ((rawKind ?? '').toLowerCase()) {
    case 'read':
    case 'search':
      return 'file_read';
    case 'edit':
    case 'write':
    case 'create':
    case 'delete':
    case 'move':
      return 'file_edit';
    case 'execute':
    case 'shell':
    case 'terminal':
      return 'shell';
    case 'fetch':
    case 'http':
      return 'web';
    case 'mcp':
      return 'mcp';
    default:
      return 'other';
  }
}

function classifyBaseRisk(toolKind: ToolKind, securityWarnings: readonly string[]): RiskLevel {
  if (securityWarnings.length > 0) return 'high';
  if (toolKind === 'shell') return 'high';
  if (toolKind === 'file_edit' || toolKind === 'mcp') return 'medium';
  return 'low';
}

function classifyOptionKind(rawKind: string | undefined, optionId: string): NativeRequestOptionKind {
  const kind = (rawKind ?? '').toLowerCase();
  const id = optionId.toLowerCase();
  if (kind === 'allow_always' || id === 'allow_always' || id === 'allow_session' || id === 'allow-session') {
    return 'allow_always';
  }
  if (kind === 'allow_once' || id === 'allow_once' || id === 'allow-once') {
    return 'allow_once';
  }
  if (kind === 'reject_always' || id === 'reject_always' || id === 'reject-always' || id === 'deny_always') {
    return 'reject_always';
  }
  if (kind === 'reject_once' || id === 'reject_once' || id === 'reject-once' || id === 'deny' || id === 'reject') {
    return 'reject_once';
  }
  return 'custom';
}

function isScopeWideningOption(kind: NativeRequestOptionKind, optionId: string, name: string): boolean {
  if (kind === 'allow_always') return true;
  const lowered = `${optionId} ${name}`.toLowerCase();
  return /\ballow[_ -]?(always|session|all|workspace)\b|\btrust[_ -]?session\b|\balways allow\b/.test(
    lowered,
  );
}

function extractDiffPreview(toolCall: Record<string, unknown>): string | null {
  const content = toolCall.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'diff') {
        const filePath = asNonEmptyString(item.path) ?? 'file';
        const oldText = typeof item.oldText === 'string' ? item.oldText : '';
        const newText = typeof item.newText === 'string' ? item.newText : '';
        if (oldText || newText) {
          return `--- ${filePath}\n+++ ${filePath}\n- ${oldText.slice(0, 1200)}\n+ ${newText.slice(0, 1200)}`;
        }
      }
    }
  }
  if (typeof toolCall.diff === 'string' && toolCall.diff.trim().length > 0) {
    return toolCall.diff.slice(0, 4000);
  }
  return null;
}

function extractMetaHints(params: Record<string, unknown>, toolCall: Record<string, unknown>): {
  parentSessionHint?: string;
  childSessionHint?: string;
  workflowIdHint?: string;
} {
  const paramMeta = isRecord(params._meta) ? params._meta : {};
  const tcMeta = isRecord(toolCall._meta) ? toolCall._meta : {};
  const agyMeta = isRecord(paramMeta.antigravity)
    ? paramMeta.antigravity
    : isRecord(tcMeta.antigravity)
      ? tcMeta.antigravity
      : {};

  const parentSessionHint =
    asNonEmptyString(params.parentSessionId) ??
    asNonEmptyString(paramMeta.parentSessionId) ??
    asNonEmptyString(tcMeta.parentSessionId) ??
    asNonEmptyString(agyMeta.parentSessionId);

  const childSessionHint =
    asNonEmptyString(params.subagentSessionId) ??
    asNonEmptyString(params.childSessionId) ??
    asNonEmptyString(paramMeta.subagentSessionId) ??
    asNonEmptyString(paramMeta.childSessionId) ??
    asNonEmptyString(tcMeta.subagentSessionId) ??
    asNonEmptyString(tcMeta.childSessionId) ??
    asNonEmptyString(agyMeta.subagentSessionId) ??
    asNonEmptyString(agyMeta.childConversationId);

  const workflowIdHint =
    asNonEmptyString(params.workflowId) ??
    asNonEmptyString(paramMeta.workflowId) ??
    asNonEmptyString(tcMeta.workflowId) ??
    asNonEmptyString(agyMeta.workflowId);

  return {
    ...(parentSessionHint ? { parentSessionHint } : {}),
    ...(childSessionHint ? { childSessionHint } : {}),
    ...(workflowIdHint ? { workflowIdHint } : {}),
  };
}

function parsePermissionRequest(params: Record<string, unknown>): ParseWireRequestResult {
  const actualNativeSessionId = asNonEmptyString(params.sessionId);
  if (!actualNativeSessionId) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: 'session/request_permission requires a non-empty string sessionId',
      },
    };
  }

  if (!Array.isArray(params.options)) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: 'session/request_permission requires an options array',
      },
    };
  }

  const subject = isRecord(params.subject) ? params.subject : null;
  const toolCall = isRecord(params.toolCall)
    ? params.toolCall
    : subject && isRecord(subject.toolCall)
      ? subject.toolCall
      : {};

  const toolCallId = asNonEmptyString(toolCall.toolCallId);
  const rawInput = isRecord(toolCall.rawInput) ? toolCall.rawInput : {};
  const isInteractionQuestion =
    Boolean(toolCallId && toolCallId.startsWith('interaction_')) ||
    asNonEmptyString(toolCall.kind)?.toLowerCase() === 'question';

  const seenOptionIds = new Set<string>();
  const options: NativeRequestOption[] = [];
  const securityWarnings: string[] = [];

  for (const rawOpt of params.options) {
    if (!isRecord(rawOpt)) {
      return {
        ok: false,
        rpcError: {
          code: JSON_RPC_INVALID_PARAMS,
          message: 'Each permission option must be an object with optionId',
        },
      };
    }
    const optionId = asNonEmptyString(rawOpt.optionId);
    if (!optionId) {
      return {
        ok: false,
        rpcError: {
          code: JSON_RPC_INVALID_PARAMS,
          message: 'Each permission option requires a non-empty optionId',
        },
      };
    }
    if (seenOptionIds.has(optionId)) {
      return {
        ok: false,
        rpcError: {
          code: JSON_RPC_INVALID_PARAMS,
          message: `Duplicate optionId "${optionId}" in session/request_permission`,
        },
      };
    }
    seenOptionIds.add(optionId);

    const name = asNonEmptyString(rawOpt.name) ?? optionId;
    const rawKind = asNonEmptyString(rawOpt.kind);
    const kind = classifyOptionKind(rawKind, optionId);
    const meta = isRecord(rawOpt._meta) ? rawOpt._meta : {};
    const warning = asNonEmptyString(meta['agy.security.warning']);
    if (warning && !securityWarnings.includes(warning)) {
      securityWarnings.push(warning);
    }
    const description = asNonEmptyString(rawOpt.description) ?? warning;

    options.push({
      optionId,
      name,
      kind,
      ...(description ? { description } : {}),
      ...(warning ? { securityWarning: warning } : {}),
      scopeWidening: isScopeWideningOption(kind, optionId, name),
    });
  }

  // Non-question permission requests MUST offer at least one option to select
  if (!isInteractionQuestion && options.length === 0) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: 'session/request_permission requires at least one option',
      },
    };
  }

  const tcMeta = isRecord(toolCall._meta) ? toolCall._meta : {};
  const tcWarning = asNonEmptyString(tcMeta['agy.security.warning']);
  if (tcWarning && !securityWarnings.includes(tcWarning)) {
    securityWarnings.push(tcWarning);
  }

  const hints = extractMetaHints(params, toolCall);

  if (isInteractionQuestion) {
    const questionText =
      asNonEmptyString(rawInput.question) ??
      asNonEmptyString(params.description) ??
      asNonEmptyString(params.title) ??
      asNonEmptyString(toolCall.title) ??
      'AGY 请求进一步确认或选择';

    // Standard ACP v1 session/request_permission wire ONLY carries `{ outcome: { outcome: 'selected', optionId } }`.
    // Never infer or fabricate free-text encoding when fixed options apply or when 0 options are supplied.
    const canAnswer = options.length > 0;
    const unsupportedReason = canAnswer ? undefined : 'no_verified_free_text_wire_encoding';

    return {
      ok: true,
      parsed: {
        method: SUPPORTED_PERMISSION_METHOD,
        kind: 'question',
        actualNativeSessionId,
        ...(toolCallId ? { toolCallId } : {}),
        ...hints,
        toolName: 'interaction',
        toolKind: 'other',
        legacyRequestKind: 'user_question',
        summary: questionText,
        diffPreview: null,
        riskLevel: securityWarnings.length > 0 ? 'high' : 'low',
        rawInput: Object.keys(rawInput).length > 0 ? rawInput : toolCall,
        options,
        securityWarnings,
        allowsFreeText: false,
        questionText,
        canAnswer,
        ...(unsupportedReason ? { unsupportedReason } : {}),
        dedupKey: toolCallId ?? `question:${questionText.slice(0, 64)}`,
      },
    };
  }

  const toolKind = mapToolKind(asNonEmptyString(toolCall.kind));
  const toolName =
    asNonEmptyString(toolCall.title) ??
    asNonEmptyString(params.title) ??
    asNonEmptyString(toolCall.kind) ??
    'Tool Permission';
  const baseSummary =
    asNonEmptyString(params.description) ??
    asNonEmptyString(toolCall.title) ??
    asNonEmptyString(params.title) ??
    'Permission requested by AGY';
  const summary =
    securityWarnings.length > 0 ? `${baseSummary} · ⚠️ ${securityWarnings[0]}` : baseSummary;
  const legacyRequestKind: RuntimeRequestKind =
    toolKind === 'file_edit'
      ? 'file_change_approval'
      : toolKind === 'mcp'
        ? 'mcp_tool_approval'
        : 'command_approval';
  const diffPreview = extractDiffPreview(toolCall);

  return {
    ok: true,
    parsed: {
      method: SUPPORTED_PERMISSION_METHOD,
      kind: 'permission',
      actualNativeSessionId,
      ...(toolCallId ? { toolCallId } : {}),
      ...hints,
      toolName,
      toolKind,
      legacyRequestKind,
      summary,
      diffPreview,
      riskLevel: classifyBaseRisk(toolKind, securityWarnings),
      rawInput: Object.keys(rawInput).length > 0 ? rawInput : toolCall,
      options,
      securityWarnings,
      allowsFreeText: false,
      canAnswer: options.length > 0,
      dedupKey: toolCallId ?? `perm:${toolName}`,
    },
  };
}

const VALID_STRING_FORMATS = new Set<NativeElicitationStringFormat>([
  'email',
  'uri',
  'date',
  'date-time',
]);

function parseElicitationRequest(
  method: string,
  params: Record<string, unknown>,
  opts: {
    readonly defaultNativeSessionId?: string | null;
    readonly rejectUrlElicitationMode?: boolean;
  },
): ParseWireRequestResult {
  const rawMode = asNonEmptyString(params.mode) ?? 'form';
  if (rawMode !== 'form' && rawMode !== 'url') {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: `Unsupported elicitation mode "${rawMode}"`,
      },
    };
  }
  if (rawMode === 'url' && opts.rejectUrlElicitationMode !== false) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_METHOD_NOT_FOUND,
        message: 'URL elicitation mode is not supported by this ACP client',
      },
    };
  }

  const message = asNonEmptyString(params.message);
  if (!message) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: `${method} requires a non-empty string message`,
      },
    };
  }

  const actualNativeSessionId =
    asNonEmptyString(params.sessionId) ?? asNonEmptyString(opts.defaultNativeSessionId);
  if (!actualNativeSessionId) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: `${method} requires a sessionId or active root native session`,
      },
    };
  }

  const hints = extractMetaHints(params, {});

  if (rawMode === 'url') {
    const formSpec: NativeElicitationFormSpec = {
      message,
      mode: 'url',
      fields: [],
      requiredFields: [],
      additionalProperties: false,
      supported: false,
      unsupportedReason: 'url_elicitation_mode_unsupported',
    };
    return {
      ok: true,
      parsed: {
        method,
        kind: 'elicitation',
        actualNativeSessionId,
        ...hints,
        toolName: 'elicitation',
        toolKind: 'other',
        legacyRequestKind: 'user_question',
        summary: message,
        diffPreview: null,
        riskLevel: 'low',
        rawInput: { message, mode: 'url' },
        options: [
          {
            optionId: 'decline',
            name: '拒绝',
            kind: 'decline',
            scopeWidening: false,
          },
        ],
        securityWarnings: [],
        allowsFreeText: false,
        questionText: message,
        formSpec,
        canAnswer: false,
        unsupportedReason: 'url_elicitation_mode_unsupported',
        dedupKey: `elicit:${message.slice(0, 64)}`,
      },
    };
  }

  const requestedSchema = params.requestedSchema;
  if (!isRecord(requestedSchema) || requestedSchema.type !== 'object' || !isRecord(requestedSchema.properties)) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: `${method} requires requestedSchema with type="object" and a properties map`,
      },
    };
  }

  const requiredSet = new Set<string>();
  if (requestedSchema.required !== undefined) {
    if (!Array.isArray(requestedSchema.required)) {
      return {
        ok: false,
        rpcError: {
          code: JSON_RPC_INVALID_PARAMS,
          message: 'requestedSchema.required must be an array of strings',
        },
      };
    }
    for (const reqField of requestedSchema.required) {
      if (typeof reqField !== 'string' || !reqField.trim()) {
        return {
          ok: false,
          rpcError: {
            code: JSON_RPC_INVALID_PARAMS,
            message: 'requestedSchema.required must contain non-empty field names',
          },
        };
      }
      requiredSet.add(reqField);
    }
  }

  const propertyEntries = Object.entries(requestedSchema.properties);
  if (propertyEntries.length === 0) {
    return {
      ok: false,
      rpcError: {
        code: JSON_RPC_INVALID_PARAMS,
        message: 'requestedSchema.properties must declare at least one field',
      },
    };
  }

  const fields: NativeElicitationFieldSchema[] = [];
  let unsupportedFieldReason: string | undefined;

  for (const [fieldName, rawField] of propertyEntries) {
    if (!fieldName.trim() || fieldName.length > 128 || !isRecord(rawField)) {
      return {
        ok: false,
        rpcError: {
          code: JSON_RPC_INVALID_PARAMS,
          message: `Invalid field schema for "${fieldName}"`,
        },
      };
    }
    const rawType = asNonEmptyString(rawField.type);
    const title = asNonEmptyString(rawField.title);
    const description = asNonEmptyString(rawField.description);
    const required = requiredSet.has(fieldName);

    if (rawType === 'string') {
      const rawEnum = rawField.enum;
      const enumVals = Array.isArray(rawEnum)
        ? rawEnum.filter((v): v is string => typeof v === 'string')
        : undefined;
      if (rawEnum !== undefined && (!Array.isArray(rawEnum) || !enumVals || enumVals.length !== rawEnum.length || enumVals.length === 0)) {
        return {
          ok: false,
          rpcError: {
            code: JSON_RPC_INVALID_PARAMS,
            message: `Invalid string enum definition for "${fieldName}"`,
          },
        };
      }
      const enumNames = Array.isArray(rawField.enumNames)
        ? rawField.enumNames.filter((v): v is string => typeof v === 'string')
        : undefined;
      const rawFormat = asNonEmptyString(rawField.format);
      const format =
        rawFormat && VALID_STRING_FORMATS.has(rawFormat as NativeElicitationStringFormat)
          ? (rawFormat as NativeElicitationStringFormat)
          : undefined;
      fields.push({
        name: fieldName,
        type: 'string',
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        required,
        ...(enumVals ? { enum: enumVals } : {}),
        ...(enumNames ? { enumNames } : {}),
        ...(typeof rawField.minLength === 'number' && Number.isInteger(rawField.minLength)
          ? { minLength: rawField.minLength }
          : {}),
        ...(typeof rawField.maxLength === 'number' && Number.isInteger(rawField.maxLength)
          ? { maxLength: rawField.maxLength }
          : {}),
        ...(format ? { format } : {}),
        ...(typeof rawField.default === 'string' ? { defaultValue: rawField.default } : {}),
      });
    } else if (rawType === 'number' || rawType === 'integer') {
      fields.push({
        name: fieldName,
        type: rawType,
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        required,
        ...(typeof rawField.minimum === 'number' && Number.isFinite(rawField.minimum)
          ? { minimum: rawField.minimum }
          : {}),
        ...(typeof rawField.maximum === 'number' && Number.isFinite(rawField.maximum)
          ? { maximum: rawField.maximum }
          : {}),
        ...(typeof rawField.default === 'number' && Number.isFinite(rawField.default)
          ? { defaultValue: rawField.default }
          : {}),
      });
    } else if (rawType === 'boolean') {
      fields.push({
        name: fieldName,
        type: 'boolean',
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        required,
        ...(typeof rawField.default === 'boolean' ? { defaultValue: rawField.default } : {}),
      });
    } else if (rawType === 'array') {
      const items = isRecord(rawField.items) ? rawField.items : null;
      if (!items || items.type !== 'string') {
        unsupportedFieldReason = `unsupported_elicitation_field:${fieldName}:array_non_string`;
        continue;
      }
      const enumVals = Array.isArray(items.enum)
        ? items.enum.filter((v): v is string => typeof v === 'string')
        : undefined;
      fields.push({
        name: fieldName,
        type: 'string_array',
        ...(title ? { title } : {}),
        ...(description ? { description } : {}),
        required,
        ...(enumVals && enumVals.length > 0 ? { enum: enumVals } : {}),
        ...(Array.isArray(rawField.default) && rawField.default.every((v) => typeof v === 'string')
          ? { defaultValue: rawField.default as string[] }
          : {}),
      });
    } else {
      unsupportedFieldReason = `unsupported_elicitation_field:${fieldName}:${rawType ?? 'unknown'}`;
    }
  }

  const supported = unsupportedFieldReason === undefined && fields.length > 0;
  const allowsFreeText =
    supported && fields.some((f) => f.type === 'string' && (!f.enum || f.enum.length === 0));

  const formSpec: NativeElicitationFormSpec = {
    message,
    mode: 'form',
    fields,
    requiredFields: [...requiredSet],
    additionalProperties: requestedSchema.additionalProperties === true,
    supported,
    ...(unsupportedFieldReason ? { unsupportedReason: unsupportedFieldReason } : {}),
  };

  return {
    ok: true,
    parsed: {
      method,
      kind: 'elicitation',
      actualNativeSessionId,
      ...hints,
      toolName: 'elicitation',
      toolKind: 'other',
      legacyRequestKind: 'user_question',
      summary: message,
      diffPreview: null,
      riskLevel: 'low',
      rawInput: { message, fieldNames: fields.map((f) => f.name) },
      options: [
        {
          optionId: 'decline',
          name: '拒绝',
          kind: 'decline',
          scopeWidening: false,
        },
      ],
      securityWarnings: [],
      allowsFreeText,
      questionText: message,
      formSpec,
      canAnswer: supported,
      ...(unsupportedFieldReason ? { unsupportedReason: unsupportedFieldReason } : {}),
      dedupKey: `elicit:${message.slice(0, 64)}`,
    },
  };
}

export function parseIncomingWireRequest(
  method: string,
  params: Record<string, unknown>,
  opts: {
    readonly defaultNativeSessionId?: string | null;
    readonly rejectUrlElicitationMode?: boolean;
  } = {},
): ParseWireRequestResult {
  if (method === SUPPORTED_PERMISSION_METHOD) {
    return parsePermissionRequest(params);
  }
  if (SUPPORTED_ELICITATION_METHODS.has(method)) {
    return parseElicitationRequest(method, params, opts);
  }
  return {
    ok: false,
    rpcError: {
      code: JSON_RPC_METHOD_NOT_FOUND,
      message: `Unsupported ACP client request method: ${method}`,
    },
  };
}

function validateStringFormat(value: string, format: NativeElicitationStringFormat): boolean {
  switch (format) {
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case 'uri':
      try {
        const u = new URL(value);
        return Boolean(u.protocol);
      } catch {
        return false;
      }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
    case 'date-time':
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value) && !Number.isNaN(Date.parse(value));
  }
}

export function validateElicitationFormPayload(
  formSpec: NativeElicitationFormSpec,
  formPayload: Record<string, string | number | boolean | string[]>,
): Record<string, string | number | boolean | string[]> {
  if (!formSpec.supported) {
    throw new NativeRequestValidationError(
      'UNSUPPORTED_FORM',
      `Elicitation form is not supported for submission (${formSpec.unsupportedReason ?? 'unsupported'})`,
      { reason: formSpec.unsupportedReason ?? 'unsupported' },
    );
  }

  const fieldMap = new Map(formSpec.fields.map((f) => [f.name, f]));

  if (!formSpec.additionalProperties) {
    for (const key of Object.keys(formPayload)) {
      if (!fieldMap.has(key)) {
        throw new NativeRequestValidationError(
          'FORM_SCHEMA_INVALID',
          `Unknown form field "${key}" is not allowed by requestedSchema`,
          { field: key },
        );
      }
    }
  }

  const validated: Record<string, string | number | boolean | string[]> = {};

  for (const field of formSpec.fields) {
    const raw = formPayload[field.name];
    if (raw === undefined) {
      if (field.required) {
        throw new NativeRequestValidationError(
          'FORM_SCHEMA_INVALID',
          `Required elicitation field "${field.name}" is missing`,
          { field: field.name },
        );
      }
      continue;
    }

    switch (field.type) {
      case 'string': {
        if (typeof raw !== 'string') {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be a string`,
            { field: field.name },
          );
        }
        if (field.required && raw.trim().length === 0) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Required field "${field.name}" must not be empty`,
            { field: field.name },
          );
        }
        if (field.minLength !== undefined && raw.length < field.minLength) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be at least ${field.minLength} characters`,
            { field: field.name, minLength: field.minLength },
          );
        }
        if (field.maxLength !== undefined && raw.length > field.maxLength) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be at most ${field.maxLength} characters`,
            { field: field.name, maxLength: field.maxLength },
          );
        }
        if (field.enum && !field.enum.includes(raw)) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" value "${raw}" is not in allowed enum values`,
            { field: field.name },
          );
        }
        if (field.format && !validateStringFormat(raw, field.format)) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" does not match format "${field.format}"`,
            { field: field.name, format: field.format },
          );
        }
        validated[field.name] = raw;
        break;
      }
      case 'number':
      case 'integer': {
        if (typeof raw !== 'number' || !Number.isFinite(raw)) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be a finite ${field.type}`,
            { field: field.name },
          );
        }
        if (field.type === 'integer' && !Number.isInteger(raw)) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be an integer`,
            { field: field.name },
          );
        }
        if (field.minimum !== undefined && raw < field.minimum) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be >= ${field.minimum}`,
            { field: field.name, minimum: field.minimum },
          );
        }
        if (field.maximum !== undefined && raw > field.maximum) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be <= ${field.maximum}`,
            { field: field.name, maximum: field.maximum },
          );
        }
        validated[field.name] = raw;
        break;
      }
      case 'boolean': {
        if (typeof raw !== 'boolean') {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be a boolean`,
            { field: field.name },
          );
        }
        validated[field.name] = raw;
        break;
      }
      case 'string_array': {
        if (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string')) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Field "${field.name}" must be an array of strings`,
            { field: field.name },
          );
        }
        if (field.required && raw.length === 0) {
          throw new NativeRequestValidationError(
            'FORM_SCHEMA_INVALID',
            `Required field "${field.name}" must include at least one selection`,
            { field: field.name },
          );
        }
        if (field.enum) {
          for (const item of raw) {
            if (!field.enum.includes(item)) {
              throw new NativeRequestValidationError(
                'FORM_SCHEMA_INVALID',
                `Field "${field.name}" contains disallowed item "${item}"`,
                { field: field.name },
              );
            }
          }
        }
        validated[field.name] = [...raw];
        break;
      }
    }
  }

  if (formSpec.additionalProperties) {
    for (const [k, v] of Object.entries(formPayload)) {
      if (!(k in validated)) {
        validated[k] = v;
      }
    }
  }

  return validated;
}

export function buildCancelWireResponse(kind: NativeRequestKind): Record<string, unknown> {
  if (kind === 'elicitation') {
    return { action: 'cancel' };
  }
  return { outcome: { outcome: 'cancelled' } };
}

export function encodeNativeWireResponse(
  record: {
    readonly kind: NativeRequestKind;
    readonly scope: string;
    readonly targetLineage: string;
    readonly options: readonly NativeRequestOption[];
    readonly allowedOptionIds: readonly string[];
    readonly allowsFreeText: boolean;
    readonly formSpec?: NativeElicitationFormSpec;
    readonly canAnswer: boolean;
    readonly unsupportedReason?: string;
  },
  request: ResolveNativeRequestInput,
): Record<string, unknown> {
  if (request.outcome === 'cancelled') {
    return buildCancelWireResponse(record.kind);
  }

  if (request.outcome === 'selected') {
    const optionId = request.optionId;
    if (!optionId) {
      throw new NativeRequestValidationError(
        'INVALID_OPTION',
        'optionId is required when outcome is "selected"',
      );
    }

    if (!record.allowedOptionIds.includes(optionId)) {
      const originalOption = record.options.find((o) => o.optionId === optionId);
      if (originalOption && (record.scope === 'unknown_child' || record.targetLineage !== 'confirmed')) {
        throw new NativeRequestValidationError(
          'UNKNOWN_CHILD_WIDENING_BLOCKED',
          `Option "${optionId}" is blocked because target scope/lineage is not confirmed`,
          { optionId, scope: record.scope, targetLineage: record.targetLineage },
        );
      }
      throw new NativeRequestValidationError(
        'INVALID_OPTION',
        `Option "${optionId}" is not in allowedOptionIds`,
        { optionId },
      );
    }

    if (record.kind === 'elicitation') {
      if (optionId === 'decline') {
        return { action: 'decline' };
      }
      throw new NativeRequestValidationError(
        'INVALID_OPTION',
        `Unsupported optionId "${optionId}" for elicitation request`,
        { optionId },
      );
    }

    return {
      outcome: {
        outcome: 'selected',
        optionId,
      },
    };
  }

  // outcome === 'form_submitted'
  if (record.kind !== 'elicitation') {
    throw new NativeRequestValidationError(
      'FREE_TEXT_NOT_SUPPORTED',
      `Free-text / form submission is not supported for ${record.kind} requests on ACP v1 permission wire; select a declared native optionId or cancel`,
      { kind: record.kind },
    );
  }

  if (record.scope === 'unknown_child' || record.targetLineage === 'conflicting') {
    throw new NativeRequestValidationError(
      'UNKNOWN_CHILD_WIDENING_BLOCKED',
      'Form submission is blocked for unconfirmed or conflicting child target',
      { scope: record.scope, targetLineage: record.targetLineage },
    );
  }

  if (!record.formSpec || !record.canAnswer) {
    throw new NativeRequestValidationError(
      'UNSUPPORTED_FORM',
      `Elicitation form cannot be submitted (${record.unsupportedReason ?? 'unsupported'})`,
    );
  }

  if (!request.formPayload) {
    throw new NativeRequestValidationError(
      'FORM_SCHEMA_INVALID',
      'formPayload is required when outcome is "form_submitted"',
    );
  }

  const validated = validateElicitationFormPayload(record.formSpec, request.formPayload);
  return {
    action: 'accept',
    content: validated,
  };
}
