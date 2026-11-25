import type { ChildProcess } from 'node:child_process';
import type { RuntimeBinding } from '@harnessmate/protocol';
import { killProcessTree as killNodeProcessTree } from '../../../process.js';
import type {
  CliVersionCompatProfile,
  ParsedAcpInitializeCapabilities,
} from './types.js';

export interface OwnedProcessRecord {
  readonly pid: number;
  readonly binding: RuntimeBinding;
  readonly connectionId: string;
  readonly cliVersion: string | null;
  readonly platform: NodeJS.Platform;
  readonly spawnedAt: number;
}

export interface TeardownTransport {
  sendCancel(nativeSessionId: string): boolean | Promise<boolean>;
  sendSessionClose?(nativeSessionId: string): Promise<boolean>;
  isProcessAlive(pid: number): boolean;
  killProcessTree(
    pid: number,
    platform: NodeJS.Platform,
  ): Promise<{
    readonly ok: boolean;
    readonly method: 'taskkill_tree' | 'posix_pgroup' | 'already_exited' | 'failed';
    readonly detail?: string;
  }>;
  wait(ms: number): Promise<void>;
  now(): number;
}

export interface TeardownAuditResult {
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly refusedNotOwned: boolean;
  readonly stepsExecuted: readonly string[];
  readonly cancelSent: boolean;
  readonly closeSent: boolean;
  readonly closeSkippedReason?: string;
  readonly treeKillInvoked: boolean;
  readonly treeKillMethod?: 'taskkill_tree' | 'posix_pgroup' | 'already_exited' | 'failed';
  readonly exitedCleanly: boolean;
  readonly elapsedMs: number;
}

function sameBinding(a: RuntimeBinding, b: RuntimeBinding): boolean {
  return (
    a.runtimeId === b.runtimeId &&
    a.generation === b.generation &&
    a.sessionId === b.sessionId &&
    a.instanceId === b.instanceId
  );
}

export function createDefaultNodeTeardownTransport(
  child: ChildProcess,
  rpcActions?: {
    readonly sendCancel: (nativeSessionId: string) => boolean | Promise<boolean>;
    readonly sendSessionClose?: (nativeSessionId: string) => Promise<boolean>;
  },
): TeardownTransport {
  return {
    sendCancel: rpcActions?.sendCancel ?? (() => false),
    sendSessionClose: rpcActions?.sendSessionClose,
    isProcessAlive: (pid) => {
      if (child.pid !== pid) return false;
      return child.exitCode === null && child.signalCode === null;
    },
    killProcessTree: async (pid, platform) => {
      if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null) {
        return { ok: true, method: 'already_exited' };
      }
      await killNodeProcessTree(child);
      return {
        ok: child.exitCode !== null || child.signalCode !== null,
        method: platform === 'win32' ? 'taskkill_tree' : 'posix_pgroup',
      };
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
    now: () => Date.now(),
  };
}

/**
 * Coordinates per-CLI-version graceful cancellation, `session/close`, and Windows/POSIX
 * process-tree cleanup strictly for processes owned by the matching HM runtime binding + generation.
 */
export class AgyProcessTreeTeardownCoordinator {
  private readonly ownedByPid = new Map<number, OwnedProcessRecord>();

  constructor(
    private readonly defaults: {
      readonly cancelGraceMs?: number;
      readonly closeGraceMs?: number;
      readonly pollIntervalMs?: number;
    } = {},
  ) {}

  registerOwnedProcess(record: OwnedProcessRecord): void {
    this.ownedByPid.set(record.pid, record);
  }

  unregisterOwnedProcess(pid: number): void {
    this.ownedByPid.delete(pid);
  }

  getOwnedProcess(pid: number): OwnedProcessRecord | undefined {
    return this.ownedByPid.get(pid);
  }

  async teardownConnection(input: {
    readonly binding: RuntimeBinding;
    readonly connectionId: string;
    readonly nativeSessionId: string | null;
    readonly pid: number;
    readonly hasActiveTurnOrWork: boolean;
    readonly negotiated?: ParsedAcpInitializeCapabilities;
    readonly compat: CliVersionCompatProfile;
    readonly transport: TeardownTransport;
    readonly platform?: NodeJS.Platform;
  }): Promise<TeardownAuditResult> {
    const startMs = input.transport.now();
    const platform = input.platform ?? process.platform;
    const owned = this.ownedByPid.get(input.pid);

    // Ownership fence: never kill or mutate PIDs not spawned under this binding + generation + connection
    if (!owned || !sameBinding(owned.binding, input.binding) || owned.connectionId !== input.connectionId) {
      return {
        pid: input.pid,
        platform,
        refusedNotOwned: true,
        stepsExecuted: ['ownership_check_failed'],
        cancelSent: false,
        closeSent: false,
        closeSkippedReason: 'process_not_owned_by_binding_generation',
        treeKillInvoked: false,
        exitedCleanly: false,
        elapsedMs: Math.max(0, input.transport.now() - startMs),
      };
    }

    const stepsExecuted: string[] = [];
    let cancelSent = false;
    let closeSent = false;
    let closeSkippedReason: string | undefined;
    let treeKillInvoked = false;
    let treeKillMethod: TeardownAuditResult['treeKillMethod'];

    const pollInterval = Math.max(10, this.defaults.pollIntervalMs ?? 50);
    const waitUntilExited = async (graceMs: number): Promise<boolean> => {
      if (!input.transport.isProcessAlive(input.pid)) return true;
      const deadline = input.transport.now() + Math.max(0, graceMs);
      while (input.transport.isProcessAlive(input.pid) && input.transport.now() < deadline) {
        const remaining = deadline - input.transport.now();
        if (remaining <= 0) break;
        await input.transport.wait(Math.min(pollInterval, remaining));
      }
      return !input.transport.isProcessAlive(input.pid);
    };

    // Step 1: Version-gated session/cancel when active turn/work exists
    if (input.hasActiveTurnOrWork && input.nativeSessionId) {
      if (input.compat.supportsReliableCancel && !input.compat.degradedToSafeMode) {
        stepsExecuted.push('session_cancel');
        try {
          cancelSent = Boolean(await input.transport.sendCancel(input.nativeSessionId));
        } catch {
          cancelSent = false;
        }
        if (cancelSent) {
          const exited = await waitUntilExited(this.defaults.cancelGraceMs ?? 3_000);
          if (exited && !input.hasActiveTurnOrWork) {
            this.ownedByPid.delete(input.pid);
          }
        }
      } else {
        stepsExecuted.push('session_cancel_skipped_compat');
      }
    }

    // Step 2: Version- & capability-gated session/close
    if (input.transport.isProcessAlive(input.pid) && input.nativeSessionId) {
      if (input.compat.degradedToSafeMode) {
        closeSkippedReason = 'bad_cli_version_degraded';
        stepsExecuted.push('session_close_skipped_degraded');
      } else if (!input.compat.supportsSessionClose) {
        closeSkippedReason = 'cli_version_predates_reliable_close';
        stepsExecuted.push('session_close_skipped_version');
      } else if (!input.negotiated?.sessionCapabilities.close) {
        closeSkippedReason = 'server_did_not_advertise_close';
        stepsExecuted.push('session_close_skipped_unadvertised');
      } else if (!input.transport.sendSessionClose) {
        closeSkippedReason = 'transport_close_not_implemented';
        stepsExecuted.push('session_close_skipped_no_handler');
      } else {
        stepsExecuted.push('session_close');
        try {
          closeSent = await input.transport.sendSessionClose(input.nativeSessionId);
        } catch {
          closeSent = false;
        }
        if (closeSent) {
          await waitUntilExited(this.defaults.closeGraceMs ?? 2_000);
        }
      }
    }

    // Step 3: Windows taskkill /T /F or POSIX process group kill if still alive
    if (input.transport.isProcessAlive(input.pid)) {
      stepsExecuted.push(platform === 'win32' ? 'windows_taskkill_tree' : 'posix_pgroup_kill');
      treeKillInvoked = true;
      const killRes = await input.transport.killProcessTree(input.pid, platform);
      treeKillMethod = killRes.method;
    }

    const exitedCleanly = !input.transport.isProcessAlive(input.pid);
    if (exitedCleanly) {
      this.ownedByPid.delete(input.pid);
    }

    return {
      pid: input.pid,
      platform,
      refusedNotOwned: false,
      stepsExecuted,
      cancelSent,
      closeSent,
      ...(closeSkippedReason ? { closeSkippedReason } : {}),
      treeKillInvoked,
      ...(treeKillMethod ? { treeKillMethod } : {}),
      exitedCleanly,
      elapsedMs: Math.max(0, input.transport.now() - startMs),
    };
  }
}
