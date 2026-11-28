const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const output = process.env.B5_OUTPUT;
fs.mkdirSync(path.join(output, 'profile'), { recursive: true });
app.setPath('userData', path.join(output, 'profile'));
app.setPath('sessionData', path.join(output, 'profile'));
app.setPath('temp', output);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let win; let step = 'create'; const errors = [];
  const mark = value => { step = value; fs.appendFileSync(path.join(output, 'steps.log'), value + '\n'); };
  const timeout = setTimeout(() => { fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, error: 'overall timeout', step, errors }, null, 2)); app.exit(1); }, 180000);
  try {
    win = new BrowserWindow({ show: false, width: 1440, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, contextIsolation: true } });
    win.webContents.on('console-message', (_e, _level, message) => { if (/error|failed/i.test(message)) errors.push(message); });
    win.webContents.on('render-process-gone', (_e, details) => errors.push(details));
    const evaluate = (fn, arg) => win.webContents.executeJavaScript('(' + fn.toString() + ')(' + JSON.stringify(arg) + ')', true);
    const wait = async fn => { for (let i = 0; i < 160; i++) { if (await evaluate(fn)) return; await new Promise(r => setTimeout(r, 150)); } throw Error('Browser condition timeout: ' + fn.toString()); };
    const screenshot = async name => { mark('screenshot ' + name); await evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))); await new Promise(r => setTimeout(r, 200)); fs.writeFileSync(path.join(output, name + '.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); };
    const request = (route, body, method = 'POST') => evaluate(async ({ route, body, method }) => { const r = await fetch('/api/v1/' + route, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw Error(JSON.stringify(data)); return data; }, { route, body, method });
    mark('load'); await win.loadURL(process.env.B5_URL);
    await evaluate(() => window.addEventListener('error', e => console.error(e.error?.stack || e.message)));
    await wait(() => [...document.querySelectorAll('button')].some(b => b.textContent.startsWith('插件中心')));
    // Initial layout config migration can change the layout run once.
    await new Promise(r => setTimeout(r, 1500));
    mark('open manager'); await evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('插件中心')).click());
    await wait(() => !!document.querySelector('[data-management-instance]'));
    await wait(() => document.body.textContent.includes('来源'));
    await screenshot('management');
    await evaluate(() => [...document.querySelectorAll('nav button')].find(b => b.textContent === '设置').click());
    await wait(() => !!document.querySelector('input[aria-label="binaryPath"]'));
    await screenshot('settings');
    await evaluate(() => [...document.querySelectorAll('nav button')].find(b => b.textContent === '插件中心').click());
    await evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('AI') && b.textContent.includes('开发')).click());
    await wait(() => !!document.querySelector('[data-developer-instance]'));
    await wait(() => document.querySelector('select[aria-label="工作区"]')?.options.length > 1 && document.querySelector('select[aria-label="Harness"]')?.options.length > 1);
    await evaluate(ws => {
      for (const [label, value] of [['工作区', ws], ['Harness', 'codex']]) { const s = document.querySelector('select[aria-label="' + label + '"]'); s.value = value; s.dispatchEvent(new Event('change', { bubbles: true })); }
      const t = document.querySelector('textarea[aria-label="插件需求"]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, '创建发布便笺页面及服务'); t.dispatchEvent(new Event('input', { bubbles: true }));
    }, process.env.B5_WORKSPACE);
    await wait(() => !document.querySelector('[data-testid="builder-generate-btn"]').disabled);
    await evaluate(() => document.querySelector('[data-testid="builder-generate-btn"]').click());
    await wait(() => !!document.querySelector('[data-testid="builder-v2-trust-checkbox"]'));
    await screenshot('diagnostics');
    await evaluate(() => { [...document.querySelectorAll('input[type="radio"]')].find(r => r.parentElement.textContent.includes('DevMode')).click(); document.querySelector('[data-testid="builder-v2-trust-checkbox"]').click(); });
    await evaluate(() => document.querySelector('[data-testid="builder-v2-install-btn"]').click());
    await wait(() => document.body.textContent.includes('已安装开发修订 · user.release-notebook'));
    await screenshot('installed');
    const installed = (await request('plugins', undefined, 'GET')).plugins.find(p => p.id === 'user.release-notebook');
    await request('plugins/' + installed.id + '/permissions', { workspaceId: '__global__', digest: installed.packageDigest, capability: 'storage:plugin', granted: true, coverFuture: true }, 'PUT');
    await evaluate(() => { const select = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'example.release-notebook.v1')); select.value = 'example.release-notebook.v1'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await wait(async () => (await (await fetch('/api/v1/plugins/services/resolve?contract=example.release-notebook.v1&allowSingleCandidate=0')).json()).status === 'ready');
    await evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('预览 notes')).click());
    await wait(() => !!document.querySelector('iframe'));
    let noteFrame;
    for (let i = 0; i < 100; i++) {
      for (const frame of win.webContents.mainFrame.frames) { if (await frame.executeJavaScript('!!document.getElementById("note")').catch(() => false)) noteFrame = frame; }
      if (noteFrame) break; await new Promise(r => setTimeout(r, 150));
    }
    if (!noteFrame) throw Error('Notebook iframe never became functional');
    await noteFrame.executeJavaScript('document.getElementById("status").textContent="";document.getElementById("note").value="B5 W2 browser note";document.getElementById("save").click();');
    for (let i = 0; i < 100; i++) { if (await noteFrame.executeJavaScript('document.getElementById("status").textContent==="已保存"')) break; if (i === 99) throw Error('Notebook save failed'); await new Promise(r => setTimeout(r, 100)); }
    await screenshot('preview');
    // The external package was installed using exactly the same public install API.
    await request('plugins/composition/bindings', { contract: 'management.view.v1', instanceId: 'user.management-lite' }, 'PUT');
    await evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('插件中心')).click());
    await wait(() => document.body.textContent.includes('外部管理 · Management Lite'));
    await evaluate(({ dir }) => { document.querySelector('input[aria-label="安装目录"]').value = dir; [...document.querySelectorAll('button')].find(b => b.textContent === '预览来源').click(); }, { dir: process.env.B5_EXTERNAL_SOURCE });
    await wait(() => [...document.querySelectorAll('pre')].some(p => p.textContent.includes('"digest"')));
    await evaluate(() => { const root = [...document.querySelectorAll('main')].find(n => n.querySelector('input[aria-label="安装目录"]')); root.querySelector('input[type="checkbox"]').click(); [...root.querySelectorAll('button')].find(b => b.textContent === '安装已预览修订').click(); });
    await wait(() => [...document.querySelectorAll('p')].some(p => p.textContent.startsWith('user.external-notebook ·')));
    await evaluate(() => { document.querySelector('input[aria-label="契约"]').value = 'example.release-notebook.v1'; document.querySelector('input[aria-label="实例 ID"]').value = 'user.release-notebook'; [...document.querySelectorAll('button')].find(b => b.textContent === '修改组合绑定').click(); });
    await screenshot('external-management');
    for (const id of ['hm.plugin.management-default', 'user.management-lite']) {
      await evaluate(id => { const row = [...document.querySelectorAll('p')].find(p => p.textContent.startsWith(id + ' ·')); [...row.querySelectorAll('button')].find(b => b.textContent === '停用').click(); }, id);
      if (id !== 'user.management-lite') await wait(() => [...document.querySelectorAll('p')].some(p => p.textContent.startsWith('hm.plugin.management-default ·') && p.textContent.includes('disabled')));
    }
    await wait(() => !document.body.textContent.includes('外部管理 · Management Lite'));
    await evaluate(() => { location.hash = 'kernel-recovery'; });
    await wait(() => !!document.querySelector('[data-testid="kernel-recovery-view"]') && document.querySelector('select[aria-label="恢复实例"]')?.options.length>1);
    await screenshot('recovery');
    await evaluate(() => { const s = document.querySelector('select[aria-label="恢复实例"]'); s.value = 'user.management-lite'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    await evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === '启用').click());
    await wait(async () => (await (await fetch('/api/v1/plugins')).json()).plugins.find(p => p.id === 'user.management-lite')?.enabled === true);
    clearTimeout(timeout);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: errors.length === 0, generatedThroughUI: true, notebookSaved: true, externalInstall: true, recoveryAfterBothManagersDisabled: true, steps: ['management', 'settings', 'diagnostics', 'installed', 'preview', 'external-management', 'recovery'], errors }, null, 2));
    app.exit(errors.length ? 1 : 0);
  } catch (error) {
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed: false, step, error: String(error), body: win ? await win.webContents.executeJavaScript('document.body.innerText').catch(() => null) : null, errors }, null, 2));
    app.exit(1);
  }
});
