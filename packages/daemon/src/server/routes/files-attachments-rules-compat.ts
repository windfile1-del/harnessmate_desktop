import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { UploadAttachmentRequestSchema } from '@harnessmate/protocol';
import { AttachmentService, inferMimeType } from '../../core/attachment-service.js';
import type { SessionManager } from '../../core/session-manager.js';
import type { HarnessMateStore } from '../../db/sqlite.js';
import { renderLegacyFilePreview } from '../../plugin-host/compat/legacy-compat.js';
import type { PluginManager } from '../../plugins/plugin-manager.js';
import {
  httpStatusForPluginError,
  resolveSessionAttachmentsService,
  resolveWorkspaceFilesService,
  resolveWorkspaceRulesService,
  unwrapPeerServiceResult,
  type WorkspaceFilePreview,
} from '../../core/w1-service-helpers.js';

export interface FilesAttachmentsRulesCompatDeps {
  store: HarnessMateStore;
  pluginManager: PluginManager;
  sessionManager: SessionManager;
  attachmentsRoot: string;
}

export function registerFilesAttachmentsRulesCompatRoutes(
  app: FastifyInstance,
  deps: FilesAttachmentsRulesCompatDeps,
): void {
  const { pluginManager, sessionManager, attachmentsRoot } = deps;
  const legacyHistoricalReader = new AttachmentService(attachmentsRoot);

  app.post('/api/v1/sessions/:id/attachments', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) {
      return reply.code(404).send({ error: 'Session not found' });
    }
    const parsed = UploadAttachmentRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid attachment' });
    }
    try {
      const { instanceId, peer, legacy } = resolveSessionAttachmentsService(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
      });
      if (legacy && typeof (legacy as unknown as AttachmentService).saveSessionAttachment === 'function') {
        const attachment = (legacy as unknown as AttachmentService).saveSessionAttachment(id, parsed.data);
        return reply.code(201).send({ attachment, instanceId });
      }
      if (peer) {
        const res = unwrapPeerServiceResult(
          await peer.save({
            sessionId: id,
            workspaceId: session.workspaceId,
            name: parsed.data.name,
            mimeType: parsed.data.mimeType ?? 'application/octet-stream',
            base64: parsed.data.dataBase64 ?? '',
          }),
        );
        return reply.code(201).send({ attachment: res.attachment, instanceId });
      }
      return reply.code(409).send({ error: '附件服务不可用', code: 'E_SERVICE_UNAVAILABLE' });
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.get('/api/v1/attachments/:sessionId/:filename', async (request, reply) => {
    const { sessionId, filename } = request.params as { sessionId: string; filename: string };
    const session = sessionManager.getSession(sessionId);

    // 1. Try active resolved session.attachments.v1 provider first
    try {
      const { peer, legacy } = resolveSessionAttachmentsService(pluginManager, {
        workspaceId: session?.workspaceId,
        sessionId,
      });
      if (legacy && typeof (legacy as unknown as AttachmentService).resolveAttachmentFile === 'function') {
        const p = (legacy as unknown as AttachmentService).resolveAttachmentFile(sessionId, filename);
        if (p) {
          reply.header('Content-Type', inferMimeType(p));
          reply.header('Cache-Control', 'private, max-age=3600');
          return reply.send(fs.createReadStream(p));
        }
      } else if (peer && typeof peer.resolveRead === 'function') {
        const res = await peer.resolveRead({ sessionId, filename });
        if (res.ok && res.value.filePath && fs.existsSync(res.value.filePath)) {
          reply.header('Content-Type', res.value.mimeType || inferMimeType(res.value.filePath));
          reply.header('Cache-Control', 'private, max-age=3600');
          return reply.send(fs.createReadStream(res.value.filePath));
        }
      }
    } catch {
      // Fall through to legacy read-only attachment fallback so historical attachments remain readable
    }

    // 2. Legacy historical read-only storage lookup (e.g., older files or when switched/disabled)
    const fallbackPath = legacyHistoricalReader.resolveAttachmentFile(sessionId, filename);
    if (!fallbackPath) {
      return reply.code(404).send({ error: 'Attachment not found' });
    }
    reply.header('Content-Type', inferMimeType(fallbackPath));
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(fs.createReadStream(fallbackPath));
  });

  async function readSessionFileFromPlugin(
    sessionId: string,
    workspaceId: string,
    cwd: string,
    filePath: string,
    explicitInstanceId?: string,
    line?: number,
  ): Promise<WorkspaceFilePreview> {
    const { peer, legacy } = resolveWorkspaceFilesService(pluginManager, {
      workspaceId,
      sessionId,
      explicitInstanceId,
    });
    if (peer) {
      return unwrapPeerServiceResult(
        await peer.read({ workspaceId, cwd, path: filePath, line }),
      );
    }
    if (legacy?.read) {
      return await legacy.read(cwd, filePath);
    }
    throw Object.assign(new Error('工作区文件读取服务不可用'), { code: 'E_SERVICE_UNAVAILABLE' });
  }

  app.get('/api/v1/sessions/:id/files', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { q?: string; instanceId?: string };
    try {
      const { instanceId, peer, legacy } = resolveWorkspaceFilesService(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      if (peer) {
        const res = unwrapPeerServiceResult(
          await peer.search({ workspaceId: session.workspaceId, cwd: session.cwd, query: q.q ?? '', limit: 120 }),
        );
        return { files: res.files, instanceId };
      }
      if (legacy?.search) {
        const files = await legacy.search(session.cwd, q.q ?? '', 120);
        return { files, instanceId };
      }
      return reply.code(409).send({ error: '工作区文件搜索服务不可用', code: 'E_SERVICE_UNAVAILABLE' });
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.get('/api/v1/sessions/:id/file-content', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { path?: string; instanceId?: string };
    if (!q.path) return reply.code(400).send({ error: 'Missing path parameter' });
    try {
      const file = await readSessionFileFromPlugin(
        session.id,
        session.workspaceId,
        session.cwd,
        q.path,
        q.instanceId || undefined,
      );
      return {
        relativePath: file.relativePath,
        content: file.content,
        truncated: file.truncated,
        sizeBytes: file.sizeBytes,
      };
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 400);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.get('/api/v1/sessions/:id/file-preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { path?: string; line?: string; instanceId?: string };
    if (typeof q.path !== 'string' || !q.path) return reply.code(400).send({ error: 'Missing path parameter' });
    reply.header('Cache-Control', 'no-store');
    const line = Number(q.line);
    try {
      const file = await readSessionFileFromPlugin(
        session.id,
        session.workspaceId,
        session.cwd,
        q.path,
        q.instanceId || undefined,
        Number.isSafeInteger(line) && line > 0 ? line : undefined,
      );
      if (!pluginManager.filePreviewProviderId) return { preview: null };
      const preview = await renderLegacyFilePreview(pluginManager, session.workspaceId, {
        ...file,
        version: 1,
        ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
      });
      return { preview };
    } catch (error) {
      const mapped = httpStatusForPluginError(error, 400);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.get('/api/v1/sessions/:id/file-view', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = request.query as { path?: string; line?: string; instanceId?: string };
    if (typeof q.path !== 'string' || !q.path) return reply.code(400).send({ error: 'Missing path parameter' });
    reply.header('Cache-Control', 'no-store');
    const line = Number(q.line);
    try {
      const file = await readSessionFileFromPlugin(
        session.id,
        session.workspaceId,
        session.cwd,
        q.path,
        undefined,
        Number.isSafeInteger(line) && line > 0 ? line : undefined,
      );
      const rendered = await pluginManager.renderPeerFilePreview(
        session.workspaceId,
        { ...file, version: 1, ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}) },
        {
          sessionId: session.id,
          explicitInstanceId: typeof q.instanceId === 'string' && q.instanceId.trim() ? q.instanceId.trim() : undefined,
        },
      );
      return {
        file: {
          relativePath: file.relativePath,
          content: file.content,
          truncated: file.truncated,
          sizeBytes: file.sizeBytes,
        },
        ...rendered,
        availableViewers: pluginManager.listFilePreviewViewers(session.workspaceId),
      };
    } catch (error) {
      const mapped = httpStatusForPluginError(error, 400);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });

  app.get('/api/v1/sessions/:id/rules', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessionManager.getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const q = (request.query ?? {}) as { instanceId?: string };
    try {
      const { instanceId, peer, legacy } = resolveWorkspaceRulesService(pluginManager, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        explicitInstanceId: q.instanceId || undefined,
      });
      if (peer) {
        const res = unwrapPeerServiceResult(
          await peer.discover({ workspaceId: session.workspaceId, cwd: session.cwd, sessionId: session.id }),
        );
        return { instructions: res.instructions, instanceId };
      }
      if (legacy?.discoverRules) {
        const instructions = await legacy.discoverRules(session.cwd);
        return { instructions, instanceId };
      }
      return reply.code(409).send({ error: '项目规则发现服务不可用', code: 'E_SERVICE_UNAVAILABLE' });
    } catch (err) {
      const mapped = httpStatusForPluginError(err, 409);
      return reply.code(mapped.status).send({ error: mapped.message, code: mapped.code });
    }
  });
}
