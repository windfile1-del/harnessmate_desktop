import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { targets, connect, sleep } from './cdp.mjs';
const [port, debug, outputRoot] = process.argv.slice(2), base = `http://127.0.0.1:${port}`;
const terminal = JSON.parse(fs.readFileSync(path.join(outputRoot, 'terminal-results.json'), 'utf8'));
async function api(route, body) {
  const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(`${r.status} ${route} ${JSON.stringify(j)}`); return j;
}
async function until(fn) { for (let i = 0; i < 160; i++) { try { const v = await fn(); if (v) return v; } catch {} await sleep(150); } throw new Error('Composer check timed out'); }
const session = (await api('/api/v1/sessions', { workspaceId: terminal.workspace.id, harnessId: 'fixed-replay', title: 'B3 Composer checks', permissionMode: 'manual' })).session;
const shell = await connect((await targets(debug)).find(t => t.type === 'page'));
let page; const results = { sessionId: session.id };
try {
  await shell.call('Page.reload');
  await shell.call('Page.bringToFront');
  await until(() => shell.eval('document.readyState === "complete" && document.hasFocus() && document.visibilityState === "visible"'));
  await until(() => shell.eval(`(()=>{const b=[...document.querySelectorAll('[role="button"]')].find(b=>b.textContent.includes('B3 Composer checks'));b?.click();return !!b})()`));
  page = await until(async () => {
    const target = (await targets(debug)).find(t => t.type === 'iframe'); if (!target) return;
    const candidate = await connect(target);
    try { if (await candidate.eval(`window.harnessMate?.session?.id===${JSON.stringify(session.id)} && !!document.querySelector('textarea')`)) return candidate; } catch {}
    candidate.close();
  });
  const click = text => page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});b?.click();return !!b})()`);
  assert(await click('插件开发'));
  assert(await page.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='插件开发')?.getAttribute('aria-pressed')==='true'`));
  assert(await click('插件开发')); results.pluginDevelopmentToggle = true;
  await page.eval(`(()=>{const e=document.querySelector('select[aria-label="权限模式"]');e.value='auto';e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  await until(async () => (await api(`/api/v1/sessions/${session.id}`)).session.permissionMode === 'auto');
  results.permissionSelectionPersisted = true;
  await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('默认 (Fixed replay)'));b?.click();return !!b})()`);
  await until(() => page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Fixed replay')&&b.querySelector('.font-mono-code')?.textContent.trim()==='replay');b?.click();return !!b})()`));
  await until(async () => (await api(`/api/v1/sessions/${session.id}`)).session.model === 'replay');
  results.modelSelectionPersisted = true;
  await page.eval(`window.harnessMate.services.call('chat.view.v1','editViewState',[{sessionId:${JSON.stringify(session.id)},operation:{type:'addTerminalContext',chip:${JSON.stringify(terminal.native.chip)}}}],{instanceId:window.harnessMate.instanceId,sessionId:${JSON.stringify(session.id)},workspaceId:${JSON.stringify(terminal.workspace.id)}})`);
  await until(() => page.eval(`document.body.innerText.includes(${JSON.stringify(terminal.native.chip.terminalTitle)})`));
  await page.eval(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'short Composer Enter test');e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(100);
  await page.eval(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));true`);
  await until(() => page.eval('document.body.innerText.includes("HMREPLAY_49_")'));
  const events = (await api(`/api/v1/sessions/${session.id}/events`)).events;
  const user = events.find(e => e.type === 'message.user');
  assert(user?.payload.text.includes('Composer Enter test'));
  assert(JSON.stringify(user).includes(terminal.native.chip.id));
  results.enterSendWithTerminalReference = true;
  assert(await page.eval(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='复制'&&b.parentElement.parentElement.querySelector('pre')?.textContent.includes('const value'));b?.click();return !!b})()`));
  await sleep(200);
  const clip = execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-Command', '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Clipboard -Raw'], { encoding: 'utf8', windowsHide: true });
  results.codeCopiedToWindowsClipboard = clip.includes('const value = "代码"');
  assert(results.codeCopiedToWindowsClipboard);
  const downloadPath = path.join(outputRoot, 'downloads', session.id); fs.mkdirSync(downloadPath, { recursive: true });
  await shell.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath });
  await page.eval(`document.querySelector('button[title="导出会话为 Markdown"]').click();true`);
  const file = await until(() => fs.readdirSync(downloadPath).find(f => f.endsWith('.md')));
  assert(fs.readFileSync(path.join(downloadPath, file), 'utf8').includes('Composer Enter test'));
  results.markdownDownloaded = file;
  results.passed = true;
} catch (error) { results.error = String(error); throw error; }
finally {
  fs.writeFileSync(path.join(outputRoot, 'composer-results.json'), JSON.stringify(results, null, 2));
  page?.close(); shell.close(); console.log(JSON.stringify(results));
}
