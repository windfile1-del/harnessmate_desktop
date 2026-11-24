import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HandoffRedactionError, HandoffRedactor } from '../core/handoff-redactor.js';
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
  opts?: { redactor?: HandoffRedactor },
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
        return respond({ tools });
      }
      case 'tools/call': {
        const call = callSchema.safeParse(params);
        if (!call.success) return failure(-32602, 'Invalid tool arguments');
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
          const text = await capabilities.invokeTool(lease, call.data.name, call.data.arguments);
          return respond({ content: [{ type: 'text', text }] });
        } catch (error) {
          return respond({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default: return failure(-32601, 'Method not found');
    }
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
