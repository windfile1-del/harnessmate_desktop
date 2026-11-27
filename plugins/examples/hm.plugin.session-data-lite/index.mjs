export const provides = ['session.data.v1', 'hm.session-data.v1'];

const EVENT_CHUNK_SIZE = 100;
const CHANGE_BUCKET_SIZE = 100;

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function peerOk(value) {
  return { ok: true, value };
}

function peerErr(code, message) {
  return { ok: false, error: { code, message } };
}

export async function apply(ctx) {
    const instanceId = ctx.instanceId || ctx.pluginId;
    const streamId = `lite:${instanceId}`;
    const streamRef = () => ({
      providerInstanceId: instanceId,
      streamId,
      runId: ctx.runId,
    });

    let active = true;
    let writable = true;
    let opQueue = Promise.resolve();

    const serialize = (fn) => {
      const next = opQueue.then(fn, fn);
      opQueue = next.then(() => undefined, () => undefined);
      return next;
    };

    const getJson = async (key, fallback) => {
      const val = await ctx.storage.plugin.get(key);
      return val === null || val === undefined ? fallback : val;
    };

    const setJson = async (key, value) => {
      await ctx.storage.plugin.set(key, value);
    };

    const getMeta = () => getJson('meta', { latestChangeSeq: 0 });
    const setMeta = (meta) => setJson('meta', meta);

    const getWorkspaces = () => getJson('workspaces', []);
    const setWorkspaces = (list) => setJson('workspaces', list);

    const getSessionIds = () => getJson('session_index', []);
    const setSessionIds = (ids) => setJson('session_index', ids);

    const getSessionRecord = (sessionId) => getJson(`session:${sessionId}`, null);
    const setSessionRecord = (session) => setJson(`session:${session.id}`, session);

    const getBindings = (sessionId) => getJson(`bindings:${sessionId}`, []);
    const setBindings = (sessionId, list) => setJson(`bindings:${sessionId}`, list);

    const getRuns = (sessionId) => getJson(`runs:${sessionId}`, []);
    const setRuns = (sessionId, list) => setJson(`runs:${sessionId}`, list);

    const getItems = (sessionId) => getJson(`items:${sessionId}`, []);
    const setItems = (sessionId, list) => setJson(`items:${sessionId}`, list);

    const getReceipts = (sessionId) => getJson(`receipts:${sessionId}`, {});
    const setReceipts = (sessionId, map) => setJson(`receipts:${sessionId}`, map);

    const readAllEvents = async (sessionId, chunkCountHint) => {
      const events = [];
      let idx = 0;
      while (true) {
        if (typeof chunkCountHint === 'number' && idx >= chunkCountHint) break;
        const chunk = await ctx.storage.plugin.get(`events:${sessionId}:${idx}`);
        if (!Array.isArray(chunk) || chunk.length === 0) break;
        events.push(...chunk);
        idx += 1;
      }
      return events;
    };

    const appendEventRecord = async (session, ev) => {
      const chunkIdx = Math.floor((ev.seq - 1) / EVENT_CHUNK_SIZE);
      const key = `events:${session.id}:${chunkIdx}`;
      const chunk = await getJson(key, []);
      chunk.push(ev);
      await setJson(key, chunk);
    };

    const appendChangeRecord = async (change) => {
      const meta = await getMeta();
      const seq = (meta.latestChangeSeq || 0) + 1;
      meta.latestChangeSeq = seq;
      const entry = {
        changeSeq: seq,
        kind: change.kind,
        sessionId: change.sessionId,
        workspaceId: change.workspaceId,
        itemId: change.itemId ?? null,
        committedAt: change.committedAt ?? Date.now(),
        ...(change.item ? { item: change.item } : {}),
        ...(change.session ? { session: change.session } : {}),
      };
      const bucketIdx = Math.floor((seq - 1) / CHANGE_BUCKET_SIZE);
      const bucketKey = `changelog:${bucketIdx}`;
      const bucket = await getJson(bucketKey, []);
      bucket.push(entry);
      await setJson(bucketKey, bucket);
      await setMeta(meta);
      return seq;
    };

    const publishChannel = (event) => {
      if (!active || typeof ctx.services?.publish !== 'function') return;
      ctx.services.publish('session.data.v1', event);
    };

    const toSnapshotItem = (session, item) => ({
      sessionId: session.id,
      sessionTitle: session.title,
      workspaceId: session.workspaceId,
      itemId: item.itemId,
      turnId: item.turnId ?? '',
      turnSeq: item.seq ?? 0,
      driverId: item.driverId,
      blockType: item.blockType,
      textBody: item.textBody,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });

    const dataService = {
      async getStreamInfo() {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const meta = await getMeta();
        return peerOk({
          stream: streamRef(),
          latestChangeSeq: meta.latestChangeSeq || 0,
          writable,
        });
      },

      async listWorkspaces() {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const workspaces = await getWorkspaces();
        return peerOk({ workspaces, stream: streamRef() });
      },

      async getWorkspace(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const workspaces = await getWorkspaces();
        const found = workspaces.find((w) => w.id === req.workspaceId) ?? null;
        return peerOk({ workspace: found });
      },

      async getWorkspaceByPath(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const workspaces = await getWorkspaces();
        const found = workspaces.find((w) => w.rootPath === req.rootPath) ?? null;
        return peerOk({ workspace: found });
      },

      async createWorkspace(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const workspaces = await getWorkspaces();
          const existing = workspaces.find((w) => w.rootPath === req.rootPath || (req.id && w.id === req.id));
          if (existing) return peerOk({ workspace: existing, created: false });
          const ws = {
            id: req.id || randomId('ws_lite'),
            name: req.name,
            rootPath: req.rootPath,
            isGitRepo: Boolean(req.isGitRepo),
            gitBranch: req.gitBranch ?? null,
            createdAt: req.createdAt ?? Date.now(),
          };
          workspaces.unshift(ws);
          await setWorkspaces(workspaces);
          const meta = await getMeta();
          publishChannel({
            kind: 'workspace_changed',
            stream: streamRef(),
            changeSeq: meta.latestChangeSeq || 0,
            workspaceId: ws.id,
          });
          return peerOk({ workspace: ws, created: true });
        });
      },

      async updateWorkspaceGit(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const workspaces = await getWorkspaces();
          const idx = workspaces.findIndex((w) => w.id === req.workspaceId);
          if (idx < 0) return peerOk({ workspace: null });
          workspaces[idx] = { ...workspaces[idx], isGitRepo: Boolean(req.isGitRepo), gitBranch: req.gitBranch ?? null };
          await setWorkspaces(workspaces);
          return peerOk({ workspace: workspaces[idx] });
        });
      },

      async deleteWorkspace(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const workspaces = await getWorkspaces();
          const nextWs = workspaces.filter((w) => w.id !== req.workspaceId);
          if (nextWs.length === workspaces.length) return peerOk({ deleted: false });
          await setWorkspaces(nextWs);
          const ids = await getSessionIds();
          const keptIds = [];
          for (const sid of ids) {
            const sess = await getSessionRecord(sid);
            if (sess && sess.workspaceId === req.workspaceId) {
              await ctx.storage.plugin.delete(`session:${sid}`);
              await appendChangeRecord({ kind: 'delete_session', sessionId: sid, workspaceId: req.workspaceId });
            } else {
              keptIds.push(sid);
            }
          }
          await setSessionIds(keptIds);
          return peerOk({ deleted: true });
        });
      },

      async listSessions(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const ids = await getSessionIds();
        const sessions = [];
        for (const id of ids) {
          const s = await getSessionRecord(id);
          if (!s) continue;
          if (req?.workspaceId && s.workspaceId !== req.workspaceId) continue;
          if (req?.harnessId && s.harnessId !== req.harnessId) continue;
          if (!req?.includeArchived && s.status === 'archived') continue;
          sessions.push(s);
        }
        sessions.sort((a, b) => b.updatedAt - a.updatedAt);
        return peerOk({ sessions, stream: streamRef() });
      },

      async getSession(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const session = await getSessionRecord(req.sessionId);
        return peerOk({ session });
      },

      async createSession(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const now = Date.now();
          const s = req.session;
          const id = s.id || randomId('sess_lite');
          const created = {
            id,
            workspaceId: s.workspaceId,
            harnessId: s.harnessId,
            harnessKind: s.harnessKind,
            nativeSessionId: s.nativeSessionId ?? null,
            parentSessionId: s.parentSessionId ?? null,
            forkedFromTurnSeq: s.forkedFromTurnSeq ?? null,
            forkMode: s.forkMode ?? null,
            importMode: s.importMode ?? null,
            importSource: s.importSource ?? null,
            participatingHarnesses: s.participatingHarnesses ?? [s.harnessId],
            contextSyncMode: s.contextSyncMode ?? 'auto',
            cwd: s.cwd,
            worktreeBranch: s.worktreeBranch ?? null,
            title: s.title,
            status: s.status || 'idle',
            model: s.model ?? null,
            actualModel: s.actualModel ?? null,
            modelReroutedReason: s.modelReroutedReason ?? null,
            reasoningEffort: s.reasoningEffort ?? null,
            permissionMode: s.permissionMode || 'manual',
            lastSeq: s.lastSeq ?? 0,
            usage: s.usage ?? null,
            pendingApprovalCount: s.pendingApprovalCount ?? 0,
            createdAt: s.createdAt ?? now,
            updatedAt: s.updatedAt ?? now,
          };
          await setSessionRecord(created);
          const ids = await getSessionIds();
          if (!ids.includes(id)) {
            ids.push(id);
            await setSessionIds(ids);
          }
          await setBindings(id, [{
            sessionId: id,
            harnessId: created.harnessId,
            harnessKind: created.harnessKind,
            nativeSessionId: created.nativeSessionId,
            lastModel: created.model,
            lastActualModel: created.actualModel,
            lastEffort: created.reasoningEffort,
            syncedUpToSeq: created.lastSeq,
            driverUsed: null,
            updatedAt: created.updatedAt,
          }]);
          const changeSeq = await appendChangeRecord({
            kind: 'upsert_session',
            sessionId: id,
            workspaceId: created.workspaceId,
            committedAt: now,
            session: {
              id: created.id,
              workspaceId: created.workspaceId,
              title: created.title,
              harnessId: created.harnessId,
              harnessKind: created.harnessKind,
              status: created.status,
              updatedAt: created.updatedAt,
            },
          });
          publishChannel({
            kind: 'session_changed',
            stream: streamRef(),
            changeSeq,
            sessionId: id,
            workspaceId: created.workspaceId,
          });
          return peerOk({ session: created, stream: streamRef() });
        });
      },

      async updateSession(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const current = await getSessionRecord(req.sessionId);
          if (!current) return peerOk({ session: null });
          const next = {
            ...current,
            ...req.patch,
            updatedAt: Date.now(),
          };
          await setSessionRecord(next);
          const changeSeq = await appendChangeRecord({
            kind: 'upsert_session',
            sessionId: next.id,
            workspaceId: next.workspaceId,
            committedAt: next.updatedAt,
            session: {
              id: next.id,
              workspaceId: next.workspaceId,
              title: next.title,
              harnessId: next.harnessId,
              harnessKind: next.harnessKind,
              status: next.status,
              updatedAt: next.updatedAt,
            },
          });
          publishChannel({
            kind: 'session_changed',
            stream: streamRef(),
            changeSeq,
            sessionId: next.id,
            workspaceId: next.workspaceId,
          });
          return peerOk({ session: next });
        });
      },

      async deleteSession(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const current = await getSessionRecord(req.sessionId);
          if (!current) return peerOk({ deleted: false });
          await ctx.storage.plugin.delete(`session:${req.sessionId}`);
          await ctx.storage.plugin.delete(`bindings:${req.sessionId}`);
          await ctx.storage.plugin.delete(`runs:${req.sessionId}`);
          await ctx.storage.plugin.delete(`items:${req.sessionId}`);
          await ctx.storage.plugin.delete(`receipts:${req.sessionId}`);
          const ids = await getSessionIds();
          await setSessionIds(ids.filter((id) => id !== req.sessionId));
          const changeSeq = await appendChangeRecord({
            kind: 'delete_session',
            sessionId: req.sessionId,
            workspaceId: current.workspaceId,
          });
          publishChannel({
            kind: 'session_deleted',
            stream: streamRef(),
            changeSeq,
            sessionId: req.sessionId,
            workspaceId: current.workspaceId,
          });
          return peerOk({ deleted: true });
        });
      },

      async listEvents(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const all = await readAllEvents(req.sessionId);
        const afterSeq = typeof req.afterSeq === 'number' ? Math.max(0, Math.floor(req.afterSeq)) : 0;
        const throughSeq = typeof req.throughSeq === 'number' ? Math.floor(req.throughSeq) : Number.MAX_SAFE_INTEGER;
        const limit = typeof req.limit === 'number' ? Math.min(4000, Math.max(1, Math.floor(req.limit))) : 500;
        const filtered = all.filter((ev) => ev.seq > afterSeq && ev.seq <= throughSeq && (!req.turnId || ev.turnId === req.turnId));
        const hasMore = filtered.length > limit;
        const sliced = hasMore ? filtered.slice(0, limit) : filtered;
        const lastSeq = sliced.length > 0 ? sliced[sliced.length - 1].seq : afterSeq;
        return peerOk({
          sessionId: req.sessionId,
          stream: streamRef(),
          events: sliced,
          lastSeq,
          nextAfterSeq: hasMore && sliced.length > 0 ? sliced[sliced.length - 1].seq : null,
          hasMore,
        });
      },

      async appendEvent(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const session = await getSessionRecord(req.sessionId);
          if (!session) return peerErr('not_found', `会话不存在: ${req.sessionId}`);
          const now = req.createdAt ?? Date.now();
          const seq = (session.lastSeq || 0) + 1;
          const ev = {
            sessionId: session.id,
            seq,
            type: req.type,
            turnId: req.turnId ?? null,
            payload: req.payload ?? {},
            createdAt: now,
          };
          await appendEventRecord(session, ev);
          session.lastSeq = seq;
          session.updatedAt = now;
          await setSessionRecord(session);
          const changeSeq = await appendChangeRecord({
            kind: 'upsert_session',
            sessionId: session.id,
            workspaceId: session.workspaceId,
            committedAt: now,
            session: {
              id: session.id,
              workspaceId: session.workspaceId,
              title: session.title,
              harnessId: session.harnessId,
              harnessKind: session.harnessKind,
              status: session.status,
              updatedAt: now,
            },
          });
          publishChannel({
            kind: 'events_committed',
            stream: streamRef(),
            changeSeq,
            sessionId: session.id,
            workspaceId: session.workspaceId,
            events: [ev],
          });
          return peerOk({ event: ev, stream: streamRef() });
        });
      },

      async listTurnItems(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        let items = await getItems(req.sessionId);
        if (req.afterSeq !== undefined) items = items.filter((i) => i.seq > req.afterSeq);
        if (req.beforeSeq !== undefined) items = items.filter((i) => i.seq < req.beforeSeq);
        if (req.turnId) items = items.filter((i) => i.turnId === req.turnId);
        if (Array.isArray(req.blockTypes) && req.blockTypes.length > 0) {
          items = items.filter((i) => req.blockTypes.includes(i.blockType));
        }
        const limit = typeof req.limit === 'number' ? Math.min(2000, Math.max(1, req.limit)) : 50;
        const sliced = items.slice(0, limit);
        const nextSeq = items.length > limit && sliced.length > 0 ? sliced[sliced.length - 1].seq : null;
        return peerOk({ items: sliced, nextSeq, stream: streamRef() });
      },

      async getTurnItem(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const items = await getItems(req.sessionId);
        const item = items.find((i) => i.itemId === req.itemId);
        if (!item) {
          for (const otherId of await getSessionIds()) {
            if (otherId === req.sessionId) continue;
            const otherItems = await getItems(otherId);
            if (otherItems.some((i) => i.itemId === req.itemId)) {
              return peerErr('permission_denied', '无权读取其他会话的 TurnItem');
            }
          }
          return peerOk(null);
        }
        const offset = typeof req.textOffset === 'number' ? Math.max(0, req.textOffset) : 0;
        const maxChars = typeof req.maxChars === 'number' ? Math.max(1, req.maxChars) : Math.max(1, item.textBody.length || 1);
        const text = item.textBody.slice(offset, offset + maxChars);
        const nextTextOffset = offset + maxChars < item.textBody.length ? offset + maxChars : null;
        return peerOk({
          item,
          text,
          totalChars: item.textBody.length,
          textOffset: offset,
          nextTextOffset,
          hasMore: nextTextOffset !== null,
        });
      },

      async upsertTurnItem(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const session = await getSessionRecord(req.item.sessionId);
          if (!session) return peerErr('not_found', `会话不存在: ${req.item.sessionId}`);
          const items = await getItems(session.id);
          const idx = items.findIndex((i) => i.itemId === req.item.itemId);
          if (idx >= 0) items[idx] = req.item;
          else items.push(req.item);
          items.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
          await setItems(session.id, items);
          if (req.item.blockType !== 'secret_request' && String(req.item.textBody || '').trim()) {
            await appendChangeRecord({
              kind: 'upsert_item',
              sessionId: session.id,
              workspaceId: session.workspaceId,
              itemId: req.item.itemId,
              committedAt: req.item.updatedAt,
              item: toSnapshotItem(session, req.item),
            });
          }
          return peerOk({ item: req.item });
        });
      },

      async settleRunningTurnItems(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const targetIds = req.sessionId ? [req.sessionId] : await getSessionIds();
          let settledCount = 0;
          const now = Date.now();
          for (const sid of targetIds) {
            const items = await getItems(sid);
            let changed = false;
            for (const item of items) {
              if (item.status === 'pending' || item.status === 'running') {
                item.status = req.status;
                item.updatedAt = now;
                settledCount += 1;
                changed = true;
              }
            }
            if (changed) await setItems(sid, items);
          }
          return peerOk({ settledCount });
        });
      },

      async commitBatch(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          let session = await getSessionRecord(req.sessionId);
          if (!session) return peerErr('not_found', `会话不存在: ${req.sessionId}`);
          const now = Date.now();

          if (req.sessionPatch) {
            session = { ...session, ...req.sessionPatch, updatedAt: now };
          }

          if (req.runStart) {
            const runs = await getRuns(session.id);
            const idx = runs.findIndex((r) => r.runId === req.runStart.runId);
            if (idx >= 0) runs[idx] = req.runStart;
            else runs.unshift(req.runStart);
            await setRuns(session.id, runs);
          }

          if (req.runFinish) {
            const runs = await getRuns(session.id);
            const idx = runs.findIndex((r) => r.runId === req.runFinish.runId);
            if (idx >= 0) {
              runs[idx] = {
                ...runs[idx],
                status: req.runFinish.status,
                ...(req.runFinish.failureClass !== undefined ? { failureClass: req.runFinish.failureClass } : {}),
                ...(req.runFinish.usage !== undefined ? { usage: req.runFinish.usage } : {}),
                endedAt: req.runFinish.endedAt ?? now,
              };
              await setRuns(session.id, runs);
            }
          }

          if (req.bindingUpsert) {
            const bindings = await getBindings(session.id);
            const idx = bindings.findIndex((b) => b.harnessId === req.bindingUpsert.harnessId);
            if (idx >= 0) bindings[idx] = req.bindingUpsert;
            else bindings.push(req.bindingUpsert);
            await setBindings(session.id, bindings);
          }

          if (req.settleRunningItemsStatus) {
            const items = await getItems(session.id);
            let changed = false;
            for (const item of items) {
              if (item.status === 'pending' || item.status === 'running') {
                item.status = req.settleRunningItemsStatus;
                item.updatedAt = now;
                changed = true;
              }
            }
            if (changed) await setItems(session.id, items);
          }

          const committedEvents = [];
          for (const evInput of req.events ?? []) {
            const seq = (session.lastSeq || 0) + 1;
            const ev = {
              sessionId: session.id,
              seq,
              type: evInput.type,
              turnId: evInput.turnId ?? null,
              payload: evInput.payload ?? {},
              createdAt: evInput.createdAt ?? now,
            };
            await appendEventRecord(session, ev);
            session.lastSeq = seq;
            session.updatedAt = ev.createdAt;
            committedEvents.push(ev);
          }

          if (Array.isArray(req.turnItems) && req.turnItems.length > 0) {
            const items = await getItems(session.id);
            for (const itemInput of req.turnItems) {
              const saved = {
                ...itemInput,
                sessionId: session.id,
                seq: typeof itemInput.seq === 'number' ? itemInput.seq : session.lastSeq,
              };
              const idx = items.findIndex((i) => i.itemId === saved.itemId);
              if (idx >= 0) items[idx] = saved;
              else items.push(saved);
              if (saved.blockType !== 'secret_request' && String(saved.textBody || '').trim()) {
                await appendChangeRecord({
                  kind: 'upsert_item',
                  sessionId: session.id,
                  workspaceId: session.workspaceId,
                  itemId: saved.itemId,
                  committedAt: saved.updatedAt,
                  item: toSnapshotItem(session, saved),
                });
              }
            }
            items.sort((a, b) => a.seq - b.seq || a.createdAt - b.createdAt);
            await setItems(session.id, items);
          }

          if (req.turnReceipt) {
            const receipts = await getReceipts(session.id);
            receipts[req.turnReceipt.requestId] = req.turnReceipt;
            await setReceipts(session.id, receipts);
          }

          await setSessionRecord(session);
          const changeSeq = await appendChangeRecord({
            kind: 'upsert_session',
            sessionId: session.id,
            workspaceId: session.workspaceId,
            committedAt: now,
            session: {
              id: session.id,
              workspaceId: session.workspaceId,
              title: session.title,
              harnessId: session.harnessId,
              harnessKind: session.harnessKind,
              status: session.status,
              updatedAt: session.updatedAt,
            },
          });

          const out = {
            stream: streamRef(),
            session,
            committedEvents,
            latestSeq: session.lastSeq,
            changeSeq,
          };

          publishChannel({
            kind: committedEvents.length > 0 ? 'events_committed' : 'session_changed',
            stream: streamRef(),
            changeSeq,
            sessionId: session.id,
            workspaceId: session.workspaceId,
            ...(committedEvents.length > 0 ? { events: committedEvents } : {}),
          });

          return peerOk(out);
        });
      },

      async listSessionRuns(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const runs = await getRuns(req.sessionId);
        return peerOk({ runs: runs.slice(0, req.limit ?? 100) });
      },

      async startSessionRun(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const runs = await getRuns(req.run.sessionId);
          runs.unshift(req.run);
          await setRuns(req.run.sessionId, runs);
          return peerOk({ run: req.run });
        });
      },

      async finishSessionRun(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const ids = await getSessionIds();
          for (const sid of ids) {
            const runs = await getRuns(sid);
            const idx = runs.findIndex((r) => r.runId === req.runId);
            if (idx >= 0) {
              runs[idx] = {
                ...runs[idx],
                status: req.status,
                ...(req.failureClass !== undefined ? { failureClass: req.failureClass } : {}),
                ...(req.usage !== undefined ? { usage: req.usage } : {}),
                endedAt: req.endedAt ?? Date.now(),
              };
              await setRuns(sid, runs);
              return peerOk({ updated: true });
            }
          }
          return peerOk({ updated: false });
        });
      },

      async getTurnReceipt(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const receipts = await getReceipts(req.sessionId);
        return peerOk({ receipt: receipts[req.requestId] ?? null });
      },

      async recordTurnReceipt(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const receipts = await getReceipts(req.receipt.sessionId);
          const existing = receipts[req.receipt.requestId];
          if (existing && existing.requestHash !== req.receipt.requestHash) {
            return peerOk({ receipt: existing, conflict: true });
          }
          receipts[req.receipt.requestId] = req.receipt;
          await setReceipts(req.receipt.sessionId, receipts);
          return peerOk({ receipt: req.receipt, conflict: false });
        });
      },

      async getHarnessBinding(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const bindings = await getBindings(req.sessionId);
        return peerOk({ binding: bindings.find((b) => b.harnessId === req.harnessId) ?? null });
      },

      async listHarnessBindings(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        return peerOk({ bindings: await getBindings(req.sessionId) });
      },

      async upsertHarnessBinding(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const bindings = await getBindings(req.binding.sessionId);
          const idx = bindings.findIndex((b) => b.harnessId === req.binding.harnessId);
          if (idx >= 0) bindings[idx] = req.binding;
          else bindings.push(req.binding);
          await setBindings(req.binding.sessionId, bindings);
          return peerOk({ binding: req.binding });
        });
      },

      async readSearchSnapshot(req = {}) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const meta = await getMeta();
        const watermarkSeq = meta.latestChangeSeq || 0;
        const ids = await getSessionIds();
        const allItems = [];
        for (const sid of ids) {
          const s = await getSessionRecord(sid);
          if (!s) continue;
          if (req.workspaceId && s.workspaceId !== req.workspaceId) continue;
          const items = await getItems(sid);
          for (const item of items) {
            if (item.blockType !== 'secret_request' && String(item.textBody || '').trim()) {
              allItems.push(toSnapshotItem(s, item));
            }
          }
        }
        return peerOk({
          snapshotId: `snap_${instanceId}_${watermarkSeq}`,
          stream: streamRef(),
          watermarkSeq,
          cursor: { providerInstanceId: instanceId, streamId, seq: watermarkSeq },
          items: allItems.slice(0, req.limit ?? 200),
          nextCursor: null,
        });
      },

      async readCommittedChanges(req = {}) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const meta = await getMeta();
        const latestSeq = meta.latestChangeSeq || 0;
        const afterSeq = Math.max(0, Math.floor(req.afterSeq ?? 0));
        const limit = Math.min(1000, Math.max(1, Math.floor(req.limit ?? 200)));
        const changes = [];
        const maxBucket = Math.floor(Math.max(0, latestSeq - 1) / CHANGE_BUCKET_SIZE);
        for (let b = Math.floor(afterSeq / CHANGE_BUCKET_SIZE); b <= maxBucket; b += 1) {
          const bucket = await getJson(`changelog:${b}`, []);
          for (const c of bucket) {
            if (c.changeSeq <= afterSeq) continue;
            if (req.workspaceId && c.workspaceId !== req.workspaceId) continue;
            changes.push(c);
          }
        }
        const hasMore = changes.length > limit;
        const sliced = hasMore ? changes.slice(0, limit) : changes;
        return peerOk({
          stream: streamRef(),
          changes: sliced,
          latestSeq,
          cursor: { providerInstanceId: instanceId, streamId, seq: latestSeq },
          hasMore,
        });
      },

      async getUsageAggregatesByInstance() {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        return peerOk({ aggregates: [] });
      },

      async getLatestCompletedTurnSeq(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const events = await readAllEvents(req.sessionId);
        let latest = 0;
        for (const ev of events) {
          if (ev.type === 'turn.completed' && ev.seq > latest) latest = ev.seq;
        }
        return peerOk({ seq: latest });
      },

      async lookupNativeMapping(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const mappings = await getJson('import_mappings', {});
        const hit = mappings[`${req.sourceId}::${req.nativeSessionId}`] ?? null;
        return peerOk({ existingSessionId: hit, matchedVia: hit ? 'mapping' : null });
      },

      async lookupReceipt(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const receipts = await getJson('import_receipts', {});
        const hit = receipts[req.requestId];
        if (!hit) return peerOk({ found: false });
        if (hit.requestHash !== req.requestHash) return peerOk({ found: true, conflict: true });
        return peerOk({ found: true, conflict: false, result: hit.result });
      },

      async resolveTargetWorkspace(req) {
        if (!active) return peerErr('plugin_disabled', `插件 ${instanceId} 已停用`);
        const workspaces = await getWorkspaces();
        const target = req.workspaceId
          ? workspaces.find((w) => w.id === req.workspaceId)
          : workspaces.find((w) => w.rootPath === req.cwd || w.rootPath === req.bundleCwd) ?? workspaces[0];
        return peerOk({
          targetWorkspaceId: target?.id ?? null,
          targetWorkspacePath: target?.rootPath ?? null,
          hasLocalCwd: Boolean(target),
          importable: Boolean(target),
          ...(target ? {} : { reason: '未在 session-data-lite 中找到目标工作区' }),
        });
      },

      async commitNativeImport(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const receipts = await getJson('import_receipts', {});
          const existing = receipts[req.requestId];
          if (existing) {
            if (existing.requestHash !== req.requestHash) return peerErr('conflict', '导入 requestId 冲突');
            return peerOk({ ...existing.result, disposition: 'reused' });
          }
          const workspaces = await getWorkspaces();
          const ws = req.workspaceId
            ? workspaces.find((w) => w.id === req.workspaceId)
            : workspaces[0];
          if (!ws) return peerErr('not_importable', '缺少可用工作区');
          const createdRes = await dataService.createSession({
            session: {
              workspaceId: ws.id,
              harnessId: req.harnessKind || 'custom',
              harnessKind: req.harnessKind || 'custom',
              nativeSessionId: req.ref.nativeSessionId,
              importMode: req.mode,
              importSource: req.legacySource || req.ref.sourceId,
              cwd: req.cwd || ws.rootPath,
              title: req.title || `导入 · ${req.ref.nativeSessionId}`,
              status: 'idle',
              model: null,
              reasoningEffort: null,
              permissionMode: 'manual',
            },
          });
          if (!createdRes.ok) return createdRes;
          const sid = createdRes.value.session.id;
          const result = {
            sessionId: sid,
            disposition: 'created',
            partial: Boolean(req.partial),
            warnings: req.warnings ?? [],
            ...(req.lockWarning ? { lockWarning: req.lockWarning } : {}),
            mode: req.mode,
          };
          receipts[req.requestId] = { requestHash: req.requestHash, result };
          await setJson('import_receipts', receipts);
          const mappings = await getJson('import_mappings', {});
          mappings[`${req.ref.sourceId}::${req.ref.nativeSessionId}`] = sid;
          await setJson('import_mappings', mappings);
          return peerOk(result);
        });
      },

      async commitBundleImport(req) {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const workspaces = await getWorkspaces();
          const ws = req.workspaceId ? workspaces.find((w) => w.id === req.workspaceId) : workspaces[0];
          if (!ws) return peerErr('not_importable', '缺少可用工作区');
          const createdRes = await dataService.createSession({
            session: {
              workspaceId: ws.id,
              harnessId: req.bundle.session.harnessId || 'custom',
              harnessKind: req.bundle.session.harnessKind || 'custom',
              nativeSessionId: null,
              importMode: 'mirror',
              importSource: 'json_bundle_v2',
              cwd: ws.rootPath,
              title: req.titleOverride || req.bundle.session.title,
              status: 'idle',
              model: req.bundle.session.model ?? null,
              reasoningEffort: req.bundle.session.reasoningEffort ?? null,
              permissionMode: req.bundle.session.permissionMode || 'manual',
            },
          });
          if (!createdRes.ok) return createdRes;
          return peerOk({
            sessionId: createdRes.value.session.id,
            disposition: 'created',
            partial: false,
            warnings: [],
            mode: 'mirror',
          });
        });
      },

      async recoverCrashState() {
        return serialize(async () => {
          if (!active || !writable) return peerErr('plugin_disabled', `插件 ${instanceId} 当前不可写入`);
          const ids = await getSessionIds();
          let recoveredRuns = 0;
          let recoveredItems = 0;
          const now = Date.now();
          for (const sid of ids) {
            const s = await getSessionRecord(sid);
            if (s && (s.status === 'running' || s.status === 'awaiting_approval')) {
              s.status = 'error';
              s.updatedAt = now;
              await setSessionRecord(s);
            }
            const runs = await getRuns(sid);
            let runChanged = false;
            for (const r of runs) {
              if (r.status === 'running') {
                r.status = 'interrupted';
                r.failureClass = 'process_exit';
                r.endedAt = now;
                recoveredRuns += 1;
                runChanged = true;
              }
            }
            if (runChanged) await setRuns(sid, runs);
            const items = await getItems(sid);
            let itemChanged = false;
            for (const it of items) {
              if (it.status === 'pending' || it.status === 'running') {
                it.status = 'interrupted';
                it.updatedAt = now;
                recoveredItems += 1;
                itemChanged = true;
              }
            }
            if (itemChanged) await setItems(sid, items);
            const receipts = await getReceipts(sid);
            let rcChanged = false;
            for (const rc of Object.values(receipts)) {
              if (rc.status === 'running') {
                rc.status = 'unknown';
                rc.updatedAt = now;
                rcChanged = true;
              }
            }
            if (rcChanged) await setReceipts(sid, receipts);
          }
          return peerOk({ recoveredRuns, recoveredItems });
        });
      },
    };

    const legacyCompat = {
      lookupNativeMapping: (p) => dataService.lookupNativeMapping(p).then((r) => (r.ok ? r.value : { existingSessionId: null, matchedVia: null })),
      lookupReceipt: (p) => dataService.lookupReceipt(p).then((r) => (r.ok ? r.value : { found: false })),
      resolveTargetWorkspace: (p) => dataService.resolveTargetWorkspace(p).then((r) => (r.ok ? r.value : { targetWorkspaceId: null, targetWorkspacePath: null, hasLocalCwd: false, importable: false })),
      listWorkspaces: () => dataService.listWorkspaces().then((r) => (r.ok ? r.value.workspaces : [])),
      commitNativeImport: (p) => dataService.commitNativeImport(p),
      commitBundleImport: (p) => dataService.commitBundleImport(p),
      readSearchSnapshot: (req) => dataService.readSearchSnapshot(req).then((r) => {
        if (!r.ok) throw new Error(r.error.message);
        return r.value;
      }),
      readCommittedChanges: (req) => dataService.readCommittedChanges(req).then((r) => {
        if (!r.ok) throw new Error(r.error.message);
        return r.value;
      }),
    };

    ctx.provide('session.data.v1', dataService, {
      version: '1.0.0',
      metadata: { role: 'session-data', engine: 'lite-kv', streamId },
    });
    ctx.provide('hm.session-data.v1', legacyCompat, {
      version: '1.0.0',
      metadata: { role: 'session-data-adapter', engine: 'lite-kv' },
    });

    ctx.effect(() => () => {
      writable = false;
      active = false;
    });
}
