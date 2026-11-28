import { useState } from 'react';
import type { ReactNode } from 'react';
import { RefreshCw, Plus, Trash2, X } from 'lucide-react';
import type { TrustedModulePageBridge } from '../../slots/TrustedPluginModuleHost';
import { SettingsSurface } from './SettingsView';
import { HarnessBadge } from '../../components/BrandMark';
import { useManagementStore as useAppStore } from './store';
function ModalHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="flex items-start justify-between gap-4 px-5 py-4"
      style={{ borderBottom: '1px solid var(--border-hairline)' }}
    >
      <div>
        <h3 className="text-[15.5px] font-semibold tracking-tight text-[var(--text-primary)]">
          {title}
        </h3>
        {subtitle && <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{subtitle}</p>}
      </div>
      <button
        type="button"
        onClick={onClose}
        className="cursor-pointer rounded-lg p-1.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
      >
        <X size={16} />
      </button>
    </div>
  );
}

export function HarnessCenterModal({ onClose, bridge }: { onClose: () => void; bridge: TrustedModulePageBridge }) {
  const { harnesses, refreshHarnesses, registerCustomHarness, deleteCustomHarness, pushToast } =
    useAppStore();
  const [refreshing, setRefreshing] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [customId, setCustomId] = useState('');
  const [customName, setCustomName] = useState('');
  const [customCmd, setCustomCmd] = useState('');
  const [customArgs, setCustomArgs] = useState('acp --stdio');

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await refreshHarnesses();
    } finally {
      setRefreshing(false);
    }
  };

  const handleAddCustom = async () => {
    if (!customId.trim() || !customName.trim() || !customCmd.trim()) return;
    try {
      await registerCustomHarness({
        id: customId.trim().toLowerCase(),
        displayName: customName.trim(),
        description: `Custom ACP CLI (${customCmd.trim()})`,
        command: customCmd.trim(),
        args: customArgs.trim().split(/\s+/).filter(Boolean),
      });
      setShowAdd(false);
      setCustomId('');
      setCustomName('');
      setCustomCmd('');
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '注册失败',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div>
      <ModalHeader
        title="本机 CLI Harness 引擎管理"
        subtitle="实时探测本机 CLI 版本、订阅身份与动态模型目录，并支持注册任意 ACP CLI"
        onClose={onClose}
      />

      <div className="max-h-[480px] space-y-3 overflow-y-auto p-5">
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => void handleRefresh()}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
            style={{ border: '1px solid var(--border-hairline)' }}
          >
            <RefreshCw size={13} className={refreshing ? 'animate-spin' : ''} />
            重新探测 CLI 与模型
          </button>

          <button
            type="button"
            onClick={() => setShowAdd(!showAdd)}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl px-3 py-1.5 text-[12px] font-medium text-[var(--accent-indigo)] hover:bg-[var(--bg-active)]"
            style={{ border: '1px solid var(--border-focus)' }}
          >
            <Plus size={13} />
            注册自定义 ACP CLI
          </button>
        </div>

        {showAdd && (
          <div
            className="space-y-2.5 rounded-xl p-3.5"
            style={{
              backgroundColor: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
            }}
          >
            <div className="grid grid-cols-2 gap-2">
              <input
                value={customId}
                onChange={(e) => setCustomId(e.target.value)}
                placeholder="ID (如 opencode)"
                className="font-mono-code rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
              <input
                value={customName}
                onChange={(e) => setCustomName(e.target.value)}
                placeholder="显示名 (如 OpenCode CLI)"
                className="rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <input
                value={customCmd}
                onChange={(e) => setCustomCmd(e.target.value)}
                placeholder="可执行命令 (如 opencode)"
                className="font-mono-code rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
              <input
                value={customArgs}
                onChange={(e) => setCustomArgs(e.target.value)}
                placeholder="ACP 参数 (如 acp --stdio)"
                className="font-mono-code rounded-lg px-2.5 py-1.5 text-[12px] text-[var(--text-primary)] focus:outline-none"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border: '1px solid var(--border-hairline)',
                }}
              />
            </div>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleAddCustom()}
                className="cursor-pointer rounded-lg px-3 py-1.5 text-[12px] font-medium text-white"
                style={{ backgroundColor: 'var(--accent-indigo)' }}
              >
                保存并探测
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2.5">
          {harnesses.map((h) => {
            const ready = h.health === 'ready';
            return (
              <div
                key={h.id}
                className="rounded-xl p-3.5"
                style={{
                  backgroundColor: 'var(--bg-elevated)',
                  border: '1px solid var(--border-hairline)',
                }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <HarnessBadge kind={h.kind} label={h.displayName} presentation={h.presentation} />
                    <span
                      className="text-[11.5px] font-medium"
                      style={{
                        color: ready ? 'var(--accent-emerald)' : 'var(--accent-rose)',
                      }}
                    >
                      {ready ? `就绪 · v${h.version ?? 'ok'} · ${h.models.length} 模型` : '不可用'}
                    </span>
                  </div>
                  {h.isCustom && (
                    <button
                      type="button"
                      onClick={() => void deleteCustomHarness(h.id)}
                      className="cursor-pointer rounded p-1 text-[var(--text-muted)] hover:text-[var(--accent-rose)]"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>

                <div className="mt-2 space-y-1 text-[11.5px] text-[var(--text-secondary)]">
                  <div>协议：{h.protocolLabel}</div>
                  {h.driverId && (
                    <div className="font-mono-code text-[10.5px] text-[var(--text-muted)]">
                      驱动：{h.driverId} · 实例：{h.instanceId ?? h.id}
                      {h.capabilitiesV2?.transport ? ` · ${h.capabilitiesV2.transport}` : ''}
                    </div>
                  )}
                  {h.accountSummary && <div>账号 / 网关：{h.accountSummary}</div>}
                  <div className="font-mono-code truncate text-[11px] text-[var(--text-muted)]">
                    路径：{h.binaryPath ?? h.healthMessage ?? '未找到'}
                  </div>
                </div>
                <div className="mt-2.5">
                  <SettingsSurface bridge={bridge} harness={h} onRefresh={() => void handleRefresh()} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
