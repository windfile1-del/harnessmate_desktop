import type { Session } from '@harnessmate/protocol';
import { ArrowRightLeft, Lock, Navigation, Workflow } from 'lucide-react';
import { useAppStore } from '../../stores/app-store';
import { AgyAgentModePicker } from './native/shared/AgyAgentModePicker';

export function AgyComposerControls({
  session,
  isRunning,
}: {
  session: Session;
  isRunning: boolean;
}) {
  const harnesses = useAppStore((s) => s.harnesses);
  const switchHarness = useAppStore((s) => s.switchHarness);
  const agyNativeWorkbenchEnabled = useAppStore((s) => s.agyNativeWorkbenchEnabled);
  const nativeSlice = useAppStore((s) => s.nativeRuntimeBySession[session.id]);
  const agyAuthState = useAppStore((s) => s.agyAuthStates[session.harnessId]);
  const setNativeAgentMode = useAppStore((s) => s.setNativeAgentMode);

  if (session.harnessKind !== 'agy') return null;

  const activeHarness = harnesses.find((h) => h.id === session.harnessId);
  const otherAgyAccounts = harnesses.filter(
    (h) => (h.driverId === 'agy' || h.kind === 'agy') && h.id !== session.harnessId,
  );
  const activeModel = session.actualModel ?? session.model ?? '';
  const isOrchestrator = activeModel.startsWith('gemini-pro-orchestrator');
  const supportsSteering = Boolean(activeHarness?.capabilitiesV2?.supportsActiveSteering);
  const profileVerified =
    agyAuthState?.phase === 'authenticated' ||
    Boolean(nativeSlice?.projection && nativeSlice.projection.capabilitiesRevision > 0);

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
      {agyNativeWorkbenchEnabled && (
        <AgyAgentModePicker
          selectedModeId={nativeSlice?.selectedModeId ?? 'normal'}
          capabilities={nativeSlice?.capabilities ?? []}
          profileVerified={profileVerified}
          disabled={isRunning && !supportsSteering}
          onSelectMode={(mode) => setNativeAgentMode(session.id, mode.id)}
        />
      )}

      {isOrchestrator && (
        <span
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium"
          style={{
            backgroundColor: 'var(--accent-indigo-soft)',
            color: 'var(--accent-indigo)',
          }}
          title="Planner + Executor 编排模型"
        >
          <Workflow size={11} />
          Orchestrator
        </span>
      )}

      {session.permissionEnforcement === 'client_guard' && (
        <span
          className="rounded-md px-1.5 py-0.5 text-[10.5px]"
          style={{
            backgroundColor: 'var(--accent-star-soft)',
            color: 'var(--accent-star)',
          }}
          title="底层 ACP 未开放原生 auto，已由客户端守卫执行权限"
        >
          client_guard
        </span>
      )}

      {isRunning && supportsSteering && session.status === 'running' && (
        <span
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium"
          style={{
            backgroundColor: 'var(--accent-emerald-soft)',
            color: 'var(--accent-emerald)',
          }}
          title="支持运行中发送 Mid-turn Steering 引导指令"
        >
          <Navigation size={11} />
          Steering 就绪
        </span>
      )}

      {isRunning && (
        <span
          className="inline-flex items-center gap-1 rounded-md border border-[var(--border-hairline)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-muted)]"
          title="轮次运行期间锁定模型与权限模式"
        >
          <Lock size={10} />
          配置已锁定
        </span>
      )}

      {otherAgyAccounts.length > 0 && (
        <div className="inline-flex items-center gap-1">
          <ArrowRightLeft size={11} className="text-[var(--text-muted)]" />
          <select
            aria-label="切换 AGY 账号"
            disabled={isRunning}
            value=""
            onChange={(e) => {
              const targetId = e.target.value;
              if (targetId) {
                void switchHarness(session.id, { targetHarnessId: targetId });
              }
            }}
            className="cursor-pointer rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)] disabled:opacity-45"
          >
            <option value="" disabled>
              切换账号 ({activeHarness?.displayName ?? session.harnessId})
            </option>
            {otherAgyAccounts.map((acc) => (
              <option key={acc.id} value={acc.id}>
                切至 {acc.displayName}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
