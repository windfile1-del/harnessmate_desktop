import type {
  ApprovalAnnotateEvent,
  HandoffComposeEvent,
  HandoffComposeSection,
  HandoffOfferDecision,
  HandoffShouldOfferEvent,
  PluginEventName,
  PluginEventV4,
} from './events.js';
import type { PLUGIN_API_VERSION } from './manifest.js';
import type { PublicSlotRegistration } from './slots.js';

export const pluginErrorCodes = [
  'E_PERMISSION_DENIED', 'E_SERVICE_UNAVAILABLE', 'E_NOT_SUPPORTED', 'E_TIMEOUT',
  'E_INVALID_INPUT', 'E_LIMIT_EXCEEDED', 'E_CONFLICT', 'E_STALE_RUN',
] as const;
export type PluginErrorCode = typeof pluginErrorCodes[number];

export class PluginApiError extends Error {
  constructor(readonly code: PluginErrorCode, message: string) {
    super(message);
    this.name = 'PluginApiError';
  }
}

export type Disposer = () => void;

export interface PublicSession {
  id: string;
  workspaceId: string;
  harnessId: string;
  harnessKind: string;
  title: string;
  status: string;
  model: string | null;
  permissionMode: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface PublicSessionCapabilities {
  harnessId: string;
  harnessKind: string;
  supportsAttachments: boolean;
  supportsNativeCommands: boolean;
  supportsModelTools: boolean;
}

export interface PublicTaskLedger {
  sessionId: string;
  objective: string;
  steps: Array<{ id: string; title: string; status: string }>;
  decisions: string[];
  touchedFiles: string[];
  blockers: string[];
  pinnedFacts: string[];
  version: number;
  updatedAt: number;
}

export interface PublicTaskLedgerAppend {
  objective?: string;
  decision?: string;
  blocker?: string;
  pinnedFact?: string;
  step?: { title: string; status?: 'pending' | 'in_progress' | 'done' | 'blocked' };
}

export interface PublicHandoffSection {
  id: string;
  order?: number;
  text: string;
}

export interface PublicComposerSuggestion {
  text?: string;
  parts?: Array<{ label: string; text: string }>;
  mode?: 'replace' | 'append';
}

export interface PublicApprovalAnnotationInput {
  risk?: 'low' | 'medium' | 'high';
  label: string;
  detail?: string;
}

export interface PublicCommandInvocation {
  sessionId: string;
  workspaceId: string;
  harnessId: string;
  args: string;
}

export type PublicCommandResult =
  | { kind: 'message'; text: string }
  | { kind: 'compose'; text: string; parts?: Array<{ label: string; text: string }> }
  | { kind: 'native'; command: string; args?: string }
  | { kind: 'none' };

export interface PublicModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly?: boolean;
  handler: (
    input: Record<string, unknown>,
    meta: { sessionId: string; workspaceId: string },
  ) => Promise<string> | string;
}

export interface PublicFsEntry {
  name: string;
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
}

export interface PublicFsStat {
  relativePath: string;
  isDirectory: boolean;
  sizeBytes: number;
  mtimeMs: number;
}

export interface PublicNetInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface PublicNetResponse {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: string;
}

export interface PluginEventQuery {
  sessionId: string;
  types?: PluginEventName[];
  afterSeq?: number;
  limit?: number;
}

export interface PluginLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type ServiceImplementation = Record<string, (...args: unknown[]) => unknown>;

export interface PluginContext {
  readonly api: { readonly version: typeof PLUGIN_API_VERSION; has(feature: string): boolean };
  get<Service = unknown>(name: string): Service | undefined;
  on<Name extends PluginEventName>(name: Name, listener: (event: PluginEventV4<Name>) => void | Promise<void>): Disposer;
  effect(activate: () => Disposer): Disposer;
}

export interface IsolatedPluginContext extends PluginContext {
  readonly runId: string;
  readonly pluginId: string;
  readonly logger: PluginLogger;
  provide(name: string, service: ServiceImplementation): Disposer;
  readonly commands: {
    register(command: string, handler: (input: PublicCommandInvocation) => Promise<PublicCommandResult> | PublicCommandResult): Disposer;
  };
  readonly events: {
    on<Name extends PluginEventName>(name: Name, listener: (event: PluginEventV4<Name>) => void | Promise<void>): Disposer;
    query(filter: PluginEventQuery): Promise<PluginEventV4[]>;
  };
  readonly sessions: {
    list(filter?: { workspaceId?: string; harnessId?: string }): Promise<PublicSession[]>;
    get(sessionId: string): Promise<PublicSession | null>;
    capabilities(sessionId: string): Promise<PublicSessionCapabilities | null>;
    prepareTurn(sessionId: string, input: { text: string; parts?: Array<{ label: string; text: string }> }): Promise<{ accepted: boolean }>;
    runNative(sessionId: string, command: string, args?: string): Promise<{ output?: string; notice?: string }>;
  };
  readonly ledger: {
    get(sessionId: string): Promise<PublicTaskLedger | null>;
    append(sessionId: string, entry: PublicTaskLedgerAppend): Promise<PublicTaskLedger>;
  };
  readonly handoff: {
    section(def: PublicHandoffSection): Disposer;
    onCompose(listener: (event: HandoffComposeEvent) => Promise<HandoffComposeSection | HandoffComposeSection[] | void> | HandoffComposeSection | HandoffComposeSection[] | void): Disposer;
    onShouldOffer(listener: (event: HandoffShouldOfferEvent) => Promise<HandoffOfferDecision | boolean | undefined> | HandoffOfferDecision | boolean | undefined): Disposer;
  };
  readonly composer: {
    suggest(sessionId: string, suggestion: PublicComposerSuggestion): Promise<void>;
  };
  readonly approvals: {
    annotate(approvalId: string, note: PublicApprovalAnnotationInput): Promise<void>;
    onAnnotate(listener: (event: ApprovalAnnotateEvent) => Promise<PublicApprovalAnnotationInput | void> | PublicApprovalAnnotationInput | void): Disposer;
  };
  readonly tools: {
    register(tool: PublicModelTool): Disposer;
  };
  readonly slots: {
    register(def: PublicSlotRegistration): Disposer;
  };
  readonly storage: {
    readonly plugin: {
      get<T = unknown>(key: string): Promise<T | undefined>;
      set(key: string, value: unknown): Promise<void>;
      delete(key: string): Promise<void>;
      keys(): Promise<string[]>;
    };
    readonly workspace: {
      get<T = unknown>(workspaceId: string, key: string): Promise<T | undefined>;
      set(workspaceId: string, key: string, value: unknown): Promise<void>;
      delete(workspaceId: string, key: string): Promise<void>;
      keys(workspaceId: string): Promise<string[]>;
    };
  };
  readonly fs: {
    read(workspaceId: string, relativePath: string): Promise<string>;
    list(workspaceId: string, relativePath?: string): Promise<PublicFsEntry[]>;
    stat(workspaceId: string, relativePath: string): Promise<PublicFsStat>;
    write(workspaceId: string, relativePath: string, content: string): Promise<void>;
  };
  readonly net: {
    fetch(url: string, init?: PublicNetInit): Promise<PublicNetResponse>;
  };
  readonly notify: {
    send(input: { title: string; body?: string; level?: 'info' | 'warn' | 'error'; workspaceId?: string }): Promise<void>;
  };
  readonly clipboard: {
    writeText(text: string, workspaceId?: string): Promise<void>;
  };
  onConfigUpdated?(listener: (config: Readonly<Record<string, unknown>>) => void | Promise<void>): Disposer;
}

export type Context = IsolatedPluginContext;

export interface PluginModule {
  readonly name?: string;
  readonly inject?: readonly string[];
  readonly optional?: readonly string[];
  readonly provides?: readonly string[];
  readonly requires?: readonly string[];
  apply(ctx: IsolatedPluginContext, config: Readonly<Record<string, unknown>>): void | Promise<void>;
}
