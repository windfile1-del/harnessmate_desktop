// No official IDs or host-private imports. The same transport is available to any local management view.
export function mount({ container, bridge }) {
  let disposed = false;
  const request = (path, body, method = body === undefined ? 'GET' : 'POST') => bridge.call('transport.request', { path, method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const el = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
  const root = el('main'); root.style.cssText = 'padding:20px;overflow:auto;height:100%;color:var(--text-primary)'; container.append(root);
  const status = el('p'); const listing = el('div'); const preview = el('pre');
  listing.style.cssText = 'max-height:340px;overflow:auto;border:1px solid var(--border-hairline);padding:8px';
  preview.style.cssText = 'max-height:180px;overflow:auto;white-space:pre-wrap;font-size:12px';
  const input = (label, value = '') => { const p = el('label', label); const n = el('input'); n.value = value; n.style.cssText='border:1px solid var(--border-hairline);padding:6px;margin:4px 12px;background:transparent;color:inherit'; n.setAttribute('aria-label', label); p.append(n); root.append(p); return n; };
  const run = async fn => { try { await fn(); if (!disposed) { status.textContent = '完成'; await refresh(); await bridge.kernel.refreshPlugins(); } } catch (error) { if (!disposed) status.textContent = String(error); } };
  const button = (parent, label, fn) => { const b = el('button', label); b.style.cssText='border:1px solid var(--border-hairline);border-radius:6px;padding:5px 10px;margin:4px;cursor:pointer'; b.onclick = () => void run(fn); parent.append(b); };
  root.append(el('h1', '外部管理 · Management Lite'), status, preview, listing);
  async function refresh() {
    const [list, composition] = await Promise.all([request('/api/v1/plugins'), request('/api/v1/plugins/composition')]);
    if (disposed) return; listing.replaceChildren();
    for (const p of list.plugins) { const id = p.instanceId || p.id; const row = el('p', id + ' · ' + p.version + ' · ' + (p.enabled ? 'enabled' : 'disabled'));
      button(row, p.enabled ? '停用' : '启用', () => request('/api/v1/plugins/' + encodeURIComponent(id), { enabled: !p.enabled }, 'PATCH'));
      if (p.canRollback) button(row, '上一修订', () => request('/api/v1/plugins/' + encodeURIComponent(p.id) + '/rollback', {}));
      listing.append(row);
    }
    const bindings = el('pre', JSON.stringify(composition.bindings, null, 2)); listing.append(bindings);
  }
  const contract = input('契约'); const target = input('实例 ID');
  button(root, '修改组合绑定', () => request('/api/v1/plugins/composition/bindings', { contract: contract.value, instanceId: target.value || null }, 'PUT'));
  const directory = input('安装目录'); let reviewed;
  button(root, '预览来源', async () => { const dirPath = directory.value; reviewed = { dirPath, ...(await request('/api/v1/plugins/preview', { mode: 'local_dir', dirPath })) }; preview.textContent = JSON.stringify(reviewed,null,2); });
  const trust = el('input'); trust.type = 'checkbox'; const trustLabel = el('label', '信任已预览代码来源'); trustLabel.append(trust); root.append(trustLabel);
  button(root, '安装已预览修订', async () => { if (!reviewed || reviewed.dirPath !== directory.value) throw Error('先预览当前目录'); if (reviewed.requiresTrust && !trust.checked) throw Error('请确认来源信任'); await request('/api/v1/plugins/install', { mode: 'local_dir', dirPath: reviewed.dirPath, expectedDigest: reviewed.digest, expectedInstalledDigest: reviewed.installedDigest, trustCode: trust.checked }); });
  button(root, '恢复上一组合', () => request('/api/v1/plugins/composition/restore', { source: 'previous' }));
  button(root, '刷新', refresh); void run(refresh);
  return () => { disposed = true; root.remove(); };
}
