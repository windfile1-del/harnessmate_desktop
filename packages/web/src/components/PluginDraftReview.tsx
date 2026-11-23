import type { PluginManifest, PluginPanelQuery, Session } from '@harnessmate/protocol';
import { useCallback, useEffect, useState } from 'react';
import { daemonApi, type PluginPreview } from '../api/client';
import { pluginEventLabels } from '../lib/plugin-panels';
import { useAppStore } from '../stores/app-store';
import { PluginPanelView } from './PluginDataPanel';

function entries(manifest?: PluginManifest) {
  const registry = new Map<string, { label: string; value: unknown }>();
  if (!manifest) return registry;
  const { name, description, category, apiVersion, author, entry, contributes } = manifest;
  registry.set('manifest', { label: '插件信息', value: { name, description, category, apiVersion, author } });
  if (entry) registry.set('entry', { label: 'JavaScript 入口', value: entry });
  const add = (kind: string, id: string, label: string, value: unknown) => registry.set(`${kind}:${id}`, { label, value });
  contributes.slashCommands?.forEach((command) => add('command', command.command, `提示词指令 /${command.command}`, command));
  contributes.panels?.forEach((panel, position) => add('panel', panel.id, `面板 ${panel.title}`, { position, ...panel }));
  contributes.dataPanels?.forEach((panel, position) => add('dataPanel', panel.id, `数据面板 ${panel.title}`, { position, ...panel }));
  contributes.projections?.forEach((projection) => add('projection', projection.id, `事件投影 ${projection.id}`, projection));
  contributes.hooks?.forEach((hook) => add('hook', hook, `运行时 Hook ${hook}`, hook));
  contributes.uiSlots?.forEach((slot) => add('slot', slot, `界面入口 ${slot}`, slot));
  contributes.harnesses?.forEach((harness) => add('harness', harness.id, `ACP ${harness.displayName}`, harness));
  contributes.mcpPresets?.forEach((preset) => add('mcp', preset.name, `MCP 预设 ${preset.name}`, preset));
  return registry;
}

export function PluginDraftReview({ preview, workspaceId }: { preview: PluginPreview; workspaceId: string }) {
  const { manifest, installedManifest } = preview;
  const before = entries(installedManifest);
  const after = entries(manifest);
  const changes = [...new Set([...before.keys(), ...after.keys()])].flatMap((key) => {
    const old = before.get(key);
    const next = after.get(key);
    if (JSON.stringify(old) === JSON.stringify(next)) return [];
    return [{ key, title: (next ?? old)!.label, before: old?.value, after: next?.value,
      change: !old ? '新增' : !next ? '移除' : '修改' }];
  });
  const panels = manifest.contributes.dataPanels ?? [];
  return (
    <>
      <div className="space-y-2" aria-label="插件变更">
        <h5 className="font-medium text-[var(--text-primary)]">功能变更</h5>
        {changes.length === 0 && <p>功能配置相同。</p>}
        {changes.map(({ key, change, title, before, after }) => <details key={key}
          className="rounded-lg border border-[var(--border-hairline)] px-2.5 py-1.5">
          <summary className="cursor-pointer"><span className="mr-2 font-medium text-[var(--accent-indigo)]">{change}</span>{title}</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {before !== undefined && <ChangeValue label="已安装" value={before} />}
            {after !== undefined && <ChangeValue label="草稿" value={after} />}
          </div>
        </details>)}
      </div>
      <div className="space-y-1">
        <h5 className="font-medium text-[var(--text-primary)]">数据与运行范围</h5>
        {manifest.contributes.projections?.map(({ id, scope, events }) => <p key={id}>
          {id} · {scope === 'workspace' ? '当前工作区内的会话' : '当前会话'} · {events.map((event) => pluginEventLabels[event]).join('、')}
        </p>)}
        {manifest.contributes.panels?.length ? <p>V1 面板读取当前会话的事件和任务账本。</p> : null}
        {manifest.contributes.slashCommands?.length ? <p>提示词指令在聊天中主动发送时交给当前 CLI。</p> : null}
        {manifest.entry && <p>JavaScript 入口以当前系统用户权限运行。</p>}
        {!!manifest.contributes.harnesses?.length && <p>注册 ACP 适配器，使用适配器时运行其配置的程序。</p>}
        {!!manifest.contributes.mcpPresets?.length && <p>提供可在 MCP 中心应用的连接预设。</p>}
      </div>
      {panels.length > 0 && <PluginDraftReplay manifest={manifest} workspaceId={workspaceId} />}
    </>
  );
}

function ChangeValue({ label, value }: { label: string; value: unknown }) {
  return <div className="min-w-0"><p>{label}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg-surface)] p-2">
    {typeof value === 'string' ? value : JSON.stringify(value, (key, item) =>
      key === 'env' && item && typeof item === 'object' ? Object.keys(item) : item, 2)}
  </pre></div>;
}

function PluginDraftReplay({ manifest, workspaceId }: { manifest: PluginManifest; workspaceId: string }) {
  const sessions = useAppStore((state) => state.sessions);
  const workspaces = useAppStore((state) => state.workspaces);
  const selectedSessionId = useAppStore((state) => state.selectedSessionId);
  const [history, setHistory] = useState<Session[]>();
  const [historyError, setHistoryError] = useState('');
  const [chosenSession, setChosenSession] = useState('');
  const [chosenPanel, setChosenPanel] = useState('');
  const [replay, setReplay] = useState<{ sessionId: string; panelId: string }>();
  const candidates = history ?? sessions;
  const sessionId = chosenSession || (candidates.some(({ id, workspaceId: workspace }) => id === selectedSessionId && workspace === workspaceId)
    ? selectedSessionId! : candidates.find(({ workspaceId: workspace }) => workspace === workspaceId)?.id ?? candidates[0]?.id ?? '');
  const panels = manifest.contributes.dataPanels ?? [];
  const panelId = chosenPanel || panels[0]?.id || '';
  const panel = panels.find(({ id }) => id === replay?.panelId);
  const selectedPanel = panels.find(({ id }) => id === panelId);
  const projection = manifest.contributes.projections?.find(({ id }) => id === selectedPanel?.projection);

  useEffect(() => {
    let active = true;
    void daemonApi.listSessions({ includeArchived: true }).then(({ sessions }) => {
      if (active) setHistory(sessions);
    }).catch(() => { if (active) setHistoryError('无法刷新历史会话列表，仍可选择已加载的会话。'); });
    return () => { active = false; };
  }, []);

  const loadSnapshot = useCallback((query: PluginPanelQuery, signal: AbortSignal) => {
    if (!replay) throw new Error('请选择要预演的历史会话');
    return daemonApi.replayPluginDraft({ manifest, ...replay, query }, signal);
  }, [manifest, replay]);

  return (
    <section className="space-y-2 rounded-lg border border-[var(--border-hairline)] p-3" aria-label="历史会话预演">
      <h5 className="font-medium text-[var(--text-primary)]">历史会话预演</h5>
      {historyError && <p role="status">{historyError}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label="预演会话" className="min-w-0 max-w-60 rounded bg-[var(--bg-surface)] p-1.5" value={sessionId}
          onChange={(event) => { setChosenSession(event.target.value); setReplay(undefined); }}>
          {!candidates.length && <option value="">暂无会话</option>}
          {candidates.map((session) => <option key={session.id} value={session.id}>
            {workspaces.find(({ id }) => id === session.workspaceId)?.name ?? session.workspaceId} · {session.title}
          </option>)}
        </select>
        <select aria-label="预演面板" className="min-w-0 max-w-52 rounded bg-[var(--bg-surface)] p-1.5" value={panelId}
          onChange={(event) => { setChosenPanel(event.target.value); setReplay(undefined); }}>
          {panels.map(({ id, title }) => <option key={id} value={id}>{title}</option>)}
        </select>
        <button type="button" disabled={!sessionId || !panelId} onClick={() => setReplay({ sessionId, panelId })}
          className="rounded-lg border border-[var(--border-hairline)] px-2.5 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-40">预演面板</button>
      </div>
      <p>{projection?.scope === 'workspace' ? '读取所选会话所属工作区的记录' : '读取所选会话的记录'}。预演中的跳转和剪贴板按钮仅供查看。</p>
      {replay && panel && <PluginPanelView key={`${replay.sessionId}:${replay.panelId}`} panel={panel} loadSnapshot={loadSnapshot} />}
    </section>
  );
}
