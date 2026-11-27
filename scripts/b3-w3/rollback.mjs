import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const [port, phase, root] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
async function api(route, body) {
  const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
async function snapshot(id) {
  const events = [];
  for (let afterSeq = 0;;) {
    const page = (await api(`/api/v1/sessions/${id}/events?afterSeq=${afterSeq}&limit=500`)).events;
    if (!page.length) break;
    events.push(...page); afterSeq = page.at(-1).seq;
  }
  const session = (await api(`/api/v1/sessions/${id}`)).session;
  const exported = await api(`/api/v1/sessions/${id}/export?format=json_bundle`);
  const ledger = await api(`/api/v1/sessions/${id}/task-state`);
  return { id, title: session.title, lastSeq: session.lastSeq, eventCount: events.length,
    digest: digest(events), tailAfter10000Digest: digest(events.filter(e => e.seq > 10000)),
    firstSeq: events[0]?.seq, finalSeq: events.at(-1)?.seq,
    exportBytes: Buffer.byteLength(JSON.stringify(exported)), ledger,
    containsOldHistory: events.some(e => e.payload?.text?.includes('历史回答 2499')),
    containsNewText: events.some(e => e.payload?.text?.includes('B3_ROLLBACK_NEW')),
    userMessages: events.filter(e => e.type === 'message.user').length,
    settlements: events.filter(e => ['turn.completed', 'turn.cancelled', 'turn.failed'].includes(e.type)).length };
}
const output = path.join(root, `${phase}.json`);
if (phase === 'upgrade') {
  const source = JSON.parse(fs.readFileSync(path.join(root, 'source-raw.json'), 'utf8'));
  const old = await snapshot(source.session.id);
  if (!old.containsOldHistory || old.eventCount < 10000 || old.lastSeq !== source.session.lastSeq && old.lastSeq !== source.events.at(-1)?.seq) throw new Error('B2 history provenance mismatch');
  if (old.tailAfter10000Digest !== digest(source.events)) throw new Error('Original B2 committed events changed during upgrade');
  const sessionsBefore = (await api('/api/v1/sessions')).sessions.filter(s => s.title !== 'B3 rollback new session').map(s => s.id).sort();
  const oldWorkspace = (await api('/api/v1/workspaces')).workspaces.find(w => w.id === source.session.workspaceId);
  const workspaceRoot = path.join(root, 'workspace-copy');
  if (!fs.existsSync(workspaceRoot)) fs.cpSync(oldWorkspace.rootPath, workspaceRoot, { recursive: true });
  const workspace = (await api('/api/v1/workspaces')).workspaces.find(w => w.rootPath === workspaceRoot)
    ?? (await api('/api/v1/workspaces', { rootPath: workspaceRoot, name: 'Rollback copy only' })).workspace;
  const fresh = (await api('/api/v1/sessions')).sessions.find(s => s.title === 'B3 rollback new session')
    ?? (await api('/api/v1/sessions', { workspaceId: workspace.id, harnessId: 'fixed-replay', title: 'B3 rollback new session', model: 'replay', permissionMode: 'manual' })).session;
  await api(`/api/v1/sessions/${fresh.id}/turns`, { text: 'short B3_ROLLBACK_NEW 中文与代码', requestId: 'b3-rollback-new' });
  for (let i = 0;; i++) {
    const s = (await api(`/api/v1/sessions/${fresh.id}`)).session;
    if (s.status === 'idle' && s.lastSeq > 10) break;
    if (i > 120) throw new Error('B3 new round did not settle');
    await sleep(250);
  }
  const written = await snapshot(fresh.id);
  if (!written.containsNewText || written.userMessages !== 1 || written.settlements !== 1) throw new Error('B3 write integrity mismatch');
  const search = await api('/api/v1/search/sessions?q=B3_ROLLBACK_NEW&forceLikeFallback=true');
  if (!JSON.stringify(search).includes(fresh.id)) throw new Error('B3 search did not find its new message');
  fs.writeFileSync(output, JSON.stringify({ old, written, sessionsBefore, search }, null, 2));
} else if (phase === 'readback') {
  const upgraded = JSON.parse(fs.readFileSync(path.join(root, 'upgrade.json'), 'utf8'));
  const old = await snapshot(upgraded.old.id), written = await snapshot(upgraded.written.id);
  const sessionsAfter = (await api('/api/v1/sessions')).sessions.map(s => s.id).sort();
  for (const [before, after] of [[upgraded.old, old], [upgraded.written, written]]) {
    if (before.digest !== after.digest || before.eventCount !== after.eventCount || before.lastSeq !== after.lastSeq) throw new Error(`B2 readback event mismatch: ${before.id}`);
  }
  if (!upgraded.sessionsBefore.every(id => sessionsAfter.includes(id))) throw new Error('Old sessions missing');
  const search = await api('/api/v1/search/sessions?q=B3_ROLLBACK_NEW&forceLikeFallback=true');
  if (!JSON.stringify(search).includes(written.id)) throw new Error('B2 search did not find the B3-written message');
  fs.writeFileSync(output, JSON.stringify({ passed: true, old, written, sessionsAfter, search,
    scope: 'Real B2-generated fixture data copy, real B3 write, real B2 EXE readback. Production user data and external side effects not exercised.' }, null, 2));
} else throw new Error('Expected upgrade or readback');
console.log(fs.readFileSync(output, 'utf8'));
