import type {
  BuilderV2Result,
  PluginBuilderInstallMode,
  PluginManifest,
  PluginPanelQuery,
  Session,
} from '@harnessmate/protocol';
import {
  AlertTriangle,
  CheckCircle2,
  FileCode2,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  XCircle,
} from 'lucide-react';
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
  contributes.programs?.forEach((program) => add('program', program.id, `处理程序 ${program.id}`, program));
  contributes.actions?.forEach((action) => add('action', action.command, `插件动作 /${action.command}`, action));
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
        {manifest.contributes.actions?.map((action) => <p key={action.command}>/{action.command} · 工作区授权后由用户主动执行
          {action.kind === 'harness' ? ` · /${action.nativeCommand}${action.args ? ` ${action.args}` : ''}` : ''}</p>)}
        {manifest.contributes.programs?.filter(({ exposeToModel }) => exposeToModel).map((program) =>
          <p key={program.id}>模型工具 {program.id} · 工作区授权后向当前 CLI 提供文本处理</p>)}
      </div>
      {panels.length > 0 && <PluginDraftReplay manifest={manifest} workspaceId={workspaceId} />}
      {!!manifest.contributes.programs?.length && <PluginProgramPreview manifest={manifest} />}
    </>
  );
}

function PluginProgramPreview({ manifest }: { manifest: PluginManifest }) {
  const programs = manifest.contributes.programs ?? [];
  const [programId, setProgramId] = useState(programs[0]?.id ?? '');
  const [text, setText] = useState('');
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    setOutput(undefined);
    setError('');
    try { setOutput((await daemonApi.previewPluginProgram({ manifest, programId, text })).output); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRunning(false); }
  };
  return <section aria-label="处理程序预演" className="space-y-2 rounded-lg border border-[var(--border-hairline)] p-3">
    <h5 className="font-medium text-[var(--text-primary)]">处理程序预演</h5>
    <select aria-label="预演处理程序" className="rounded bg-[var(--bg-surface)] p-1.5" value={programId} disabled={running}
      onChange={(event) => { setProgramId(event.target.value); setOutput(undefined); setError(''); }}>
      {programs.map(({ id, description }) => <option key={id} value={id}>{description}</option>)}
    </select>
    <textarea aria-label="处理程序输入" className="w-full rounded bg-[var(--bg-surface)] p-2" rows={3} maxLength={12_000} value={text}
      disabled={running} onChange={(event) => { setText(event.target.value); setOutput(undefined); setError(''); }} />
    <button type="button" className="rounded border border-[var(--border-hairline)] px-2 py-1 hover:bg-[var(--bg-hover)]"
      disabled={running} onClick={() => void run()}>运行样例</button>
    {output !== undefined && <pre aria-label="处理程序输出" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--bg-surface)] p-2">{output || '（空结果）'}</pre>}
    {error && <p role="alert" className="text-[var(--accent-rose)]">{error}</p>}
  </section>;
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

const RISK_STYLE: Record<'low' | 'medium' | 'high', { label: string; color: string; bg: string }> = {
  low: { label: '低风险', color: 'var(--accent-emerald)', bg: 'var(--accent-emerald-soft)' },
  medium: { label: '中风险', color: 'var(--accent-star)', bg: 'var(--accent-star-soft)' },
  high: { label: '高风险', color: 'var(--accent-rose)', bg: 'var(--accent-rose-soft)' },
};

export interface PluginBuilderV2ReviewProps {
  result: BuilderV2Result;
  trustCode: boolean;
  onTrustCodeChange: (trusted: boolean) => void;
  installMode: PluginBuilderInstallMode;
  onInstallModeChange: (mode: PluginBuilderInstallMode) => void;
  installing?: boolean;
  onInstall: () => void;
}

/**
 * Pure presentation & confirmation panel for Tier 2 AI Plugin Builder v2 packages:
 * displays the 4-step sandbox pipeline, repair attempts, static security audit issues,
 * permission risk matrix, generated multi-file code tree, and explicit trust gate.
 */
export function PluginBuilderV2Review({
  result,
  trustCode,
  onTrustCodeChange,
  installMode,
  onInstallModeChange,
  installing = false,
  onInstall,
}: PluginBuilderV2ReviewProps) {
  const fileNames = Object.keys(result.files ?? {}).sort((a, b) => a.localeCompare(b));
  const [selectedFile, setSelectedFile] = useState<string>(
    () => fileNames.find((f) => f === 'index.mjs') ?? fileNames[0] ?? 'harnessmate-plugin.json',
  );

  useEffect(() => {
    if (fileNames.length > 0 && !fileNames.includes(selectedFile)) {
      setSelectedFile(fileNames.find((f) => f === 'index.mjs') ?? fileNames[0]!);
    }
  }, [fileNames, selectedFile]);

  const auditPassed = Boolean(result.audit?.passed);
  const canInstall =
    result.verified && auditPassed && trustCode && Boolean(result.digest) && !installing;
  const activeFileName = fileNames.includes(selectedFile) ? selectedFile : fileNames[0];
  const activeFileContent = activeFileName ? result.files?.[activeFileName] ?? '' : '';

  return (
    <section
      data-testid="builder-v2-review"
      className="space-y-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-3.5 text-[12px]"
    >
      {/* Header Summary */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {auditPassed && result.verified ? (
            <ShieldCheck size={16} style={{ color: 'var(--accent-emerald)' }} />
          ) : (
            <ShieldAlert size={16} style={{ color: 'var(--accent-rose)' }} />
          )}
          <span className="font-semibold text-[var(--text-primary)]">
            Tier 2 代码插件工程验证报告
          </span>
          {result.templateUsed && (
            <span
              className="rounded px-1.5 py-0.5 font-mono-code text-[10.5px]"
              style={{
                backgroundColor: 'var(--accent-indigo-soft)',
                color: 'var(--accent-indigo)',
              }}
            >
              {result.templateUsed}
            </span>
          )}
        </div>
        <span className="text-[11px] text-[var(--text-muted)]">{result.classificationReason}</span>
      </div>

      {/* 4-Step Sandbox Pipeline */}
      {result.steps && result.steps.length > 0 && (
        <div data-testid="builder-v2-steps" className="space-y-1.5">
          <h5 className="font-medium text-[var(--text-primary)]">4 步沙箱验证流水线</h5>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {result.steps.map((step) => (
              <div
                key={step.step}
                data-testid={`builder-step-${step.step}`}
                className="flex items-start gap-2 rounded-lg p-2"
                style={{
                  backgroundColor: 'var(--bg-surface)',
                  border:
                    step.status === 'failed'
                      ? '1px solid var(--accent-rose)'
                      : '1px solid var(--border-hairline)',
                }}
              >
                {step.status === 'passed' ? (
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-emerald)' }} />
                ) : step.status === 'failed' ? (
                  <XCircle size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent-rose)' }} />
                ) : (
                  <SkipForward size={14} className="mt-0.5 shrink-0 text-[var(--text-muted)]" />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-1">
                    <span className="font-medium text-[var(--text-primary)]">{step.label}</span>
                    <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                      {step.durationMs}ms
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">{step.details}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Self-Repair Attempts History */}
      {result.attempts && result.attempts.length > 1 && (
        <div data-testid="builder-v2-attempts" className="space-y-1">
          <h5 className="font-medium text-[var(--text-primary)]">
            自动修复迭代记录（共 {result.attempts.length} 轮 / 上限 3 轮）
          </h5>
          <ul className="space-y-1 text-[11px]">
            {result.attempts.map((a) => (
              <li
                key={a.attempt}
                className="flex items-start justify-between gap-2 rounded-lg bg-[var(--bg-surface)] px-2.5 py-1.5"
              >
                <span className="font-medium text-[var(--text-primary)]">
                  第 {a.attempt} 轮 · {a.passed ? '通过' : '未通过'}
                  {a.errorSummary ? `：${a.errorSummary}` : ''}
                </span>
                <span className="shrink-0 font-mono-code text-[10px] text-[var(--text-muted)]">
                  {a.durationMs}ms
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Static Security Audit Findings & Permission Risk Matrix */}
      {result.audit && (
        <div data-testid="builder-v2-audit" className="space-y-2">
          {result.audit.blockingIssues.length > 0 && (
            <div
              data-testid="builder-v2-blocking-issues"
              className="space-y-1.5 rounded-xl p-2.5"
              style={{
                backgroundColor: 'var(--accent-rose-soft)',
                border: '1px solid var(--accent-rose)',
              }}
            >
              <div className="flex items-center gap-1.5 font-semibold" style={{ color: 'var(--accent-rose)' }}>
                <XCircle size={14} />
                <span>静态安全审计阻断（{result.audit.blockingIssues.length} 项高危问题，禁止安装）</span>
              </div>
              <ul className="ml-4 list-disc space-y-1 text-[11px] text-[var(--text-primary)]">
                {result.audit.blockingIssues.map((issue, idx) => (
                  <li key={`${issue.code}:${idx}`}>
                    <code className="font-mono-code text-[10.5px]">{issue.code}</code>
                    {issue.file && <span className="ml-1 font-mono-code text-[var(--text-muted)]">({issue.file}{issue.line ? `:${issue.line}` : ''})</span>}
                    {' — '}
                    {issue.message}
                    {issue.suggestion && <div className="text-[10.5px] text-[var(--text-secondary)]">建议：{issue.suggestion}</div>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.audit.warnings.length > 0 && (
            <div
              data-testid="builder-v2-warnings"
              className="space-y-1 rounded-xl p-2.5"
              style={{
                backgroundColor: 'var(--accent-star-soft)',
                border: '1px solid var(--accent-star)',
              }}
            >
              <div className="flex items-center gap-1.5 font-medium" style={{ color: 'var(--accent-star)' }}>
                <AlertTriangle size={13.5} />
                <span>最小权限建议（{result.audit.warnings.length} 项告警）</span>
              </div>
              <ul className="ml-4 list-disc space-y-0.5 text-[11px] text-[var(--text-primary)]">
                {result.audit.warnings.map((w, idx) => (
                  <li key={`${w.code}:${idx}`}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          {result.audit.permissionSummary.length > 0 && (
            <div className="space-y-1">
              <h5 className="font-medium text-[var(--text-primary)]">声明权限与风险分级</h5>
              <div className="flex flex-wrap gap-1.5">
                {result.audit.permissionSummary.map((perm) => {
                  const style = RISK_STYLE[perm.risk];
                  return (
                    <span
                      key={perm.capability}
                      title={perm.description}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-0.5 font-mono-code text-[10.5px]"
                      style={{
                        backgroundColor: style.bg,
                        color: style.color,
                        border: '1px solid var(--border-hairline)',
                      }}
                    >
                      <span>{perm.capability}</span>
                      <span>· {style.label}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Multi-file Generated Code Tree Preview */}
      {fileNames.length > 0 && (
        <div data-testid="builder-v2-files" className="space-y-1.5">
          <div className="flex items-center justify-between">
            <h5 className="flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
              <FileCode2 size={13.5} />
              生成文件预览（{fileNames.length} 个文件）
            </h5>
            {result.digest && (
              <span className="font-mono-code text-[10px] text-[var(--text-muted)]">
                SHA-256: {result.digest.slice(0, 12)}…
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-1">
            {fileNames.map((fileName) => {
              const active = fileName === activeFileName;
              return (
                <button
                  key={fileName}
                  type="button"
                  onClick={() => setSelectedFile(fileName)}
                  className="cursor-pointer rounded-lg px-2 py-1 font-mono-code text-[10.5px] transition-colors"
                  style={{
                    backgroundColor: active ? 'var(--accent-indigo-soft)' : 'var(--bg-surface)',
                    color: active ? 'var(--accent-indigo)' : 'var(--text-secondary)',
                    border: '1px solid var(--border-hairline)',
                  }}
                >
                  {fileName}
                </button>
              );
            })}
          </div>
          {activeFileName && (
            <pre
              data-testid="builder-v2-file-preview"
              className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-2.5 font-mono-code text-[11px] text-[var(--text-primary)]"
            >
              {activeFileContent}
            </pre>
          )}
        </div>
      )}

      {/* Explicit Trust Gate & Install Mode Selection */}
      {result.error && (
        <p role="alert" className="rounded-lg bg-[var(--accent-rose-soft)] p-2 text-[11.5px] text-[var(--accent-rose)]">
          {result.error}
        </p>
      )}

      <div className="space-y-2 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
        <div className="flex flex-wrap items-center gap-3 text-[11.5px]">
          <span className="font-medium text-[var(--text-primary)]">部署方式：</span>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="builder-v2-install-mode"
              checked={installMode === 'local_install'}
              onChange={() => onInstallModeChange('local_install')}
            />
            <span>正式安装并热加载（签名隔离目录）</span>
          </label>
          <label className="flex cursor-pointer items-center gap-1.5">
            <input
              type="radio"
              name="builder-v2-install-mode"
              checked={installMode === 'dev_link'}
              onChange={() => onInstallModeChange('dev_link')}
            />
            <span>关联 DevMode 热重载（继续本地开发修改）</span>
          </label>
        </div>

        <label className="flex cursor-pointer items-start gap-2 text-[11.5px] text-[var(--text-secondary)]">
          <input
            type="checkbox"
            data-testid="builder-v2-trust-checkbox"
            checked={trustCode}
            disabled={!auditPassed || !result.verified}
            onChange={(e) => onTrustCodeChange(e.target.checked)}
          />
          <span>
            我已审阅上述代码文件与权限分级，并信任此代码插件在 Node 受限沙箱中运行。
          </span>
        </label>

        <button
          type="button"
          data-testid="builder-v2-install-btn"
          disabled={!canInstall}
          onClick={onInstall}
          className="cursor-pointer rounded-lg px-3.5 py-1.5 text-[12px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
          style={{
            backgroundColor: auditPassed ? 'var(--accent-indigo)' : 'var(--accent-rose)',
          }}
        >
          {installing
            ? '正在安装…'
            : !auditPassed || !result.verified
              ? '安全验证未通过 · 禁止安装'
              : installMode === 'dev_link'
                ? '安全确认并关联 DevMode 热加载'
                : '安全确认并安装启用'}
        </button>
      </div>
    </section>
  );
}
