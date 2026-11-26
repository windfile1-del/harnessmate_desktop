import { Puzzle, RotateCcw, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { useAppStore } from '../stores/app-store';

export function KernelRecoveryView() {
  const { restorePluginComposition, openModal, pushToast } = useAppStore();
  const [busy, setBusy] = useState(false);

  const runRestore = async (source: 'builtin' | 'previous') => {
    setBusy(true);
    try {
      await restorePluginComposition(source);
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '恢复组合失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      aria-label="内核恢复模式"
      className="flex min-h-0 flex-1 items-center justify-center p-6"
      style={{ backgroundColor: 'var(--bg-canvas)' }}
    >
      <div
        className="w-full max-w-md space-y-4 rounded-2xl p-6"
        style={{
          backgroundColor: 'var(--bg-surface)',
          border: '1px solid var(--border-strong)',
        }}
      >
        <div className="flex items-start gap-3">
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
            style={{
              backgroundColor: 'var(--accent-indigo-soft)',
              color: 'var(--accent-indigo)',
            }}
          >
            <ShieldAlert size={20} />
          </div>
          <div className="space-y-1">
            <h1 className="text-[15.5px] font-semibold text-[var(--text-primary)]">
              内核恢复模式（空业务组合）
            </h1>
            <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)]">
              当前未装配任何业务插件，仅保留内核装配与恢复能力。可重新启用预装组合、恢复上一套可用配置，或打开插件中心检查配置与版本。
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => void runRestore('builtin')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3.5 py-2 text-[12px] font-medium text-white disabled:opacity-50"
            style={{ backgroundColor: 'var(--accent-indigo)' }}
          >
            <RotateCcw size={13} />
            重新启用预装组合
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void runRestore('previous')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] px-3.5 py-2 text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            恢复上一套配置
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => openModal('plugins')}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[var(--border-hairline)] px-3.5 py-2 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <Puzzle size={13} />
            打开插件恢复中心
          </button>
        </div>
      </div>
    </main>
  );
}
