import type {
  Disposer,
  NavigationRequestV1,
  NavigationResultV1,
  UiContributionOwner,
} from '@harnessmate/protocol';

export type NavigationHandler = (
  request: Required<Pick<NavigationRequestV1, 'requestId'>> & NavigationRequestV1,
) => Promise<NavigationResultV1> | NavigationResultV1;

interface RegisteredNavigationHandler {
  readonly owner: UiContributionOwner;
  readonly handler: NavigationHandler;
}

let navSeq = 0;

function nextRequestId(): string {
  return `nav_${Date.now()}_${++navSeq}`;
}

/**
 * Domain-agnostic kernel navigation router.
 * Dispatches navigation requests to the active application layout handler without
 * hardcoding session, file, or business semantics in the kernel.
 */
export class NavigationBus {
  private activeHandler: RegisteredNavigationHandler | null = null;
  private readonly listeners = new Set<() => void>();

  registerHandler(owner: UiContributionOwner, handler: NavigationHandler): Disposer {
    const entry: RegisteredNavigationHandler = {
      owner: { ...owner },
      handler,
    };
    this.activeHandler = entry;
    this.emit();
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.activeHandler === entry) {
        this.activeHandler = null;
        this.emit();
      }
    };
  }

  revokeByOwner(instanceId: string, runId?: string): boolean {
    if (!this.activeHandler) return false;
    if (this.activeHandler.owner.instanceId !== instanceId) return false;
    if (runId !== undefined && this.activeHandler.owner.runId !== runId) return false;
    this.activeHandler = null;
    this.emit();
    return true;
  }

  getActiveOwner(): UiContributionOwner | null {
    return this.activeHandler ? { ...this.activeHandler.owner } : null;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async navigate(request: NavigationRequestV1): Promise<NavigationResultV1> {
    const requestId =
      typeof request.requestId === 'string' && request.requestId.trim()
        ? request.requestId.trim()
        : nextRequestId();
    const normalized: Required<Pick<NavigationRequestV1, 'requestId'>> & NavigationRequestV1 = {
      ...request,
      requestId,
      target: request.target ?? {},
    };

    const current = this.activeHandler;
    if (!current) {
      return {
        requestId,
        status: 'unavailable',
        code: 'E_SERVICE_UNAVAILABLE',
        message: '当前没有活动的布局导航处理器。',
      };
    }

    try {
      const result = await current.handler(normalized);
      return {
        ...result,
        requestId: result.requestId || requestId,
        handledByInstanceId: result.handledByInstanceId ?? current.owner.instanceId,
      };
    } catch (error) {
      const errObj = error && typeof error === 'object' ? (error as { code?: unknown; message?: unknown }) : null;
      return {
        requestId,
        status: 'failed',
        handledByInstanceId: current.owner.instanceId,
        code: typeof errObj?.code === 'string' ? errObj.code : 'E_NAVIGATION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  reset(): void {
    if (!this.activeHandler) return;
    this.activeHandler = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // isolate listener errors
      }
    }
  }
}

export const navigationBus = new NavigationBus();
