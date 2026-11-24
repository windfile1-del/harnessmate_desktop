import type { Session } from '@harnessmate/protocol';
import { Check, FileCheck2, MessageSquarePlus, RefreshCw, Shield, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  daemonApi,
  type AgyArtifactContentDto,
  type AgyArtifactSummaryDto,
  type AgyEcosystemSnapshotDto,
} from '../../api/client';
import { useAppStore } from '../../stores/app-store';

export interface ArtifactLineComment {
  file: string;
  line: number;
  comment: string;
}

export function AgyArtifactReviewPanel({
  session,
  initialArtifacts,
  initialContent,
}: {
  session: Session;
  initialArtifacts?: AgyArtifactSummaryDto[];
  initialContent?: AgyArtifactContentDto | null;
}) {
  const setDraftText = useAppStore((s) => s.setDraftText);
  const sendTurn = useAppStore((s) => s.sendTurn);
  const pushToast = useAppStore((s) => s.pushToast);

  const [artifacts, setArtifacts] = useState<AgyArtifactSummaryDto[]>(initialArtifacts ?? []);
  const [selectedName, setSelectedName] = useState<string | null>(
    initialContent?.name ?? initialArtifacts?.[0]?.name ?? null,
  );
  const [content, setContent] = useState<AgyArtifactContentDto | null>(initialContent ?? null);
  const [comments, setComments] = useState<ArtifactLineComment[]>([]);
  const [draftLine, setDraftLine] = useState<number | null>(null);
  const [draftNote, setDraftNote] = useState('');
  const [loading, setLoading] = useState(false);

  const loadList = useCallback(async () => {
    if (session.harnessKind !== 'agy' || initialArtifacts) return;
    setLoading(true);
    try {
      const res = await daemonApi.listAgyArtifacts(session.id);
      setArtifacts(res.artifacts);
      if (res.artifacts[0] && !selectedName) {
        setSelectedName(res.artifacts[0].name);
      }
    } catch {
      // ignore if session has no native artifacts yet
    } finally {
      setLoading(false);
    }
  }, [session.id, session.harnessKind, initialArtifacts, selectedName]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedName || initialContent?.name === selectedName) return;
    let active = true;
    void daemonApi
      .readAgyArtifact(session.id, selectedName)
      .then((res) => {
        if (active) setContent(res.artifact);
      })
      .catch(() => {
        if (active) setContent(null);
      });
    return () => {
      active = false;
    };
  }, [session.id, selectedName, initialContent]);

  if (session.harnessKind !== 'agy') {
    return (
      <div className="p-3 text-[12px] text-[var(--text-muted)]">
        Artifact Review 仅在 AGY 会话中可用。
      </div>
    );
  }

  const addLineComment = () => {
    if (!content || draftLine === null || !draftNote.trim()) return;
    setComments((prev) => [
      ...prev,
      { file: content.name, line: draftLine, comment: draftNote.trim() },
    ]);
    setDraftLine(null);
    setDraftNote('');
  };

  const buildReviewMarkdown = (verdict?: 'approve' | 'request_changes') => {
    const header =
      verdict === 'approve'
        ? '[AGY Artifact Review · Approve]'
        : verdict === 'request_changes'
          ? '[AGY Artifact Review · Request Changes]'
          : '[AGY Artifact Review Comments]';
    const lines = comments.map((c) => `- \`${c.file}#L${c.line}\`: ${c.comment}`);
    return [header, ...(lines.length > 0 ? lines : ['请按上述结论继续。'])].join('\n');
  };

  const lines = content ? content.content.split(/\r?\n/) : [];

  return (
    <div className="space-y-3 text-[12px]">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
          <FileCheck2 size={14} className="text-[var(--accent-indigo)]" />
          AGY Artifact Review
        </span>
        <button
          type="button"
          onClick={() => void loadList()}
          className="cursor-pointer rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
        >
          <RefreshCw size={12} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {artifacts.length === 0 ? (
        <p className="text-[11.5px] text-[var(--text-muted)]">
          当前 AGY 会话暂无产物文件（位于 brain/{session.nativeSessionId ?? '<id>'}/）。
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {artifacts.map((art) => (
            <button
              key={art.name}
              type="button"
              onClick={() => setSelectedName(art.name)}
              className={`cursor-pointer rounded-lg border px-2 py-1 text-[11px] ${
                selectedName === art.name
                  ? 'border-[var(--accent-indigo)] bg-[var(--accent-indigo-soft)] text-[var(--accent-indigo)]'
                  : 'border-[var(--border-hairline)] text-[var(--text-secondary)]'
              }`}
            >
              {art.name}
            </button>
          ))}
        </div>
      )}

      {content && (
        <div
          className="max-h-72 overflow-auto rounded-xl p-2 font-mono-code text-[11px]"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          {lines.map((lineText, idx) => {
            const lineNo = idx + 1;
            const hasComment = comments.some((c) => c.file === content.name && c.line === lineNo);
            return (
              <div
                key={lineNo}
                className="group flex items-start gap-2 rounded px-1 py-0.5 hover:bg-[var(--bg-hover)]"
              >
                <button
                  type="button"
                  onClick={() => setDraftLine(lineNo)}
                  title={`在第 ${lineNo} 行添加评论`}
                  className={`w-8 shrink-0 cursor-pointer text-right ${
                    hasComment ? 'font-bold text-[var(--accent-star)]' : 'text-[var(--text-muted)]'
                  }`}
                >
                  {lineNo}
                </button>
                <span className="flex-1 whitespace-pre-wrap break-all text-[var(--text-secondary)]">
                  {lineText || ' '}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {draftLine !== null && content && (
        <div className="flex items-center gap-1.5">
          <span className="font-mono-code text-[11px] text-[var(--accent-indigo)]">
            {content.name}#L{draftLine}
          </span>
          <input
            type="text"
            placeholder="输入行级审阅意见..."
            value={draftNote}
            onChange={(e) => setDraftNote(e.target.value)}
            className="flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11.5px]"
          />
          <button
            type="button"
            onClick={addLineComment}
            className="cursor-pointer rounded bg-[var(--accent-indigo)] px-2 py-1 text-[11px] text-white"
          >
            添加评论
          </button>
        </div>
      )}

      {comments.length > 0 && (
        <div className="space-y-1 rounded-lg bg-[var(--bg-elevated)] p-2 text-[11px]">
          <div className="font-medium text-[var(--text-primary)]">
            已收集 {comments.length} 条行级评论
          </div>
          {comments.map((c, idx) => (
            <div key={idx} className="text-[var(--text-secondary)]">
              <code className="text-[var(--accent-indigo)]">
                {c.file}#L{c.line}
              </code>
              : {c.comment}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => {
            setDraftText(session.id, buildReviewMarkdown());
            pushToast({ kind: 'info', title: '已将审阅意见填入输入框' });
          }}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          <MessageSquarePlus size={12} />
          填入审阅意见
        </button>
        <button
          type="button"
          onClick={() => void sendTurn(session.id, buildReviewMarkdown('approve'))}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-emerald)] px-2.5 py-1 text-[11px] font-medium text-white"
        >
          <Check size={12} />
          批准 (Approve)
        </button>
        <button
          type="button"
          onClick={() => void sendTurn(session.id, buildReviewMarkdown('request_changes'))}
          className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-rose)] px-2.5 py-1 text-[11px] font-medium text-white"
        >
          <XCircle size={12} />
          要求修改
        </button>
      </div>
    </div>
  );
}

export function AgyEcosystemPanel({
  session,
  initialSnapshot,
}: {
  session: Session;
  initialSnapshot?: AgyEcosystemSnapshotDto | null;
}) {
  const [snapshot, setSnapshot] = useState<AgyEcosystemSnapshotDto | null>(initialSnapshot ?? null);

  useEffect(() => {
    if (session.harnessKind !== 'agy' || initialSnapshot) return;
    let active = true;
    void daemonApi
      .getAgyEcosystem(session.id)
      .then((res) => {
        if (active) setSnapshot(res.ecosystem);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session.id, session.harnessKind, initialSnapshot]);

  if (session.harnessKind !== 'agy') {
    return (
      <div className="p-3 text-[12px] text-[var(--text-muted)]">
        AGY 生态边界视图仅适用于 AGY 会话。
      </div>
    );
  }

  if (!snapshot) {
    return <div className="p-3 text-[12px] text-[var(--text-muted)]">正在加载 AGY 生态边界快照…</div>;
  }

  const rows = [
    {
      label: 'Projects (目录边界)',
      value: `${snapshot.projects.workspaceRoot} · 附加 ${snapshot.projects.additionalDirectories.length} 目录`,
    },
    {
      label: 'Rules (规则文件)',
      value:
        snapshot.rules.profileFiles.length > 0
          ? `${snapshot.rules.profileFiles.join(', ')}${snapshot.rules.workspaceRulesDirPresent ? ' + .agents/rules' : ''}`
          : snapshot.rules.workspaceRulesDirPresent
            ? '.agents/rules'
            : '未检测到自定义规则',
    },
    {
      label: 'Skills (技能目录)',
      value: `${snapshot.skills.profileSkillsLinked ? '已链接 Profile Skills' : '未链接'} · 工作区 ${snapshot.skills.workspaceSkillsCount} 个`,
    },
    {
      label: 'MCP (作用域边界)',
      value: `AGY 原生: ${snapshot.mcp.nativeScope} (跨 Profile 共享) · HarnessMate: ${snapshot.mcp.harnessMateSessionMcpScope}`,
    },
    {
      label: 'Hooks (严禁混用)',
      value: `AGY hooks.json: ${snapshot.hooks.agyInternalHooksPresent ? '已存在 (内部工具链)' : '无'} · HarnessMate V5 插件: ${snapshot.hooks.harnessMateV5HooksCount} 启用`,
    },
    {
      label: 'Plugins (双轨独立)',
      value: snapshot.plugins.agyPluginCliNote,
    },
  ];

  return (
    <div className="space-y-2.5 text-[12px]">
      <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
        <Shield size={14} className="text-[var(--accent-indigo)]" />
        AGY 原生生态与 HarnessMate 边界
      </div>
      <div className="space-y-1.5">
        {rows.map((r) => (
          <div
            key={r.label}
            className="rounded-xl p-2.5"
            style={{
              backgroundColor: 'var(--bg-surface)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <div className="text-[11px] font-medium text-[var(--text-primary)]">{r.label}</div>
            <div className="mt-0.5 break-all text-[11px] text-[var(--text-secondary)]">{r.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
