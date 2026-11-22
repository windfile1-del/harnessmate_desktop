import { useMemo } from 'react';
import type { InstalledPluginInfo } from '@harnessmate/protocol';
import { useAppStore } from '../stores/app-store';

const eventLabels = {
  'turn.completed': '完成',
  'turn.failed': '失败',
  'turn.cancelled': '取消',
} as const;

const resultLabels = { pass: '通过', fail: '失败', unknown: '待确认' };

export function PluginPanels({ sessionId, plugins }: { sessionId: string; plugins: InstalledPluginInfo[] }) {
  const { eventsBySession, taskStateBySession, setDraftText, draftTextBySession } = useAppStore();
  const events = eventsBySession[sessionId];
  const taskState = taskStateBySession[sessionId];
  const draft = draftTextBySession[sessionId];
  const activity = useMemo(() => (events ?? []).flatMap((event) => {
    if (!Object.hasOwn(eventLabels, event.type) || event.payload.maintenance) return [];
    return [{ seq: event.seq, time: event.createdAt, status: eventLabels[event.type as keyof typeof eventLabels] }];
  }), [events]);
  const completed = activity.filter(({ status }) => status === '完成').length;
  const failed = activity.filter(({ status }) => status === '失败').length;

  return (
    <div className="space-y-3 text-[12px] text-[var(--text-secondary)]">
      {plugins.flatMap((plugin) => plugin.contributes.panels?.map((panel) => (
        <section key={`${plugin.id}:${panel.id}`} className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3">
          <h3 className="font-semibold text-[var(--text-primary)]">{panel.title}</h3>
          {panel.description && <p>{panel.description}</p>}
          {panel.sections.includes('turns') && <p>完成 {completed} · 失败 {failed} · 取消 {activity.length - completed - failed}</p>}
          {panel.sections.includes('changed_files') && <div>
            <h4 className="font-medium">已记录的改动文件</h4>
            {(taskState?.touchedFiles.length ?? 0) ? <ul className="ml-4 list-disc break-all">
              {taskState?.touchedFiles.slice(-12).map((file) => <li key={file}><code>{file}</code></li>)}
            </ul> : <p>暂无记录</p>}
          </div>}
          {panel.sections.includes('verifications') && <div>
            <h4 className="font-medium">验证结果</h4>
            {(taskState?.verifications.length ?? 0) ? <ul className="ml-4 list-disc break-all">
              {taskState?.verifications.slice(-8).map((item, index) =>
                <li key={`${item.timestamp}:${index}`}>{resultLabels[item.status]} · <code>{item.command}</code>{item.summary && <p>{item.summary}</p>}</li>)}
            </ul> : <p>暂无记录</p>}
          </div>}
          {panel.sections.includes('recent_activity') && <div>
            <h4 className="font-medium">最近轮次</h4>
            {activity.length ? <ul className="ml-4 list-disc">
              {activity.slice(-6).reverse().map(({ seq, time, status }) =>
                <li key={seq}>{status} · {new Date(time).toLocaleString()}</li>)}
            </ul> : <p>暂无记录</p>}
          </div>}
          {panel.actions.length > 0 && <div className="flex flex-wrap gap-1.5">
            {panel.actions.map(({ command, args, label }, index) => <button key={index} type="button"
              disabled={Boolean(draft?.trim())}
              title={draft?.trim() ? '请先处理当前输入草稿' : `填入 /${command}`}
              className="rounded-lg border border-[var(--border-hairline)] px-2 py-1 hover:bg-[var(--bg-hover)] disabled:opacity-40"
              onClick={() => setDraftText(sessionId, `/${command} ${args ?? ''}`)}>{label}</button>)}
          </div>}
        </section>
      )) ?? [])}
    </div>
  );
}
