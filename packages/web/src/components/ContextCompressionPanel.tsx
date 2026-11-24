import type {
  CompressedTurnChunk,
  ContextCompressionConfig,
  FileSymbolOutline,
  HarnessInfo,
  Session,
  SessionCompressionStatus,
  UpdateCompressionConfigRequest,
} from '@harnessmate/protocol';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  FileCode2,
  HardDrive,
  Loader2,
  Minimize2,
  RefreshCw,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { daemonApi } from '../api/client';
import { resolveHarnessMeta } from '../lib/harness-meta';
import { useAppStore } from '../stores/app-store';

function formatChars(chars: number): string {
  if (chars >= 1000) {
    return `${(chars / 1000).toFixed(1)}k`;
  }
  return String(chars);
}

function formatBytesMb(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

export interface ContextCompressionPanelViewProps {
  session: Session;
  status: SessionCompressionStatus | null;
  harnesses: readonly HarnessInfo[];
  loading?: boolean;
  compressing?: boolean;
  clearing?: boolean;
  savingConfig?: boolean;
  errorMessage?: string | null;
  onRefresh: () => void;
  onCompressNow: (opts?: { forceRecompute?: boolean }) => void | Promise<void>;
  onClearCache: () => void | Promise<void>;
  onSaveConfig: (patch: UpdateCompressionConfigRequest) => void | Promise<void>;
}

export function ContextCompressionPanelView({
  status,
  harnesses,
  loading = false,
  compressing = false,
  clearing = false,
  savingConfig = false,
  errorMessage = null,
  onRefresh,
  onCompressNow,
  onClearCache,
  onSaveConfig,
}: ContextCompressionPanelViewProps) {
  const cfg: ContextCompressionConfig = status?.config ?? {
    summarizerInstanceId: null,
    summarizerModel: null,
    dailyCallLimit: 50,
    sessionTokenBudgetCap: 120_000,
    timeoutMs: 8_000,
    chunkSizeTurns: 10,
    rollupTurnThreshold: 25,
    backgroundRollupEnabled: true,
    symbolOutlineMaxChars: 4_000,
  };

  const [showConfig, setShowConfig] = useState(false);
  const [summarizerInstanceId, setSummarizerInstanceId] = useState<string>(
    cfg.summarizerInstanceId ?? '',
  );
  const [dailyCallLimit, setDailyCallLimit] = useState<number>(cfg.dailyCallLimit);
  const [sessionTokenBudgetCap, setSessionTokenBudgetCap] = useState<number>(
    cfg.sessionTokenBudgetCap,
  );
  const [timeoutMs, setTimeoutMs] = useState<number>(cfg.timeoutMs);
  const [backgroundRollupEnabled, setBackgroundRollupEnabled] = useState<boolean>(
    cfg.backgroundRollupEnabled,
  );

  useEffect(() => {
    setSummarizerInstanceId(cfg.summarizerInstanceId ?? '');
    setDailyCallLimit(cfg.dailyCallLimit);
    setSessionTokenBudgetCap(cfg.sessionTokenBudgetCap);
    setTimeoutMs(cfg.timeoutMs);
    setBackgroundRollupEnabled(cfg.backgroundRollupEnabled);
  }, [
    cfg.summarizerInstanceId,
    cfg.dailyCallLimit,
    cfg.sessionTokenBudgetCap,
    cfg.timeoutMs,
    cfg.backgroundRollupEnabled,
  ]);

  const chunks: readonly CompressedTurnChunk[] = status?.chunks ?? [];
  const symbolOutlines: readonly FileSymbolOutline[] = status?.symbolOutlines ?? [];
  const cacheStats = status?.cacheStats;
  const activeSummarizerMeta = cfg.summarizerInstanceId
    ? resolveHarnessMeta({ harnessId: cfg.summarizerInstanceId }, harnesses)
    : null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveConfig({
      summarizerInstanceId: summarizerInstanceId.trim() ? summarizerInstanceId.trim() : null,
      dailyCallLimit: Number(dailyCallLimit) || 0,
      sessionTokenBudgetCap: Number(sessionTokenBudgetCap) || 1_000,
      timeoutMs: Number(timeoutMs) || 8_000,
      backgroundRollupEnabled,
    });
    setShowConfig(false);
  };

  return (
    <section
      data-testid="context-compression-panel"
      className="space-y-3 text-[12px] text-[var(--text-secondary)]"
    >
      {/* Header & Mode Summary */}
      <div
        className="rounded-xl p-3"
        style={{
          backgroundColor: 'var(--bg-elevated)',
          border: '1px solid var(--border-hairline)',
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <Minimize2 size={14} style={{ color: 'var(--accent-indigo)' }} className="shrink-0" />
            <span className="truncate font-semibold text-[var(--text-primary)]">
              上下文压缩与符号索引
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              aria-label="摘要器与预算配置"
              onClick={() => setShowConfig((v) => !v)}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] hover:bg-[var(--bg-hover)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              <Settings2 size={11.5} />
              配置
            </button>
            <button
              type="button"
              aria-label="刷新压缩状态"
              onClick={onRefresh}
              disabled={loading}
              className="inline-flex cursor-pointer items-center rounded-lg p-1 hover:bg-[var(--bg-hover)] disabled:opacity-50"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              {loading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
            </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <span
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium"
            style={{
              backgroundColor: cfg.summarizerInstanceId
                ? 'var(--accent-indigo-soft)'
                : 'var(--accent-emerald-soft)',
              color: cfg.summarizerInstanceId ? 'var(--accent-indigo)' : 'var(--accent-emerald)',
            }}
          >
            <Cpu size={10.5} />
            {cfg.summarizerInstanceId
              ? `外置摘要 (${activeSummarizerMeta?.shortLabel ?? cfg.summarizerInstanceId})`
              : '纯本地零费用符号轮廓模式'}
          </span>

          {status && status.chunks.length > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono-code"
              style={{ backgroundColor: 'var(--bg-surface)', border: '1px solid var(--border-hairline)' }}
            >
              {formatChars(status.totalOriginalChars)} → {formatChars(status.totalCompressedChars)}{' '}
              chars ({status.compressionRatio}x)
            </span>
          )}
        </div>

        {cacheStats && (
          <div className="mt-2 grid grid-cols-2 gap-1.5 text-[10.5px] text-[var(--text-muted)]">
            <div className="flex items-center gap-1">
              <HardDrive size={10.5} />
              <span>
                工作区缓存 {formatBytesMb(cacheStats.workspaceBytesUsed)} /{' '}
                {formatBytesMb(cacheStats.workspaceBytesCap)}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <Sparkles size={10.5} />
              <span>
                今日外发调用 {cacheStats.dailyLlmCallsUsed} / {cacheStats.dailyLlmCallsLimit}
              </span>
            </div>
          </div>
        )}

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            data-testid="manual-compress-btn"
            disabled={compressing}
            onClick={() => void onCompressNow()}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-white transition-opacity disabled:opacity-50"
            style={{ backgroundColor: 'var(--accent-indigo)' }}
          >
            {compressing ? <Loader2 size={11.5} className="animate-spin" /> : <Minimize2 size={11.5} />}
            手动压缩历史
          </button>
          <button
            type="button"
            data-testid="clear-compression-cache-btn"
            disabled={clearing || chunks.length === 0}
            onClick={() => void onClearCache()}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1 text-[11px] hover:bg-[var(--bg-hover)] disabled:opacity-40"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            {clearing ? <Loader2 size={11.5} className="animate-spin" /> : <Trash2 size={11.5} />}
            清空缓存
          </button>
        </div>

        {errorMessage && (
          <div
            className="mt-2 rounded-lg px-2.5 py-1.5 text-[11px]"
            style={{
              backgroundColor: 'var(--accent-rose-soft)',
              color: 'var(--accent-rose)',
            }}
          >
            {errorMessage}
          </div>
        )}
      </div>

      {/* Config Form */}
      {showConfig && (
        <form
          data-testid="compression-config-form"
          onSubmit={(e) => void handleSave(e)}
          className="space-y-2 rounded-xl p-3"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="font-medium text-[var(--text-primary)]">摘要与预算配置</div>
          <label className="block space-y-1 text-[11px]">
            <span>摘要引擎实例</span>
            <select
              aria-label="摘要引擎实例"
              value={summarizerInstanceId}
              onChange={(e) => setSummarizerInstanceId(e.target.value)}
              className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1.5 text-[11.5px] text-[var(--text-primary)]"
            >
              <option value="">关闭外置 LLM（纯本地零费用模式）</option>
              {harnesses.map((h) => {
                const meta = resolveHarnessMeta({ harnessId: h.id, harnessKind: h.kind }, harnesses);
                return (
                  <option key={h.id} value={h.id}>
                    {meta.shortLabel} ({h.id})
                  </option>
                );
              })}
            </select>
          </label>

          <div className="grid grid-cols-3 gap-2 text-[11px]">
            <label className="space-y-1">
              <span>每日上限</span>
              <input
                aria-label="每日外发调用上限"
                type="number"
                min={0}
                max={10000}
                value={dailyCallLimit}
                onChange={(e) => setDailyCallLimit(Number(e.target.value))}
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[var(--text-primary)]"
              />
            </label>
            <label className="space-y-1">
              <span>会话 Token 预算</span>
              <input
                aria-label="会话 Token 预算上限"
                type="number"
                min={1000}
                max={5000000}
                value={sessionTokenBudgetCap}
                onChange={(e) => setSessionTokenBudgetCap(Number(e.target.value))}
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[var(--text-primary)]"
              />
            </label>
            <label className="space-y-1">
              <span>超时 (ms)</span>
              <input
                aria-label="摘要硬超时毫秒"
                type="number"
                min={100}
                max={60000}
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(Number(e.target.value))}
                className="w-full rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[var(--text-primary)]"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={backgroundRollupEnabled}
              onChange={(e) => setBackgroundRollupEnabled(e.target.checked)}
            />
            <span>空闲自动滚动压缩历史（turn.completed ≥ {cfg.rollupTurnThreshold} 轮触发）</span>
          </label>

          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setShowConfig(false)}
              className="rounded-lg px-2.5 py-1 text-[11px] hover:bg-[var(--bg-hover)]"
              style={{ border: '1px solid var(--border-hairline)' }}
            >
              取消
            </button>
            <button
              type="submit"
              disabled={savingConfig}
              className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--accent-indigo)' }}
            >
              {savingConfig && <Loader2 size={11} className="animate-spin" />}
              保存配置
            </button>
          </div>
        </form>
      )}

      {/* Compressed Chunks */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-[11px] font-medium text-[var(--text-primary)]">
          <span>分段压缩缓存 ({chunks.length})</span>
        </div>

        {chunks.length === 0 ? (
          <div
            className="rounded-xl p-3 text-[11px] text-[var(--text-muted)]"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-hairline)',
            }}
          >
            尚未生成压缩分块；长会话切换交接或点击「手动压缩历史」后，将在不修改原始消息记录的前提下建立只读摘要缓存。
          </div>
        ) : (
          chunks.map((chunk) => {
            const missingRefs = chunk.referencedPaths.filter((r) => !r.existsAtCheck);
            return (
              <div
                key={chunk.chunkId}
                data-testid={`compression-chunk-${chunk.chunkId}`}
                className="space-y-1.5 rounded-xl p-2.5"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="font-mono-code text-[11px] font-semibold text-[var(--text-primary)]">
                    Turns {chunk.fromTurn}–{chunk.toTurn}: {formatChars(chunk.originalChars)} →{' '}
                    {formatChars(chunk.compressedChars)} chars ({chunk.compressionRatio}x)
                  </span>
                  <div className="flex items-center gap-1 text-[10px]">
                    {chunk.cacheHit && (
                      <span
                        className="rounded px-1.5 py-0.5"
                        style={{
                          backgroundColor: 'var(--accent-emerald-soft)',
                          color: 'var(--accent-emerald)',
                        }}
                      >
                        缓存命中
                      </span>
                    )}
                    {chunk.fallback && (
                      <span
                        className="rounded px-1.5 py-0.5"
                        style={{
                          backgroundColor: 'var(--accent-star-soft)',
                          color: 'var(--accent-star)',
                        }}
                      >
                        降级本地 ({chunk.fallbackReason ?? 'fallback'})
                      </span>
                    )}
                    <span
                      className="rounded px-1.5 py-0.5"
                      style={{ backgroundColor: 'var(--bg-surface)' }}
                    >
                      {chunk.usedLlm ? 'LLM' : '本地轮廓'}
                    </span>
                  </div>
                </div>

                <pre className="max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--bg-surface)] p-2 font-sans text-[11px] leading-relaxed text-[var(--text-secondary)]">
                  {chunk.summaryMarkdown}
                </pre>

                {chunk.referencedPaths.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[10.5px]">
                    {chunk.referencedPaths.map((ref) => (
                      <span
                        key={ref.path}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono-code"
                        style={{
                          backgroundColor: ref.existsAtCheck
                            ? 'var(--bg-surface)'
                            : 'var(--accent-rose-soft)',
                          color: ref.existsAtCheck
                            ? 'var(--text-secondary)'
                            : 'var(--accent-rose)',
                          border: '1px solid var(--border-hairline)',
                        }}
                      >
                        {ref.existsAtCheck ? (
                          <CheckCircle2 size={10} />
                        ) : (
                          <AlertTriangle size={10} />
                        )}
                        {ref.path}
                        {!ref.existsAtCheck && ' [已删除/已重命名]'}
                      </span>
                    ))}
                    {missingRefs.length > 0 && (
                      <span className="text-[10px] text-[var(--accent-rose)]">
                        发现 {missingRefs.length} 个未验证路径
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Hot File Symbol Outlines */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-[var(--text-primary)]">
          热点文件符号轮廓 ({symbolOutlines.length})
        </div>
        {symbolOutlines.length === 0 ? (
          <div className="text-[11px] text-[var(--text-muted)]">暂无已索引的源码符号轮廓。</div>
        ) : (
          symbolOutlines.map((file) => (
            <div
              key={file.path}
              className="rounded-xl p-2"
              style={{
                backgroundColor: 'var(--bg-elevated)',
                border: '1px solid var(--border-hairline)',
              }}
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="inline-flex min-w-0 items-center gap-1 truncate font-mono-code text-[var(--text-primary)]">
                  <FileCode2 size={11.5} className="shrink-0 text-[var(--accent-indigo)]" />
                  <span className="truncate">{file.path}</span>
                </span>
                <span className="shrink-0 text-[10px] text-[var(--text-muted)]">
                  {file.language} · {file.symbols.length} 符号
                </span>
              </div>
              {file.symbols.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {file.symbols.slice(0, 12).map((sym, idx) => (
                    <span
                      key={`${sym.name}:${sym.line}:${idx}`}
                      className="rounded bg-[var(--bg-surface)] px-1.5 py-0.5 font-mono-code text-[10px]"
                    >
                      L{sym.line} {sym.exported ? 'export ' : ''}
                      {sym.kind} {sym.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function ContextCompressionPanel({ session }: { session: Session }) {
  const harnesses = useAppStore((state) => state.harnesses);
  const pushToast = useAppStore((state) => state.pushToast);

  const [status, setStatus] = useState<SessionCompressionStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [compressing, setCompressing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setErrorMessage(null);
    try {
      const next = await daemonApi.getSessionCompression(session.id);
      setStatus(next);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCompress = async (opts?: { forceRecompute?: boolean }) => {
    setCompressing(true);
    setErrorMessage(null);
    try {
      const res = await daemonApi.compressSessionContext(session.id, opts);
      setStatus(res.status);
      pushToast({
        kind: 'info',
        title: `上下文压缩完成 (${res.result.compressionRatio}x)`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      pushToast({ kind: 'error', title: '上下文压缩失败', body: msg });
    } finally {
      setCompressing(false);
    }
  };

  const handleClear = async () => {
    setClearing(true);
    setErrorMessage(null);
    try {
      const res = await daemonApi.clearSessionCompressionCache(session.id);
      setStatus(res.status);
      pushToast({ kind: 'info', title: `已清理 ${res.clearedCount} 条压缩缓存` });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
    } finally {
      setClearing(false);
    }
  };

  const handleSaveConfig = async (patch: UpdateCompressionConfigRequest) => {
    setSavingConfig(true);
    setErrorMessage(null);
    try {
      await daemonApi.updateCompressionConfig(patch);
      await refresh();
      pushToast({ kind: 'info', title: '压缩配置已更新' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setErrorMessage(msg);
      pushToast({ kind: 'error', title: '保存配置失败', body: msg });
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <ContextCompressionPanelView
      session={session}
      status={status}
      harnesses={harnesses}
      loading={loading}
      compressing={compressing}
      clearing={clearing}
      savingConfig={savingConfig}
      errorMessage={errorMessage}
      onRefresh={() => void refresh()}
      onCompressNow={handleCompress}
      onClearCache={handleClear}
      onSaveConfig={handleSaveConfig}
    />
  );
}
