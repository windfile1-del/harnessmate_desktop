export const PLUGIN_EVENT_VERSION = 4;

export interface PluginEventData {
  'turn.started': { harnessId: string | null };
  'turn.completed': { harnessId: string | null; stopReason: string | null; maintenance: boolean };
  'turn.failed': { harnessId: string | null; message: string | null; maintenance: boolean };
  'turn.cancelled': { harnessId: string | null };
  'message.user': { text: string };
  'message.assistant.completed': { text: string };
  'tool.completed': { toolCallId: string; toolName: string; status: string };
  'approval.requested': { approvalId: string; toolName: string };
  'session.created': { title: string; harnessId: string };
  'session.closing': { title: string; harnessId: string };
  'plugin.state': { pluginId: string; state: PluginState; missingServices: readonly string[] };
}

export type PluginEventName = keyof PluginEventData;
export type PluginState = 'PENDING' | 'LOADING' | 'ACTIVE' | 'UNLOADING' | 'DISPOSED' | 'FAILED';
export type PluginEventV4<Name extends PluginEventName = PluginEventName> = {
  [Type in Name]: {
    version: typeof PLUGIN_EVENT_VERSION;
    type: Type;
    sessionId: string | null;
    turnId: string | null;
    seq: number | null;
    createdAt: number;
    data: Readonly<PluginEventData[Type]>;
  }
}[Name];

export type PluginHookEventName = 'handoff.compose' | 'handoff.shouldOffer' | 'approval.annotate';

export interface HandoffComposeEvent {
  sessionId: string;
  workspaceId: string;
  targetHarnessId: string;
  targetHarnessKind: string;
  referenceOnly: boolean;
}

export interface HandoffComposeSection {
  id: string;
  text: string;
  order?: number;
}

export interface ApprovalAnnotateEvent {
  approvalId: string;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  toolKind: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface ApprovalAnnotation {
  pluginId: string;
  risk?: 'low' | 'medium' | 'high';
  label: string;
  detail?: string;
}

export interface HandoffShouldOfferEvent {
  sessionId: string;
  workspaceId: string;
  harnessId: string;
  reason: 'rate_limit' | 'turn_failed' | 'manual_check';
  message?: string | null;
}

export interface HandoffOfferDecision {
  offer: boolean;
  targetHarnessId?: string;
  reason?: string;
}

export const pluginEventContracts = {
  'turn.started': { mode: 'emit', permission: 'events:turn' },
  'turn.completed': { mode: 'emit', permission: 'events:turn' },
  'turn.failed': { mode: 'emit', permission: 'events:turn' },
  'turn.cancelled': { mode: 'emit', permission: 'events:turn' },
  'message.user': { mode: 'emit', permission: 'events:message' },
  'message.assistant.completed': { mode: 'emit', permission: 'events:message' },
  'tool.completed': { mode: 'emit', permission: 'events:tool' },
  'approval.requested': { mode: 'emit', permission: 'events:approval' },
  'session.created': { mode: 'serial', permission: 'session:read' },
  'session.closing': { mode: 'parallel', permission: 'session:read' },
  'plugin.state': { mode: 'emit', permission: null },
  'handoff.compose': { mode: 'waterfall', permission: 'handoff:section' },
  'handoff.shouldOffer': { mode: 'bail', permission: 'session:read' },
  'approval.annotate': { mode: 'waterfall', permission: 'approvals:annotate' },
} as const satisfies Record<PluginEventName | PluginHookEventName,
  { mode: 'emit' | 'serial' | 'parallel' | 'waterfall' | 'bail'; permission: string | null }>;
