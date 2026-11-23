# 插件 API 报告

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

清单与声明式贡献点见同目录 JSON Schema。公共错误码见类型声明。

```ts
import type { ApprovalAnnotateEvent, HandoffComposeEvent, HandoffComposeSection, HandoffOfferDecision, HandoffShouldOfferEvent, PluginEventName, PluginEventV4 } from './events.js';
import type { PLUGIN_API_VERSION } from './manifest.js';
import type { PublicSlotRegistration } from './slots.js';
export declare const pluginErrorCodes: readonly ["E_PERMISSION_DENIED", "E_SERVICE_UNAVAILABLE", "E_NOT_SUPPORTED", "E_TIMEOUT", "E_INVALID_INPUT", "E_LIMIT_EXCEEDED", "E_CONFLICT", "E_STALE_RUN"];
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
export type Context = IsolatedPluginContext;
export interface PluginModule {
    readonly name?: string;
    readonly inject?: readonly string[];
    readonly optional?: readonly string[];
    readonly provides?: readonly string[];
    readonly requires?: readonly string[];
    apply(ctx: IsolatedPluginContext, config: Readonly<Record<string, unknown>>): void | Promise<void>;
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
};

import type { PluginErrorCode } from './context.js';
import type { PluginRuntimeSlotDescriptor } from './slots.js';
export declare const PLUGIN_RPC_PROTOCOL_VERSION = 1;
export declare const HOST_SUPPORTED_FEATURES: readonly ["rpc.v1", "isolation.process", "services.third-party", "permissions.v4", "handoff.compose", "handoff.shouldOffer", "approvals.annotate", "tools.model", "commands.v4", "storage.kv", "fs.workspace", "net.fetch", "ui.slots"];
export interface PluginHandshakeRequest {
    protocolVersion: number;
    pluginApi: string;
    features: readonly string[];
    pluginId: string;
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
export declare function normalizePluginSlotKey(key: string): PluginSlotKey;
export declare function isValidPluginSlotKey(key: string): key is PluginSlotKey;
export declare function isSafePluginUiPath(value: string): boolean;
export declare const PluginSlotKeyInputSchema: z.ZodEnum<["session.header.title", "sidebar.tools", "composer.actions", "inspector.tabs", "inspector.tab", "statusbar.items", "chat.node", "tool.result", "approval.detail", "chat.message.wrapper"]>;
export declare const PluginSlotContributionSchema: z.ZodObject<{
    slot: z.ZodEnum<["session.header.title", "sidebar.tools", "composer.actions", "inspector.tabs", "inspector.tab", "statusbar.items", "chat.node", "tool.result", "approval.detail", "chat.message.wrapper"]>;
    id: z.ZodString;
    title: z.ZodString;
    ui: z.ZodEffects<z.ZodString, string, string>;
    order: z.ZodOptional<z.ZodNumber>;
    key: z.ZodOptional<z.ZodString>;
    height: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    id: string;
    title: string;
    slot: "session.header.title" | "sidebar.tools" | "composer.actions" | "inspector.tabs" | "statusbar.items" | "chat.node" | "tool.result" | "approval.detail" | "chat.message.wrapper" | "inspector.tab";
    ui: string;
    key?: string | undefined;
    order?: number | undefined;
    height?: number | undefined;
}, {
    id: string;
    title: string;
    slot: "session.header.title" | "sidebar.tools" | "composer.actions" | "inspector.tabs" | "statusbar.items" | "chat.node" | "tool.result" | "approval.detail" | "chat.message.wrapper" | "inspector.tab";
    ui: string;
    key?: string | undefined;
    order?: number | undefined;
    height?: number | undefined;
}>;
export type PluginSlotContribution = z.infer<typeof PluginSlotContributionSchema>;
export interface PluginRuntimeSlotDescriptor {
    slot: PluginSlotKey;
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
    slot: PluginSlotKey;
    slotItemId: string;
    message: string;
    timestamp: number;
}
export type PluginSlotBridgeHostMessage = {
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
    slot: PluginSlotKey;
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
```
