// Against an already-running real portable EXE; no private daemon is constructed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const WS = createRequire(new URL('../../packages/daemon/package.json', import.meta.url))('ws');
const [port, dataDir, outputRoot] = process.argv.slice(2);
const base = `http://127.0.0.1:${port}`;
const token = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8')).localToken;
const headers = { Origin: base, Authorization: `Bearer ${token}` };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function api(route, body, method = body ? 'POST' : 'GET') {
  const r = await fetch(base + route, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(25000) });
  const value = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${route} ${JSON.stringify(value)}`);
  return value;
}
async function until(fn) { for (let i = 0; i < 120; i++) { if (await fn()) return; await sleep(100); } throw new Error('Terminal output timeout'); }
fs.mkdirSync(outputRoot, { recursive: true });
const cwd = path.join(outputRoot, 'workspace'); fs.mkdirSync(cwd, { recursive: true });
const workspace = (await api('/api/v1/workspaces')).workspaces.find(w => w.rootPath === cwd)
  ?? (await api('/api/v1/workspaces', { rootPath: cwd, name: 'B3 terminal regression' })).workspace;
const socket = new WS(base.replace('http:', 'ws:') + '/api/v1/ws', { headers });
const frames = [], terminals = [], results = { product: 'B3 portable EXE', workspace };
socket.on('message', raw => frames.push(JSON.parse(String(raw))));
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
const output = id => frames.filter(f => f.op === 'terminal_output' && f.terminalId === id);
try {
  await api('/api/v1/plugins/hm.plugin.terminal-workspace', { enabled: true }, 'PATCH');
  await api(`/api/v1/workspaces/${workspace.id}/bindings`, { contract: 'terminal.workspace.v1', instanceId: 'hm.plugin.terminal-workspace' }, 'PUT');
  const native = (await api(`/api/v1/workspaces/${workspace.id}/terminals`, { title: 'B3 native shell' })).terminal;
  terminals.push(native.terminalId);
  socket.send(JSON.stringify({ op: 'subscribe_terminal', terminalId: native.terminalId }));
  await api(`/api/v1/terminals/${native.terminalId}/input`, { data: 'Write-Output "TERM_B3_EXEC_$((20+22))"; Write-Output "$([char]27)[33mAssertionError$([char]27)[0m: expected 401 to be 200"\r\n' });
  await until(() => output(native.terminalId).some(f => f.chunk.includes('TERM_B3_EXEC_42')));
  const chip = (await api(`/api/v1/terminals/${native.terminalId}/context-chip`, { recentLines: 10 })).chip;
  assert(chip.cleanText.includes('TERM_B3_EXEC_42'));
  results.native = { backend: native.backend, liveFrames: output(native.terminalId).length, executedOutput: true, contextReference: true, chip };
  await api(`/api/v1/terminals/${native.terminalId}`, undefined, 'DELETE');
  const dirPath = path.resolve('plugins/examples/hm.plugin.terminal-lite');
  const preview = await api('/api/v1/plugins/preview', { mode: 'local_dir', dirPath });
  await api('/api/v1/plugins/install', { mode: 'local_dir', dirPath, trustCode: true, expectedDigest: preview.digest, expectedInstalledDigest: preview.installedDigest });
  for (const capability of preview.manifest.permissions) await api(`/api/v1/plugins/${preview.manifest.id}/permissions`, { workspaceId: workspace.id, digest: preview.digest, capability, granted: true }, 'PUT');
  await api(`/api/v1/workspaces/${workspace.id}/bindings`, { contract: 'terminal.workspace.v1', instanceId: preview.manifest.id }, 'PUT');
  const external = (await api(`/api/v1/workspaces/${workspace.id}/terminals`, { title: 'B3 saturation', cwd })).terminal;
  const id = external.terminalId; terminals.push(id);
  socket.send(JSON.stringify({ op: 'subscribe_terminal', terminalId: id }));
  await until(() => output(id).length > 0);
  for (let i = 0; i < 9; i++) { await api(`/api/v1/terminals/${id}/input`, { data: `${i}${'x'.repeat(10000)}\n` }); await sleep(210); }
  await sleep(500);
  const listed = (await api(`/api/v1/workspaces/${workspace.id}/terminals`)).terminals.find(t => t.terminalId === id);
  assert.equal(listed.ringBufferBytes, 65536);
  const before = output(id).length;
  await api(`/api/v1/terminals/${id}/input`, { data: 'B3_AFTER_SATURATION_中文\n' });
  await until(() => output(id).slice(before).some(f => f.chunk.includes('B3_AFTER_SATURATION_中文')));
  const externalChip = (await api(`/api/v1/terminals/${id}/context-chip`, { recentLines: 4 })).chip;
  assert(externalChip.excerpt.includes('B3_AFTER_SATURATION_中文'));
  const after = output(id).length;
  socket.send(JSON.stringify({ op: 'unsubscribe_terminal', terminalId: id }));
  socket.send(JSON.stringify({ op: 'subscribe_terminal', terminalId: id }));
  await until(() => output(id).slice(after).some(f => f.snapshot && f.chunk.includes('B3_AFTER_SATURATION_中文')));
  results.external = { ringBufferBytes: listed.ringBufferBytes, beforeFrames: before, afterFrames: after, markerInWs: true, markerInContext: true, contextField: 'excerpt', resubscribe: true };
  results.passed = true;
} catch (error) { results.error = String(error); throw error; }
finally {
  fs.writeFileSync(path.join(outputRoot, 'terminal-results.json'), JSON.stringify(results, null, 2));
  for (const id of terminals) await api(`/api/v1/terminals/${id}`, undefined, 'DELETE').catch(() => {});
  socket.close();
  console.log(JSON.stringify(results));
}
