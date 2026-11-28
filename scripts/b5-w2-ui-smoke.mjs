import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createDaemon } from '../packages/daemon/dist/server/app.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] ?? 'D:/HarnessMate/b5-tmp/w2/ui-smoke');
if (!/^[dD]:[\\/]/.test(output)) throw Error('Evidence and profile must be on D:');
if (fs.existsSync(path.join(output, 'result.json'))) throw Error('Use a new evidence directory to avoid stale results');
fs.mkdirSync(output, { recursive: true }); fs.mkdirSync(path.join(output, 'workspace'), { recursive: true });
process.env.HARNESSMATE_BUNDLES_DIR = path.join(root, 'packages/daemon/src/plugin-host/composition');
const daemon = createDaemon({ bundledPluginsDir: path.join(root, 'plugins/bundled'), dataDir: path.join(output, 'data'), port: 0, webDistDir: path.join(root, 'packages/web/dist') });
const files = Object.fromEntries(['harnessmate-plugin.json', 'index.mjs', 'ui/index.html'].map(p => [p, fs.readFileSync(path.join(root, 'plugins/examples/user.release-notebook', p), 'utf8')]));
const manifest = JSON.parse(files['harnessmate-plugin.json']);
const address = await daemon.start();
try {
  fs.copyFileSync(daemon.paths.configPath, path.join(output, 'baseline-config.json'));
  fs.writeFileSync(path.join(output, 'baseline-composition.json'), JSON.stringify(daemon.pluginManager.getComposition(), null, 2));
  const ws = await daemon.sessionManager.addWorkspace(path.join(output, 'workspace'));
  daemon.registry.get('codex').createSession = async () => { let cb; return { nativeSessionId: null, onEvent(fn) { cb = fn; return () => cb = undefined; }, async sendTurn({ turnId }) { cb?.({ type: 'message.assistant.completed', turnId, text: JSON.stringify({ manifest, files }) }); cb?.({ type: 'turn.completed', turnId }); }, async interrupt() {}, async resolveApproval() {}, async dispose() {} }; };
  const external = path.join(root, 'plugins/examples/hm.plugin.management-lite');
  const preview = await daemon.pluginManager.previewInstallAsync({ mode: 'local_dir', dirPath: external });
  await daemon.pluginManager.installPlugin({ mode: 'local_dir', dirPath: external, expectedDigest: preview.digest, trustCode: true });
  const externalSource = path.join(output, 'external-install-source');
  for (const [name, content] of Object.entries(files)) { const target = path.join(externalSource, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, name === 'harnessmate-plugin.json' ? JSON.stringify({ ...manifest, id: 'user.external-notebook' }) : content); }
  const require = createRequire(path.join(root, 'packages/electron/package.json'));
  const childEnv = { ...process.env, B5_URL: 'http://127.0.0.1:' + address.port, B5_WORKSPACE: ws.id, B5_OUTPUT: output, B5_EXTERNAL_SOURCE: externalSource };
  delete childEnv.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(root, 'scripts/b5-w2-ui-smoke.cjs')], { windowsHide: true, stdio: 'pipe', env: childEnv });
    child.on('error', reject); child.on('exit', resolve);
    child.stdout.on('data', b => fs.appendFileSync(path.join(output, 'electron.log'), b)); child.stderr.on('data', b => fs.appendFileSync(path.join(output, 'electron.log'), b));
  });
  if (!fs.existsSync(path.join(output, 'result.json'))) throw Error('Electron exited ' + code + ': ' + fs.readFileSync(path.join(output, 'electron.log'), 'utf8'));
  const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
  if (code !== 0 || !result.passed) { process.exitCode = 1; console.log(JSON.stringify(result, null, 2)); }
  else {
    const saved = await daemon.pluginManager.invokeServiceSelection('example.release-notebook.v1', 'read', [], { allowSingleCandidate: false });
    if (saved.value.text !== 'B5 W2 browser note') throw Error('Actual service did not read the iframe-saved note');
    const source = daemon.pluginManager.listInstalled().find(p => p.id === manifest.id).devSourceDir;
    const main = path.join(source, 'index.mjs'); fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace("version: '1.0.0'", "version: '1.0.1'"));
    let hotReload;
    for (let i = 0; i < 100; i++) { try { hotReload = await daemon.pluginManager.invokeServiceSelection('example.release-notebook.v1', 'getInfo', [], { allowSingleCandidate: false }); if (hotReload.value?.version === '1.0.1') break; } catch {} await new Promise(r => setTimeout(r, 100)); }
    if (hotReload?.value?.version !== '1.0.1') throw Error('Source edit did not hot-reload through watcher');
    Object.assign(result, { savedServiceValue: saved.value, hotReload: hotReload.value });
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
  }
} finally { await daemon.stop(); }
