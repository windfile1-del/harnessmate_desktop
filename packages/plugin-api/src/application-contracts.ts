import type { ServiceMethodResult } from './context.js';

export const APPLICATION_VIEW_CONTRACT = 'application.view.v1';
export const APPLICATION_VIEW_CONTRACT_VERSION = '1.0.0';
export const APPLICATION_SHELL_SLOT = 'application.shell';

export interface ApplicationViewRegionDescriptor {
  id: string;
  title: string;
  placements?: string[];
}

export interface ApplicationViewInfo {
  layoutId: string;
  name: string;
  version: string;
  description?: string;
  supportsHotSwap?: boolean;
  requiresRestartOnSwitch?: boolean;
  regions?: ApplicationViewRegionDescriptor[];
}

export interface ApplicationViewStateSnapshot {
  revision?: number;
  [key: string]: unknown;
}

/**
 * Service implemented by any `application.view.v1` layout plugin (default or external).
 * Provides layout metadata and persistent presentation state via plugin storage.
 */
export interface ApplicationViewServiceV1 {
  getInfo(): Promise<ServiceMethodResult<{ info: ApplicationViewInfo }>>;
  readLayoutState(req?: { scope?: string }): Promise<ServiceMethodResult<{ state: ApplicationViewStateSnapshot }>>;
  writeLayoutState(req: {
    scope?: string;
    patch: Record<string, unknown>;
    sourceId?: string;
  }): Promise<ServiceMethodResult<{ state: ApplicationViewStateSnapshot }>>;
}

export type ApplicationSwitchStatus = 'applied' | 'restart_required' | 'rolled_back' | 'failed';

export interface ApplicationSwitchResult {
  status: ApplicationSwitchStatus;
  instanceId: string | null;
  previousInstanceId?: string | null;
  restartRequired?: boolean;
  code?: string;
  reason?: string;
}

export type NavigationPlacement =
  | 'primary'
  | 'side'
  | 'drawer'
  | 'modal'
  | 'tab'
  | 'inline'
  | 'external'
  | (string & {});

export interface NavigationTarget {
  kind?: string;
  instanceId?: string;
  pageId?: string;
  slotId?: string;
  contract?: string;
  uri?: string;
}

/**
 * Generic navigation request routed through the kernel to the active application layout.
 * The kernel never interprets domain-specific fields inside `context`; domain DTOs stay
 * owned by their domain contracts and layouts interpret `placement`.
 */
export interface NavigationRequestV1 {
  requestId?: string;
  target: NavigationTarget;
  context?: Record<string, unknown>;
  placement?: NavigationPlacement;
  sourceInstanceId?: string;
  sourceRunId?: string;
}

export type NavigationResultStatus = 'accepted' | 'unavailable' | 'failed';

export interface NavigationResultV1 {
  requestId: string;
  status: NavigationResultStatus;
  handledByInstanceId?: string;
  placement?: NavigationPlacement;
  code?: string;
  message?: string;
  detail?: Record<string, unknown>;
}

export type UiContributionKind =
  | 'page'
  | 'region'
  | 'command'
  | 'shortcut'
  | 'menu'
  | 'tray'
  | 'settings';

export interface UiContributionOwner {
  instanceId: string;
  runId: string;
  pluginId?: string;
}

export interface UiContributionInvocation {
  requestId: string;
  sourceInstanceId?: string;
  args?: Record<string, unknown>;
}

export interface UiContributionInput {
  id: string;
  kind: UiContributionKind;
  title: string;
  subtitle?: string;
  category?: string;
  keywords?: string[];
  order?: number;
  target?: string;
  shortcut?: string;
  allowInInput?: boolean;
  scope?: string;
  enabled?: boolean;
  context?: Record<string, unknown>;
  when?: Record<string, unknown>;
  execute?: (invocation: UiContributionInvocation) => Promise<unknown> | unknown;
}

export interface UiContributionRecord extends UiContributionInput {
  readonly key: string;
  readonly owner: UiContributionOwner;
  readonly registeredAt: number;
}

export interface DesktopMenuContributionDto {
  key: string;
  id: string;
  kind: 'menu' | 'tray';
  label: string;
  accelerator?: string;
  enabled: boolean;
  order: number;
  ownerInstanceId: string;
  ownerRunId: string;
}
