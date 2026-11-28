import type { Disposer, UiContributionOwner } from '@harnessmate/protocol';

/**
 * Public presentation snapshot published by the currently active `application.view.v1` layout.
 * Nested child plugins (such as `chat.view.v1`, `runtime.requests.view.v1`, `agy.workbench.v1`,
 * and `workspace.pages`) consume this via the public bridge without importing any layout's private store
 * or the monolithic host app-store.
 */
export interface PublishedLayoutState {
  sidebarCollapsed?: boolean;
  inspectorOpen?: boolean;
  inspectorTab?: string;
  selectedWorkspaceId?: string | null;
  selectedSessionId?: string | null;
  sessions?: unknown[];
  harnesses?: unknown[];
  workspaces?: unknown[];
  slashCommands?: unknown[];
  focusedTurn?: { sessionId: string; turnId: string; itemId?: string } | null;
  accountUsage?: unknown[];
  failoverPolicy?: unknown;
  agyNativeWorkbenchEnabled?: boolean;
  agyAuthStates?: Record<string, unknown>;
  nativeRuntimeBySession?: Record<string, unknown>;
  [key: string]: unknown;
}

export type LayoutToastHandler = (toast: {
  kind: 'info' | 'success' | 'warning' | 'error';
  title: string;
  body?: string;
}) => void;

export type LayoutLegacyActionDelegate = (name: string, args: unknown[]) => unknown;

class KernelLayoutBridge {
  private owner: UiContributionOwner | null = null;
  private state: PublishedLayoutState = {};
  private toastHandler: LayoutToastHandler | null = null;
  private legacyActionDelegate: LayoutLegacyActionDelegate | null = null;
  private readonly listeners = new Set<(patch: PublishedLayoutState) => void>();

  attachOwner(owner: UiContributionOwner): Disposer {
    this.owner = { ...owner };
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.owner?.instanceId === owner.instanceId && this.owner?.runId === owner.runId) {
        this.owner = null;
        this.toastHandler = null;
        this.legacyActionDelegate = null;
        this.state = {};
        this.emit({});
      }
    };
  }

  publishState(owner: UiContributionOwner, patch: PublishedLayoutState): boolean {
    if (
      this.owner &&
      (this.owner.instanceId !== owner.instanceId || this.owner.runId !== owner.runId)
    ) {
      return false;
    }
    const diff: PublishedLayoutState = {};
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (this.state[key] !== value) {
        diff[key] = value;
        changed = true;
      }
    }
    if (!changed) return true;
    this.state = { ...this.state, ...diff };
    this.emit(diff);
    return true;
  }

  registerToastHandler(owner: UiContributionOwner, handler: LayoutToastHandler): Disposer {
    if (
      this.owner &&
      (this.owner.instanceId !== owner.instanceId || this.owner.runId !== owner.runId)
    ) {
      return () => {};
    }
    this.toastHandler = handler;
    return () => {
      if (this.toastHandler === handler) this.toastHandler = null;
    };
  }

  /**
   * Transitional delegate for W2/W3 actions that have not yet migrated out of default layout.
   * Always scoped to the owning layout runId and revoked on layout unmount.
   */
  registerLegacyActionDelegate(owner: UiContributionOwner, delegate: LayoutLegacyActionDelegate): Disposer {
    if (
      this.owner &&
      (this.owner.instanceId !== owner.instanceId || this.owner.runId !== owner.runId)
    ) {
      return () => {};
    }
    this.legacyActionDelegate = delegate;
    return () => {
      if (this.legacyActionDelegate === delegate) this.legacyActionDelegate = null;
    };
  }

  invokeLegacyAction(name: string, args: unknown[]): { handled: boolean; result?: unknown } {
    if (!this.legacyActionDelegate) return { handled: false };
    return { handled: true, result: this.legacyActionDelegate(name, args) };
  }

  pushToast(toast: { kind: 'info' | 'success' | 'warning' | 'error'; title: string; body?: string }): boolean {
    if (!this.toastHandler) return false;
    this.toastHandler(toast);
    return true;
  }

  getState(): Readonly<PublishedLayoutState> {
    return this.state;
  }

  getOwner(): UiContributionOwner | null {
    return this.owner ? { ...this.owner } : null;
  }

  subscribe(listener: (patch: PublishedLayoutState) => void): Disposer {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.owner = null;
    this.state = {};
    this.toastHandler = null;
    this.legacyActionDelegate = null;
    this.emit({});
  }

  private emit(patch: PublishedLayoutState): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(patch);
      } catch {
        // isolate listener errors
      }
    }
  }
}

export const layoutBridge = new KernelLayoutBridge();
