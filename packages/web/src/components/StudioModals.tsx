import type {
  ContextPreview,
  ContextSyncMode,
  PluginCatalogItem,
  PluginCategory,
  PluginRegistryStateDto,
} from '@harnessmate/protocol';
import { GeneratedPluginManifestSchema, PluginManifestSchema, type PluginManifest } from '@harnessmate/protocol';
import {
  ArrowRightLeft,
  Check,
  Copy,
  Download,
  GitBranch,
  Loader2,
  Plus,
  Puzzle,
  RefreshCw,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { daemonApi } from '../api/client';
import {
  formatTokenCount,
  getHarnessMeta,
  resolveHarnessMeta,
} from '../lib/harness-meta';
import { useAppStore } from '../stores/app-store';
import { useSlotRegistry, useSlotRenderFailures } from '../slots';
import { HarnessBadge } from './BrandMark';
import { ModelPicker } from './ModelPicker';
import { MetricMini, PillTab, StudioHeader } from './StudioModalControls';

// ── 4. Cross-Harness Switch & Fork Modal ───────────────────────────────

export function HandoffModal({ onClose }: { onClose: () => void }) {
  const { sessions, harnesses, selectedSessionId, switchHarness, handoffSession, pushToast } =
    useAppStore();
  const source = sessions.find((s) => s.id === selectedSessionId);
  const [mode, setMode] = useState<'in_session' | 'fork'>('in_session');
  const [targetHarnessId, setTargetHarnessId] = useState(
    harnesses.find((h) => h.id !== source?.harnessId && h.health === 'ready')?.id ??
      harnesses[0]?.id ??
      '',
  );
  const [targetModel, setTargetModel] = useState<string | null>(null);
  const [syncMode, setSyncMode] = useState<ContextSyncMode>('auto');
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedHarness = harnesses.find((h) => h.id === targetHarnessId);

  useEffect(() => {
    if (!source || !targetHarnessId) return;
    let active = true;
    void daemonApi
      .getContextPreview(source.id, targetHarnessId, syncMode)
      .then((res) => {
        if (active) setPreview(res.preview);
      })
      .catch(() => {
        if (active) setPreview(null);
      });
    return () => {
      active = false;
    };
  }, [source, targetHarnessId, syncMode]);

  if (!source) return null;

  const handleGo = async () => {
    setBusy(true);
    try {
      if (mode === 'in_session') {
        await switchHarness(source.id, {
          targetHarnessId,
          targetModel,
          syncMode,
        });
        onClose();
      } else {
        await handoffSession(source.id, targetHarnessId, targetModel);
      }
    } catch (err) {
      pushToast({
        kind: 'error',
        title: mode === 'in_session' ? '切换引擎失败' : '分支失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <StudioHeader
        title="跨 Harness 无缝交接"
        subtitle="默认在当前会话内无缝切换引擎，完整保留历史聊天记录与任务账本；也可分支出独立会话"
        onClose={onClose}
      />
      <div className="space-y-4 p-5">
        {/* Mode Switcher */}
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode('in_session')}
            className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors"
            style={{
              backgroundColor: mode === 'in_session' ? 'var(--bg-active)' : 'var(--bg-elevated)',
              border: `1px solid ${mode === 'in_session' ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
            }}
          >
            <Sparkles size={14} className="shrink-0 text-[var(--accent-indigo)]" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">
                会话内无缝切换（推荐）
              </div>
              <div className="text-[10.5px] text-[var(--text-muted)]">
                同窗口延续历史 + 增量同步上下文
              </div>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setMode('fork')}
            className="flex cursor-pointer items-center gap-2 rounded-xl px-3 py-2.5 text-left transition-colors"
            style={{
              backgroundColor: mode === 'fork' ? 'var(--bg-active)' : 'var(--bg-elevated)',
              border: `1px solid ${mode === 'fork' ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
            }}
          >
            <GitBranch size={14} className="shrink-0 text-[var(--accent-star)]" />
            <div className="min-w-0">
              <div className="text-[12px] font-medium text-[var(--text-primary)]">
                分支为新会话 (Fork)
              </div>
              <div className="text-[10.5px] text-[var(--text-muted)]">
                复制任务账本与上下文另开分支
              </div>
            </div>
          </button>
        </div>

        <div>
          <label className="mb-1.5 block text-[11.5px] text-[var(--text-secondary)]">
            选择目标 CLI 引擎
          </label>
          <div className="grid grid-cols-3 gap-2">
            {harnesses.map((h) => {
              const active = targetHarnessId === h.id;
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => {
                    setTargetHarnessId(h.id);
                    setTargetModel(null);
                  }}
                  className="flex cursor-pointer flex-col gap-1 rounded-xl p-2.5 text-left"
                  style={{
                    backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                  }}
                >
                  <HarnessBadge kind={h.kind} label={h.displayName} presentation={h.presentation} compact />
                  <span className="text-[10.5px] text-[var(--text-muted)]">
                    {h.models.length} 个模型
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {selectedHarness && selectedHarness.models.length > 0 && (
            <div>
              <label className="mb-1.5 block text-[11.5px] text-[var(--text-secondary)]">
                目标模型（可选）
              </label>
              <ModelPicker
                models={selectedHarness.models}
                value={targetModel}
                defaultModelId={selectedHarness.defaultModelId}
                placement="bottom"
                onChange={setTargetModel}
              />
            </div>
          )}

          {mode === 'in_session' && (
            <div>
              <label className="mb-1.5 block text-[11.5px] text-[var(--text-secondary)]">
                上下文同步策略
              </label>
              <select
                value={syncMode}
                onChange={(e) => setSyncMode(e.target.value as ContextSyncMode)}
                className="w-full rounded-xl px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <option value="auto">智能增量同步（推荐 · 复用热记忆）</option>
                <option value="full_ledger">全量账本 + 最近窗口重新同步</option>
                <option value="delta_only">仅增量未同步轮次</option>
              </select>
            </div>
          )}
        </div>

        {preview && (
          <div
            className="rounded-xl px-3.5 py-2.5 text-[11.5px] text-[var(--text-secondary)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                同步预估：
                <strong className="text-[var(--text-primary)]">
                  {preview.unsyncedTurnCount} 轮增量对话
                </strong>{' '}
                · 约{' '}
                <strong className="font-mono-code text-[var(--accent-indigo)]">
                  {formatTokenCount(preview.estimatedTokens)} tokens
                </strong>
              </span>
              <span className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                驱动：{preview.driverPlanned}
              </span>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-xl px-4 py-2 text-[12.5px] text-[var(--text-secondary)]"
          >
            取消
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleGo()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-4 py-2 text-[12.5px] font-medium text-white disabled:opacity-40"
            style={{ backgroundColor: 'var(--accent-indigo)' }}
          >
            <ArrowRightLeft size={13.5} />
            {busy
              ? '处理中...'
              : mode === 'in_session'
                ? '立即无缝切换'
                : '创建分支会话'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── 4b. Context Bridge Transparency Preview Modal ──────────────────────

export function ContextPreviewModal({ onClose }: { onClose: () => void }) {
  const { sessions, harnesses, selectedSessionId, pushToast } = useAppStore();
  const session = sessions.find((s) => s.id === selectedSessionId);
  const [targetHarnessId, setTargetHarnessId] = useState(session?.harnessId ?? harnesses[0]?.id ?? '');
  const [syncMode, setSyncMode] = useState<ContextSyncMode>(session?.contextSyncMode ?? 'auto');
  const [preview, setPreview] = useState<ContextPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!session) return;
    setLoading(true);
    void daemonApi
      .getContextPreview(session.id, targetHarnessId, syncMode)
      .then((res) => setPreview(res.preview))
      .catch(() => setPreview(null))
      .finally(() => setLoading(false));
  }, [session, targetHarnessId, syncMode]);

  if (!session) return null;

  const handleCopy = () => {
    if (!preview) return;
    void navigator.clipboard.writeText(preview.compiledMarkdown);
    setCopied(true);
    pushToast({ kind: 'info', title: '已复制完整编译上下文包' });
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div>
      <StudioHeader
        title="上下文同步透视 (Context Bridge Preview)"
        subtitle="透明查看切换引擎时即将注入的工作区真值、任务账本与增量对话内容"
        onClose={onClose}
      />

      <div className="space-y-3.5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {harnesses.map((h) => {
              const active = targetHarnessId === h.id;
              const meta = resolveHarnessMeta({ harness: h }, harnesses);
              return (
                <button
                  key={h.id}
                  type="button"
                  onClick={() => setTargetHarnessId(h.id)}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--bg-active)' : 'var(--bg-elevated)',
                    color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                    border: `1px solid ${active ? 'var(--border-focus)' : 'var(--border-hairline)'}`,
                  }}
                >
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: meta.accentColor }}
                  />
                  {meta.shortLabel}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-1.5">
            <select
              value={syncMode}
              onChange={(e) => setSyncMode(e.target.value as ContextSyncMode)}
              className="rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] focus:outline-none"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <option value="auto">智能增量</option>
              <option value="full_ledger">全量账本</option>
              <option value="delta_only">仅增量</option>
            </select>

            <button
              type="button"
              onClick={handleCopy}
              disabled={!preview}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-40"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              {copied ? <Check size={12} className="text-[var(--accent-emerald)]" /> : <Copy size={12} />}
              复制
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-[12px] text-[var(--text-muted)]">
            <Loader2 size={18} className="mx-auto mb-2 animate-spin text-[var(--accent-indigo)]" />
            正在编译增量上下文包...
          </div>
        ) : preview ? (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <MetricMini label="已同步水位" value={`#${preview.syncedUpToSeq} / #${preview.currentLastSeq}`} />
              <MetricMini label="待同步轮次" value={`${preview.unsyncedTurnCount} 轮`} />
              <MetricMini
                label="预算占用"
                value={`${formatTokenCount(preview.estimatedTokens)} / ${formatTokenCount(preview.budgetTokens)}`}
              />
              <MetricMini label="注入协议驱动" value={preview.driverPlanned} />
            </div>

            <div
              className="max-h-[340px] overflow-auto rounded-xl p-3 font-mono-code text-[11.5px] leading-relaxed whitespace-pre-wrap text-[var(--text-secondary)]"
              style={{
                backgroundColor: 'var(--code-bg)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              {preview.compiledMarkdown}
            </div>
          </>
        ) : (
          <div className="py-10 text-center text-[12px] text-[var(--text-muted)]">
            无法加载上下文预览。
          </div>
        )}
      </div>
    </div>
  );
}
