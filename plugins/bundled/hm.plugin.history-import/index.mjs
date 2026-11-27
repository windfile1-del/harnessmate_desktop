import { createHash, randomUUID } from 'node:crypto';

export const requires = ['ui.workspace.pages'];

const SOURCE_CONTRACT = 'history.source.v1';
const IMPORT_CONTRACT = 'history.import.v1';
const SESSION_DATA_CONTRACTS = ['session.data.v1', 'hm.session-data.v1'];
const MAX_READ_PAGES = 200;
const READ_PAGE_LIMIT = 200;

function ok(value) {
  return { ok: true, value };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

function hashImportRequest(req) {
  const canonical = JSON.stringify({
    input: req.input,
    workspaceId: req.workspaceId ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function isValidRef(ref) {
  return (
    ref &&
    typeof ref === 'object' &&
    typeof ref.sourceInstanceId === 'string' &&
    ref.sourceInstanceId.trim().length > 0 &&
    typeof ref.sourceId === 'string' &&
    ref.sourceId.trim().length > 0 &&
    typeof ref.nativeSessionId === 'string' &&
    ref.nativeSessionId.trim().length > 0
  );
}

function extractBundlePreviewItems(bundle) {
  const items = [];
  if (Array.isArray(bundle?.items) && bundle.items.length > 0) {
    for (const item of bundle.items) {
      if (!item || item.blockType === 'secret_request') continue;
      if (item.blockType === 'runtime_request' && item.payload?.kind === 'secret_request') continue;
      const text = typeof item.textBody === 'string' ? item.textBody.trim() : '';
      if (!text) continue;
      items.push({
        itemId: String(item.itemId ?? `bundle-item-${items.length + 1}`),
        role: item.blockType === 'user_message' ? 'user' : 'assistant',
        text: item.textBody,
        ...(typeof item.createdAt === 'number' ? { timestamp: item.createdAt } : {}),
      });
      if (items.length >= 200) break;
    }
    return items;
  }

  if (Array.isArray(bundle?.events)) {
    for (const ev of bundle.events) {
      if (!ev || (ev.type !== 'message.user' && ev.type !== 'message.assistant.completed')) continue;
      const text = typeof ev.payload?.text === 'string' ? ev.payload.text.trim() : '';
      if (!text) continue;
      items.push({
        itemId: `bundle-ev-${ev.seq ?? items.length + 1}`,
        role: ev.type === 'message.user' ? 'user' : 'assistant',
        text: ev.payload.text,
        ...(typeof ev.createdAt === 'number' ? { timestamp: ev.createdAt } : {}),
      });
      if (items.length >= 200) break;
    }
  }
  return items;
}

export function apply(ctx) {
  let disposed = false;
  const inFlightByOpId = new Map();
  const opIdByRequestId = new Map();

  async function callData(method, args = []) {
    const providers = await ctx.services.list().catch(() => []);
    const contract = SESSION_DATA_CONTRACTS.find((c) => providers.some((p) => p.contract === c))
      ?? SESSION_DATA_CONTRACTS[1];
    const res = await ctx.services.call(contract, method, args);
    if (contract === 'session.data.v1') {
      if (method === 'commitNativeImport' || method === 'commitBundleImport') {
        return res;
      }
      if (res && typeof res === 'object' && 'ok' in res) {
        if (!res.ok) throw new Error(res.error?.message || `session.data.v1.${method} failed`);
        if (method === 'listWorkspaces') return res.value?.workspaces ?? [];
        return res.value;
      }
    }
    return res;
  }

  async function forwardCancelToSource(op) {
    if (!op || !op.sourceInstanceId || !op.sourceOpId) return;
    try {
      await ctx.services.call(
        SOURCE_CONTRACT,
        'cancel',
        [{ operationId: op.sourceOpId }],
        { instanceId: op.sourceInstanceId },
      );
    } catch {
      // Best-effort source cancellation
    }
  }

  ctx.effect(() => () => {
    disposed = true;
    for (const op of inFlightByOpId.values()) {
      if (op.stage === 'reading') {
        op.cancelled = true;
        void forwardCancelToSource(op);
      }
    }
    inFlightByOpId.clear();
    opIdByRequestId.clear();
  });

  async function findSummaryMeta(ref) {
    try {
      const res = await ctx.services.call(
        SOURCE_CONTRACT,
        'discover',
        [{ query: ref.nativeSessionId, limit: 50 }],
        { instanceId: ref.sourceInstanceId },
      );
      if (res?.ok && Array.isArray(res.value?.sessions)) {
        const hit = res.value.sessions.find(
          (s) => s?.ref?.nativeSessionId === ref.nativeSessionId && s?.ref?.sourceId === ref.sourceId,
        ) ?? res.value.sessions.find((s) => s?.ref?.nativeSessionId === ref.nativeSessionId);
        if (hit) return hit;
      }
    } catch {
      // Optional metadata enrichment
    }
    return null;
  }

  async function readAllPagesFromSource(ref, op, maxPages = MAX_READ_PAGES) {
    const items = [];
    const warnings = [];
    let readStatus = 'complete';
    let cursor = undefined;
    let truncatedReason = undefined;
    let lockWarning = undefined;
    let summaryMeta = null;

    for (let page = 0; page < maxPages; page++) {
      if (disposed || op?.cancelled) {
        return { ok: false, error: { code: 'cancelled', message: '已在提交前取消' } };
      }

      let res;
      try {
        res = await ctx.services.call(
          SOURCE_CONTRACT,
          'read',
          [
            {
              ref,
              ...(cursor !== undefined ? { cursor } : {}),
              limit: READ_PAGE_LIMIT,
              ...(op?.sourceOpId ? { operationId: op.sourceOpId } : {}),
            },
          ],
          { instanceId: ref.sourceInstanceId },
        );
      } catch (err) {
        if (disposed || op?.cancelled) {
          return { ok: false, error: { code: 'cancelled', message: '已在提交前取消' } };
        }
        return {
          ok: false,
          error: {
            code: 'source_unreadable',
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }

      if (disposed || op?.cancelled) {
        return { ok: false, error: { code: 'cancelled', message: '已在提交前取消' } };
      }

      if (!res || res.ok !== true || !res.value) {
        return {
          ok: false,
          error: {
            code: res?.error?.code ?? 'source_unreadable',
            message: res?.error?.message ?? '无法读取所选来源会话',
          },
        };
      }

      const val = res.value;
      if (Array.isArray(val.items)) {
        for (const item of val.items) {
          if (item && typeof item.text === 'string' && (item.role === 'user' || item.role === 'assistant')) {
            items.push(item);
          }
        }
      }
      if (Array.isArray(val.warnings)) {
        for (const w of val.warnings) {
          if (typeof w === 'string' && w && !warnings.includes(w)) warnings.push(w);
        }
      }
      if (val.readStatus === 'partial') {
        readStatus = 'partial';
      }
      if (typeof val.truncatedReason === 'string' && !truncatedReason) {
        truncatedReason = val.truncatedReason;
      }
      if (typeof val.lockWarning === 'string' && !lockWarning) {
        lockWarning = val.lockWarning;
      }
      if (val.sessionMeta && !summaryMeta) {
        summaryMeta = val.sessionMeta;
      }

      if (!val.nextCursor) break;
      cursor = val.nextCursor;
    }

    return {
      ok: true,
      value: { items, warnings, readStatus, truncatedReason, lockWarning, summaryMeta },
    };
  }

  async function preview(req) {
    if (!req || typeof req !== 'object' || !req.input || typeof req.input !== 'object') {
      return fail('invalid_request', '缺少有效的导入预览请求 input');
    }

    if (req.input.kind === 'bundle') {
      const bundle = req.input.bundle;
      if (!bundle || typeof bundle !== 'object' || bundle.bundleVersion !== 2 || !bundle.session) {
        return fail('invalid_request', '无效的便携归档包格式');
      }
      const wsInfo = await callData('resolveTargetWorkspace', [
        { kind: 'bundle', workspaceId: req.workspaceId, bundleCwd: bundle.session.cwd },
      ]);
      const items = extractBundlePreviewItems(bundle);
      return ok({
        input: req.input,
        existingSessionId: null,
        targetWorkspaceId: wsInfo.targetWorkspaceId,
        targetWorkspacePath: wsInfo.targetWorkspacePath,
        importable: wsInfo.importable,
        items,
        readStatus: 'complete',
        warnings: [],
        title: req.input.titleOverride?.trim() || bundle.session.title,
        harnessKind: bundle.session.harnessKind,
      });
    }

    if (req.input.kind !== 'native' || !isValidRef(req.input.ref)) {
      return fail('invalid_request', '无效的原生历史来源引用 ref');
    }
    const mode = req.input.mode === 'mirror' ? 'mirror' : 'attach';
    const ref = req.input.ref;

    const mapping = await callData('lookupNativeMapping', [
      {
        sourceId: ref.sourceId,
        nativeSessionId: ref.nativeSessionId,
        compatLegacySources: req.input.compatLegacySources,
      },
    ]);

    const readRes = await readAllPagesFromSource(ref, null, 1);
    if (!readRes.ok) {
      return fail(readRes.error.code, readRes.error.message);
    }

    let summaryMeta = readRes.value.summaryMeta;
    if (!summaryMeta && !req.input.cwd && !req.input.title) {
      summaryMeta = await findSummaryMeta(ref);
    }

    const cwd = req.input.cwd ?? summaryMeta?.workspaceHint?.cwd ?? null;
    const title = req.input.title ?? summaryMeta?.title ?? `Native · ${ref.nativeSessionId.slice(0, 12)}`;
    const harnessKind = req.input.harnessKind ?? summaryMeta?.harnessKind ?? 'acp';

    const wsInfo = await callData('resolveTargetWorkspace', [
      { kind: 'native', workspaceId: req.workspaceId, cwd },
    ]);
    const hasText = readRes.value.items.some((item) => item.text.trim().length > 0);
    const warnings = [...readRes.value.warnings];
    if (!wsInfo.importable && wsInfo.reason && !warnings.includes(wsInfo.reason)) {
      warnings.push(wsInfo.reason);
    }
    if (!hasText && !warnings.includes('此会话没有可导入的文本消息')) {
      warnings.push('此会话没有可导入的文本消息');
    }

    return ok({
      input: { ...req.input, mode },
      existingSessionId: mode === 'attach' ? mapping.existingSessionId : null,
      targetWorkspaceId: wsInfo.targetWorkspaceId,
      targetWorkspacePath: wsInfo.targetWorkspacePath,
      importable: Boolean(wsInfo.importable && hasText),
      items: readRes.value.items,
      readStatus: readRes.value.readStatus,
      warnings,
      title,
      harnessKind,
    });
  }

  async function performImport(req) {
    if (!req || typeof req !== 'object' || !req.input || typeof req.input !== 'object') {
      return fail('invalid_request', '缺少有效的导入请求 input');
    }
    const requestId = typeof req.requestId === 'string' && req.requestId.trim() ? req.requestId.trim() : '';
    if (!requestId) {
      return fail('invalid_request', '缺少幂等请求标识 requestId');
    }

    const requestHash = hashImportRequest(req);
    const existingReceipt = await callData('lookupReceipt', [{ requestId, requestHash }]);
    if (existingReceipt?.found) {
      if (existingReceipt.conflict) {
        return fail('conflict', `requestId ${requestId} 已绑定到不同的导入请求`);
      }
      return ok(existingReceipt.result);
    }

    if (req.input.kind === 'bundle') {
      const opId = typeof req.operationId === 'string' && req.operationId.trim() ? req.operationId.trim() : requestId;
      const op = { opId, requestId, stage: 'committing', cancelled: false };
      inFlightByOpId.set(opId, op);
      opIdByRequestId.set(requestId, opId);
      try {
        return await callData('commitBundleImport', [
          {
            requestId,
            requestHash,
            bundle: req.input.bundle,
            workspaceId: req.workspaceId,
            titleOverride: req.input.titleOverride,
          },
        ]);
      } finally {
        inFlightByOpId.delete(opId);
        opIdByRequestId.delete(requestId);
      }
    }

    if (req.input.kind !== 'native' || !isValidRef(req.input.ref)) {
      return fail('invalid_request', '无效的原生历史来源引用 ref');
    }

    const ref = req.input.ref;
    const mode = req.input.mode === 'mirror' ? 'mirror' : 'attach';
    const opId =
      typeof req.operationId === 'string' && req.operationId.trim()
        ? req.operationId.trim()
        : `imp_${randomUUID()}`;

    const op = {
      opId,
      requestId,
      sourceInstanceId: ref.sourceInstanceId,
      sourceOpId: `src_${opId}`,
      stage: 'reading',
      cancelled: false,
    };
    inFlightByOpId.set(opId, op);
    opIdByRequestId.set(requestId, opId);

    try {
      if (mode === 'attach') {
        const existingMapping = await callData('lookupNativeMapping', [
          {
            sourceId: ref.sourceId,
            nativeSessionId: ref.nativeSessionId,
            compatLegacySources: req.input.compatLegacySources,
          },
        ]);
        if (existingMapping?.existingSessionId) {
          op.stage = 'committing';
          return await callData('commitNativeImport', [
            {
              requestId,
              requestHash,
              ref,
              mode,
              compatLegacySources: req.input.compatLegacySources,
              legacySource: req.input.legacySource,
              sourcePath: req.input.sourcePath,
              title: req.input.title,
              harnessKind: req.input.harnessKind,
              cwd: req.input.cwd,
              workspaceId: req.workspaceId,
              updatedAt: req.input.updatedAt,
              items: [{ role: 'user', text: 'existing' }],
              partial: false,
              warnings: [],
            },
          ]);
        }
      }

      const readRes = await readAllPagesFromSource(ref, op, MAX_READ_PAGES);
      if (!readRes.ok) {
        return fail(readRes.error.code, readRes.error.message);
      }
      if (disposed || op.cancelled) {
        await forwardCancelToSource(op);
        return fail('cancelled', '已在提交前取消');
      }

      let summaryMeta = readRes.value.summaryMeta;
      if (!summaryMeta && (!req.input.title || !req.input.cwd || !req.input.harnessKind)) {
        summaryMeta = await findSummaryMeta(ref);
      }
      if (disposed || op.cancelled) {
        await forwardCancelToSource(op);
        return fail('cancelled', '已在提交前取消');
      }

      const nonEmpty = readRes.value.items.filter((m) => m.text.trim().length > 0);
      if (nonEmpty.length === 0) {
        return fail('not_importable', '此会话没有可导入的文本消息');
      }

      // Transition to commit stage: once started, persistence result is authoritative.
      op.stage = 'committing';

      return await callData('commitNativeImport', [
        {
          requestId,
          requestHash,
          ref,
          mode,
          compatLegacySources: req.input.compatLegacySources,
          legacySource: req.input.legacySource ?? summaryMeta?.legacySource ?? summaryMeta?.source,
          sourcePath: req.input.sourcePath ?? summaryMeta?.sourcePath,
          title: req.input.title ?? summaryMeta?.title,
          harnessKind: req.input.harnessKind ?? summaryMeta?.harnessKind,
          cwd: req.input.cwd ?? summaryMeta?.workspaceHint?.cwd ?? null,
          workspaceId: req.workspaceId,
          updatedAt: req.input.updatedAt ?? summaryMeta?.updatedAt,
          items: nonEmpty,
          partial: readRes.value.readStatus === 'partial',
          warnings: readRes.value.warnings,
          lockWarning: readRes.value.lockWarning,
          truncatedReason: readRes.value.truncatedReason,
        },
      ]);
    } finally {
      inFlightByOpId.delete(opId);
      if (opIdByRequestId.get(requestId) === opId) {
        opIdByRequestId.delete(requestId);
      }
    }
  }

  async function cancel(req = {}) {
    const rawOpId = typeof req?.operationId === 'string' && req.operationId.trim() ? req.operationId.trim() : null;
    const rawReqId = typeof req?.requestId === 'string' && req.requestId.trim() ? req.requestId.trim() : null;
    const opId = rawOpId ?? (rawReqId ? opIdByRequestId.get(rawReqId) ?? null : null);
    const op = opId ? inFlightByOpId.get(opId) : null;

    if (!op) {
      return ok({ cancelled: false, status: 'not_found' });
    }
    if (op.stage === 'committing') {
      return ok({ cancelled: false, status: 'committing' });
    }
    op.cancelled = true;
    await forwardCancelToSource(op);
    return ok({ cancelled: true, status: 'cancelled' });
  }

  async function listSources() {
    return ctx.services.list(SOURCE_CONTRACT);
  }

  async function discover(req = {}) {
    const providers = await listSources();
    const targetId = typeof req?.sourceInstanceId === 'string' && req.sourceInstanceId.trim()
      ? req.sourceInstanceId.trim()
      : null;
    const targets = targetId ? providers.filter((p) => p.instanceId === targetId) : providers;

    const settled = await Promise.allSettled(
      targets.map(async (provider) => {
        const res = await ctx.services.call(
          SOURCE_CONTRACT,
          'discover',
          [req],
          { instanceId: provider.instanceId },
        );
        return { provider, res };
      }),
    );

    const sessions = [];
    const errors = [];
    for (let i = 0; i < settled.length; i++) {
      const entry = settled[i];
      const provider = targets[i];
      if (entry.status === 'rejected') {
        errors.push({
          instanceId: provider.instanceId,
          code: 'source_unreadable',
          message: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
        continue;
      }
      if (!entry.value.res?.ok) {
        errors.push({
          instanceId: provider.instanceId,
          code: entry.value.res?.error?.code ?? 'source_unreadable',
          message: entry.value.res?.error?.message ?? '发现失败',
        });
        continue;
      }
      for (const s of entry.value.res.value.sessions ?? []) {
        const mapping = await callData('lookupNativeMapping', [
          {
            sourceId: s.ref.sourceId,
            nativeSessionId: s.ref.nativeSessionId,
            compatLegacySources: s.compatLegacySources,
          },
        ]);
        sessions.push({
          ...s,
          alreadyImportedSessionId: mapping?.existingSessionId ?? null,
        });
      }
    }
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return ok({ sources: providers, sessions, errors });
  }

  ctx.provide(
    IMPORT_CONTRACT,
    {
      preview,
      import: performImport,
      cancel,
    },
    {
      version: '1.0.0',
      metadata: {
        title: '历史会话导入',
        slotId: 'history-import',
      },
    },
  );

  ctx.routes.register('/status', async () => ({
    status: 200,
    body: {
      ok: true,
      instanceId: ctx.instanceId,
      pluginId: ctx.pluginId,
      activeOperations: inFlightByOpId.size,
    },
  }));

  ctx.routes.register('/sources', async () => ({
    status: 200,
    body: { ok: true, value: { sources: await listSources() } },
  }));

  ctx.routes.register('/workspaces', async () => ({
    status: 200,
    body: { ok: true, value: { workspaces: await callData('listWorkspaces', []) } },
  }));

  ctx.routes.register('/discover', async (req) => ({
    status: 200,
    body: await discover(req.body ?? {}),
  }));

  ctx.routes.register('/preview', async (req) => ({
    status: 200,
    body: await preview(req.body ?? {}),
  }));

  ctx.routes.register('/import', async (req) => ({
    status: 200,
    body: await performImport(req.body ?? {}),
  }));

  ctx.routes.register('/cancel', async (req) => ({
    status: 200,
    body: await cancel(req.body ?? {}),
  }));

  ctx.slots.register({
    slot: 'workspace.pages',
    id: 'history-import',
    title: '历史会话导入',
    ui: 'ui/panel.html',
    order: 30,
    async onMessage(payload) {
      if (!payload || typeof payload !== 'object') {
        return fail('invalid_request', '无效工作页消息');
      }
      const params =
        payload.params && typeof payload.params === 'object' ? payload.params : payload;
      switch (payload.type) {
        case 'status':
          return ok({
            instanceId: ctx.instanceId,
            pluginId: ctx.pluginId,
            activeOperations: inFlightByOpId.size,
          });
        case 'sources':
          return ok({ sources: await listSources() });
        case 'workspaces':
          return ok({ workspaces: await callData('listWorkspaces', []) });
        case 'discover':
          return discover(params);
        case 'preview':
          return preview(params);
        case 'import':
          return performImport(params);
        case 'cancel':
          return cancel(params);
        default:
          return fail('invalid_request', '未知导入工作页操作');
      }
    },
  });
}
