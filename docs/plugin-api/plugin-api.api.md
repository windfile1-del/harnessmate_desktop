# 插件 API 报告

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

清单与声明式贡献点见同目录 JSON Schema。公共错误码见类型声明。

```ts
import type { ApprovalAnnotateEvent, HandoffComposeEvent, HandoffComposeSection, HandoffOfferDecision, HandoffRedactEvent, HandoffRedactResult, HandoffShouldOfferEvent, PluginEventName, PluginEventV4 } from './events.js';
import type { PLUGIN_API_VERSION } from './manifest.js';
import type { PublicSlotRegistration } from './slots.js';
import type { FilePreviewRenderer } from './file-preview.js';
import { type DriverCommandCapability, type DriverCommandReceipt, type DriverConfigReceipt } from './driver-contracts.js';
export declare const pluginErrorCodes: readonly ["E_PERMISSION_DENIED", "E_SERVICE_UNAVAILABLE", "E_NOT_SUPPORTED", "E_TIMEOUT", "E_INVALID_INPUT", "E_LIMIT_EXCEEDED", "E_CONFLICT", "E_STALE_RUN", "E_CIRCULAR_DEPENDENCY", "E_PLUGIN_DISABLED"];
export type PluginErrorCode = typeof pluginErrorCodes[number];
export declare class PluginApiError extends Error {
    readonly code: PluginErrorCode;
    constructor(code: PluginErrorCode, message: string);
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
    steps: Array<{
        id: string;
        title: string;
        status: string;
    }>;
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
    step?: {
        title: string;
        status?: 'pending' | 'in_progress' | 'done' | 'blocked';
    };
}
export interface PublicHandoffSection {
    id: string;
    order?: number;
    text: string;
}
export interface PublicComposerSuggestion {
    text?: string;
    parts?: Array<{
        label: string;
        text: string;
    }>;
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
export type PublicCommandResult = {
    kind: 'message';
    text: string;
} | {
    kind: 'compose';
    text: string;
    parts?: Array<{
        label: string;
        text: string;
    }>;
} | {
    kind: 'native';
    command: string;
    args?: string;
} | {
    kind: 'none';
};
export interface PublicModelTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly?: boolean;
    handler: (input: Record<string, unknown>, meta: {
        sessionId: string;
        workspaceId: string;
    }) => Promise<string> | string;
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
export interface PublicNetStreamInit {
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    headers?: Record<string, string>;
    body?: string;
    connectTimeoutMs?: number;
    workspaceId?: string;
}
export interface PublicNetStreamHandle {
    readonly streamId: string;
    readonly status: number;
    readonly ok: boolean;
    readonly headers: Record<string, string>;
    onChunk(listener: (chunk: string) => void): Disposer;
    onEnd(listener: () => void): Disposer;
    onError(listener: (message: string) => void): Disposer;
    close(): Promise<void>;
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
    readonly api: {
        readonly version: typeof PLUGIN_API_VERSION;
        has(feature: string): boolean;
    };
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
        list(filter?: {
            workspaceId?: string;
            harnessId?: string;
        }): Promise<PublicSession[]>;
        get(sessionId: string): Promise<PublicSession | null>;
        capabilities(sessionId: string): Promise<PublicSessionCapabilities | null>;
        prepareTurn(sessionId: string, input: {
            text: string;
            parts?: Array<{
                label: string;
                text: string;
            }>;
        }): Promise<{
            accepted: boolean;
        }>;
        runNative(sessionId: string, command: string, args?: string): Promise<{
            output?: string;
            notice?: string;
        }>;
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
        send(input: {
            title: string;
            body?: string;
            level?: 'info' | 'warn' | 'error';
            workspaceId?: string;
        }): Promise<void>;
    };
    readonly clipboard: {
        writeText(text: string, workspaceId?: string): Promise<void>;
    };
    onConfigUpdated?(listener: (config: Readonly<Record<string, unknown>>) => void | Promise<void>): Disposer;
}
export type PublicReasoningEffort = 'none' | 'disabled' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type PublicPermissionMode = 'plan' | 'accept_edits' | 'auto' | 'manual';
export type PublicToolKind = 'shell' | 'file_read' | 'file_edit' | 'search' | 'mcp' | 'subagent' | 'web' | 'other';
export type PublicRiskLevel = 'low' | 'medium' | 'high';
export type PublicApprovalDecision = 'allow_once' | 'allow_session' | 'deny';
export type PublicContextInjectionDriver = 'codex_inject_items' | 'acp_embedded_context' | 'claude_sysfile_delta' | 'prompt_envelope' | 'native_warm';
export type PublicHarnessHealth = 'ready' | 'degraded' | 'unavailable' | 'unauthenticated';
export type PublicHarnessTransportKind = 'jsonrpc_stdio' | 'stream_json' | 'acp_stdio' | 'http_sse' | 'sdk' | 'custom';
export type PublicHarnessHistoryInjectionMode = 'native_items' | 'embedded_context' | 'sysfile_delta' | 'inline';
export type PublicProviderOptionDescriptor = {
    key: string;
    label: string;
    description?: string;
    kind: 'select';
    defaultValue?: string;
    options: Array<{
        value: string;
        label: string;
        description?: string;
    }>;
} | {
    key: string;
    label: string;
    description?: string;
    kind: 'boolean';
    defaultValue?: boolean;
} | {
    key: string;
    label: string;
    description?: string;
    kind: 'number';
    min?: number;
    max?: number;
    step?: number;
    defaultValue?: number;
};
export interface PublicHarnessPresentationMeta {
    shortLabel: string;
    accentColor: string;
    softBg: string;
    tagline: string;
    iconSvg?: string;
}
export interface PublicHarnessCapabilities {
    streaming: boolean;
    interactiveApproval: boolean;
    reasoningEfforts: PublicReasoningEffort[];
    permissionModes: PublicPermissionMode[];
    sessionResume: boolean;
    sessionFork: boolean;
    imageInput: boolean;
    subagents: boolean;
}
export interface PublicHarnessCapabilitiesV2 extends PublicHarnessCapabilities {
    transport: PublicHarnessTransportKind;
    historyInjectionMode: PublicHarnessHistoryInjectionMode;
    supportsNativeRollback: boolean;
    supportsActiveSteering: boolean;
    supportsUsageLimits: boolean;
    supportsDynamicOptions: boolean;
    nativeCommands: string[];
    optionDescriptors: PublicProviderOptionDescriptor[];
}
export interface PublicHarnessModelInfo {
    id: string;
    displayName: string;
    description?: string;
    group?: string;
    isDefault?: boolean;
    defaultEffort?: PublicReasoningEffort;
    supportedEfforts?: PublicReasoningEffort[];
    inputModalities?: string[];
}
export interface PublicHarnessDriverDescriptor {
    driverId: string;
    harnessId?: string;
    instanceId?: string;
    pluginId?: string;
    displayName: string;
    description: string;
    protocolLabel: string;
    capabilities: PublicHarnessCapabilities;
    capabilitiesV2?: PublicHarnessCapabilitiesV2;
    presentation?: PublicHarnessPresentationMeta;
    pluginMcpTransport?: 'http' | 'acp';
    supportedCommands?: DriverCommandCapability[];
}
export interface PublicHarnessInstanceInfo {
    id: string;
    driverId: string;
    pluginId?: string;
    providerInstanceId?: string;
    runId?: string;
    isDefault?: boolean;
    displayName: string;
    description: string;
    protocolLabel: string;
    enabled: boolean;
    isCustom?: boolean;
    supportedCommands?: DriverCommandCapability[];
}
export interface PublicAdapterSessionConfig {
    cwd: string;
    model?: string | null;
    reasoningEffort?: PublicReasoningEffort | null;
    permissionMode: PublicPermissionMode;
    nativeSessionId?: string | null;
    requireNativeResume?: boolean;
    handoffContinuity?: boolean;
    pluginMcp?: {
        url: string;
        token: string;
    };
}
export interface PublicHarnessProbeResult {
    binaryPath: string | null;
    version: string | null;
    health: PublicHarnessHealth;
    healthMessage?: string;
    models: PublicHarnessModelInfo[];
    defaultModelId?: string | null;
    accountSummary?: string | null;
    capabilitiesV2?: PublicHarnessCapabilitiesV2;
    presentation?: PublicHarnessPresentationMeta;
}
export interface PublicPortableHistoryMessage {
    type: 'message';
    role: 'user' | 'assistant';
    content: Array<{
        type: 'input_text' | 'output_text';
        text: string;
    }>;
}
export interface PublicDriverContextSyncPayload {
    deltaMarkdown: string;
    portableItems: PublicPortableHistoryMessage[];
    objective?: string;
    isWarmBinding: boolean;
}
export interface PublicDriverTurnInput {
    turnId: string;
    text: string;
    attachments?: Array<{
        id: string;
        kind: 'file_ref' | 'image';
        name: string;
        path?: string;
        relativePath?: string;
        mimeType?: string;
        sizeBytes?: number;
    }>;
    model?: string | null;
    reasoningEffort?: PublicReasoningEffort | null;
    permissionMode?: PublicPermissionMode;
    turnOptions?: Record<string, string | number | boolean>;
    contextSync?: PublicDriverContextSyncPayload | null;
    cliCommand?: string;
    nativeSkill?: {
        name: string;
        path: string;
    };
}
export type PublicNormalizedAdapterEvent = {
    type: 'native_session_ready';
    nativeSessionId: string;
} | {
    type: 'model.confirmed';
    actualModel: string;
    reroutedFrom?: string;
    reason?: string;
} | {
    type: 'config.confirmed';
    model?: string | null;
    thoughtLevel?: string | null;
    availableThoughtLevels?: string[];
    modeId?: string | null;
    permissionEnforcement?: 'native' | 'client_guard';
    tierName?: string | null;
} | {
    type: 'commands.updated';
    commands: Array<{
        name: string;
        description?: string;
        argumentHint?: string;
    }>;
} | {
    type: 'session.title_updated';
    title: string;
} | {
    type: 'turn.started';
    turnId: string;
    continuation?: boolean;
} | {
    type: 'turn.completed';
    turnId: string;
    stopReason?: string;
} | {
    type: 'turn.failed';
    turnId: string;
    message: string;
    code?: string;
    failureClass?: string;
    resetAt?: number | null;
} | {
    type: 'turn.cancelled';
    turnId: string;
} | {
    type: 'message.assistant.delta';
    turnId: string;
    text: string;
    messageId?: string;
    parentToolUseId?: string;
} | {
    type: 'message.assistant.completed';
    turnId: string;
    text: string;
    messageId?: string;
    parentToolUseId?: string;
} | {
    type: 'thinking.delta';
    turnId: string;
    text: string;
} | {
    type: 'thinking.completed';
    turnId: string;
    text: string;
} | {
    type: 'tool.call.started';
    turnId: string;
    toolCallId: string;
    toolName: string;
    toolKind: PublicToolKind;
    summary: string;
    input?: unknown;
    parentToolUseId?: string;
} | {
    type: 'tool.call.delta';
    turnId: string;
    toolCallId: string;
    outputDelta: string;
    diffDelta?: string;
} | {
    type: 'tool.call.completed';
    turnId: string;
    toolCallId: string;
    toolName: string;
    status: 'success' | 'error' | 'cancelled';
    output?: string;
    diff?: string;
} | {
    type: 'approval.requested';
    turnId: string;
    nativeRequestId: string;
    toolName: string;
    toolKind: PublicToolKind;
    summary: string;
    input: unknown;
    diffPreview?: string;
    riskLevel: PublicRiskLevel;
} | {
    type: 'command.output.delta';
    turnId: string;
    toolCallId: string;
    chunk: string;
    stream?: 'stdout' | 'stderr';
} | {
    type: 'turn_block.ext';
    turnId: string;
    itemId: string;
    blockType: `ext:${string}`;
    title: string;
    fallbackSummary: string;
    status?: 'pending' | 'running' | 'completed' | 'failed';
    payload: Record<string, unknown>;
} | {
    type: 'usage.updated';
    turnId: string | null;
    usage: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens?: number;
        reasoningTokens?: number;
        modelContextWindow?: number;
        costUsd?: number;
    };
} | {
    type: 'diagnostic.log';
    level: 'info' | 'warn' | 'error';
    stream: 'stdout' | 'stderr' | 'protocol';
    message: string;
};
export interface PublicRateLimitWindow {
    label: string;
    usedPercent: number;
    windowMinutes: number;
    resetsAt?: number | null;
}
export interface PublicAdapterUsageLimitResult {
    loggedIn: boolean;
    accountLabel: string | null;
    planType: string | null;
    authMethod: string | null;
    billingTier?: 'subscription' | 'api_payg' | 'local_free' | 'unknown';
    gatewayUrl?: string | null;
    rateLimits: PublicRateLimitWindow[];
    error?: string | null;
}
export interface PluginHarnessSessionHandle {
    readonly nativeSessionId?: string | null;
    readonly pluginMcpAvailable?: boolean;
    sendTurn(input: PublicDriverTurnInput): Promise<{
        driverUsed?: PublicContextInjectionDriver;
    } | void>;
    steerTurn?(input: PublicDriverTurnInput): Promise<void>;
    listSkills?(): Promise<Array<{
        name: string;
        path?: string;
        description?: string;
        enabled?: boolean;
    }>>;
    runNativeCommand?(command: string, args: string): Promise<string | DriverCommandReceipt>;
    injectContext?(payload: PublicDriverContextSyncPayload): Promise<PublicContextInjectionDriver>;
    interrupt(): Promise<void>;
    resolveApproval(nativeRequestId: string, decision: PublicApprovalDecision, comment?: string): Promise<void>;
    updateConfig?(patch: Partial<PublicAdapterSessionConfig>): Promise<DriverConfigReceipt | void>;
    dispose(): Promise<void>;
    onEvent(listener: (event: PublicNormalizedAdapterEvent) => void): Disposer;
}
export interface PluginHarnessDriverRegistration extends PublicHarnessDriverDescriptor {
    probe(): Promise<PublicHarnessProbeResult> | PublicHarnessProbeResult;
    probePassive?(): Promise<PublicHarnessProbeResult> | PublicHarnessProbeResult;
    readUsageLimits?(): Promise<PublicAdapterUsageLimitResult> | PublicAdapterUsageLimitResult;
    createSession(config: PublicAdapterSessionConfig): Promise<PluginHarnessSessionHandle> | PluginHarnessSessionHandle;
}
export interface SpawnCliSpec {
    command: string;
    args: string[];
    cwdWorkspaceId?: string;
    cwdRelativePath?: string;
    cwd?: string;
    extraEnv?: Record<string, string>;
    unsetEnv?: string[];
    timeoutMs?: number;
}
export interface ManagedCliProcessHandle {
    readonly processId: string;
    readonly pid: number;
    writeStdin(data: string): Promise<void>;
    closeStdin(): Promise<void>;
    kill(signal?: 'SIGTERM' | 'SIGKILL'): Promise<void>;
    onStdout(listener: (chunk: string) => void): Disposer;
    onStderr(listener: (chunk: string) => void): Disposer;
    onExit(listener: (info: {
        code: number | null;
        signal: string | null;
    }) => void): Disposer;
    wait(): Promise<{
        code: number | null;
        signal: string | null;
    }>;
}
export interface PublicTurnBlock {
    itemId: string;
    schemaVersion: number;
    sessionId: string;
    turnId: string | null;
    seq: number;
    instanceId: string;
    driverId: string;
    blockType: string;
    status: string;
    title: string;
    textBody: string;
    payload: Record<string, unknown>;
    outputOmitted: boolean;
    omittedBytes: number;
    rawRef?: {
        eventSeq: number;
        vendorType: string;
    } | null;
    createdAt: number;
    updatedAt: number;
}
export interface PublicHarnessBinding {
    sessionId: string;
    harnessId: string;
    harnessKind: string;
    nativeSessionId: string | null;
    lastModel?: string | null;
    lastActualModel?: string | null;
    lastEffort?: string | null;
    syncedUpToSeq: number;
    driverUsed?: string | null;
    updatedAt: number;
}
export interface ListSessionItemsOptions {
    afterSeq?: number;
    beforeSeq?: number;
    types?: string[];
    limit?: number;
    includeOmittedBodies?: boolean;
}
export interface GetSessionItemOptions {
    textOffset?: number;
    maxChars?: number;
}
export interface ForkSessionOptions {
    targetInstanceId?: string;
    title?: string;
    createWorktree?: boolean;
}
export interface SwitchSessionInstanceOptions {
    targetInstanceId: string;
    forceFreshNativeSession?: boolean;
}
export interface PublicSessionNotice {
    level: 'info' | 'warn' | 'error';
    message: string;
    code?: string;
}
export interface ContextHandoffPreviewV2 {
    sessionId: string;
    mode: 'full_session_summary' | 'delta_since_target_last_seen';
    deliveryChannel: string;
    sourceInstanceId: string;
    targetInstanceId: string;
    coveredSeqRange: {
        fromSeq: number;
        toSeq: number;
    };
    unsyncedTurnCount: number;
    estimatedChars: number;
    estimatedTokens: number;
    budgetTokens: number;
    syncNeeded: boolean;
    redactionSummary?: {
        categories: string[];
        redactedCount: number;
    };
    renderedPayload: string;
}
export interface ServiceProvideMeta {
    version?: string;
    metadata?: Record<string, unknown>;
}
export interface ServiceProviderDescriptor {
    pluginId: string;
    instanceId: string;
    contract: string;
    version: string;
    metadata?: Record<string, unknown>;
}
export type SelectionSource = 'explicit' | 'session' | 'workspace' | 'dependency' | 'composition' | 'single' | 'none';
export interface ServiceCandidate {
    instanceId: string;
    pluginId: string;
    version: string;
}
export type ServiceResolutionV1 = {
    contract: string;
    versionRange: string;
    candidates: ServiceCandidate[];
} & ({
    instanceId: string;
    source: Exclude<SelectionSource, 'none'>;
    status: 'ready';
} | {
    instanceId: string;
    source: Exclude<SelectionSource, 'none' | 'single'>;
    status: 'disabled' | 'unavailable' | 'incompatible';
} | {
    instanceId: null;
    source: 'none';
    status: 'unconfigured' | 'selection_required';
});
export interface ResolveServiceSelectionOptions {
    versionRange?: string;
    sessionId?: string;
    workspaceId?: string;
    callerInstanceId?: string;
    explicitInstanceId?: string;
    allowSingleCandidate?: boolean;
}
export interface ServiceCallOptions {
    instanceId?: string;
    versionRange?: string;
    sessionId?: string;
    workspaceId?: string;
    allowSingleCandidate?: boolean;
}
export declare function serviceResolutionErrorCode(status: Exclude<ServiceResolutionV1['status'], 'ready'>): PluginErrorCode;
export declare const HISTORY_SOURCE_CONTRACT_VERSION = "1.0.0";
export declare const HISTORY_IMPORT_CONTRACT_VERSION = "1.0.0";
export declare const SESSION_SEARCH_CONTRACT_VERSION = "1.0.0";
export declare const GIT_WORKSPACE_CONTRACT_VERSION = "1.0.0";
export declare const GIT_CHECKPOINT_CONTRACT_VERSION = "1.0.0";
export declare const TERMINAL_WORKSPACE_CONTRACT_VERSION = "1.0.0";
export declare const TERMINAL_RUNNER_CONTRACT_VERSION = "1.0.0";
export declare const WORKSPACE_FILES_CONTRACT_VERSION = "1.0.0";
export declare const SESSION_ATTACHMENTS_CONTRACT_VERSION = "1.0.0";
export declare const WORKSPACE_RULES_CONTRACT_VERSION = "1.0.0";
export declare const PEER_CONTRACT_VERSIONS: {
    readonly 'history.source.v1': "1.0.0";
    readonly 'history.import.v1': "1.0.0";
    readonly 'session.search.v1': "1.0.0";
    readonly 'git.workspace.v1': "1.0.0";
    readonly 'git.checkpoint.v1': "1.0.0";
    readonly 'terminal.workspace.v1': "1.0.0";
    readonly 'terminal.runner.v1': "1.0.0";
    readonly 'workspace.files.v1': "1.0.0";
    readonly 'session.attachments.v1': "1.0.0";
    readonly 'workspace.rules.v1': "1.0.0";
    readonly 'session.data.v1': "1.0.0";
    readonly 'session.runtime.v1': "1.0.0";
    readonly 'hm.session-data.v1': "1.0.0";
    readonly 'harness.driver.v1': "1.0.0";
    readonly 'harness.driver.codex.v1': "1.0.0";
    readonly 'harness.driver.claude.v1': "1.0.0";
    readonly 'harness.driver.acp.v1': "1.0.0";
    readonly 'harness.driver.agy.v1': "1.0.0";
    readonly 'session.handoff.v1': "1.0.0";
    readonly 'session.compression.v1': "1.0.0";
    readonly 'session.collaboration.v1': "1.0.0";
    readonly 'session.orchestration.v1': "1.0.0";
    readonly 'agy.runtime.v1': "1.0.0";
    readonly 'agy.accounts.v1': "1.0.0";
    readonly 'agy.workbench.v1': "1.0.0";
};
export interface ServiceChannelEvent<T = Record<string, unknown>> {
    contract: string;
    instanceId: string;
    runId?: string;
    seq: number;
    emittedAt: number;
    payload: T;
}
export type PeerServiceErrorCode = 'invalid_request' | 'source_unreadable' | 'not_importable' | 'cancelled' | 'conflict' | 'not_found' | 'busy' | 'plugin_disabled' | 'permission_denied' | 'git_required' | 'not_supported';
export interface PeerServiceError<Code extends string = PeerServiceErrorCode | (string & {})> {
    code: Code;
    message: string;
}
export type ServiceMethodResult<T, Code extends string = PeerServiceErrorCode | (string & {})> = {
    ok: true;
    value: T;
} | {
    ok: false;
    error: PeerServiceError<Code>;
};
export interface HistoryRef {
    sourceInstanceId: string;
    sourceId: string;
    nativeSessionId: string;
}
export interface HistoryWorkspaceHint {
    cwd?: string;
    label?: string;
}
export interface HistorySummary {
    ref: HistoryRef;
    title: string;
    harnessKind: string;
    updatedAt: number;
    workspaceHint?: HistoryWorkspaceHint;
}
export interface HistoryItem {
    itemId: string;
    role: 'user' | 'assistant';
    text: string;
    timestamp?: number;
}
export interface HistorySourceDiscoverRequest {
    query?: string;
    workspaceId?: string;
    fromTs?: number;
    toTs?: number;
    cursor?: string;
    limit?: number;
    refresh?: boolean;
    operationId?: string;
}
export interface HistorySourceDiscoverResponse {
    sessions: HistorySummary[];
    nextCursor: string | null;
}
export interface HistorySourceReadRequest {
    ref: HistoryRef;
    cursor?: string;
    limit?: number;
    operationId?: string;
}
export interface HistorySourceReadResponse {
    ref: HistoryRef;
    items: HistoryItem[];
    nextCursor: string | null;
    readStatus: 'complete' | 'partial';
    warnings: string[];
}
export interface HistorySourceCancelRequest {
    operationId: string;
}
export interface HistorySourceCancelResponse {
    cancelled: boolean;
}
export interface HistorySourceServiceV1 {
    discover(request: HistorySourceDiscoverRequest): Promise<ServiceMethodResult<HistorySourceDiscoverResponse>>;
    read(request: HistorySourceReadRequest): Promise<ServiceMethodResult<HistorySourceReadResponse>>;
    cancel?(request: HistorySourceCancelRequest): Promise<ServiceMethodResult<HistorySourceCancelResponse>>;
}
export interface PublicPortableSessionBundleV2 {
    bundleVersion: 2;
    exportedAt: number;
    redacted: boolean;
    redactionCategories: string[];
    redactedCount: number;
    session: {
        originalId: string;
        title: string;
        harnessId: string;
        harnessKind: string;
        model?: string | null;
        actualModel?: string | null;
        reasoningEffort?: PublicReasoningEffort | null;
        permissionMode: PublicPermissionMode;
        cwd: string;
        participatingHarnesses: string[];
        createdAt: number;
        updatedAt: number;
    };
    taskState?: {
        objective: string;
        steps: Array<{
            id: string;
            title: string;
            status: 'pending' | 'in_progress' | 'done' | 'blocked';
            ownerHarnessId?: string | null;
            updatedAt: number;
        }>;
        decisions: string[];
        touchedFiles: string[];
        verifications: Array<{
            command: string;
            status: 'pass' | 'fail' | 'unknown';
            summary?: string;
            harnessId?: string | null;
            timestamp: number;
        }>;
        blockers: string[];
        pinnedFacts: string[];
        failedAttempts?: Array<{
            id: string;
            summary: string;
            failureReason: string;
            relatedFiles?: string[];
            harnessInstanceId?: string | null;
            recordedAt: number;
        }>;
        rollingSummary: string;
        summarizedUpToSeq: number;
        version: number;
        ledgerFilePath?: string | null;
        updatedAt: number;
    } | null;
    items: PublicTurnBlock[];
    events: Array<{
        seq: number;
        type: string;
        turnId: string | null;
        createdAt: number;
        payload: Record<string, unknown>;
    }>;
}
export type ImportInput = {
    kind: 'native';
    ref: HistoryRef;
    mode: 'attach' | 'mirror';
} | {
    kind: 'bundle';
    bundle: PublicPortableSessionBundleV2;
    titleOverride?: string;
};
export interface HistoryImportPreviewRequest {
    input: ImportInput;
    workspaceId?: string;
    operationId?: string;
}
export interface HistoryImportPreviewResponse {
    input: ImportInput;
    existingSessionId: string | null;
    targetWorkspaceId: string | null;
    importable: boolean;
    items: HistoryItem[];
    readStatus: 'complete' | 'partial';
    warnings: string[];
}
export interface HistoryImportExecuteRequest {
    input: ImportInput;
    workspaceId?: string;
    requestId: string;
    operationId?: string;
}
export interface HistoryImportExecuteResponse {
    sessionId: string;
    disposition: 'created' | 'reused';
    partial: boolean;
    warnings: string[];
}
export interface HistoryImportCancelRequest {
    operationId?: string;
    requestId?: string;
}
export interface HistoryImportServiceV1 {
    preview(request: HistoryImportPreviewRequest): Promise<ServiceMethodResult<HistoryImportPreviewResponse>>;
    import(request: HistoryImportExecuteRequest): Promise<ServiceMethodResult<HistoryImportExecuteResponse>>;
    cancel?(request: HistoryImportCancelRequest): Promise<ServiceMethodResult<{
        cancelled: boolean;
    }>>;
}
export interface PublicSessionSearchHighlight {
    start: number;
    end: number;
}
export interface PublicSessionSearchHit {
    sessionId: string;
    sessionTitle: string;
    workspaceId: string;
    turnId: string;
    turnSeq: number;
    itemId: string;
    blockType: string;
    snippetText: string;
    snippetHtmlSafe: string;
    highlights: PublicSessionSearchHighlight[];
    driverId: string;
    createdAt: number;
}
export interface SessionSearchQueryRequest {
    q: string;
    workspaceId?: string;
    driverId?: string;
    fromTs?: number;
    toTs?: number;
    limit?: number;
    offset?: number;
}
export interface SessionSearchQueryResponse {
    hits: PublicSessionSearchHit[];
    nextOffset: number | null;
    fallbackUsed: boolean;
    tookMs: number;
}
export interface SessionSearchReindexRequest {
    mode?: 'full' | 'incremental' | 'resume';
    jobId?: string;
    workspaceId?: string;
}
export interface SessionSearchReindexResponse {
    jobId: string;
    status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
    indexedCount?: number;
    totalCount?: number;
    cursorSeq?: number;
    snapshotWatermark?: number;
    startedAt?: number;
    updatedAt?: number;
    finishedAt?: number;
}
export interface SessionSearchStatusResponse {
    instanceId: string;
    engineKind: string;
    state: 'idle' | 'queued' | 'running' | 'completed' | 'cancelled' | 'failed';
    cursorSeq: number;
    latestSourceSeq?: number;
    indexedItems: number;
    indexedSessions: number;
    activeJob: SessionSearchReindexResponse | null;
    lastJob: SessionSearchReindexResponse | null;
    lastError?: string;
}
export interface SessionSearchServiceV1 {
    query(request: SessionSearchQueryRequest): Promise<ServiceMethodResult<SessionSearchQueryResponse>>;
    reindex(request: SessionSearchReindexRequest): Promise<ServiceMethodResult<SessionSearchReindexResponse>>;
    getStatus?(request?: Record<string, never>): Promise<ServiceMethodResult<SessionSearchStatusResponse>>;
    cancelReindex?(request?: {
        jobId?: string;
    }): Promise<ServiceMethodResult<SessionSearchReindexResponse>>;
    resumeReindex?(request?: {
        jobId?: string;
    }): Promise<ServiceMethodResult<SessionSearchReindexResponse>>;
}
export interface PublicGitChangeEntry {
    path: string;
    indexStatus: string;
    worktreeStatus: string;
    untracked: boolean;
}
export interface PublicGitStatusSummary {
    isGitRepo: boolean;
    repoRoot: string | null;
    gitCommonDir?: string | null;
    branch: string | null;
    ahead: number;
    behind: number;
    changes: PublicGitChangeEntry[];
    stagedCount: number;
    unstagedCount: number;
    untrackedCount: number;
    totalChanged: number;
}
export interface WorkspaceGitStatusLookupRequest {
    workspaceId: string;
    sessionId?: string;
    cwd?: string;
}
export interface WorkspaceGitStatusLookupResult {
    available: boolean;
    reason?: 'disabled' | 'unavailable' | 'unconfigured' | 'not_git_repo';
    instanceId: string | null;
    status: PublicGitStatusSummary | null;
}
export interface NavigateToFileRequest {
    workspaceId?: string;
    sessionId?: string;
    path: string;
    line?: number;
    openInspector?: boolean;
    preserveSession?: boolean;
}
export interface NavigateToFileResult {
    opened: boolean;
    sessionId: string | null;
    workspaceId?: string | null;
    path: string;
    line?: number;
    errorCode?: string;
    message?: string;
}
export interface GitWorktreeEntryDto {
    path: string;
    branch: string | null;
    headSha: string;
    isMain: boolean;
    dirtyCount: number;
    isLocked: boolean;
}
export interface SetupScriptInfoDto {
    exists: boolean;
    relativePath: string | null;
    scriptPath?: string | null;
    sha256: string | null;
    trusted: boolean;
    trustedAt?: number | null;
    content?: string | null;
}
export interface GitWorkspaceServiceV1 {
    getStatus(request: WorkspaceGitStatusLookupRequest): Promise<ServiceMethodResult<WorkspaceGitStatusLookupResult>>;
    inspect(request: {
        cwd: string;
        workspaceId?: string;
    }): Promise<ServiceMethodResult<{
        isGitRepo: boolean;
        branch: string | null;
        repoRoot: string | null;
        gitCommonDir?: string | null;
    }>>;
    getFileDiff(request: {
        cwd: string;
        filePath: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    getTruthDigest(request: {
        cwd: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    initRepo(request: {
        cwd: string;
        initialCommit?: boolean;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    discardFile(request: {
        cwd: string;
        filePath: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    commit(request: {
        cwd: string;
        message: string;
        stageAll?: boolean;
        files?: string[];
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    push(request: {
        cwd: string;
        remote?: string;
        branch?: string;
        setUpstream?: boolean;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    pull(request: {
        cwd: string;
        remote?: string;
        branch?: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    createPr(request: {
        cwd: string;
        title: string;
        body?: string;
        baseBranch?: string;
        draft?: boolean;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    listWorktrees(request: {
        repoRoot: string;
        workspaceId?: string;
    }): Promise<ServiceMethodResult<{
        worktrees: GitWorktreeEntryDto[];
    }>>;
    createWorktree(request: {
        repoRoot: string;
        branchName: string;
        baseBranch?: string;
        workspaceId?: string;
    }): Promise<ServiceMethodResult<{
        worktreePath: string;
        branch: string;
    }>>;
    removeWorktree(request: {
        repoRoot: string;
        worktreePath: string;
        force?: boolean;
        prune?: boolean;
        deleteBranch?: boolean;
        releaseTerminals?: boolean;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    dryRunMerge(request: {
        repoRoot: string;
        sourceBranch: string;
        targetBranch?: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    getSetupScriptInfo(request: {
        repoRoot: string;
    }): Promise<ServiceMethodResult<SetupScriptInfoDto>>;
    setSetupScriptTrust(request: {
        repoRoot: string;
        trusted: boolean;
    }): Promise<ServiceMethodResult<SetupScriptInfoDto>>;
    runSetupScript(request: {
        repoRoot: string;
        targetDir: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
}
export interface GitCheckpointServiceV1 {
    list(request: {
        sessionId: string;
        limit?: number;
    }): Promise<ServiceMethodResult<{
        checkpoints: Record<string, unknown>[];
    }>>;
    get(request: {
        checkpointId: string;
    }): Promise<ServiceMethodResult<{
        checkpoint: Record<string, unknown> | null;
    }>>;
    capture(request: {
        sessionId: string;
        cwd: string;
        turnSeq: number;
        phase: string;
    }): Promise<ServiceMethodResult<{
        checkpoint: Record<string, unknown> | null;
    }>>;
    diff(request: {
        sessionId: string;
        cwd: string;
        fromCheckpointId: string;
        toCheckpointId?: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    revert(request: {
        sessionId: string;
        cwd: string;
        checkpointId: string;
        mode: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    gc(request: {
        sessionId: string;
        cwd: string;
        keepLatestTurns?: number;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    deleteSession(request: {
        sessionId: string;
        cwd?: string;
    }): Promise<ServiceMethodResult<{
        removed: number;
    }>>;
}
export interface TerminalPathUsageEntry {
    terminalId: string;
    title: string;
    cwd: string;
    pid?: number;
    instanceId?: string;
}
export interface TerminalPathUsageResult {
    busy: boolean;
    terminals: TerminalPathUsageEntry[];
}
export interface TerminalWorkspaceServiceV1 {
    listTerminals(request: {
        workspaceId: string;
        cwd?: string;
    }): Promise<ServiceMethodResult<{
        terminals: Record<string, unknown>[];
        ptyAvailable: boolean;
    }>>;
    openTerminal(request: {
        workspaceId: string;
        cwd: string;
        sessionId?: string;
        cols?: number;
        rows?: number;
        shell?: string;
        title?: string;
    }): Promise<ServiceMethodResult<{
        terminal: Record<string, unknown>;
    }>>;
    writeInput(request: {
        terminalId: string;
        data: string;
    }): Promise<ServiceMethodResult<{
        ok: boolean;
    }>>;
    resizeTerminal(request: {
        terminalId: string;
        cols: number;
        rows: number;
    }): Promise<ServiceMethodResult<{
        ok: boolean;
    }>>;
    interruptTerminal(request: {
        terminalId: string;
    }): Promise<ServiceMethodResult<{
        ok: boolean;
    }>>;
    restartTerminal(request: {
        terminalId: string;
    }): Promise<ServiceMethodResult<{
        terminal: Record<string, unknown>;
    }>>;
    closeTerminal(request: {
        terminalId: string;
    }): Promise<ServiceMethodResult<{
        closed: boolean;
    }>>;
    buildContextChip(request: {
        terminalId: string;
        selectedText?: string;
        lineStart?: number;
        lineEnd?: number;
        recentLines?: number;
    }): Promise<ServiceMethodResult<{
        chip: Record<string, unknown>;
    }>>;
    pathUsage(request: {
        targetPath: string;
    }): Promise<ServiceMethodResult<TerminalPathUsageResult>>;
    releasePath(request: {
        targetPath: string;
        workspaceId?: string;
    }): Promise<ServiceMethodResult<{
        closedCount: number;
        terminalIds: string[];
    }>>;
    getOutputSnapshot(request: {
        terminalId: string;
    }): Promise<ServiceMethodResult<{
        snapshot: string;
        truncated: boolean;
        status: string;
        exitCode: number | null;
    }>>;
}
export interface TerminalRunnerServiceV1 {
    run(request: {
        sessionId?: string;
        workspaceId?: string;
        cwd: string;
        command: string;
        timeoutMs?: number;
        toolCallId?: string;
    }): Promise<ServiceMethodResult<{
        exitCode: number;
        stdout: string;
        stderr: string;
        output: string;
        durationMs: number;
        timedOut?: boolean;
        backend?: string;
    }>>;
}
export interface WorkspaceFilesServiceV1 {
    search(request: {
        workspaceId?: string;
        cwd: string;
        query?: string;
        limit?: number;
    }): Promise<ServiceMethodResult<{
        files: Array<{
            path?: string;
            fullPath?: string;
            name?: string;
            relativePath: string;
            sizeBytes: number;
        }>;
    }>>;
    read(request: {
        workspaceId?: string;
        cwd: string;
        path: string;
        line?: number;
    }): Promise<ServiceMethodResult<{
        path?: string;
        relativePath: string;
        sizeBytes: number;
        lineCount?: number;
        content: string;
        truncated: boolean;
        isBinary?: boolean;
        previewable?: boolean;
    }>>;
}
export interface SessionAttachmentsServiceV1 {
    save(request: {
        sessionId: string;
        workspaceId?: string;
        name: string;
        mimeType: string;
        base64: string;
    }): Promise<ServiceMethodResult<{
        attachment: Record<string, unknown>;
    }>>;
    resolveRead(request: {
        sessionId: string;
        filename: string;
    }): Promise<ServiceMethodResult<{
        filePath: string;
        mimeType: string;
        sizeBytes: number;
        legacy?: boolean;
    }>>;
}
export interface WorkspaceRulesServiceV1 {
    discover(request: {
        workspaceId?: string;
        cwd: string;
        sessionId?: string;
    }): Promise<ServiceMethodResult<{
        instructions: Array<Record<string, unknown>>;
    }>>;
}
export interface PluginRouteRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
}
export interface PluginRouteResponse {
    status?: number;
    headers?: Record<string, string>;
    body?: unknown;
}
export interface ApprovalPolicyRequest {
    mode?: import('./request-contracts.js').RequestMode;
    kind?: string;
    source?: string;
    toolKind?: string;
    riskLevel?: string;
    supportedDecisions?: string[];
    requestId?: string;
    sessionId: string;
    workspaceId: string;
    pluginId: string;
    instanceId: string;
    toolName: string;
    readOnly: boolean;
    args: Record<string, unknown>;
}
export interface ApprovalPolicyDecision {
    scope?: 'once' | 'session';
    decision: 'allow' | 'deny' | 'ask';
    reason?: string;
}
export interface IsolatedPluginContextV5 extends IsolatedPluginContext {
    readonly instanceId: string;
    provide(name: string, service: ServiceImplementation, meta?: ServiceProvideMeta): Disposer;
    readonly services: {
        list(contract?: string): Promise<ServiceProviderDescriptor[]>;
        resolve(contract: string, opts?: ResolveServiceSelectionOptions): Promise<ServiceResolutionV1>;
        call<T = unknown>(contract: string, method: string, args?: unknown[], opts?: ServiceCallOptions): Promise<T>;
        publish?(contract: string, payload: Record<string, unknown>): void;
        subscribe?(contract: string, listener: (event: ServiceChannelEvent) => void): Disposer;
    };
    readonly routes: {
        register(pathPrefix: string, handler: (req: PluginRouteRequest) => Promise<PluginRouteResponse> | PluginRouteResponse): Disposer;
    };
    readonly harnesses: {
        registerDriver(driver: PluginHarnessDriverRegistration): Disposer;
        listInstances(): Promise<ReadonlyArray<PublicHarnessInstanceInfo>>;
        openSession?(harnessId: string, config: PublicAdapterSessionConfig): Promise<PluginHarnessSessionHandle>;
    };
    readonly runtime: {
        /** Whether the user authorized direct system access for this development instance. */
        readonly trustedLocal?: boolean;
        spawnCli(spec: SpawnCliSpec): Promise<ManagedCliProcessHandle>;
    };
    readonly sessions: IsolatedPluginContext['sessions'] & {
        listItems(sessionId: string, opts?: ListSessionItemsOptions): Promise<{
            items: PublicTurnBlock[];
            nextSeq: number | null;
        }>;
        getItem(sessionId: string, itemId: string, opts?: GetSessionItemOptions): Promise<{
            item: PublicTurnBlock;
            bodyChunk?: string;
            nextTextOffset?: number | null;
        } | null>;
        getBindings(sessionId: string): Promise<ReadonlyArray<PublicHarnessBinding>>;
        fork(sessionId: string, opts?: ForkSessionOptions): Promise<PublicSession>;
        switchInstance(sessionId: string, opts: SwitchSessionInstanceOptions): Promise<void>;
        postNotice(sessionId: string, notice: PublicSessionNotice): Promise<void>;
    };
    readonly handoff: IsolatedPluginContext['handoff'] & {
        onRedact(listener: (input: HandoffRedactEvent) => Promise<HandoffRedactResult> | HandoffRedactResult): Disposer;
        preview(sessionId: string, targetInstanceId: string): Promise<ContextHandoffPreviewV2>;
    };
    readonly net: IsolatedPluginContext['net'] & {
        openStream(url: string, init?: PublicNetStreamInit): Promise<PublicNetStreamHandle>;
    };
    readonly secrets: {
        resolve(secretRef: string): Promise<string | null>;
    };
}
export type Context = IsolatedPluginContextV5;
export interface PluginModule<Ctx extends IsolatedPluginContext = IsolatedPluginContextV5> {
    readonly name?: string;
    readonly inject?: readonly string[];
    readonly optional?: readonly string[];
    readonly provides?: readonly string[];
    readonly requires?: readonly string[];
    readonly renderFilePreview?: FilePreviewRenderer;
    apply(ctx: Ctx, config: Readonly<Record<string, unknown>>): void | Promise<void>;
}

export declare const PLUGIN_EVENT_VERSION = 4;
export interface PluginEventData {
    'turn.started': {
        harnessId: string | null;
    };
    'turn.completed': {
        harnessId: string | null;
        stopReason: string | null;
        maintenance: boolean;
    };
    'turn.failed': {
        harnessId: string | null;
        message: string | null;
        maintenance: boolean;
    };
    'turn.cancelled': {
        harnessId: string | null;
    };
    'message.user': {
        text: string;
    };
    'message.assistant.completed': {
        text: string;
    };
    'tool.completed': {
        toolCallId: string;
        toolName: string;
        status: string;
    };
    'approval.requested': {
        approvalId: string;
        toolName: string;
    };
    'session.created': {
        title: string;
        harnessId: string;
    };
    'session.closing': {
        title: string;
        harnessId: string;
    };
    'triage.snooze_expired': {
        snoozedUntilMs: number;
    };
    'session.harness_switched': {
        previousHarnessId: string | null;
        targetHarnessId: string;
        driverId?: string;
        reason?: string;
    };
    'handoff.delivered': {
        handoffId: string;
        toInstanceId: string;
        deliveryChannel: string;
        deliveryStatus: string;
    };
    'plugin.state': {
        pluginId: string;
        state: PluginState;
        missingServices: readonly string[];
    };
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
    };
}[Name];
export type PluginHookEventName = 'handoff.compose' | 'handoff.shouldOffer' | 'approval.annotate' | 'handoff.redact';
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
export interface HandoffRedactEvent {
    text: string;
    targetDriverId: string;
    sessionId?: string;
    workspaceId?: string;
    targetInstanceId?: string;
}
export interface HandoffRedactResult {
    text: string;
    categories: string[];
}
export declare const pluginEventContracts: {
    readonly 'turn.started': {
        readonly mode: "emit";
        readonly permission: "events:turn";
    };
    readonly 'turn.completed': {
        readonly mode: "emit";
        readonly permission: "events:turn";
    };
    readonly 'turn.failed': {
        readonly mode: "emit";
        readonly permission: "events:turn";
    };
    readonly 'turn.cancelled': {
        readonly mode: "emit";
        readonly permission: "events:turn";
    };
    readonly 'message.user': {
        readonly mode: "emit";
        readonly permission: "events:message";
    };
    readonly 'message.assistant.completed': {
        readonly mode: "emit";
        readonly permission: "events:message";
    };
    readonly 'tool.completed': {
        readonly mode: "emit";
        readonly permission: "events:tool";
    };
    readonly 'approval.requested': {
        readonly mode: "emit";
        readonly permission: "events:approval";
    };
    readonly 'session.created': {
        readonly mode: "serial";
        readonly permission: "session:read";
    };
    readonly 'session.closing': {
        readonly mode: "parallel";
        readonly permission: "session:read";
    };
    readonly 'triage.snooze_expired': {
        readonly mode: "emit";
        readonly permission: "session:read";
    };
    readonly 'session.harness_switched': {
        readonly mode: "emit";
        readonly permission: "session:read";
    };
    readonly 'handoff.delivered': {
        readonly mode: "emit";
        readonly permission: "session:read";
    };
    readonly 'plugin.state': {
        readonly mode: "emit";
        readonly permission: null;
    };
    readonly 'handoff.compose': {
        readonly mode: "waterfall";
        readonly permission: "handoff:section";
    };
    readonly 'handoff.shouldOffer': {
        readonly mode: "bail";
        readonly permission: "session:read";
    };
    readonly 'approval.annotate': {
        readonly mode: "waterfall";
        readonly permission: "approvals:annotate";
    };
    readonly 'handoff.redact': {
        readonly mode: "waterfall";
        readonly permission: "handoff:redact";
    };
};

import type { PluginErrorCode, PublicHarnessDriverDescriptor } from './context.js';
import type { PluginRuntimeSlotDescriptor } from './slots.js';
export declare const PLUGIN_RPC_PROTOCOL_VERSION = 1;
export declare const HOST_FEATURES_V5: readonly ["harness.driver.v2", "runtime.spawnCli", "handoff.protocol.v2", "sessions.items.read", "sessions.fork", "ui.slots.v5"];
export type HostFeatureV5 = typeof HOST_FEATURES_V5[number];
export declare const HOST_SUPPORTED_FEATURES: readonly ["rpc.v1", "isolation.process", "services.third-party", "permissions.v4", "handoff.compose", "handoff.shouldOffer", "approvals.annotate", "tools.model", "commands.v4", "storage.kv", "fs.workspace", "net.fetch", "ui.slots", "harness.driver.v2", "runtime.spawnCli", "handoff.protocol.v2", "sessions.items.read", "sessions.fork", "ui.slots.v5", "ui.workspace.pages", "runtime.trustedLocal", "peer.assembly.v1", "desktop.view.v1", "plugin.routes.v1", "approval.policy.v1", "ui.filePreview.v1"];
export type HostSupportedFeature = typeof HOST_SUPPORTED_FEATURES[number];
export interface PluginHandshakeRequest {
    trustedLocal?: boolean;
    protocolVersion: number;
    pluginApi: string;
    features: readonly string[];
    pluginId: string;
    instanceId?: string;
    bindings?: Readonly<Record<string, string>>;
    packageDigest: string;
    runId: string;
    config: Readonly<Record<string, unknown>>;
    declaredPermissions: readonly string[];
    services: readonly string[];
}
export interface PluginHandshakeResponse {
    sdkVersion: string;
    name?: string;
    requires?: readonly string[];
    inject?: readonly string[];
    optional?: readonly string[];
    provides?: readonly string[];
    serviceMethods?: Record<string, readonly string[]>;
    serviceMeta?: Record<string, {
        version?: string;
        metadata?: Record<string, unknown>;
    }>;
    routes?: readonly string[];
    commands?: readonly string[];
    tools?: Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        readOnly?: boolean;
    }>;
    slots?: PluginRuntimeSlotDescriptor[];
    sections?: Array<{
        id: string;
        order?: number;
        text: string;
    }>;
    subscribedEvents?: readonly string[];
    hasHandoffCompose?: boolean;
    hasHandoffShouldOffer?: boolean;
    hasApprovalAnnotate?: boolean;
    hasFilePreview?: boolean;
    hasHandoffRedact?: boolean;
    registeredDrivers?: PublicHarnessDriverDescriptor[];
}
export interface PluginRpcErrorPayload {
    code: PluginErrorCode | 'E_INTERNAL';
    message: string;
}
export interface PluginRpcRequest {
    jsonrpc: '2.0';
    id: number;
    runId: string;
    method: string;
    params?: Record<string, unknown>;
}
export interface PluginRpcNotification {
    jsonrpc: '2.0';
    runId: string;
    method: string;
    params?: Record<string, unknown>;
}
export interface PluginRpcResponse {
    jsonrpc: '2.0';
    id: number;
    runId: string;
    result?: unknown;
    error?: PluginRpcErrorPayload;
}
export type PluginRpcMessage = PluginRpcRequest | PluginRpcNotification | PluginRpcResponse;

import { z } from 'zod';
import type { PublicSession } from './context.js';
export type SlotCardinality = 'single' | 'list' | 'keyed' | 'chain' | 'hoc';
export type SlotScope = 'root' | 'session' | 'session-maybe';
export interface PluginSlotContract {
    readonly cardinality: SlotCardinality;
    readonly scope: SlotScope;
    readonly description: string;
}
export declare const PLUGIN_UI_SLOTS: {
    readonly 'session.header.title': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "会话顶栏标题区域（按 order 最小者优先）";
    };
    readonly 'sidebar.tools': {
        readonly cardinality: "list";
        readonly scope: "session-maybe";
        readonly description: "左侧栏快捷工具区";
    };
    readonly 'composer.actions': {
        readonly cardinality: "list";
        readonly scope: "session";
        readonly description: "输入区操作栏";
    };
    readonly 'inspector.tabs': {
        readonly cardinality: "list";
        readonly scope: "session";
        readonly description: "右侧检视抽屉标签页与面板";
    };
    readonly 'statusbar.items': {
        readonly cardinality: "list";
        readonly scope: "session-maybe";
        readonly description: "状态栏扩展项";
    };
    readonly 'chat.node': {
        readonly cardinality: "keyed";
        readonly scope: "session";
        readonly description: "按事件或节点类型渲染自定义聊天节点";
    };
    readonly 'tool.result': {
        readonly cardinality: "keyed";
        readonly scope: "session";
        readonly description: "按工具名渲染自定义工具结果视图";
    };
    readonly 'approval.detail': {
        readonly cardinality: "chain";
        readonly scope: "session";
        readonly description: "按审批类型链式选择审批详情渲染器";
    };
    readonly 'chat.message.wrapper': {
        readonly cardinality: "hoc";
        readonly scope: "session";
        readonly description: "包裹聊天消息内容的容器组件";
    };
};
export type PluginSlotKey = keyof typeof PLUGIN_UI_SLOTS;
export declare const PLUGIN_SLOT_KEYS: readonly ["session.header.title", "sidebar.tools", "composer.actions", "inspector.tabs", "statusbar.items", "chat.node", "tool.result", "approval.detail", "chat.message.wrapper"];
export declare const PLUGIN_UI_SLOTS_V5: {
    readonly 'chat.block': {
        readonly cardinality: "keyed";
        readonly scope: "session";
        readonly description: "按块类型渲染专有消息块（ext:<vendor>.*）或扩展标准块";
    };
    readonly 'composer.traits': {
        readonly cardinality: "list";
        readonly scope: "session";
        readonly description: "输入栏动态参数与工作流 Trait 快捷控件";
    };
    readonly 'harness.settings': {
        readonly cardinality: "keyed";
        readonly scope: "root";
        readonly description: "按 driverId 渲染 Harness 插件自定义认证与高级设置面板";
    };
    readonly 'inspector.diff': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "接管或增强右侧 Diff 与检查点视图";
    };
    readonly 'session.sidebar.badge': {
        readonly cardinality: "list";
        readonly scope: "session-maybe";
        readonly description: "侧栏会话行轻量状态徽标";
    };
};
export type PluginSlotKeyV5 = keyof typeof PLUGIN_UI_SLOTS_V5;
declare const workspaceSlots: {
    readonly 'workspace.pages': {
        readonly cardinality: "list";
        readonly scope: "root";
        readonly description: "在侧栏提供入口并在主工作区打开独立插件页面";
    };
    readonly 'workspace.start': {
        readonly cardinality: "single";
        readonly scope: "root";
        readonly description: "组合中提供的应用启动页与主工作区布局";
    };
    readonly 'inspector.files': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "接管或增强右侧工作区文件浏览与行号预览视图";
    };
    readonly 'inspector.rules': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "接管或增强右侧项目规则与 Skills 视图";
    };
    readonly 'session.stage.embedded': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "会话主舞台内嵌工作台区域（支持分屏与全屏切换，默认与外部插件共享挂载路径）";
    };
};
export type AnyPluginSlotKey = PluginSlotKey | PluginSlotKeyV5 | keyof typeof workspaceSlots;
export declare const PLUGIN_SLOT_KEYS_V5: readonly ["chat.block", "composer.traits", "harness.settings", "inspector.diff", "session.sidebar.badge"];
export declare const ALL_PLUGIN_UI_SLOTS: {
    readonly 'workspace.pages': {
        readonly cardinality: "list";
        readonly scope: "root";
        readonly description: "在侧栏提供入口并在主工作区打开独立插件页面";
    };
    readonly 'workspace.start': {
        readonly cardinality: "single";
        readonly scope: "root";
        readonly description: "组合中提供的应用启动页与主工作区布局";
    };
    readonly 'inspector.files': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "接管或增强右侧工作区文件浏览与行号预览视图";
    };
    readonly 'inspector.rules': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "接管或增强右侧项目规则与 Skills 视图";
    };
    readonly 'session.stage.embedded': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "会话主舞台内嵌工作台区域（支持分屏与全屏切换，默认与外部插件共享挂载路径）";
    };
    readonly 'chat.block': {
        readonly cardinality: "keyed";
        readonly scope: "session";
        readonly description: "按块类型渲染专有消息块（ext:<vendor>.*）或扩展标准块";
    };
    readonly 'composer.traits': {
        readonly cardinality: "list";
        readonly scope: "session";
        readonly description: "输入栏动态参数与工作流 Trait 快捷控件";
    };
    readonly 'harness.settings': {
        readonly cardinality: "keyed";
        readonly scope: "root";
        readonly description: "按 driverId 渲染 Harness 插件自定义认证与高级设置面板";
    };
    readonly 'inspector.diff': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "接管或增强右侧 Diff 与检查点视图";
    };
    readonly 'session.sidebar.badge': {
        readonly cardinality: "list";
        readonly scope: "session-maybe";
        readonly description: "侧栏会话行轻量状态徽标";
    };
    readonly 'session.header.title': {
        readonly cardinality: "single";
        readonly scope: "session";
        readonly description: "会话顶栏标题区域（按 order 最小者优先）";
    };
    readonly 'sidebar.tools': {
        readonly cardinality: "list";
        readonly scope: "session-maybe";
        readonly description: "左侧栏快捷工具区";
    };
    readonly 'composer.actions': {
        readonly cardinality: "list";
        readonly scope: "session";
        readonly description: "输入区操作栏";
    };
    readonly 'inspector.tabs': {
        readonly cardinality: "list";
        readonly scope: "session";
        readonly description: "右侧检视抽屉标签页与面板";
    };
    readonly 'statusbar.items': {
        readonly cardinality: "list";
        readonly scope: "session-maybe";
        readonly description: "状态栏扩展项";
    };
    readonly 'chat.node': {
        readonly cardinality: "keyed";
        readonly scope: "session";
        readonly description: "按事件或节点类型渲染自定义聊天节点";
    };
    readonly 'tool.result': {
        readonly cardinality: "keyed";
        readonly scope: "session";
        readonly description: "按工具名渲染自定义工具结果视图";
    };
    readonly 'approval.detail': {
        readonly cardinality: "chain";
        readonly scope: "session";
        readonly description: "按审批类型链式选择审批详情渲染器";
    };
    readonly 'chat.message.wrapper': {
        readonly cardinality: "hoc";
        readonly scope: "session";
        readonly description: "包裹聊天消息内容的容器组件";
    };
};
export declare const ALL_PLUGIN_SLOT_KEYS: readonly ["session.header.title", "sidebar.tools", "composer.actions", "inspector.tabs", "statusbar.items", "chat.node", "tool.result", "approval.detail", "chat.message.wrapper", "chat.block", "composer.traits", "harness.settings", "inspector.diff", "session.sidebar.badge", "workspace.pages", "workspace.start", "inspector.files", "inspector.rules", "session.stage.embedded"];
export declare function normalizePluginSlotKey(key: string): PluginSlotKey;
export declare function normalizeAnyPluginSlotKey(key: string): AnyPluginSlotKey;
export declare function isValidPluginSlotKey(key: string): key is AnyPluginSlotKey;
export declare function isSafePluginUiPath(value: string): boolean;
export declare const PluginSlotKeyInputSchema: z.ZodEnum<["workspace.pages", "workspace.start", "session.header.title", "sidebar.tools", "composer.actions", "inspector.tabs", "inspector.tab", "statusbar.items", "chat.node", "tool.result", "approval.detail", "chat.message.wrapper", "chat.block", "composer.traits", "harness.settings", "inspector.diff", "inspector.files", "inspector.rules", "session.stage.embedded", "session.sidebar.badge"]>;
export declare const PluginSlotContributionSchema: z.ZodObject<{
    slot: z.ZodEnum<["workspace.pages", "workspace.start", "session.header.title", "sidebar.tools", "composer.actions", "inspector.tabs", "inspector.tab", "statusbar.items", "chat.node", "tool.result", "approval.detail", "chat.message.wrapper", "chat.block", "composer.traits", "harness.settings", "inspector.diff", "inspector.files", "inspector.rules", "session.stage.embedded", "session.sidebar.badge"]>;
    id: z.ZodString;
    title: z.ZodString;
    ui: z.ZodEffects<z.ZodString, string, string>;
    order: z.ZodOptional<z.ZodNumber>;
    key: z.ZodOptional<z.ZodString>;
    height: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    id: string;
    title: string;
    slot: "session.header.title" | "sidebar.tools" | "composer.actions" | "inspector.tabs" | "statusbar.items" | "chat.node" | "tool.result" | "approval.detail" | "chat.message.wrapper" | "chat.block" | "composer.traits" | "harness.settings" | "inspector.diff" | "session.sidebar.badge" | "workspace.pages" | "workspace.start" | "inspector.files" | "inspector.rules" | "session.stage.embedded" | "inspector.tab";
    ui: string;
    order?: number | undefined;
    key?: string | undefined;
    height?: number | undefined;
}, {
    id: string;
    title: string;
    slot: "session.header.title" | "sidebar.tools" | "composer.actions" | "inspector.tabs" | "statusbar.items" | "chat.node" | "tool.result" | "approval.detail" | "chat.message.wrapper" | "chat.block" | "composer.traits" | "harness.settings" | "inspector.diff" | "session.sidebar.badge" | "workspace.pages" | "workspace.start" | "inspector.files" | "inspector.rules" | "session.stage.embedded" | "inspector.tab";
    ui: string;
    order?: number | undefined;
    key?: string | undefined;
    height?: number | undefined;
}>;
export type PluginSlotContribution = z.infer<typeof PluginSlotContributionSchema>;
export interface PluginRuntimeSlotDescriptor {
    slot: AnyPluginSlotKey;
    id: string;
    title: string;
    ui: string;
    order?: number;
    key?: string;
    height?: number;
}
export interface PublicSlotRegistration extends PluginRuntimeSlotDescriptor {
    onMessage?: (payload: unknown, meta: {
        sessionId: string | null;
        slotId: string;
    }) => Promise<unknown> | unknown;
}
export interface PluginSlotRenderFailure {
    id: string;
    pluginId: string;
    pluginName: string;
    slot: AnyPluginSlotKey;
    slotItemId: string;
    message: string;
    timestamp: number;
}
export type PluginSlotBridgeHostMessage = {
    type: 'hm:service:batch';
    runId: string;
    subscriptionId: string;
    batch: PluginUiServiceBatch;
} | {
    type: 'hm:browser:frame';
    runId: string;
    frame: PluginBrowserFrame;
} | {
    type: 'hm:browser:status';
    runId: string;
    status: PluginBrowserStatus;
} | {
    type: 'hm:init';
    pluginId: string;
    runId: string;
    slotId: string;
    slot: AnyPluginSlotKey;
    theme: 'dark' | 'light';
    cssVars: Record<string, string>;
    session: PublicSession | null;
    props: Record<string, unknown>;
} | {
    type: 'hm:theme';
    theme: 'dark' | 'light';
    cssVars: Record<string, string>;
} | {
    type: 'hm:context';
    session: PublicSession | null;
    props: Record<string, unknown>;
} | {
    type: 'hm:rpc:response';
    requestId: string;
    ok: boolean;
    result?: unknown;
    error?: {
        code: string;
        message: string;
    };
};
export type PluginSlotBridgeIframeMessage = {
    type: 'hm:rpc:cancel';
    requestId: string;
    runId: string;
} | {
    type: 'hm:ready';
    slotId: string;
} | {
    type: 'hm:resize';
    slotId: string;
    height: number;
} | {
    type: 'hm:rpc:request';
    requestId: string;
    runId: string;
    method: string;
    params?: Record<string, unknown>;
};
import type { PluginBrowserFrame, PluginBrowserStatus } from './browser-preview.js';
/** One shared shell connection; subscribe acknowledgement precedes the caller's durable snapshot. */
export interface PluginUiServiceBatch {
    subscriptionId: string;
    instanceId: string;
    runId?: string;
    reset?: boolean;
    events: Array<{
        seq: number;
        emittedAt: number;
        payload: Record<string, unknown>;
    }>;
}
export interface PluginUiCancellationSignal {
    readonly aborted: boolean;
    addEventListener(type: 'abort', listener: () => void, options?: {
        once?: boolean;
    }): void;
    removeEventListener(type: 'abort', listener: () => void): void;
}
export interface PluginUiServiceOptions {
    instanceId?: string;
    workspaceId?: string;
    sessionId?: string;
    runId?: string;
    signal?: PluginUiCancellationSignal;
    timeoutMs?: number;
}
export interface PluginUiServices {
    call<T>(contract: string, method: string, args: unknown[], options?: PluginUiServiceOptions): Promise<{
        resolution: unknown;
        value: T;
    }>;
    subscribe(options: PluginUiServiceOptions & {
        contract: string;
        instanceId: string;
    }, listener: (batch: PluginUiServiceBatch) => void): Promise<() => void>;
}
export {};

/** An HTTP(S) page rendered by the desktop host in a private Chromium session. */
export interface PluginBrowserOptions {
    url: string;
    width?: number;
    height?: number;
}
export type PluginBrowserInput = {
    type: 'click' | 'move';
    x: number;
    y: number;
} | {
    type: 'wheel';
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
} | {
    type: 'key';
    key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'Left' | 'Right' | 'Up' | 'Down' | 'Home' | 'End' | 'PageUp' | 'PageDown';
} | {
    type: 'text';
    text: string;
};
export interface PluginBrowserFrame {
    dataUrl: string;
    width: number;
    height: number;
}
export interface PluginBrowserStatus {
    state: 'loading' | 'ready' | 'error' | 'closed';
    url?: string;
    message?: string;
}
export interface PluginBrowserBridge {
    available: boolean;
    open(options: PluginBrowserOptions): Promise<void>;
    close(): Promise<void>;
    reload(): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    input(event: PluginBrowserInput): Promise<void>;
    onFrame(listener: (frame: PluginBrowserFrame) => void): () => void;
    onStatus(listener: (status: PluginBrowserStatus) => void): () => void;
}

/** Options for creating or mounting a kernel-managed desktop view. */
export interface DesktopViewCreateOptions {
    url: string;
    width?: number;
    height?: number;
    title?: string;
}
export interface DesktopViewResizeOptions {
    width: number;
    height: number;
}
export type DesktopViewInput = {
    type: 'click' | 'move';
    x: number;
    y: number;
} | {
    type: 'wheel';
    x: number;
    y: number;
    deltaX: number;
    deltaY: number;
} | {
    type: 'key';
    key: 'Enter' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'Left' | 'Right' | 'Up' | 'Down' | 'Home' | 'End' | 'PageUp' | 'PageDown';
} | {
    type: 'text';
    text: string;
};
export interface DesktopViewFrame {
    dataUrl: string;
    width: number;
    height: number;
}
export interface DesktopViewStatus {
    state: 'loading' | 'ready' | 'error' | 'closed';
    url?: string;
    message?: string;
}
export interface DesktopViewBridge {
    readonly available: boolean;
    create(options: DesktopViewCreateOptions): Promise<void>;
    mount(options: DesktopViewCreateOptions): Promise<void>;
    navigate(url: string): Promise<void>;
    resize(options: DesktopViewResizeOptions): Promise<void>;
    focus(focused?: boolean): Promise<void>;
    input(event: DesktopViewInput): Promise<void>;
    back(): Promise<void>;
    forward(): Promise<void>;
    reload(): Promise<void>;
    destroy(): Promise<void>;
    onFrame(listener: (frame: DesktopViewFrame) => void): () => void;
    onStatus(listener: (status: DesktopViewStatus) => void): () => void;
}

import { z } from 'zod';
export declare const FILE_PREVIEW_FEATURE = "ui.filePreview.v1";
export declare const FILE_PREVIEW_PERMISSION = "file:preview";
export declare const FilePreviewContributionSchema: z.ZodObject<{
    extensions: z.ZodEffects<z.ZodArray<z.ZodUnion<[z.ZodLiteral<"*">, z.ZodString]>, "many">, string[], string[]>;
    viewerKind: z.ZodOptional<z.ZodEnum<["text", "markdown", "custom"]>>;
}, "strict", z.ZodTypeAny, {
    extensions: string[];
    viewerKind?: "custom" | "text" | "markdown" | undefined;
}, {
    extensions: string[];
    viewerKind?: "custom" | "text" | "markdown" | undefined;
}>;
export interface FilePreviewProviderMeta {
    extensions: string[];
    viewerKind?: 'text' | 'markdown' | 'custom';
    title?: string;
}
export interface FilePreviewRequest {
    readonly version: 1;
    readonly relativePath: string;
    readonly content: string;
    readonly truncated: boolean;
    readonly sizeBytes: number;
    readonly line?: number;
}
export declare const FilePreviewResultSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    format: z.ZodEnum<["markdown", "text"]>;
    content: z.ZodString;
    line: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    version: 1;
    format: "text" | "markdown";
    content: string;
    line?: number | undefined;
}, {
    version: 1;
    format: "text" | "markdown";
    content: string;
    line?: number | undefined;
}>;
/** The optional line refers to the returned content. Return null to use the built-in preview. */
export type FilePreviewResult = z.infer<typeof FilePreviewResultSchema>;
export type FilePreviewRenderer = (request: FilePreviewRequest) => FilePreviewResult | null | Promise<FilePreviewResult | null>;

import type { HistoryImportExecuteRequest, HistoryImportExecuteResponse, HistoryRef, PublicDriverTurnInput, PublicPermissionMode, PublicPortableSessionBundleV2, PublicReasoningEffort, PublicTurnBlock, ServiceMethodResult } from './context.js';
export declare const SESSION_DATA_CONTRACT = "session.data.v1";
export declare const SESSION_DATA_CONTRACT_VERSION = "1.0.0";
export declare const SESSION_RUNTIME_CONTRACT = "session.runtime.v1";
export declare const SESSION_RUNTIME_CONTRACT_VERSION = "1.0.0";
export declare const LEGACY_SESSION_DATA_CONTRACT = "hm.session-data.v1";
export declare const LEGACY_SESSION_DATA_CONTRACT_VERSION = "1.0.0";
/**
 * Identifies a concrete data stream owned by a specific `session.data.v1` provider instance.
 * Sequence numbers (`seq`, `changeSeq`, `watermarkSeq`) are ONLY comparable within the same stream.
 */
export interface SessionDataStreamIdentity {
    providerInstanceId: string;
    streamId: string;
    runId?: string;
}
export interface SessionDataCursor {
    providerInstanceId: string;
    streamId: string;
    seq: number;
}
export declare function sessionDataStreamKey(stream: SessionDataStreamIdentity): string;
export declare function isSameSessionDataStream(a: SessionDataStreamIdentity, b: SessionDataStreamIdentity): boolean;
/**
 * Compares two cursors if and only if they belong to the same provider instance & stream.
 * Returns `null` when cursors come from different streams so callers never compare foreign seqs.
 */
export declare function compareSessionDataCursors(a: SessionDataCursor, b: SessionDataCursor): number | null;
export interface SessionRuntimeGenerationRef {
    runtimeInstanceId: string;
    runtimeRunId: string;
    dataInstanceId: string;
    dataStreamId?: string;
    driverProviderInstanceId?: string;
    harnessId: string;
    turnGeneration: number;
}
export interface SessionWorkspaceDto {
    id: string;
    name: string;
    rootPath: string;
    isGitRepo: boolean;
    gitBranch?: string | null;
    createdAt: number;
}
export interface SessionTokenUsageDto {
    inputTokens: number;
    outputTokens: number;
    cachedTokens?: number;
    costUsd?: number;
    contextTokens?: number;
    modelContextWindow?: number;
    cacheReadTokens?: number;
}
export interface SessionRecordDto {
    id: string;
    workspaceId: string;
    harnessId: string;
    harnessKind: string;
    nativeSessionId: string | null;
    parentSessionId?: string | null;
    forkedFromTurnSeq?: number | null;
    forkMode?: 'with_context' | 'clean_fork' | null;
    importMode?: 'attach' | 'mirror' | null;
    importSource?: string | null;
    participatingHarnesses?: string[];
    contextSyncMode?: 'auto' | 'full_ledger' | 'delta_only';
    cwd: string;
    worktreeBranch?: string | null;
    title: string;
    status: string;
    model: string | null;
    actualModel?: string | null;
    modelReroutedReason?: string | null;
    reasoningEffort: PublicReasoningEffort | null;
    permissionMode: PublicPermissionMode;
    lastSeq: number;
    usage: SessionTokenUsageDto | null;
    pendingApprovalCount: number;
    createdAt: number;
    updatedAt: number;
}
export interface SessionCanonicalEventDto {
    sessionId: string;
    seq: number;
    type: string;
    turnId: string | null;
    payload: Record<string, unknown>;
    createdAt: number;
}
export interface SessionRunRecordDto {
    runId: string;
    sessionId: string;
    turnId: string;
    instanceId: string;
    driverId: string;
    model?: string | null;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
    failureClass?: string | null;
    usage?: SessionTokenUsageDto | null;
    startedAt: number;
    endedAt?: number | null;
}
export interface SessionHarnessBindingDto {
    sessionId: string;
    harnessId: string;
    harnessKind: string;
    nativeSessionId: string | null;
    lastModel?: string | null;
    lastActualModel?: string | null;
    lastEffort?: PublicReasoningEffort | null;
    syncedUpToSeq: number;
    driverUsed?: string | null;
    updatedAt: number;
}
export interface SessionTurnReceiptDto {
    sessionId: string;
    requestId: string;
    requestHash: string;
    turnId: string;
    runId: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
    runtimeInstanceId: string;
    runtimeRunId: string;
    createdAt: number;
    updatedAt: number;
}
export interface SessionUsageAggregateDto {
    harnessId: string;
    instanceId: string;
    sessionCount: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    costUsd: number;
    dailyBuckets: Array<{
        date: string;
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        costUsd: number;
    }>;
}
export type SessionChangeKindV1 = 'upsert_item' | 'upsert_session' | 'delete_session' | 'delete_item';
export interface SessionSearchSnapshotItemDto {
    sessionId: string;
    sessionTitle: string;
    workspaceId: string;
    itemId: string;
    turnId: string;
    turnSeq: number;
    driverId: string;
    blockType: string;
    textBody: string;
    createdAt: number;
    updatedAt: number;
}
export interface SessionCommittedSummaryDto {
    id: string;
    workspaceId: string;
    title: string;
    harnessId: string;
    harnessKind: string;
    status: string;
    updatedAt: number;
}
export interface SessionCommittedChangeDto {
    changeSeq: number;
    kind: SessionChangeKindV1;
    sessionId: string;
    workspaceId: string;
    itemId: string | null;
    committedAt: number;
    item?: SessionSearchSnapshotItemDto | null;
    session?: SessionCommittedSummaryDto | null;
}
export interface SessionSearchSnapshotResponseV1 {
    snapshotId: string;
    stream: SessionDataStreamIdentity;
    watermarkSeq: number;
    cursor: SessionDataCursor;
    items: SessionSearchSnapshotItemDto[];
    nextCursor: string | null;
}
export interface SessionCommittedChangesResponseV1 {
    stream: SessionDataStreamIdentity;
    changes: SessionCommittedChangeDto[];
    latestSeq: number;
    cursor: SessionDataCursor;
    hasMore: boolean;
}
export interface SessionEventsPageResponseV1 {
    sessionId: string;
    stream: SessionDataStreamIdentity;
    events: SessionCanonicalEventDto[];
    lastSeq: number;
    nextAfterSeq: number | null;
    hasMore: boolean;
}
export interface SessionUpdatePatchDto {
    title?: string;
    harnessId?: string;
    harnessKind?: string;
    nativeSessionId?: string | null;
    participatingHarnesses?: string[];
    contextSyncMode?: 'auto' | 'full_ledger' | 'delta_only';
    status?: string;
    model?: string | null;
    actualModel?: string | null;
    modelReroutedReason?: string | null;
    reasoningEffort?: PublicReasoningEffort | null;
    permissionMode?: PublicPermissionMode;
    usage?: SessionTokenUsageDto | null;
    worktreeBranch?: string | null;
    cwd?: string;
}
export interface SessionDataCommitBatchRequest {
    sessionId: string;
    sessionPatch?: SessionUpdatePatchDto;
    events?: Array<{
        type: string;
        turnId?: string | null;
        payload: Record<string, unknown>;
        createdAt?: number;
    }>;
    turnItems?: Array<Omit<PublicTurnBlock, 'sessionId' | 'seq'> & {
        seq?: number;
    }>;
    runStart?: SessionRunRecordDto;
    runFinish?: {
        runId: string;
        status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
        failureClass?: string | null;
        usage?: SessionTokenUsageDto | null;
        endedAt?: number;
    };
    bindingUpsert?: SessionHarnessBindingDto;
    settleRunningItemsStatus?: 'completed' | 'interrupted' | 'cancelled';
    turnReceipt?: SessionTurnReceiptDto;
}
export interface SessionDataCommitBatchResult {
    stream: SessionDataStreamIdentity;
    session: SessionRecordDto | null;
    committedEvents: SessionCanonicalEventDto[];
    latestSeq: number;
    changeSeq: number;
}
export interface SessionDataChannelEvent {
    kind: 'events_committed' | 'session_changed' | 'session_deleted' | 'workspace_changed';
    stream: SessionDataStreamIdentity;
    changeSeq: number;
    sessionId?: string;
    workspaceId?: string;
    events?: SessionCanonicalEventDto[];
}
export interface SessionDataServiceV1 {
    getStreamInfo(): Promise<ServiceMethodResult<{
        stream: SessionDataStreamIdentity;
        latestChangeSeq: number;
        writable: boolean;
    }>>;
    listWorkspaces(): Promise<ServiceMethodResult<{
        workspaces: SessionWorkspaceDto[];
        stream: SessionDataStreamIdentity;
    }>>;
    getWorkspace(req: {
        workspaceId: string;
    }): Promise<ServiceMethodResult<{
        workspace: SessionWorkspaceDto | null;
    }>>;
    getWorkspaceByPath(req: {
        rootPath: string;
    }): Promise<ServiceMethodResult<{
        workspace: SessionWorkspaceDto | null;
    }>>;
    createWorkspace(req: {
        id?: string;
        name: string;
        rootPath: string;
        isGitRepo?: boolean;
        gitBranch?: string | null;
        createdAt?: number;
    }): Promise<ServiceMethodResult<{
        workspace: SessionWorkspaceDto;
        created: boolean;
    }>>;
    updateWorkspaceGit(req: {
        workspaceId: string;
        isGitRepo: boolean;
        gitBranch: string | null;
    }): Promise<ServiceMethodResult<{
        workspace: SessionWorkspaceDto | null;
    }>>;
    deleteWorkspace(req: {
        workspaceId: string;
    }): Promise<ServiceMethodResult<{
        deleted: boolean;
    }>>;
    listSessions(req?: {
        workspaceId?: string;
        harnessId?: string;
        includeArchived?: boolean;
    }): Promise<ServiceMethodResult<{
        sessions: SessionRecordDto[];
        stream: SessionDataStreamIdentity;
    }>>;
    getSession(req: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        session: SessionRecordDto | null;
    }>>;
    createSession(req: {
        session: Omit<SessionRecordDto, 'id' | 'lastSeq' | 'usage' | 'pendingApprovalCount' | 'createdAt' | 'updatedAt'> & {
            id?: string;
            lastSeq?: number;
            usage?: SessionTokenUsageDto | null;
            pendingApprovalCount?: number;
            createdAt?: number;
            updatedAt?: number;
        };
    }): Promise<ServiceMethodResult<{
        session: SessionRecordDto;
        stream: SessionDataStreamIdentity;
    }>>;
    updateSession(req: {
        sessionId: string;
        patch: SessionUpdatePatchDto;
    }): Promise<ServiceMethodResult<{
        session: SessionRecordDto | null;
    }>>;
    deleteSession(req: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        deleted: boolean;
    }>>;
    listEvents(req: {
        sessionId: string;
        afterSeq?: number;
        throughSeq?: number;
        turnId?: string;
        limit?: number;
    }): Promise<ServiceMethodResult<SessionEventsPageResponseV1>>;
    appendEvent(req: {
        sessionId: string;
        type: string;
        turnId?: string | null;
        payload: Record<string, unknown>;
        createdAt?: number;
    }): Promise<ServiceMethodResult<{
        event: SessionCanonicalEventDto;
        stream: SessionDataStreamIdentity;
    }>>;
    listTurnItems(req: {
        sessionId: string;
        afterSeq?: number;
        beforeSeq?: number;
        turnId?: string;
        blockTypes?: string[];
        limit?: number;
    }): Promise<ServiceMethodResult<{
        items: PublicTurnBlock[];
        nextSeq: number | null;
        stream: SessionDataStreamIdentity;
    }>>;
    getTurnItem(req: {
        sessionId: string;
        itemId: string;
        textOffset?: number;
        maxChars?: number;
    }): Promise<ServiceMethodResult<{
        item: PublicTurnBlock;
        text: string;
        totalChars: number;
        textOffset: number;
        nextTextOffset: number | null;
        hasMore: boolean;
    } | null>>;
    upsertTurnItem(req: {
        item: PublicTurnBlock;
    }): Promise<ServiceMethodResult<{
        item: PublicTurnBlock;
    }>>;
    settleRunningTurnItems(req: {
        sessionId?: string;
        status: 'completed' | 'interrupted' | 'cancelled';
    }): Promise<ServiceMethodResult<{
        settledCount: number;
    }>>;
    commitBatch(req: SessionDataCommitBatchRequest): Promise<ServiceMethodResult<SessionDataCommitBatchResult>>;
    listSessionRuns(req: {
        sessionId: string;
        limit?: number;
    }): Promise<ServiceMethodResult<{
        runs: SessionRunRecordDto[];
    }>>;
    startSessionRun(req: {
        run: SessionRunRecordDto;
    }): Promise<ServiceMethodResult<{
        run: SessionRunRecordDto;
    }>>;
    finishSessionRun(req: {
        runId: string;
        status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
        failureClass?: string | null;
        usage?: SessionTokenUsageDto | null;
        endedAt?: number;
    }): Promise<ServiceMethodResult<{
        updated: boolean;
    }>>;
    getTurnReceipt(req: {
        sessionId: string;
        requestId: string;
    }): Promise<ServiceMethodResult<{
        receipt: SessionTurnReceiptDto | null;
    }>>;
    recordTurnReceipt(req: {
        receipt: SessionTurnReceiptDto;
    }): Promise<ServiceMethodResult<{
        receipt: SessionTurnReceiptDto;
        conflict?: boolean;
    }>>;
    getHarnessBinding(req: {
        sessionId: string;
        harnessId: string;
    }): Promise<ServiceMethodResult<{
        binding: SessionHarnessBindingDto | null;
    }>>;
    listHarnessBindings(req: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        bindings: SessionHarnessBindingDto[];
    }>>;
    upsertHarnessBinding(req: {
        binding: SessionHarnessBindingDto;
    }): Promise<ServiceMethodResult<{
        binding: SessionHarnessBindingDto;
    }>>;
    readSearchSnapshot(req?: {
        snapshotId?: string;
        cursor?: string | null;
        limit?: number;
        workspaceId?: string;
    }): Promise<ServiceMethodResult<SessionSearchSnapshotResponseV1>>;
    readCommittedChanges(req?: {
        afterSeq?: number;
        limit?: number;
        workspaceId?: string;
    }): Promise<ServiceMethodResult<SessionCommittedChangesResponseV1>>;
    getUsageAggregatesByInstance(): Promise<ServiceMethodResult<{
        aggregates: SessionUsageAggregateDto[];
    }>>;
    getLatestCompletedTurnSeq(req: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        seq: number;
    }>>;
    lookupNativeMapping(req: {
        sourceId: string;
        nativeSessionId: string;
        compatLegacySources?: string[];
    }): Promise<ServiceMethodResult<{
        existingSessionId: string | null;
        matchedVia: 'mapping' | 'legacy' | null;
    }>>;
    lookupReceipt(req: {
        requestId: string;
        requestHash: string;
    }): Promise<ServiceMethodResult<{
        found: false;
    } | {
        found: true;
        conflict: true;
    } | {
        found: true;
        conflict: false;
        result: {
            sessionId: string;
            disposition: 'created' | 'reused';
            partial: boolean;
            warnings: string[];
            mode: 'attach' | 'mirror';
        };
    }>>;
    resolveTargetWorkspace(req: {
        kind: 'native' | 'bundle';
        workspaceId?: string;
        cwd?: string | null;
        bundleCwd?: string | null;
    }): Promise<ServiceMethodResult<{
        targetWorkspaceId: string | null;
        targetWorkspacePath: string | null;
        hasLocalCwd: boolean;
        importable: boolean;
        reason?: string;
    }>>;
    commitNativeImport(req: {
        requestId: string;
        requestHash: string;
        ref: HistoryRef;
        mode: 'attach' | 'mirror';
        compatLegacySources?: string[];
        legacySource?: string;
        sourcePath?: string;
        title?: string;
        harnessKind?: string;
        cwd?: string | null;
        workspaceId?: string;
        updatedAt?: number;
        items: Array<{
            itemId?: string;
            role: 'user' | 'assistant';
            text: string;
            timestamp?: number;
        }>;
        partial?: boolean;
        warnings?: string[];
        lockWarning?: string;
        truncatedReason?: string;
    }): Promise<ServiceMethodResult<HistoryImportExecuteResponse & {
        lockWarning?: string;
        mode: 'attach' | 'mirror';
    }>>;
    commitBundleImport(req: {
        requestId: string;
        requestHash: string;
        bundle: PublicPortableSessionBundleV2;
        workspaceId?: string;
        titleOverride?: string;
    }): Promise<ServiceMethodResult<HistoryImportExecuteResponse & {
        mode: 'attach' | 'mirror';
    }>>;
    recoverCrashState(): Promise<ServiceMethodResult<{
        recoveredRuns: number;
        recoveredItems: number;
    }>>;
}
/**
 * Legacy Batch 1 `hm.session-data.v1` compatibility service interface.
 */
export interface LegacySessionDataCompatServiceV1 {
    lookupNativeMapping(params: {
        sourceId: string;
        nativeSessionId: string;
        compatLegacySources?: string[];
    }): Promise<{
        existingSessionId: string | null;
        matchedVia: 'mapping' | 'legacy' | null;
    }> | {
        existingSessionId: string | null;
        matchedVia: 'mapping' | 'legacy' | null;
    };
    lookupReceipt(params: {
        requestId: string;
        requestHash: string;
    }): unknown;
    resolveTargetWorkspace(params: {
        kind: 'native' | 'bundle';
        workspaceId?: string;
        cwd?: string | null;
        bundleCwd?: string | null;
    }): unknown;
    listWorkspaces(): Promise<SessionWorkspaceDto[]> | SessionWorkspaceDto[];
    commitNativeImport(params: Record<string, unknown>): Promise<unknown>;
    commitBundleImport(params: Record<string, unknown>): Promise<unknown> | unknown;
    readSearchSnapshot(req?: {
        snapshotId?: string;
        cursor?: string | null;
        limit?: number;
        workspaceId?: string;
    }): Promise<SessionSearchSnapshotResponseV1> | SessionSearchSnapshotResponseV1;
    readCommittedChanges(req?: {
        afterSeq?: number;
        limit?: number;
        workspaceId?: string;
    }): Promise<SessionCommittedChangesResponseV1> | SessionCommittedChangesResponseV1;
}
export type SessionConfigApplyStatus = 'applied' | 'pending_next_session' | 'unsupported' | 'rejected';
export interface SessionConfigReceiptDto {
    sessionId: string;
    harnessId: string;
    requested: {
        model?: string | null;
        reasoningEffort?: PublicReasoningEffort | null;
        permissionMode?: PublicPermissionMode;
    };
    confirmed: {
        model?: string | null;
        actualModel?: string | null;
        reasoningEffort?: PublicReasoningEffort | null;
        permissionMode?: PublicPermissionMode | null;
        permissionEnforcement?: 'native' | 'client_guard' | null;
    };
    status: SessionConfigApplyStatus;
    note?: string;
}
export interface SendTurnRuntimeRequest {
    sessionId: string;
    text: string;
    requestId?: string;
    attachments?: PublicDriverTurnInput['attachments'];
    terminalContexts?: Array<{
        id: string;
        terminalId: string;
        terminalTitle: string;
        cwd: string;
        lineStart: number;
        lineEnd: number;
        cleanText: string;
        truncated?: boolean;
        exitCode?: number | null;
    }>;
    harnessId?: string;
    model?: string | null;
    turnOptions?: Record<string, string | number | boolean>;
    omitHandoff?: boolean;
    literalText?: boolean;
    mode?: 'plugin_development';
    cliCommand?: string;
    nativeSkill?: {
        name: string;
        path: string;
    };
    dataInstanceId?: string;
    driverProviderInstanceId?: string;
}
export interface SendTurnRuntimeReceipt {
    sessionId: string;
    turnId: string;
    runId: string;
    requestId?: string;
    disposition: 'started' | 'reused' | 'steered';
    status: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
    runtimeInstanceId: string;
    runtimeRunId: string;
    dataInstanceId: string;
    harnessId: string;
    driverProviderInstanceId?: string;
    turnGeneration: number;
}
export interface RuntimeActiveTurnStateDto {
    sessionId: string;
    turnId: string;
    runId: string;
    requestId?: string;
    runtimeInstanceId: string;
    runtimeRunId: string;
    dataInstanceId: string;
    harnessId: string;
    harnessKind: string;
    model: string | null;
    actualModel: string | null;
    turnGeneration: number;
    startedAt: number;
}
export interface RuntimePendingRecoveryDto {
    sessionId: string;
    turnId: string;
    runId: string;
    dataInstanceId: string;
    reason: string;
    recordedAt: number;
}
export interface SessionRuntimeServiceV1 {
    getRuntimeInfo(): Promise<ServiceMethodResult<{
        runtimeInstanceId: string;
        runtimeRunId: string;
        acceptingTurns: boolean;
        activeTurnCount: number;
        liveHandleCount: number;
        pendingRecoveryCount: number;
    }>>;
    sendTurn(req: SendTurnRuntimeRequest): Promise<ServiceMethodResult<SendTurnRuntimeReceipt>>;
    getTurnStatus(req: {
        sessionId: string;
        turnId?: string;
        requestId?: string;
    }): Promise<ServiceMethodResult<{
        active: RuntimeActiveTurnStateDto | null;
        receipt: SessionTurnReceiptDto | null;
        pendingRecovery: RuntimePendingRecoveryDto | null;
    }>>;
    interrupt(req: {
        sessionId: string;
        reason?: string;
    }): Promise<ServiceMethodResult<{
        interrupted: boolean;
    }>>;
    applyConfig(req: {
        sessionId: string;
        patch: {
            model?: string | null;
            reasoningEffort?: PublicReasoningEffort | null;
            permissionMode?: PublicPermissionMode;
        };
        configAlreadyApplied?: boolean;
    }): Promise<ServiceMethodResult<SessionConfigReceiptDto>>;
    closeSession(req: {
        sessionId: string;
        reason?: string;
    }): Promise<ServiceMethodResult<{
        closedHandles: number;
    }>>;
    closeHarnessSessions(req: {
        harnessId: string;
        reason?: string;
    }): Promise<ServiceMethodResult<{
        closedHandles: number;
    }>>;
    listActiveTurns(req?: {
        workspaceId?: string;
    }): Promise<ServiceMethodResult<{
        turns: RuntimeActiveTurnStateDto[];
    }>>;
    listPendingRecoveries(): Promise<ServiceMethodResult<{
        recoveries: RuntimePendingRecoveryDto[];
    }>>;
    recoverStaleRuns(req?: {
        dataInstanceId?: string;
    }): Promise<ServiceMethodResult<{
        recoveredCount: number;
    }>>;
    drainAndStop(req?: {
        reason?: string;
    }): Promise<ServiceMethodResult<{
        drainedTurns: number;
        closedHandles: number;
    }>>;
}
export type HistoryImportSessionCommitResult = HistoryImportExecuteRequest | HistoryImportExecuteResponse;

import type { PublicHarnessCapabilities, PublicHarnessCapabilitiesV2, PublicHarnessHealth, PublicHarnessModelInfo, PublicHarnessPresentationMeta, PublicRateLimitWindow, ServiceMethodResult } from './context.js';
export declare const HARNESS_DRIVER_CONTRACT = "harness.driver.v1";
export declare const HARNESS_DRIVER_CONTRACT_VERSION = "1.0.0";
export declare const HARNESS_DRIVER_CODEX_CONTRACT = "harness.driver.codex.v1";
export declare const HARNESS_DRIVER_CLAUDE_CONTRACT = "harness.driver.claude.v1";
export declare const HARNESS_DRIVER_ACP_CONTRACT = "harness.driver.acp.v1";
export declare const HARNESS_DRIVER_AGY_CONTRACT = "harness.driver.agy.v1";
export declare function harnessDriverCategoryContract(driverId: string): string;
export interface DriverProviderIdentity {
    pluginId: string;
    instanceId: string;
    driverId: string;
    harnessId: string;
    runId: string;
    continuationKey?: string;
}
export interface DriverCommandCapability {
    command: string;
    description: string;
    argumentHint?: string;
    supported: boolean;
    reason?: string;
    source?: 'builtin' | 'driver' | 'native_advertised';
}
export interface DriverCommandReceipt {
    command: string;
    status: 'executed' | 'queued_turn' | 'unsupported' | 'rejected';
    output: string;
    turnId?: string;
    confirmed?: Record<string, unknown>;
    reason?: string;
}
export interface DriverConfigReceipt {
    harnessId: string;
    driverId: string;
    providerInstanceId: string;
    runId: string;
    requested: Record<string, unknown>;
    confirmed: Record<string, unknown>;
    status: 'applied' | 'pending_next_session' | 'unsupported' | 'rejected';
    note?: string;
}
export interface DriverRegistrationEntry {
    key: string;
    pluginId: string;
    instanceId: string;
    driverId: string;
    harnessId: string;
    runId: string;
    displayName: string;
    description: string;
    protocolLabel: string;
    continuationKey?: string;
    isDefault?: boolean;
    isCustom?: boolean;
    capabilities: PublicHarnessCapabilities;
    capabilitiesV2?: PublicHarnessCapabilitiesV2;
    presentation?: PublicHarnessPresentationMeta;
    supportedCommands?: DriverCommandCapability[];
}
export interface DriverProbeSnapshotDto {
    harnessId: string;
    driverId: string;
    providerPluginId: string;
    providerInstanceId: string;
    providerRunId: string;
    binaryPath: string | null;
    version: string | null;
    health: PublicHarnessHealth;
    healthMessage?: string;
    models: PublicHarnessModelInfo[];
    defaultModelId?: string | null;
    accountSummary?: string | null;
    supportedCommands?: DriverCommandCapability[];
}
export interface DriverUsageLimitSnapshotDto {
    harnessId: string;
    driverId: string;
    providerInstanceId: string;
    loggedIn: boolean;
    accountLabel: string | null;
    planType: string | null;
    authMethod: string | null;
    billingTier?: 'subscription' | 'api_payg' | 'local_free' | 'unknown';
    gatewayUrl?: string | null;
    rateLimits: PublicRateLimitWindow[];
    error?: string | null;
}
export interface HarnessDriverProviderServiceV1 {
    getProviderInfo(): Promise<ServiceMethodResult<{
        pluginId: string;
        instanceId: string;
        runId: string;
        driverIds: string[];
        harnessIds: string[];
    }>>;
    listHarnessInstances(): Promise<ServiceMethodResult<{
        instances: DriverRegistrationEntry[];
    }>>;
    probe(request?: {
        harnessId?: string;
        forceRefresh?: boolean;
    }): Promise<ServiceMethodResult<{
        probes: DriverProbeSnapshotDto[];
    }>>;
    readUsageLimits?(request?: {
        harnessId?: string;
    }): Promise<ServiceMethodResult<DriverUsageLimitSnapshotDto>>;
    listCommands?(request?: {
        harnessId?: string;
    }): Promise<ServiceMethodResult<{
        commands: DriverCommandCapability[];
    }>>;
    runCommand?(request: {
        sessionId: string;
        harnessId: string;
        command: string;
        args?: string;
    }): Promise<ServiceMethodResult<DriverCommandReceipt>>;
}

import type { PublicPortableSessionBundleV2, ServiceMethodResult } from './context.js';
import type { SessionHarnessBindingDto, SessionRecordDto } from './session-contracts.js';
export declare const SESSION_HANDOFF_CONTRACT = "session.handoff.v1";
export declare const SESSION_HANDOFF_CONTRACT_VERSION = "1.0.0";
export declare const SESSION_COMPRESSION_CONTRACT = "session.compression.v1";
export declare const SESSION_COMPRESSION_CONTRACT_VERSION = "1.0.0";
export declare const SESSION_COLLABORATION_CONTRACT = "session.collaboration.v1";
export declare const SESSION_COLLABORATION_CONTRACT_VERSION = "1.0.0";
export declare const SESSION_ORCHESTRATION_CONTRACT = "session.orchestration.v1";
export declare const SESSION_ORCHESTRATION_CONTRACT_VERSION = "1.0.0";
export type HandoffDeliveryStateDto = 'pending' | 'confirmed' | 'failed' | 'uncertain';
export interface HandoffRecordDto {
    handoffId: string;
    sessionId: string;
    turnId: string | null;
    fromInstanceId: string | null;
    toInstanceId: string;
    mode: string;
    deliveryChannel: string;
    deliveryStatus: HandoffDeliveryStateDto;
    coveredUpToSeq: number;
    estimatedChars: number;
    redactedCount: number;
    forceFreshReason?: string | null;
    snapshot?: Record<string, unknown> | null;
    createdAt: number;
    deliveredAt?: number | null;
}
export interface CompiledHandoffPacketDto {
    preview: {
        sessionId: string;
        targetHarnessId: string;
        targetHarnessKind: string;
        syncedUpToSeq: number;
        currentLastSeq: number;
        unsyncedTurnCount: number;
        estimatedTokens: number;
        budgetTokens: number;
        driverPlanned: string;
        isWarmBinding: boolean;
        syncNeeded: boolean;
        compiledMarkdown: string;
        ledgerMarkdown: string;
        deltaTurnSummary: Array<{
            turnId: string;
            harnessId: string;
            model?: string | null;
            userPreview: string;
        }>;
    };
    snapshot: Record<string, unknown>;
    deltaMarkdown: string;
    portableItems: Array<{
        type: 'message';
        role: 'user' | 'assistant';
        content: Array<{
            type: 'input_text' | 'output_text';
            text: string;
        }>;
    }>;
    objective: string;
    coveredUpToSeq: number;
    syncNeeded: boolean;
    forceFreshNativeSession?: boolean;
    forceFreshReason?: 'uncertain_previous_delivery' | 'context_budget_overflow' | null;
    redaction?: {
        redactedCount: number;
        categories: string[];
    };
    omitted?: {
        count: number;
        itemIds: string[];
        mcpPullAvailable: boolean;
        mcpPullInstruction?: string;
    };
    workspaceAnchor?: {
        workspaceDigest: string;
        mutatedSinceTargetLastTurn: boolean;
        mutatedFiles: string[];
    };
}
export interface SessionHandoffServiceV1 {
    getProviderInfo(): Promise<ServiceMethodResult<{
        instanceId: string;
        runId: string;
        autoAttach: boolean;
        budgetTokens: number;
    }>>;
    preview(request: {
        sessionId: string;
        targetHarnessId?: string;
        syncMode?: 'auto' | 'full_ledger' | 'delta_only';
    }): Promise<ServiceMethodResult<{
        preview: Record<string, unknown>;
    }>>;
    compile(request: {
        sessionId: string;
        targetHarnessId: string;
        targetHarnessKind: string;
        binding?: SessionHarnessBindingDto | null;
        syncMode?: 'auto' | 'full_ledger' | 'delta_only';
        excludeTurnId?: string;
        upToSeq?: number;
        budgetTokens?: number;
        modelContextWindow?: number;
        nativeUsedTokens?: number;
        currentUserText?: string;
    }): Promise<ServiceMethodResult<{
        packet: CompiledHandoffPacketDto;
    }>>;
    stagePending(request: {
        sessionId: string;
        targetHarnessId: string;
        turnId?: string | null;
        driver: string;
        fromInstanceId?: string | null;
        coveredUpToSeq: number;
        estimatedChars: number;
        redactedCount: number;
        isWarmBinding: boolean;
        forceFreshNativeSession?: boolean;
        forceFreshReason?: string | null;
        snapshot: Record<string, unknown>;
    }): Promise<ServiceMethodResult<{
        handoffId: string;
    }>>;
    confirmDelivery(request: {
        handoffId: string;
    }): Promise<ServiceMethodResult<{
        ok: boolean;
    }>>;
    failDelivery(request: {
        handoffId: string;
        sessionId: string;
        targetHarnessId: string;
        resetBinding?: boolean;
        uncertain?: boolean;
    }): Promise<ServiceMethodResult<{
        deliveryStatus: HandoffDeliveryStateDto;
    }>>;
    listHandoffs(request: {
        sessionId: string;
        limit?: number;
    }): Promise<ServiceMethodResult<{
        handoffs: HandoffRecordDto[];
    }>>;
    evaluateOffer?(request: {
        sessionId: string;
        harnessId: string;
        message?: string | null;
    }): Promise<ServiceMethodResult<{
        decision: unknown;
    }>>;
}
export interface SessionCompressionServiceV1 {
    isEnabled(): boolean;
    getConfig(): Promise<ServiceMethodResult<{
        enabled: boolean;
        config: Record<string, unknown>;
    }>>;
    updateConfig(patch: Record<string, unknown>): Promise<ServiceMethodResult<{
        enabled: boolean;
        config: Record<string, unknown>;
    }>>;
    getStatus(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    compressRange(request: {
        sessionId: string;
        fromSeq?: number;
        toSeq?: number;
        budgetChars?: number;
        forceRecompute?: boolean;
        includeSymbolOutline?: boolean;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    clearCache(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    buildSymbolOutline?(request: {
        workspacePath: string;
        filePaths: string[];
        maxChars: number;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
}
export interface SideChatMessageDto {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant';
    text: string;
    harnessId: string;
    model?: string | null;
    createdAt: number;
}
export interface SessionCollaborationServiceV1 {
    forkSession(request: {
        sessionId: string;
        targetHarnessId?: string;
        fromTurnSeq?: number;
        title?: string;
        mode?: 'with_context' | 'clean_fork';
        createWorktree?: boolean;
        worktreeBranch?: string;
    }): Promise<ServiceMethodResult<{
        session: SessionRecordDto;
        forkMode: string;
        handoffPreview?: Record<string, unknown>;
    }>>;
    mergeBack(request: {
        childSessionId: string;
        summary?: string;
        decision?: string;
        pinnedFacts?: string[];
        archiveChild?: boolean;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    getSideChat(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        messages: SideChatMessageDto[];
    }>>;
    clearSideChat(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        ok: boolean;
    }>>;
    sendSideChat(request: {
        sessionId: string;
        text: string;
        harnessId?: string;
        model?: string | null;
    }): Promise<ServiceMethodResult<{
        messages: SideChatMessageDto[];
        reply: SideChatMessageDto;
    }>>;
    promoteSideChatToFork(request: {
        sessionId: string;
        title?: string;
        targetHarnessId?: string;
        createWorktree?: boolean;
    }): Promise<ServiceMethodResult<{
        session: SessionRecordDto;
        forkMode: string;
    }>>;
    exportSession(request: {
        sessionId: string;
        format: 'markdown' | 'json_bundle';
        redact?: boolean;
    }): Promise<ServiceMethodResult<{
        format: 'markdown' | 'json_bundle';
        filename: string;
        contentType: string;
        content: string | PublicPortableSessionBundleV2;
    }>>;
    importSessionBundle(request: {
        bundle: PublicPortableSessionBundleV2;
        workspaceId?: string;
        titleOverride?: string;
    }): Promise<ServiceMethodResult<{
        session: SessionRecordDto;
    }>>;
}
export interface OrchestratorPolicyDto {
    maxDepth: number;
    maxConcurrent: number;
    defaultTimeoutMs: number;
    worktreePolicy?: 'required_for_write' | 'optional' | 'always';
}
export interface SessionOrchestrationServiceV1 {
    getLimits(): Promise<ServiceMethodResult<OrchestratorPolicyDto>>;
    getBoard(request: {
        parentSessionId: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    listSubagents(request: {
        parentSessionId: string;
        cohortId?: string;
        status?: string;
    }): Promise<ServiceMethodResult<{
        subagents: Array<Record<string, unknown>>;
    }>>;
    getSubagentResult(request: {
        subagentId: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    delegateTask(request: {
        parentSessionId: string;
        targetInstanceId: string;
        roleTitle: string;
        prompt: string;
        isolation?: 'read_only' | 'worktree_write';
        cohortId?: string;
        requestedApprovalPolicy?: string;
        model?: string | null;
        timeoutMs?: number;
        failFast?: boolean;
        baseBranch?: string;
    }): Promise<ServiceMethodResult<{
        subagent: Record<string, unknown>;
    }>>;
    sendToSubagent(request: {
        subagentId: string;
        text: string;
    }): Promise<ServiceMethodResult<{
        subagent: Record<string, unknown>;
        turnId: string;
    }>>;
    stopSubagent(request: {
        subagentId: string;
        reason?: string;
        suppressWakeup?: boolean;
    }): Promise<ServiceMethodResult<{
        subagent: Record<string, unknown>;
    }>>;
    dryRunMergeSubagent(request: {
        subagentId: string;
        baseBranch?: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    mergeSubagent(request: {
        subagentId: string;
        baseBranch?: string;
        confirmMerge: boolean;
        cleanupWorktree?: boolean;
        deleteBranch?: boolean;
        commitMessage?: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    cleanupSubagentWorktree(request: {
        subagentId: string;
        deleteBranch?: boolean;
        force?: boolean;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    notifyChildTurnCompleted?(childSessionId: string): Promise<void>;
    notifyChildTurnCancelled?(childSessionId: string): Promise<void>;
    notifyChildTurnFailed?(childSessionId: string, message: string): Promise<void>;
    notifyParentSessionIdle?(parentSessionId: string): void;
    notifyChildApproval?(childSessionId: string, approvalId: string, toolName: string): void;
    recoverOrphanedRuns?(): Promise<ServiceMethodResult<{
        settledCount: number;
    }>>;
}

import type { ServiceMethodResult } from './context.js';
export declare const CHAT_VIEW_CONTRACT = "chat.view.v1";
export interface ChatViewState {
    text?: string;
    attachments?: Array<Record<string, unknown>>;
    terminalContexts?: Array<Record<string, unknown>>;
    scrollTop?: number;
    followBottom?: boolean;
    timeline?: {
        scrollTop: number;
        followBottom: boolean;
    };
    traitsByScope?: Record<string, Record<string, string | number | boolean>>;
    revision?: number;
}
export type ChatViewOperation = {
    type: 'setText';
    text: string;
} | {
    type: 'clear' | 'clearTerminalContexts';
} | {
    type: 'addAttachment';
    attachment: Record<string, unknown>;
} | {
    type: 'addTerminalContext';
    chip: Record<string, unknown>;
} | {
    type: 'removeAttachment' | 'removeTerminalContext';
    id: string;
};
/** View state is stored by the selected chat instance; reading never sends a turn. */
export interface ChatViewServiceV1 {
    readViewState(req: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        state: ChatViewState;
    }>>;
    writeViewState(req: {
        sessionId: string;
        patch: ChatViewState;
        sourceId?: string;
    }): Promise<ServiceMethodResult<{
        state: ChatViewState;
    }>>;
    editViewState(req: {
        sessionId: string;
        operation: ChatViewOperation;
        sourceId?: string;
    }): Promise<ServiceMethodResult<{
        state: ChatViewState;
    }>>;
}

import type { ServiceMethodResult } from './context.js';
export declare const AGY_RUNTIME_CONTRACT = "agy.runtime.v1";
export declare const AGY_RUNTIME_CONTRACT_VERSION = "1.0.0";
export declare const AGY_ACCOUNTS_CONTRACT = "agy.accounts.v1";
export declare const AGY_ACCOUNTS_CONTRACT_VERSION = "1.0.0";
export declare const AGY_WORKBENCH_CONTRACT = "agy.workbench.v1";
export declare const AGY_WORKBENCH_CONTRACT_VERSION = "1.0.0";
/**
 * Distinct identity tuple separating plugin package/instance/run generation from legacy AGY profile IDs
 * and native runtime bindings. Never conflate `pluginInstanceId` with legacy `profileInstanceId`.
 */
export interface AgyProviderIdentity {
    /** Plugin package ID (e.g. `core.harness.agy`, `hm.plugin.agy-driver-lite`). */
    pluginId: string;
    /** Installed/configured plugin instance ID (e.g. `harness-agy`, `harness-agy-work`). */
    pluginInstanceId: string;
    /** Driver provider plugin instance ID (equals `pluginInstanceId` for driver-owning instances). */
    driverProviderInstanceId: string;
    /** Plugin activation/process run generation ID. */
    runId: string;
    /** Legacy AGY profile ID (e.g. `agy`, `agy-work`), preserved for backward compatibility. */
    profileInstanceId: string;
    /** Logical harness ID stored on sessions (e.g. `agy`, `agy-work`, `hm.plugin.agy-driver-lite:agy`). */
    harnessId: string;
    /** Optional native CLI/ACP session ID bound to this provider. */
    nativeSessionId?: string | null;
    /** Optional native runtime binding ID. */
    runtimeId?: string | null;
    /** Optional native runtime binding generation token. */
    generation?: string | null;
}
/**
 * Authoritative stream identity for native runtime event feeds and cursors.
 * Cross-instance or cross-generation sequence numbers must never be compared as one linear stream.
 */
export interface AgyRuntimeStreamIdentity {
    providerInstanceId: string;
    runId: string;
    runtimeId: string;
    generation: string;
    sessionId: string;
    harnessId: string;
}
export interface AgyRuntimeCursor {
    stream: AgyRuntimeStreamIdentity;
    seq: number;
    cursor?: string | null;
}
export declare function agyRuntimeStreamKey(stream: AgyRuntimeStreamIdentity): string;
export declare function isSameAgyRuntimeStream(a: AgyRuntimeStreamIdentity | null | undefined, b: AgyRuntimeStreamIdentity | null | undefined): boolean;
/**
 * Compares two native runtime cursors. Returns `null` if they belong to different provider instances,
 * plugin runs, runtime bindings, or generations so callers always trigger resync instead of reusing seqs.
 */
export declare function compareAgyRuntimeCursors(a: AgyRuntimeCursor | null | undefined, b: AgyRuntimeCursor | null | undefined): -1 | 0 | 1 | null;
export interface AgyRuntimeFeatureFlagsDto {
    enabled: boolean;
    observatoryTap: boolean;
    nativeLifecycle: boolean;
    nativePermissions: boolean;
    nativeCommands: boolean;
    nativeWorkflowObservation: boolean;
    nativeTasksObservation: boolean;
    acpV2Preview: boolean;
}
export interface AgyRuntimeSchemaStatusDto {
    component: string;
    supportedVersion: number;
    storedVersion: number;
    compatible: boolean;
}
export interface AgyRuntimeBindingDto {
    runtimeId: string;
    sessionId: string;
    instanceId: string;
    generation: string;
    driverProviderInstanceId?: string;
    runtimeProviderInstanceId?: string;
    runtimeRunId?: string;
    bindingRevision?: number;
}
export type AgyTurnSettlementAction = 'hold' | 'settle' | 'ignore';
/**
 * Serializable turn settlement decision exchanged across runtime boundaries without passing
 * internal classes or in-process callback functions.
 */
export interface AgyTurnSettlementDecisionDto {
    action: AgyTurnSettlementAction;
    turnId: string;
    binding: AgyRuntimeBindingDto | null;
    reason?: string;
    /** Opaque serializable resource reference for acknowledging/settling a held turn once. */
    settlementRef?: string | null;
    providerInstanceId?: string;
    providerRunId?: string;
}
export interface AgyDispatchProvenanceDto {
    channel: 'human_direct' | 'manual_user_switch' | 'agy_native_internal' | 'hm_orchestrator_delegation' | 'hm_orchestrator_wakeup' | 'auto_failover' | 'plugin_automated';
    actor: 'desktop' | 'mobile' | 'system' | 'plugin';
    issuedAt: number;
    reason?: string;
    /** Opaque kernel-verified marker indicating the caller identity was verified by the host boundary. */
    verifiedByHost?: boolean;
}
export interface AgyProvenanceCheckResultDto {
    allowed: boolean;
    code?: 'CONSUMER_PROVENANCE_BLOCKED';
    reason?: string;
    policyMode: 'strict_consumer_oauth' | 'permissive' | 'custom';
    channel: string;
}
/**
 * W1 temporary narrow legacy approval bridge DTOs.
 * W1 owns native wire protocol, options, bindingRevision, and execution receipts;
 * W2 takes over unified request state, decision truth, timers, and policy evaluation.
 */
export interface AgyNativeRequestOptionDto {
    optionId: string;
    name: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | 'accept' | 'decline' | 'cancel' | string;
}
export interface AgyLegacyApprovalBridgeRequestDto {
    approvalId: string;
    nativeRequestId: string;
    sessionId: string;
    harnessId: string;
    driverProviderInstanceId: string;
    runtimeProviderInstanceId: string;
    runtimeRunId: string;
    binding: AgyRuntimeBindingDto;
    bindingRevision: number;
    kind: 'command_approval' | 'file_approval' | 'user_question' | 'elicitation' | 'secret_request' | string;
    toolName: string;
    summary: string;
    options: AgyNativeRequestOptionDto[];
    deadlineAtMs: number;
    createdAtMs: number;
    receiptState: 'pending' | 'dispatching' | 'delivered' | 'expired' | 'cancelled' | 'failed' | 'unknown';
    settlementRef?: string | null;
}
export interface AgyLegacyApprovalBridgeResolveInputDto {
    approvalId: string;
    sessionId: string;
    decision?: 'allow' | 'deny' | 'allow_session' | 'cancel';
    selectedOptionId?: string | null;
    answers?: Record<string, unknown>;
    resolvedBy: 'desktop' | 'mobile' | 'policy' | 'timeout' | 'system';
    idempotencyKey: string;
    expectedBindingRevision?: number;
    expectedGeneration?: string;
}
export interface AgyLegacyApprovalBridgeResolveResultDto {
    approvalId: string;
    accepted: boolean;
    conflict?: boolean;
    staleGeneration?: boolean;
    receiptState: 'delivered' | 'cancelled' | 'expired' | 'failed' | 'unknown' | 'already_settled';
    bindingRevision: number;
    generation: string;
    deliveredAtMs?: number | null;
    settlementRef?: string | null;
    note?: string;
}
export interface AgyLegacyApprovalBridgeInfoDto {
    mode: 'w1_temporary_narrow_adapter' | 'unified_requests';
    owner: 'agy.runtime.v1';
    handoffTarget: 'runtime.requests.v1';
    supportsCasResolution: boolean;
    supportsNativeOptions: boolean;
    supportsDeadlines: boolean;
}
export interface AgyRuntimeProviderInfoDto {
    pluginId: string;
    instanceId: string;
    driverProviderInstanceId: string;
    runId: string;
    acceptingCommands: boolean;
    featureFlags: AgyRuntimeFeatureFlagsDto;
    schemaStatus: AgyRuntimeSchemaStatusDto;
    provenancePolicy: 'strict_consumer_oauth' | 'permissive' | 'custom';
    legacyApprovalBridge: AgyLegacyApprovalBridgeInfoDto;
}
export interface AgyPrepareBindingRequest {
    sessionId: string;
    harnessId: string;
    nativeSessionId?: string | null;
    sourceRef: string;
    driverProviderInstanceId?: string;
}
export interface AgyPrepareBindingResponse {
    binding: AgyRuntimeBindingDto;
    /** Serializable reference identifying the prepared runtime hooks/attachment inside the owning plugin. */
    bindingRef: string;
    stream: AgyRuntimeStreamIdentity;
}
/**
 * Public peer service contract (`agy.runtime.v1`) owned by AGY runtime plugins (default or external).
 */
export interface AgyRuntimeServiceV1 {
    getProviderInfo(): Promise<ServiceMethodResult<AgyRuntimeProviderInfoDto>>;
    getSnapshot(request: {
        sessionId: string;
        harnessId?: string;
    }): Promise<ServiceMethodResult<{
        snapshot: Record<string, unknown>;
        provider: AgyProviderIdentity;
        stream: AgyRuntimeStreamIdentity | null;
    }>>;
    getCapabilities(request: {
        sessionId: string;
        harnessId?: string;
    }): Promise<ServiceMethodResult<{
        capabilities: Record<string, unknown>;
        provider: AgyProviderIdentity;
    }>>;
    readEvents(request: {
        sessionId: string;
        harnessId?: string;
        afterSeq?: number;
        limit?: number;
        cursor?: string;
        generation?: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    readTimeline(request: {
        sessionId: string;
        scopeKind: 'activity' | 'agent';
        scopeId: string;
        pageToken?: string;
        limit?: number;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    readWorkflowResource(request: {
        sessionId: string;
        workflowId: string;
        resource: 'board' | 'phases' | 'logs' | 'artifacts' | string;
        pageToken?: string;
        limit?: number;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    submitCommand(request: {
        sessionId: string;
        body: Record<string, unknown>;
        provenance?: AgyDispatchProvenanceDto;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    dispatchControl(request: {
        sessionId: string;
        body: Record<string, unknown>;
        provenance?: AgyDispatchProvenanceDto;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    getRequestDetails(request: {
        sessionId: string;
        requestId: string;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    resolveNativeRequest(request: {
        sessionId: string;
        requestId: string;
        body: Record<string, unknown>;
    }): Promise<ServiceMethodResult<Record<string, unknown>>>;
    listSubagents?(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        subagents: Array<Record<string, unknown>>;
    }>>;
    readSubagentDetail?(request: {
        sessionId: string;
        subagentId: string;
    }): Promise<ServiceMethodResult<{
        subagent: Record<string, unknown> | null;
    }>>;
    listArtifacts?(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        artifacts: Array<Record<string, unknown>>;
    }>>;
    readArtifact?(request: {
        sessionId: string;
        name: string;
    }): Promise<ServiceMethodResult<{
        artifact: Record<string, unknown> | null;
    }>>;
    getEcosystem?(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        ecosystem: Record<string, unknown>;
    }>>;
    prepareSessionBinding(request: AgyPrepareBindingRequest): Promise<ServiceMethodResult<AgyPrepareBindingResponse>>;
    notifyReconnect(request: {
        binding: AgyRuntimeBindingDto;
        mode: 'resume' | 'fresh';
    }): Promise<ServiceMethodResult<{
        ok: true;
    }>>;
    notifyCancelRequested(request: {
        binding: AgyRuntimeBindingDto;
        target?: {
            type: 'runtime' | 'activity' | 'work' | 'agent' | 'workflow';
            id: string;
        };
    }): Promise<ServiceMethodResult<{
        ok: true;
    }>>;
    decideTurnSettlement(request: {
        turnId: string;
        binding: AgyRuntimeBindingDto | null;
    }): Promise<ServiceMethodResult<AgyTurnSettlementDecisionDto>>;
    getActiveBinding(request: {
        sessionId: string;
        harnessId?: string;
    }): Promise<ServiceMethodResult<{
        binding: AgyRuntimeBindingDto | null;
    }>>;
    acknowledgeSettlement?(request: {
        settlementRef: string;
        turnId: string;
        outcome: 'settled' | 'cancelled' | 'failed';
    }): Promise<ServiceMethodResult<{
        acknowledged: boolean;
    }>>;
    verifyDispatchProvenance?(request: {
        harnessId: string;
        driverId: string;
        provenance?: AgyDispatchProvenanceDto | null;
    }): Promise<ServiceMethodResult<AgyProvenanceCheckResultDto>>;
}
/**
 * Public auth status DTO. Credentials/tokens/secrets are NEVER returned as plain DTO fields.
 */
export interface AgyAccountAuthStateDto {
    instanceId: string;
    profileInstanceId?: string;
    pluginInstanceId?: string;
    phase: 'idle' | 'starting' | 'awaiting_code' | 'completing' | 'authenticated' | 'error' | 'cancelled' | string;
    flowId?: string | null;
    authUrl?: string | null;
    message?: string | null;
    error?: string | null;
    updatedAt: number;
}
export interface AgyAccountProfileSummaryDto {
    /** Legacy AGY profile ID (e.g. `agy`, `agy-work`). */
    instanceId: string;
    displayName: string;
    description?: string;
    isolationMode: 'official_default' | 'profile_isolated' | string;
    authMethod: string;
    geminiDir?: string;
    appDataDirName?: string;
    binaryPath?: string;
    gcpProject?: string;
    gcpLocation?: string;
    enabled: boolean;
    identity?: Record<string, unknown> | null;
    defaults?: Record<string, unknown>;
}
export interface AgyAccountInstanceDto {
    /** Explicit plugin & profile identity mapping. */
    identity: AgyProviderIdentity;
    profile: AgyAccountProfileSummaryDto;
    authState: AgyAccountAuthStateDto;
    configRevision: number;
}
export interface AgyAccountsServiceV1 {
    getProviderInfo(): Promise<ServiceMethodResult<{
        pluginId: string;
        instanceId: string;
        runId: string;
        configRevision: number;
        provenancePolicy: 'strict_consumer_oauth' | 'permissive' | 'custom';
        managedHarnessIds: string[];
    }>>;
    listInstances(): Promise<ServiceMethodResult<{
        instances: AgyAccountInstanceDto[];
        configRevision: number;
    }>>;
    upsertInstance(request: {
        profile: Record<string, unknown>;
    }): Promise<ServiceMethodResult<{
        profile: AgyAccountProfileSummaryDto;
        authState: AgyAccountAuthStateDto;
        identity: AgyProviderIdentity;
        configRevision: number;
    }>>;
    deleteInstance(request: {
        profileInstanceId: string;
        purgeData?: boolean;
    }): Promise<ServiceMethodResult<{
        deleted: boolean;
        instanceId: string;
        configRevision: number;
    }>>;
    getAuthState(request: {
        profileInstanceId: string;
    }): Promise<ServiceMethodResult<{
        state: AgyAccountAuthStateDto;
    }>>;
    startLogin(request: {
        profileInstanceId: string;
    }): Promise<ServiceMethodResult<{
        state: AgyAccountAuthStateDto;
    }>>;
    respondLogin(request: {
        profileInstanceId: string;
        flowId: string;
        codeOrUrl: string;
    }): Promise<ServiceMethodResult<{
        state: AgyAccountAuthStateDto;
    }>>;
    cancelLogin(request: {
        profileInstanceId: string;
        flowId?: string;
    }): Promise<ServiceMethodResult<{
        state: AgyAccountAuthStateDto;
    }>>;
    logout(request: {
        profileInstanceId: string;
        confirmSharedKeyring?: boolean;
    }): Promise<ServiceMethodResult<{
        state: AgyAccountAuthStateDto;
    }>>;
}
export type AgyWorkbenchSurfaceId = 'chat' | 'runtime' | 'subagents' | 'swarm' | 'boost' | 'teamwork' | 'dynamic' | 'tasks';
export type AgyWorkbenchLayoutMode = 'split' | 'full';
export interface AgyWorkbenchViewStateDto {
    surface: AgyWorkbenchSurfaceId;
    layout: AgyWorkbenchLayoutMode;
    selectedActivityId?: string | null;
    selectedWorkId?: string | null;
    selectedAgentId?: string | null;
    selectedWorkflowId?: string | null;
    revision?: number;
}
export interface AgyWorkbenchEmbeddedRegionDto {
    region: 'session.stage.embedded' | 'composer.actions' | 'inspector.tabs' | 'chat.block' | 'harness.settings' | 'session.sidebar.badge' | 'workspace.pages';
    slotId: string;
    title: string;
    ui: string;
}
export interface AgyWorkbenchServiceV1 {
    getProviderInfo(): Promise<ServiceMethodResult<{
        pluginId: string;
        instanceId: string;
        runId: string;
        surfaces: AgyWorkbenchSurfaceId[];
        embeddedRegions: AgyWorkbenchEmbeddedRegionDto[];
    }>>;
    readWorkbenchState(request: {
        sessionId: string;
    }): Promise<ServiceMethodResult<{
        state: AgyWorkbenchViewStateDto;
    }>>;
    writeWorkbenchState(request: {
        sessionId: string;
        patch: Partial<AgyWorkbenchViewStateDto>;
        sourceId?: string;
    }): Promise<ServiceMethodResult<{
        state: AgyWorkbenchViewStateDto;
    }>>;
}

import type { ServiceMethodResult } from './context.js';
export declare const RUNTIME_REQUESTS_CONTRACT = "runtime.requests.v1";
export declare const REQUEST_VIEW_CONTRACT = "runtime.requests.view.v1";
export declare const REQUEST_DELIVERY_CONTRACT = "runtime.request-delivery.v1";
export type RequestMode = 'manual' | 'accept_edits' | 'auto' | 'plan';
export type RequestDelivery = 'not_required' | 'pending' | 'sending' | 'acknowledged' | 'unknown' | 'unavailable';
export interface RequestOriginDto {
    providerInstanceId: string;
    driverGeneration: string;
    connectionId?: string;
    runtimeId?: string;
    nativeRequestId: string | number;
    turnId: string | null;
}
export interface RuntimeRequestDto {
    requestId: string;
    sessionId: string;
    workspaceId: string;
    origin: RequestOriginDto;
    version: number;
    idempotencyKey: string;
    deadlineAtMs: number;
    status: string;
    delivery: RequestDelivery;
    closed: boolean;
    presentation?: Record<string, unknown>;
    /** Legacy ApprovalRequest fields; secret plaintext is forbidden here. */
    approval: Record<string, unknown>;
    policyInstanceId?: string;
    policyRevision?: string;
    /** Exact driver option/scope. Legacy approval.decision cannot express persistent/unknown native scope. */
    decisionReceipt?: {
        actor: RequestResolveDto['actor'];
        decision?: RequestResolveDto['decision'];
        nativeOutcome?: string;
        optionId?: string;
        scope?: 'once' | 'session' | 'persistent' | 'unknown';
    };
    execution?: {
        state: 'succeeded' | 'failed';
        finishedAtMs: number;
    };
}
export interface RequestCreateDto {
    approval: Record<string, unknown>;
    presentation?: Record<string, unknown>;
    workspaceId: string;
    origin: RequestOriginDto;
    deadlineAtMs: number;
    idempotencyKey: string;
    /** Revocable, serializable origin resource. No function or credential crosses the service boundary. */
    deliveryResource?: {
        instanceId: string;
        runId: string;
        resourceId: string;
    };
}
export interface RequestDeliveryServiceV1 {
    validate(input: {
        resourceId: string;
        response: RequestResolveDto;
    }): Promise<ServiceMethodResult<{
        valid: boolean;
    }>>;
    deliver(input: {
        resourceId: string;
        response: RequestResolveDto;
    }): Promise<ServiceMethodResult<{
        delivery: RequestDelivery;
    }>>;
    release?(input: {
        resourceId: string;
    }): Promise<ServiceMethodResult<{
        released: boolean;
    }>>;
}
export interface RequestResolveDto {
    requestId: string;
    expectedVersion?: number;
    idempotencyKey?: string;
    actor: 'desktop' | 'mobile' | 'auto';
    decision?: 'allow_once' | 'allow_session' | 'deny';
    comment?: string;
    questionAnswer?: {
        selectedOptionIds?: string[];
        freeText?: string;
    };
    /** Transient transport only: never persisted, published or echoed. */
    secretValue?: string;
    native?: Record<string, unknown>;
}
export interface RequestPolicyInputDto {
    requestId?: string;
    sessionId: string;
    workspaceId: string;
    mode: RequestMode;
    kind: string;
    toolName: string;
    toolKind: string;
    readOnly: boolean;
    riskLevel?: string;
    supportedDecisions: string[];
    source: 'cli' | 'native' | 'model_tool';
    args?: Record<string, unknown>;
}
export interface RequestPolicyDecisionDto {
    decision: 'allow' | 'deny' | 'ask';
    scope?: 'once' | 'session';
    reason?: string;
}
/** evaluateToolCall remains compatible with v1 consumers. */
export interface ApprovalPolicyServiceV1 {
    evaluateToolCall(input: Record<string, unknown>): Promise<RequestPolicyDecisionDto> | RequestPolicyDecisionDto;
    evaluateRequest?(input: RequestPolicyInputDto): Promise<RequestPolicyDecisionDto> | RequestPolicyDecisionDto;
}
export interface RequestModeReceiptDto {
    sessionId: string;
    requested: RequestMode;
    policyInstanceId: string | null;
    policyRevision: string | null;
    status: 'applied' | 'pending_next_session' | 'unsupported' | 'rejected' | 'policy_handled';
    driverRequested?: Record<string, unknown>;
    driverAccepted?: Record<string, unknown>;
    execution: 'driver' | 'per_request_policy' | 'none';
    note?: string;
}
export interface RuntimeRequestsServiceV1 {
    create(input: RequestCreateDto): Promise<ServiceMethodResult<RuntimeRequestDto>>;
    snapshot(input: {
        sessionId?: string;
        includeHistory?: boolean;
    }): Promise<ServiceMethodResult<{
        requests: RuntimeRequestDto[];
        version: number;
    }>>;
    resolve(input: RequestResolveDto): Promise<ServiceMethodResult<{
        accepted: boolean;
        conflict: boolean;
        request: RuntimeRequestDto;
    }>>;
    cancel(input: {
        sessionId?: string;
        reason: string;
    }): Promise<ServiceMethodResult<{
        cancelled: number;
    }>>;
    close(input: {
        requestId: string;
    }): Promise<ServiceMethodResult<{
        closed: boolean;
    }>>;
    evaluate(input: RequestPolicyInputDto): Promise<ServiceMethodResult<RequestPolicyDecisionDto & {
        policyInstanceId: string;
        policyRevision: string;
    }>>;
    recordMode(input: RequestModeReceiptDto): Promise<ServiceMethodResult<RequestModeReceiptDto>>;
    /** Optional configuration UI of the default request provider; not a policy restriction. */
    listRules?(): Promise<ServiceMethodResult<{
        rules: unknown[];
    }>>;
    addRule?(input: Record<string, unknown>): Promise<ServiceMethodResult<{
        rules: unknown[];
    }>>;
    deleteRule?(input: {
        id: string;
    }): Promise<ServiceMethodResult<{
        rules: unknown[];
    }>>;
    getMode(input: {
        sessionId: string;
    }): Promise<ServiceMethodResult<RequestModeReceiptDto | null>>;
}
```
