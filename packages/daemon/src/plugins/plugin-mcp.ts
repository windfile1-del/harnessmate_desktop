import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DelegateSubagentRequestSchema } from '@harnessmate/protocol';
import { HandoffRedactionError, HandoffRedactor } from '../core/handoff-redactor.js';
import { ORCHESTRATOR_PLUGIN_ID, type OrchestratorService } from '../core/orchestrator-service.js';
import type { HarnessMateStore } from '../db/sqlite.js';
import { isLoopbackAddress } from '../server/auth.js';
import type { PluginCapabilities } from './plugin-capabilities.js';

export const pluginMcpPath = '/api/v1/plugin-tools';
const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const messageSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(), params: z.record(z.unknown()).optional(),
});
const callSchema = z.object({ name: z.string(), arguments: z.record(z.unknown()).default({}) });

const sessionReadArgsSchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    itemId: z.string().min(1).optional(),
    afterSeq: z.number().int().nonnegative().optional(),
    beforeSeq: z.number().int().positive().optional(),
    blockTypes: z.array(z.string().min(1)).max(20).optional(),
    limit: z.number().int().min(1).max(50).default(10),
    textOffset: z.number().int().nonnegative().default(0),
    maxChars: z.number().int().min(100).max(32_000).default(8_000),
  })
  .strict();

const hmSessionReadDescriptor = {
  name: 'hm_session_read',
  description:
    'Read redacted turn items or truncated large tool outputs from the active unified session on demand.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      itemId: { type: 'string', minLength: 1 },
      afterSeq: { type: 'integer', minimum: 0 },
      beforeSeq: { type: 'integer', minimum: 1 },
      blockTypes: { type: 'array', items: { type: 'string', minLength: 1 }, maxItems: 20 },
      limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      textOffset: { type: 'integer', minimum: 0, default: 0 },
      maxChars: { type: 'integer', minimum: 100, maximum: 32_000, default: 8_000 },
    },
    additionalProperties: false,
  },
};

const HTML_RENDER_MAX_BYTES = 512 * 1024;

const renderHtmlArgsSchema = z
  .object({
    title: z.string().trim().min(1).max(160).default('HTML 交互预览'),
    html: z.string().min(1),
    preferredHeightPx: z.number().int().min(120).max(960).optional(),
    allowFullscreen: z.boolean().default(true),
  })
  .strict();

export const hmRenderHtmlDescriptor = {
  name: 'hm_render_html',
  description:
    'Render a self-contained interactive HTML/SVG preview card inside a strictly sandboxed chat block (max 512KB, no external network scripts).',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 160 },
      html: { type: 'string', minLength: 1 },
      preferredHeightPx: { type: 'integer', minimum: 120, maximum: 960 },
      allowFullscreen: { type: 'boolean', default: true },
    },
    required: ['html'],
    additionalProperties: false,
  },
};

function shouldExposeRenderHtml(
  capabilities: PluginCapabilities,
  store: HarnessMateStore | undefined,
  sessionId: string,
): boolean {
  if (!store) return false;
  // Expose in tools/list when hm.plugin.message-studio is explicitly installed & enabled,
  // or when the session already contains an html_render block (preserves strict V3/V4 tools/list counts).
  const cap = capabilities as unknown as {
    pluginManager?: { listInstalled?: () => Array<{ id: string; enabled: boolean }> };
    plugins?: { isPluginEnabled?: (id: string) => boolean; listInstalled?: () => Array<{ id: string; enabled: boolean }> };
  };
  if (cap.plugins?.isPluginEnabled?.('hm.plugin.message-studio')) {
    return true;
  }
  const manager = cap.pluginManager ?? cap.plugins;
  if (manager?.listInstalled?.().some((p) => p.id === 'hm.plugin.message-studio' && p.enabled)) {
    return true;
  }
  return store.listTurnItems(sessionId, { blockTypes: ['html_render'], limit: 1 }).length > 0;
}

// ── Multi-Harness Parallel Orchestrator MCP Toolkit (Conditional Exposure) ──

const hmDelegateTaskDescriptor = {
  name: 'hm_delegate_task',
  description:
    'Delegate a parallel subtask to a target harness instance. Write tasks (isolation: "worktree_write") require a Git repository and are strictly isolated in a dedicated Git Worktree; approval policy is strictly capped by the parent session.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      targetInstanceId: { type: 'string', minLength: 1 },
      roleTitle: { type: 'string', minLength: 1, maxLength: 160 },
      prompt: { type: 'string', minLength: 1, maxLength: 40000 },
      isolation: { type: 'string', enum: ['read_only', 'worktree_write'], default: 'read_only' },
      cohortId: { type: 'string', minLength: 1, maxLength: 96 },
      requestedApprovalPolicy: { type: 'string', minLength: 1, maxLength: 32 },
      model: { type: ['string', 'null'] },
      timeoutMs: { type: 'integer', minimum: 200, maximum: 3600000 },
      failFast: { type: 'boolean', default: false },
      baseBranch: { type: 'string', minLength: 1, maxLength: 120 },
    },
    required: ['targetInstanceId', 'roleTitle', 'prompt'],
    additionalProperties: false,
  },
};

const hmListSubagentsDescriptor = {
  name: 'hm_list_subagents',
  description:
    'List parallel subagents spawned by the current parent session, including concurrency quota, status, worktree branch, and diffstat.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      cohortId: { type: 'string', minLength: 1 },
      status: {
        type: 'string',
        enum: ['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'stopped'],
      },
    },
    additionalProperties: false,
  },
};

const hmGetSubagentResultDescriptor = {
  name: 'hm_get_subagent_result',
  description:
    'Fetch the latest summary, diffstat, worktree branch, and pending approvals for a specific subagent.',
  annotations: { readOnlyHint: true },
  inputSchema: {
    type: 'object',
    properties: {
      subagentId: { type: 'string', minLength: 1 },
    },
    required: ['subagentId'],
    additionalProperties: false,
  },
};

const hmSendToSubagentDescriptor = {
  name: 'hm_send_to_subagent',
  description:
    'Send a follow-up clarification or additional instruction to an existing idle subagent.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      subagentId: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1, maxLength: 40000 },
    },
    required: ['subagentId', 'text'],
    additionalProperties: false,
  },
};

const hmStopSubagentDescriptor = {
  name: 'hm_stop_subagent',
  description:
    'Stop a running subagent while preserving its isolated Git worktree and branch for inspection or manual merge-back.',
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      subagentId: { type: 'string', minLength: 1 },
      reason: { type: 'string', maxLength: 400 },
    },
    required: ['subagentId'],
    additionalProperties: false,
  },
};

export const ORCHESTRATOR_MCP_DESCRIPTORS = [
  hmDelegateTaskDescriptor,
  hmListSubagentsDescriptor,
  hmGetSubagentResultDescriptor,
  hmSendToSubagentDescriptor,
  hmStopSubagentDescriptor,
] as const;

const ORCHESTRATOR_TOOL_NAMES = new Set<string>(ORCHESTRATOR_MCP_DESCRIPTORS.map((d) => d.name));

const listSubagentsArgsSchema = z
  .object({
    cohortId: z.string().min(1).optional(),
    status: z.enum(['queued', 'running', 'awaiting_approval', 'completed', 'failed', 'stopped']).optional(),
  })
  .strict();

const getSubagentResultArgsSchema = z.object({ subagentId: z.string().min(1) }).strict();
const sendToSubagentArgsSchema = z.object({ subagentId: z.string().min(1), text: z.string().min(1).max(40_000) }).strict();
const stopSubagentArgsSchema = z
  .object({ subagentId: z.string().min(1), reason: z.string().max(400).optional() })
  .strict();

function shouldExposeOrchestratorTools(
  capabilities: PluginCapabilities,
  isOrchestratorEnabled?: () => boolean,
): boolean {
  if (isOrchestratorEnabled) return isOrchestratorEnabled();
  const cap = capabilities as unknown as {
    plugins?: { isPluginEnabled?: (id: string) => boolean };
    pluginManager?: { isPluginEnabled?: (id: string) => boolean };
  };
  return Boolean(
    cap.plugins?.isPluginEnabled?.(ORCHESTRATOR_PLUGIN_ID) ??
      cap.pluginManager?.isPluginEnabled?.(ORCHESTRATOR_PLUGIN_ID),
  );
}

function shouldExposeSessionRead(store: HarnessMateStore | undefined, sessionId: string): boolean {
  if (!store) return false;
  const session = store.getSession(sessionId);
  if (!session || session.status === 'archived') return false;
  if ((session.participatingHarnesses?.length ?? 0) > 1) return true;
  let afterSeq: number | undefined;
  while (true) {
    const batch = store.listTurnItems(sessionId, { afterSeq, limit: 2000 });
    if (batch.some((item) => item.outputOmitted)) return true;
    if (batch.length < 2000) break;
    const lastSeq = batch[batch.length - 1]!.seq;
    if (afterSeq !== undefined && lastSeq <= afterSeq) break;
    afterSeq = lastSeq;
  }
  const handoffs = store.listHandoffRecords(sessionId, 10);
  if (
    handoffs.some((rec) => {
      if (rec.fromInstanceId && rec.fromInstanceId !== rec.toInstanceId) return true;
      const omitted = rec.snapshot?.omittedItemIds;
      return Array.isArray(omitted) && omitted.length > 0;
    })
  ) {
    return true;
  }
  return false;
}

async function redactPayloadValue(
  value: unknown,
  redactor: HandoffRedactor,
  sessionId: string,
  categories: Set<string>,
): Promise<{ value: unknown; count: number }> {
  if (typeof value === 'string') {
    if (!value) return { value, count: 0 };
    const res = await redactor.redact(value, { sessionId, source: 'mcp_session_read' });
    for (const cat of res.categories) categories.add(cat);
    return { value: res.text, count: res.redactedCount };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out: unknown[] = [];
    for (const entry of value) {
      const r = await redactPayloadValue(entry, redactor, sessionId, categories);
      count += r.count;
      out.push(r.value);
    }
    return { value: out, count };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      const r = await redactPayloadValue(v, redactor, sessionId, categories);
      count += r.count;
      out[k] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}

export function registerPluginMcp(
  app: FastifyInstance,
  capabilities: PluginCapabilities,
  store?: HarnessMateStore,
  opts?: {
    redactor?: HandoffRedactor;
    getOrchestrator?: () => OrchestratorService | undefined;
    isOrchestratorEnabled?: () => boolean;
  },
) {
  const resolvedStore = store ?? (capabilities as unknown as { store?: HarnessMateStore }).store;
  const redactor = opts?.redactor ?? new HandoffRedactor();

  app.route({ method: ['GET', 'DELETE'], url: pluginMcpPath, handler: async (_request, reply) =>
    reply.code(405).header('Allow', 'POST').send() });
  app.post(pluginMcpPath, { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const lease = capabilities.getLease(request.headers.authorization);
    if (!isLoopbackAddress(request.socket.remoteAddress) || request.headers.origin || !lease) return reply.code(403).send();
    reply.header('Cache-Control', 'no-store');
    const parsed = messageSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
    const { id, method, params } = parsed.data;
    if (id === undefined) return reply.code(202).send();
    const respond = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    const failure = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return respond({ protocolVersion: typeof requested === 'string' && versions.includes(requested) ? requested : versions[0],
          serverInfo: { name: 'harnessmate_session_tools', version: '1.0.0' }, capabilities: { tools: {} } });
      }
      case 'ping': return respond({});
      case 'tools/list': {
        lease.discovered = true;
        const tools = capabilities.listLeaseTools(lease).map(({ name, description, readOnly, inputSchema }) => ({
          name,
          description,
          annotations: { readOnlyHint: readOnly },
          inputSchema,
        }));
        if (shouldExposeSessionRead(resolvedStore, lease.sessionId)) {
          tools.push(hmSessionReadDescriptor);
        }
        if (shouldExposeRenderHtml(capabilities, resolvedStore, lease.sessionId)) {
          tools.push(hmRenderHtmlDescriptor);
        }
        if (shouldExposeOrchestratorTools(capabilities, opts?.isOrchestratorEnabled)) {
          tools.push(...ORCHESTRATOR_MCP_DESCRIPTORS);
        }
        return respond({ tools });
      }
      case 'tools/call': {
        const call = callSchema.safeParse(params);
        if (!call.success) return failure(-32602, 'Invalid tool arguments');
        const session = resolvedStore?.getSession(lease.sessionId);
        if (resolvedStore && (!session || session.status === 'archived' || session.harnessId !== lease.harnessId)) {
          return respond({ content: [{ type: 'text', text: 'Harness lease mismatch' }], isError: true });
        }
        if (ORCHESTRATOR_TOOL_NAMES.has(call.data.name)) {
          if (!shouldExposeOrchestratorTools(capabilities, opts?.isOrchestratorEnabled)) {
            return respond({
              content: [{ type: 'text', text: 'Multi-Harness Parallel Orchestrator plugin is disabled' }],
              isError: true,
            });
          }
          const orchestrator = opts?.getOrchestrator?.();
          if (!orchestrator) {
            return respond({
              content: [{ type: 'text', text: 'Orchestrator service is unavailable' }],
              isError: true,
            });
          }
          try {
            const text = await handleOrchestratorToolCall(
              orchestrator,
              lease.sessionId,
              call.data.name,
              call.data.arguments,
            );
            return respond({ content: [{ type: 'text', text }] });
          } catch (error) {
            return respond({
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            });
          }
        }
        if (call.data.name === 'hm_render_html') {
          try {
            const text = handleRenderHtml(resolvedStore, lease.sessionId, lease.harnessId, call.data.arguments);
            return respond({ content: [{ type: 'text', text }] });
          } catch (error) {
            return respond({
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            });
          }
        }
        if (call.data.name === 'hm_session_read') {
          try {
            const text = await handleSessionRead(resolvedStore, redactor, lease.sessionId, lease.harnessId, call.data.arguments);
            return respond({ content: [{ type: 'text', text }] });
          } catch (error) {
            return respond({
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            });
          }
        }
        try {
          const text = await capabilities.dispatchLeaseTool(lease, call.data.name, call.data.arguments);
          return respond({ content: [{ type: 'text', text }] });
        } catch (error) {
          return respond({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default: return failure(-32601, 'Method not found');
    }
  });
}

function handleRenderHtml(
  store: HarnessMateStore | undefined,
  leaseSessionId: string,
  leaseHarnessId: string,
  rawArgs: Record<string, unknown>,
): string {
  if (!store) {
    throw new Error('Session store unavailable for hm_render_html');
  }
  const parsed = renderHtmlArgsSchema.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(
      `Invalid hm_render_html arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const args = parsed.data;
  const byteLength = Buffer.byteLength(args.html, 'utf8');
  if (byteLength > HTML_RENDER_MAX_BYTES) {
    throw new Error(
      `HTML payload (${byteLength} bytes) exceeds maximum allowed size (${HTML_RENDER_MAX_BYTES} bytes)`,
    );
  }
  const session = store.getSession(leaseSessionId);
  if (!session || session.status === 'archived') {
    throw new Error('Session is missing or archived');
  }
  const runs = store.listSessionRuns(leaseSessionId, 1);
  const turnId = runs[0]?.turnId ?? null;
  const now = Date.now();
  const renderId = `html_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  store.upsertTurnItem({
    itemId: `html:${renderId}`,
    schemaVersion: 2,
    sessionId: leaseSessionId,
    turnId,
    seq: session.lastSeq,
    instanceId: leaseHarnessId,
    driverId: session.harnessKind,
    blockType: 'html_render',
    status: 'completed',
    title: args.title,
    textBody: args.html,
    payload: {
      renderId,
      title: args.title,
      html: args.html,
      preferredHeightPx: args.preferredHeightPx,
      allowFullscreen: args.allowFullscreen,
      byteLength,
    },
    outputOmitted: false,
    omittedBytes: 0,
    createdAt: now,
    updatedAt: now,
  });

  return JSON.stringify({
    ok: true,
    renderId,
    itemId: `html:${renderId}`,
    title: args.title,
    byteLength,
  });
}

async function handleSessionRead(
  store: HarnessMateStore | undefined,
  redactor: HandoffRedactor,
  leaseSessionId: string,
  leaseHarnessId: string,
  rawArgs: Record<string, unknown>,
): Promise<string> {
  if (!store) {
    throw new Error('Session store unavailable for hm_session_read');
  }
  const argsParsed = sessionReadArgsSchema.safeParse(rawArgs);
  if (!argsParsed.success) {
    throw new Error(`Invalid hm_session_read arguments: ${argsParsed.error.issues.map((i) => i.message).join('; ')}`);
  }
  const args = argsParsed.data;
  if (args.sessionId && args.sessionId !== leaseSessionId) {
    throw new Error('Session ID mismatch');
  }

  const session = store.getSession(leaseSessionId);
  if (!session || session.status === 'archived') {
    throw new Error('Session is missing or archived');
  }
  if (session.harnessId !== leaseHarnessId) {
    throw new Error('Harness lease mismatch');
  }
  if (session.status !== 'running' && session.status !== 'awaiting_approval') {
    throw new Error('hm_session_read is only available during an active session turn');
  }

  let redactedCount = 0;
  const redactedCategories = new Set<string>();
  const redactString = async (text: string): Promise<string> => {
    if (!text) return text;
    const res = await redactor.redact(text, { sessionId: leaseSessionId, source: 'mcp_session_read' });
    redactedCount += res.redactedCount;
    for (const cat of res.categories) redactedCategories.add(cat);
    return res.text;
  };

  if (args.itemId) {
    const item = store.getTurnItem(args.itemId);
    if (!item || item.sessionId !== leaseSessionId) {
      throw new Error(`Turn item not found in session: ${args.itemId}`);
    }
    if (item.blockType === 'reasoning') {
      throw new Error('Reasoning items are non-portable and excluded from hm_session_read');
    }
    const totalChars = item.textBody.length;
    const start = Math.min(args.textOffset, totalChars);
    const end = Math.min(start + args.maxChars, totalChars);
    const slice = item.textBody.slice(start, end);
    const hasMore = end < totalChars;
    const nextTextOffset = hasMore ? end : null;

    const safeTitle = await redactString(item.title);
    const safeBody = await redactString(slice);
    const safePayloadRes = await redactPayloadValue(item.payload, redactor, leaseSessionId, redactedCategories);
    redactedCount += safePayloadRes.count;

    return JSON.stringify({
      sessionId: leaseSessionId,
      item: {
        itemId: item.itemId,
        turnId: item.turnId,
        seq: item.seq,
        instanceId: item.instanceId,
        driverId: item.driverId,
        blockType: item.blockType,
        status: item.status,
        title: safeTitle,
        textBody: safeBody,
        payload: safePayloadRes.value,
        totalChars,
        textOffset: start,
        returnedChars: slice.length,
        hasMore,
        nextTextOffset,
        outputOmitted: item.outputOmitted,
        omittedBytes: item.omittedBytes,
      },
      redactedCount,
      redactedCategories: [...redactedCategories],
    });
  }

  const rawItems = store.listTurnItems(leaseSessionId, {
    afterSeq: args.afterSeq,
    blockTypes: args.blockTypes,
    limit: 2000,
  });
  const filtered = rawItems.filter(
    (item) =>
      item.blockType !== 'reasoning' &&
      (args.beforeSeq === undefined || item.seq < args.beforeSeq),
  );
  const page = filtered.slice(0, args.limit);
  let remainingChars = args.maxChars;
  let stoppedForMaxChars = false;
  let lastFullyReadSeq: number | null = null;
  let hasAnyTruncatedItem = false;
  const items: Array<Record<string, unknown>> = [];
  for (const item of page) {
    if (remainingChars <= 0) {
      stoppedForMaxChars = true;
      break;
    }
    const totalChars = item.textBody.length;
    const start = Math.min(args.textOffset, totalChars);
    const sliceLen = Math.max(0, Math.min(remainingChars, totalChars - start));
    const end = start + sliceLen;
    const slice = item.textBody.slice(start, end);
    remainingChars = Math.max(0, remainingChars - slice.length);
    const itemHasMore = end < totalChars;
    if (itemHasMore) {
      hasAnyTruncatedItem = true;
    } else {
      lastFullyReadSeq = item.seq;
    }

    const safeTitle = await redactString(item.title);
    const safeBody = await redactString(slice);
    const safePayloadRes = await redactPayloadValue(item.payload, redactor, leaseSessionId, redactedCategories);
    redactedCount += safePayloadRes.count;

    items.push({
      itemId: item.itemId,
      turnId: item.turnId,
      seq: item.seq,
      instanceId: item.instanceId,
      driverId: item.driverId,
      blockType: item.blockType,
      status: item.status,
      title: safeTitle,
      textBody: safeBody,
      payload: safePayloadRes.value,
      totalChars,
      textOffset: start,
      returnedChars: slice.length,
      hasMore: itemHasMore,
      nextTextOffset: itemHasMore ? end : null,
      outputOmitted: item.outputOmitted,
      omittedBytes: item.omittedBytes,
    });
  }

  const hasMoreItems = stoppedForMaxChars || hasAnyTruncatedItem || filtered.length > items.length;
  const nextAfterSeq = hasMoreItems ? lastFullyReadSeq : null;

  // Ensure HandoffRedactionError is never swallowed silently
  if (redactedCount < 0) {
    throw new HandoffRedactionError('Invalid redaction count');
  }

  return JSON.stringify({
    sessionId: leaseSessionId,
    items,
    totalMatched: filtered.length,
    hasMore: hasMoreItems,
    nextAfterSeq,
    redactedCount,
    redactedCategories: [...redactedCategories],
  });
}

async function handleOrchestratorToolCall(
  orchestrator: OrchestratorService,
  parentSessionId: string,
  toolName: string,
  rawArgs: Record<string, unknown>,
): Promise<string> {
  switch (toolName) {
    case 'hm_delegate_task': {
      const parsed = DelegateSubagentRequestSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(
          `Invalid hm_delegate_task arguments: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
        );
      }
      const subagent = await orchestrator.delegateTask(parentSessionId, parsed.data);
      return JSON.stringify({
        ok: true,
        subagent,
      });
    }
    case 'hm_list_subagents': {
      const parsed = listSubagentsArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid hm_list_subagents arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      }
      const board = orchestrator.getBoard(parentSessionId);
      const subagents = orchestrator.listSubagents(parentSessionId, parsed.data);
      return JSON.stringify({
        parentSessionId,
        activeCount: board.activeCount,
        maxConcurrent: board.maxConcurrent,
        maxDepth: board.maxDepth,
        subagents,
      });
    }
    case 'hm_get_subagent_result': {
      const parsed = getSubagentResultArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid hm_get_subagent_result arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      }
      const result = orchestrator.getSubagentResult(parsed.data.subagentId);
      if (result.subagent.parentSessionId !== parentSessionId) {
        throw new Error(`Subagent ${parsed.data.subagentId} does not belong to parent session ${parentSessionId}`);
      }
      return JSON.stringify(result);
    }
    case 'hm_send_to_subagent': {
      const parsed = sendToSubagentArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid hm_send_to_subagent arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      }
      const existing = orchestrator.getSubagentResult(parsed.data.subagentId);
      if (existing.subagent.parentSessionId !== parentSessionId) {
        throw new Error(`Subagent ${parsed.data.subagentId} does not belong to parent session ${parentSessionId}`);
      }
      const res = await orchestrator.sendToSubagent(parsed.data.subagentId, parsed.data.text);
      return JSON.stringify({ ok: true, ...res });
    }
    case 'hm_stop_subagent': {
      const parsed = stopSubagentArgsSchema.safeParse(rawArgs);
      if (!parsed.success) {
        throw new Error(`Invalid hm_stop_subagent arguments: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
      }
      const existing = orchestrator.getSubagentResult(parsed.data.subagentId);
      if (existing.subagent.parentSessionId !== parentSessionId) {
        throw new Error(`Subagent ${parsed.data.subagentId} does not belong to parent session ${parentSessionId}`);
      }
      const subagent = await orchestrator.stopSubagent(parsed.data.subagentId, parsed.data.reason);
      return JSON.stringify({ ok: true, subagent });
    }
    default:
      throw new Error(`Unknown orchestrator tool: ${toolName}`);
  }
}
