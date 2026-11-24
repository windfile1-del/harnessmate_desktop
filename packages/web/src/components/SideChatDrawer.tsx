import type { Session, SideChatMessage } from '@harnessmate/protocol';
import { GitFork, Loader2, MessageSquareDashed, Send, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { daemonApi } from '../api/client';
import { useAppStore } from '../stores/app-store';

export function SideChatView({
  session,
  messages,
  sending,
  promoting,
  onSend,
  onClear,
  onPromote,
}: {
  session: Session;
  messages: SideChatMessage[];
  sending: boolean;
  promoting: boolean;
  onSend: (text: string) => void;
  onClear: () => void;
  onPromote: () => void;
}) {
  const [draft, setDraft] = useState('');

  const handleSubmit = () => {
    const trimmed = draft.trim();
    if (!trimmed || sending) return;
    setDraft('');
    onSend(trimmed);
  };

  return (
    <div className="flex h-full flex-col gap-3">
      <div
        className="flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-[11.5px]"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
            <MessageSquareDashed size={13.5} className="text-[var(--accent-indigo)]" />
            <span>Side Chat 侧栏问答</span>
          </div>
          <p className="mt-0.5 truncate text-[10.5px] text-[var(--text-muted)]">
            读取当前工作区与账本上下文，绝不污染主会话时间线
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            disabled={messages.length === 0 || promoting}
            onClick={onPromote}
            title="将侧栏讨论升级为正式分叉子会话"
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
            style={{ border: '1px solid var(--border-focus)' }}
          >
            <GitFork size={11.5} />
            <span>{promoting ? '升级中...' : '升级为分叉'}</span>
          </button>
          <button
            type="button"
            disabled={messages.length === 0}
            onClick={onClear}
            title="清空侧栏临时对话"
            className="cursor-pointer rounded-lg p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent-rose)] disabled:opacity-35"
          >
            <Trash2 size={12.5} />
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-2.5 overflow-y-auto pr-0.5">
        {messages.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--border-hairline)] p-4 text-center text-[11.5px] text-[var(--text-muted)]">
            随时向 <span className="font-mono-code text-[var(--text-primary)]">{session.harnessId}</span> 询问报错解释、设计备选方案或代码片段，不留痕迹地探索。
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className="rounded-xl px-3 py-2 text-[12px] leading-relaxed"
              style={{
                backgroundColor:
                  msg.role === 'user' ? 'var(--accent-indigo-soft)' : 'var(--bg-surface)',
                border: '1px solid var(--border-hairline)',
                color: 'var(--text-primary)',
              }}
            >
              <div className="mb-1 flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                <span className="font-medium uppercase">
                  {msg.role === 'user' ? '你' : `Side Chat · ${msg.harnessId ?? session.harnessId}`}
                </span>
              </div>
              <div className="whitespace-pre-wrap break-words">{msg.text}</div>
            </div>
          ))
        )}
      </div>

      <div className="flex items-end gap-1.5">
        <textarea
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit();
            }
          }}
          placeholder="临时提问（不写入主时间线）..."
          className="min-w-0 flex-1 resize-none rounded-xl px-2.5 py-2 text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          style={{
            backgroundColor: 'var(--bg-surface)',
            border: '1px solid var(--border-strong)',
          }}
        />
        <button
          type="button"
          disabled={!draft.trim() || sending}
          onClick={handleSubmit}
          aria-label="发送 Side Chat 提问"
          className="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl text-white disabled:opacity-40"
          style={{ backgroundColor: 'var(--accent-indigo)' }}
        >
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        </button>
      </div>
    </div>
  );
}

export function SideChatDrawer({ session }: { session: Session }) {
  const { selectSession, refreshAll, pushToast } = useAppStore();
  const [messages, setMessages] = useState<SideChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [promoting, setPromoting] = useState(false);

  useEffect(() => {
    let active = true;
    void daemonApi
      .getSideChat(session.id)
      .then((res) => {
        if (active) setMessages(res.messages);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [session.id]);

  return (
    <SideChatView
      session={session}
      messages={messages}
      sending={sending}
      promoting={promoting}
      onSend={async (text) => {
        setSending(true);
        try {
          const res = await daemonApi.sendSideChat(session.id, { text });
          setMessages(res.messages);
        } catch (err) {
          pushToast({
            kind: 'error',
            title: 'Side Chat 发送失败',
            body: err instanceof Error ? err.message : String(err),
          });
        } finally {
          setSending(false);
        }
      }}
      onClear={async () => {
        await daemonApi.clearSideChat(session.id).catch(() => {});
        setMessages([]);
      }}
      onPromote={async () => {
        setPromoting(true);
        try {
          const res = await daemonApi.promoteSideChat(session.id, {});
          setMessages([]);
          await refreshAll();
          await selectSession(res.session.id);
          pushToast({
            kind: 'success',
            title: '已升级为正式分叉子会话',
            body: res.notice,
          });
        } catch (err) {
          pushToast({
            kind: 'error',
            title: '升级分叉失败',
            body: err instanceof Error ? err.message : String(err),
          });
        } finally {
          setPromoting(false);
        }
      }}
    />
  );
}
