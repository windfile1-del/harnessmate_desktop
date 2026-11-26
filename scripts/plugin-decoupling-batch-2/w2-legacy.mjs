import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [output, source, oldDaemon] = process.argv.slice(2);
if (!output || !source || !oldDaemon) {
  throw new Error('Usage: node w2-legacy.mjs D:/isolated-output D:/readonly-source D:/b1/resources/daemon/daemon.cjs');
}
const outDir = path.resolve(output);
if (path.parse(outDir).root[0]?.toLowerCase() !== 'd') throw new Error('Use a D drive output directory');
const root = process.cwd();
process.env.HARNESSMATE_BUNDLES_DIR = path.join(root, 'packages/daemon/src/plugin-host/composition');
const { createDaemon } = await import(pathToFileURL(path.join(root, 'packages/daemon/dist/server/app.js')));
fs.mkdirSync(outDir, { recursive: true });
const run = fs.mkdtempSync(path.join(outDir, 'upgrade-'));
for (const name of ['harnessmate.db', 'profile.json', 'patch.yml', 'plugin-composition.previous.json']) {
  if (fs.existsSync(path.join(source, name))) fs.copyFileSync(path.join(source, name), path.join(run, name));
}

const db = new DatabaseSync(path.join(run, 'harnessmate.db'));
const counts = {};
try {
  const updateRoot = db.prepare('UPDATE workspaces SET root_path = ? WHERE id = ?');
  const updateSessions = db.prepare('UPDATE sessions SET cwd = ? WHERE workspace_id = ?');
  for (const { id } of db.prepare('SELECT id FROM workspaces').all()) {
    const cwd = fs.mkdtempSync(path.join(run, 'workspace-'));
    updateRoot.run(cwd, id);
    updateSessions.run(cwd, id);
  }
  for (const table of ['workspaces', 'sessions', 'session_task_state', 'session_turn_items']) {
    counts[table] = db.prepare('SELECT COUNT(*) AS count FROM ' + table).get().count;
  }
} finally {
  db.close();
}

const daemon = createDaemon({ dataDir: run, port: 0, hostOverride: '127.0.0.1', bundledPluginsDir: path.join(root, 'plugins/bundled') });
let sessionId;
let writtenObjective;
try {
  await daemon.start();
  sessionId = daemon.store.listSessions()[0]?.id;
  if (!sessionId) throw new Error('Old data copy did not contain a session');
  const detail = await daemon.app.inject({ url: '/api/v1/sessions/' + sessionId });
  if (detail.statusCode !== 200) throw new Error('W2 could not open a session from old data');
  const objective = 'W2 isolated legacy rollback probe';
  const update = await daemon.app.inject({
    url: '/api/v1/sessions/' + sessionId + '/task-state', method: 'PUT', payload: { objective },
  });
  writtenObjective = update.json().taskState?.objective;
  if (writtenObjective !== objective) throw new Error('Could not update the legacy ledger through W2');
  await daemon.pluginManager.togglePlugin('hm.plugin.triage-inbox', true);
  const triage = await daemon.app.inject({
    url: '/api/v1/triage/sessions/' + sessionId, method: 'PATCH', payload: { pinned: true, forceUnread: true },
  });
  if (!triage.json().session?.meta?.pinned) throw new Error('Could not update the legacy inbox through W2');
} finally {
  await daemon.stop();
}

const listener = net.createServer();
await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
const { port } = listener.address();
await new Promise((resolve) => listener.close(resolve));
const configFile = path.join(run, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
fs.writeFileSync(configFile, JSON.stringify({ ...config, port, lanEnabled: false }, null, 2));
const log = fs.openSync(path.join(run, 'b1-daemon.log'), 'a');
const child = spawn(process.execPath, [path.resolve(oldDaemon)], {
  env: {
    ...process.env,
    HARNESSMATE_DATA_DIR: run,
    HARNESSMATE_PORT: String(port),
    HARNESSMATE_BUNDLES_DIR: path.dirname(path.resolve(oldDaemon)),
    HARNESSMATE_BUNDLED_PLUGINS_DIR: path.resolve(path.dirname(oldDaemon), '../bundled-plugins'),
  },
  windowsHide: true, stdio: ['ignore', log, log],
});
fs.closeSync(log);
try {
  const base = 'http://127.0.0.1:' + port;
  const deadline = Date.now() + 25_000;
  let objective;
  let lastStatus;
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      const req = await fetch(base + '/api/v1/sessions/' + sessionId + '/task-state', { signal: AbortSignal.timeout(1000) });
      lastStatus = req.status;
      if (req.ok) {
        objective = (await req.json()).taskState?.objective;
        break;
      }
    } catch (error) {
      lastStatus = error.cause?.code ?? error.name;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (objective !== writtenObjective) {
    throw new Error(`B1 packaged daemon could not read the W2 ledger update (HTTP or transport status: ${lastStatus})`);
  }
  const response = await fetch(base + '/api/v1/triage/state', { signal: AbortSignal.timeout(3000) });
  const meta = (await response.json()).sessions?.find((session) => session.sessionId === sessionId)?.meta;
  if (!response.ok || !meta?.pinned || !meta.forceUnread) {
    throw new Error(`B1 packaged daemon could not read the W2 inbox update (HTTP ${response.status})`);
  }
  const result = { run, oldCounts: counts, w2LegacySessionOpen: true, b1PackagedDaemonReadsW2Ledger: true, b1PackagedDaemonReadsW2Inbox: true };
  fs.writeFileSync(path.join(run, 'results.json'), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
} finally {
  child.kill();
}
