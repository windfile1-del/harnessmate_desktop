import type { AgyAuthMethod, AgyAuthState, AgyProfileConfig, HarnessInfo } from '@harnessmate/protocol';
import { Copy, ExternalLink, KeyRound, LogOut, Plus, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { daemonApi, type AgyInstanceEntryDto } from '../../api/client';
import { useAppStore } from '../../stores/app-store';

export interface AgySettingsSlotProps {
  harness: HarnessInfo;
  onRefresh: () => void;
  initialEntries?: AgyInstanceEntryDto[];
}

const PHASE_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  authenticated: { label: '已登录', color: 'var(--accent-emerald)', bg: 'var(--accent-emerald-soft)' },
  waiting_code: { label: '等待授权码', color: 'var(--accent-star)', bg: 'var(--accent-star-soft)' },
  starting: { label: '正在启动登录', color: 'var(--accent-indigo)', bg: 'var(--accent-indigo-soft)' },
  verifying: { label: '校验中', color: 'var(--accent-indigo)', bg: 'var(--accent-indigo-soft)' },
  unauthenticated: { label: '未登录', color: 'var(--accent-rose)', bg: 'var(--accent-rose-soft)' },
  failed: { label: '失败', color: 'var(--accent-rose)', bg: 'var(--accent-rose-soft)' },
  cancelled: { label: '已取消', color: 'var(--text-muted)', bg: 'var(--bg-surface)' },
  idle: { label: '官方默认态', color: 'var(--text-secondary)', bg: 'var(--bg-surface)' },
};

export function AgySettingsSlot({ harness, onRefresh, initialEntries }: AgySettingsSlotProps) {
  const pushToast = useAppStore((s) => s.pushToast);
  const wsAuthStates = useAppStore((s) => s.agyAuthStates);
  const [entries, setEntries] = useState<AgyInstanceEntryDto[]>(initialEntries ?? []);
  const [authCodeInput, setAuthCodeInput] = useState('');
  const [confirmSharedLogout, setConfirmSharedLogout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newInstanceId, setNewInstanceId] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newAuthMethod, setNewAuthMethod] = useState<AgyAuthMethod>('oauth-personal');

  const loadInstances = useCallback(async () => {
    if (initialEntries) return;
    try {
      const res = await daemonApi.listAgyInstances();
      setEntries(res.instances);
    } catch {
      // Ignore transient errors while daemon reconnects
    }
  }, [initialEntries]);

  useEffect(() => {
    void loadInstances();
  }, [loadInstances]);

  const currentEntry = entries.find((e) => e.profile.instanceId === harness.id);
  const profile: AgyProfileConfig | undefined = currentEntry?.profile;
  const authState: AgyAuthState | undefined = wsAuthStates[harness.id] ?? currentEntry?.authState;
  const phase = authState?.phase ?? 'idle';
  const defaultPhaseMeta = {
    label: '官方默认态',
    color: 'var(--text-secondary)',
    bg: 'var(--bg-surface)',
  } as const;
  const phaseMeta = PHASE_LABELS[phase] ?? defaultPhaseMeta;
  const isOfficialDefault = (profile?.isolationMode ?? (harness.id === 'agy' ? 'official_default' : 'profile_isolated')) === 'official_default';

  const handleStartLogin = async () => {
    setBusy(true);
    try {
      const { state } = await daemonApi.startAgyLogin(harness.id);
      setEntries((prev) =>
        prev.map((item) =>
          item.profile.instanceId === harness.id ? { ...item, authState: state } : item,
        ),
      );
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '无法启动 AGY 官方登录',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRespondLogin = async () => {
    if (!authState?.flowId || !authCodeInput.trim()) return;
    setBusy(true);
    try {
      await daemonApi.respondAgyLogin(harness.id, authState.flowId, authCodeInput.trim());
      setAuthCodeInput('');
      await loadInstances();
      onRefresh();
      pushToast({ kind: 'success', title: `${harness.displayName} 登录成功` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: 'Google 授权校验失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCancelLogin = async () => {
    setBusy(true);
    try {
      await daemonApi.cancelAgyLogin(harness.id, authState?.flowId ?? undefined);
      setAuthCodeInput('');
      await loadInstances();
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    if (isOfficialDefault && !confirmSharedLogout) return;
    setBusy(true);
    try {
      await daemonApi.logoutAgy(harness.id, isOfficialDefault ? confirmSharedLogout : undefined);
      setConfirmSharedLogout(false);
      await loadInstances();
      onRefresh();
      pushToast({ kind: 'info', title: `${harness.displayName} 已登出` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '登出失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleCreateIsolated = async () => {
    const id = newInstanceId.trim();
    const displayName = newDisplayName.trim() || id;
    if (!id) return;
    setBusy(true);
    try {
      await daemonApi.upsertAgyInstance({
        instanceId: id,
        displayName,
        isolationMode: 'profile_isolated',
        authMethod: newAuthMethod,
        appDataDirName: 'antigravity-cli',
        enabled: true,
      });
      setNewInstanceId('');
      setNewDisplayName('');
      setShowCreateForm(false);
      await loadInstances();
      onRefresh();
      pushToast({ kind: 'success', title: `已创建隔离账号 ${displayName}` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '创建 AGY Profile 失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteProfile = async () => {
    if (harness.id === 'agy') return;
    setBusy(true);
    try {
      await daemonApi.deleteAgyInstance(harness.id, true);
      onRefresh();
      pushToast({ kind: 'info', title: `已移除隔离账号 ${harness.displayName}` });
    } catch (err) {
      pushToast({
        kind: 'error',
        title: '移除失败',
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="space-y-2.5 rounded-xl p-2.5 text-[11.5px]"
      style={{
        backgroundColor: 'var(--bg-surface)',
        border: '1px solid var(--border-hairline)',
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium"
            style={{
              backgroundColor: isOfficialDefault ? 'var(--accent-star-soft)' : 'var(--accent-indigo-soft)',
              color: isOfficialDefault ? 'var(--accent-star)' : 'var(--accent-indigo)',
            }}
          >
            {isOfficialDefault ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
            {isOfficialDefault ? '官方默认 · 共享系统凭据' : '独立 Profile · 文件隔离'}
          </span>

          <span
            className="rounded-full px-2 py-0.5 text-[10.5px] font-medium"
            style={{ backgroundColor: phaseMeta.bg, color: phaseMeta.color }}
          >
            {phaseMeta.label}
          </span>

          {authState?.identity?.tierName && (
            <span className="font-mono-code rounded-full border border-[var(--border-hairline)] px-2 py-0.5 text-[10px] text-[var(--text-secondary)]">
              {authState.identity.tierName}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {(profile?.authMethod ?? 'oauth-personal') === 'oauth-personal' && phase !== 'waiting_code' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleStartLogin()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-[var(--accent-indigo)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-45"
            >
              <KeyRound size={11} />
              官方 Google 登录
            </button>
          )}
          <button
            type="button"
            disabled={busy || (isOfficialDefault && !confirmSharedLogout)}
            onClick={() => void handleLogout()}
            className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
          >
            <LogOut size={11} />
            登出
          </button>
          {harness.id !== 'agy' && (
            <button
              type="button"
              disabled={busy}
              aria-label={`删除 ${harness.displayName}`}
              onClick={() => void handleDeleteProfile()}
              className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--accent-rose)] hover:bg-[var(--bg-hover)] disabled:opacity-45"
            >
              <Trash2 size={11} />
              移除
            </button>
          )}
        </div>
      </div>

      {isOfficialDefault && (
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={confirmSharedLogout}
            onChange={(e) => setConfirmSharedLogout(e.target.checked)}
          />
          确认登出本机共享凭据（将影响本地 Antigravity IDE/CLI）
        </label>
      )}

      {profile?.authMethod === 'oauth-business' && (
        <p className="text-[11px] text-[var(--accent-star)]">
          提示：Gemini Enterprise 企业账号受限于上游 CLI issue #1610，暂不支持多账号并发文件隔离。
        </p>
      )}

      {authState?.phase === 'waiting_code' && authState.authorizationUrl && (
        <div
          className="space-y-2 rounded-lg p-2.5"
          style={{
            backgroundColor: 'var(--bg-elevated)',
            border: '1px solid var(--border-hairline)',
          }}
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[var(--text-primary)]">
              请在浏览器完成官方 Google 授权，并粘贴回调 URL 或授权码：
            </span>
            <button
              type="button"
              onClick={() => void handleCancelLogin()}
              className="cursor-pointer rounded p-0.5 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            >
              <X size={12} />
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              aria-label="Google OAuth 授权链接"
              value={authState.authorizationUrl}
              className="font-mono-code flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[10.5px] text-[var(--text-secondary)]"
            />
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(authState.authorizationUrl ?? '');
                pushToast({ kind: 'info', title: '已复制 Google 授权链接' });
              }}
              className="inline-flex cursor-pointer items-center gap-1 rounded border border-[var(--border-hairline)] px-2 py-1 text-[11px] hover:bg-[var(--bg-hover)]"
            >
              <Copy size={11} />
              复制
            </button>
            <a
              href={authState.authorizationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] px-2 py-1 text-[11px] text-[var(--accent-indigo)] hover:bg-[var(--bg-hover)]"
            >
              <ExternalLink size={11} />
              打开
            </a>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              placeholder="粘贴 https://antigravity.google/oauth-callback?... 或授权码"
              value={authCodeInput}
              onChange={(e) => setAuthCodeInput(e.target.value)}
              className="font-mono-code flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px] text-[var(--text-primary)]"
            />
            <button
              type="button"
              disabled={busy || !authCodeInput.trim()}
              onClick={() => void handleRespondLogin()}
              className="cursor-pointer rounded bg-[var(--accent-emerald)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-45"
            >
              提交验证
            </button>
          </div>
        </div>
      )}

      {harness.id === 'agy' && (
        <div className="pt-1" style={{ borderTop: '1px solid var(--border-hairline)' }}>
          {!showCreateForm ? (
            <button
              type="button"
              onClick={() => setShowCreateForm(true)}
              className="inline-flex cursor-pointer items-center gap-1 text-[11px] font-medium text-[var(--accent-indigo)] hover:underline"
            >
              <Plus size={12} />
              新增独立 Google 账号 Profile
            </button>
          ) : (
            <div className="space-y-2 rounded-lg bg-[var(--bg-elevated)] p-2.5">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[var(--text-primary)]">新增隔离 AGY 账号</span>
                <button
                  type="button"
                  onClick={() => setShowCreateForm(false)}
                  className="cursor-pointer text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                >
                  <X size={12} />
                </button>
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-3">
                <input
                  type="text"
                  placeholder="实例 ID (如 agy-work)"
                  value={newInstanceId}
                  onChange={(e) => setNewInstanceId(e.target.value)}
                  className="font-mono-code rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px]"
                />
                <input
                  type="text"
                  placeholder="显示名称 (如 Work Gmail)"
                  value={newDisplayName}
                  onChange={(e) => setNewDisplayName(e.target.value)}
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px]"
                />
                <select
                  value={newAuthMethod}
                  onChange={(e) => setNewAuthMethod(e.target.value as AgyAuthMethod)}
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-1 text-[11px]"
                >
                  <option value="oauth-personal">Google 个人账号 (OAuth 隔离)</option>
                  <option value="gemini-api-key">Gemini API Key</option>
                  <option value="agent-platform">Agent Platform API Key</option>
                </select>
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={busy || !newInstanceId.trim()}
                  onClick={() => void handleCreateIsolated()}
                  className="cursor-pointer rounded bg-[var(--accent-indigo)] px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-45"
                >
                  创建隔离实例
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
