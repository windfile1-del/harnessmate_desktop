import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isLoopbackAddress } from '../server/auth.js';
import type { PluginCapabilities } from './plugin-capabilities.js';
import { pluginTextLimit } from './plugin-program.js';

export const pluginMcpPath = '/api/v1/plugin-tools';
const versions = ['2025-11-25', '2025-06-18', '2025-03-26'];
const messageSchema = z.object({
  jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]).optional(),
  method: z.string(), params: z.record(z.unknown()).optional(),
});
const callSchema = z.object({ name: z.string(), arguments: z.object({ text: z.string().max(pluginTextLimit) }).strict() });

export function registerPluginMcp(app: FastifyInstance, capabilities: PluginCapabilities) {
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
        return respond({ tools: capabilities.listLeaseTools(lease).map(({ name, program }) => ({
          name, description: program.description, annotations: { readOnlyHint: true },
          inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: pluginTextLimit } },
            required: ['text'], additionalProperties: false },
        })) });
      }
      case 'tools/call': {
        const call = callSchema.safeParse(params);
        if (!call.success) return failure(-32602, 'Invalid tool arguments');
        try {
          const text = capabilities.invokeTool(lease, call.data.name, call.data.arguments.text);
          return respond({ content: [{ type: 'text', text }] });
        } catch (error) {
          return respond({ content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true });
        }
      }
      default: return failure(-32601, 'Method not found');
    }
  });
}
