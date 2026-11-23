# 插件 API 报告

由 `pnpm contracts:generate` 生成。插件 API 4.0.0。

清单与声明式贡献点见同目录 JSON Schema。公共错误码见类型声明。

```ts
import type { PluginEventName, PluginEventV4 } from './events.js';
import type { PLUGIN_API_VERSION } from './manifest.js';
export declare const pluginErrorCodes: readonly ["E_PERMISSION_DENIED", "E_SERVICE_UNAVAILABLE", "E_NOT_SUPPORTED", "E_TIMEOUT", "E_INVALID_INPUT", "E_LIMIT_EXCEEDED", "E_CONFLICT", "E_STALE_RUN"];
export type PluginErrorCode = typeof pluginErrorCodes[number];
export declare class PluginApiError extends Error {
    readonly code: PluginErrorCode;
    constructor(code: PluginErrorCode, message: string);
}
export type Disposer = () => void;
export interface PluginContext {
    readonly api: {
        readonly version: typeof PLUGIN_API_VERSION;
        has(feature: string): boolean;
    };
    get<Service = unknown>(name: string): Service | undefined;
    on<Name extends PluginEventName>(name: Name, listener: (event: PluginEventV4<Name>) => void | Promise<void>): Disposer;
    effect(activate: () => Disposer): Disposer;
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
```
