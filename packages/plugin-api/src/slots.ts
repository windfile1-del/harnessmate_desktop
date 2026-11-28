import { z } from 'zod';
import type { PublicSession } from './context.js';

export type SlotCardinality = 'single' | 'list' | 'keyed' | 'chain' | 'hoc';
export type SlotScope = 'root' | 'session' | 'session-maybe';

export interface PluginSlotContract {
  readonly cardinality: SlotCardinality;
  readonly scope: SlotScope;
  readonly description: string;
}

export const PLUGIN_UI_SLOTS = {
  'session.header.title': {
    cardinality: 'single',
    scope: 'session',
    description: '会话顶栏标题区域（按 order 最小者优先）',
  },
  'sidebar.tools': {
    cardinality: 'list',
    scope: 'session-maybe',
    description: '左侧栏快捷工具区',
  },
  'composer.actions': {
    cardinality: 'list',
    scope: 'session',
    description: '输入区操作栏',
  },
  'inspector.tabs': {
    cardinality: 'list',
    scope: 'session',
    description: '右侧检视抽屉标签页与面板',
  },
  'statusbar.items': {
    cardinality: 'list',
    scope: 'session-maybe',
    description: '状态栏扩展项',
  },
  'chat.node': {
    cardinality: 'keyed',
    scope: 'session',
    description: '按事件或节点类型渲染自定义聊天节点',
  },
  'tool.result': {
    cardinality: 'keyed',
    scope: 'session',
    description: '按工具名渲染自定义工具结果视图',
  },
  'approval.detail': {
    cardinality: 'chain',
    scope: 'session',
    description: '按审批类型链式选择审批详情渲染器',
  },
  'chat.message.wrapper': {
    cardinality: 'hoc',
    scope: 'session',
    description: '包裹聊天消息内容的容器组件',
  },
} as const satisfies Record<string, PluginSlotContract>;

export type PluginSlotKey = keyof typeof PLUGIN_UI_SLOTS;

export const PLUGIN_SLOT_KEYS = [
  'session.header.title',
  'sidebar.tools',
  'composer.actions',
  'inspector.tabs',
  'statusbar.items',
  'chat.node',
  'tool.result',
  'approval.detail',
  'chat.message.wrapper',
] as const satisfies readonly PluginSlotKey[];

export const PLUGIN_UI_SLOTS_V5 = {
  'chat.block': {
    cardinality: 'keyed',
    scope: 'session',
    description: '按块类型渲染专有消息块（ext:<vendor>.*）或扩展标准块',
  },
  'composer.traits': {
    cardinality: 'list',
    scope: 'session',
    description: '输入栏动态参数与工作流 Trait 快捷控件',
  },
  'harness.settings': {
    cardinality: 'keyed',
    scope: 'root',
    description: '按 driverId 渲染 Harness 插件自定义认证与高级设置面板',
  },
  'inspector.diff': {
    cardinality: 'single',
    scope: 'session',
    description: '接管或增强右侧 Diff 与检查点视图',
  },
  'session.sidebar.badge': {
    cardinality: 'list',
    scope: 'session-maybe',
    description: '侧栏会话行轻量状态徽标',
  },
} as const satisfies Record<string, PluginSlotContract>;

export type PluginSlotKeyV5 = keyof typeof PLUGIN_UI_SLOTS_V5;
const workspaceSlots = {
  'workspace.pages': {
    cardinality: 'list',
    scope: 'root',
    description: '在侧栏提供入口并在主工作区打开独立插件页面',
  },
  'workspace.start': {
    cardinality: 'single',
    scope: 'root',
    description: '组合中提供的应用启动页与主工作区布局',
  },
  'inspector.files': {
    cardinality: 'single',
    scope: 'session',
    description: '接管或增强右侧工作区文件浏览与行号预览视图',
  },
  'inspector.rules': {
    cardinality: 'single',
    scope: 'session',
    description: '接管或增强右侧项目规则与 Skills 视图',
  },
  'session.stage.embedded': {
    cardinality: 'single',
    scope: 'session',
    description: '会话主舞台内嵌工作台区域（支持分屏与全屏切换，默认与外部插件共享挂载路径）',
  },
} as const satisfies Record<string, PluginSlotContract>;

export type AnyPluginSlotKey = PluginSlotKey | PluginSlotKeyV5 | keyof typeof workspaceSlots;

export const PLUGIN_SLOT_KEYS_V5 = [
  'chat.block',
  'composer.traits',
  'harness.settings',
  'inspector.diff',
  'session.sidebar.badge',
] as const satisfies readonly PluginSlotKeyV5[];

export const ALL_PLUGIN_UI_SLOTS = {
  ...PLUGIN_UI_SLOTS,
  ...PLUGIN_UI_SLOTS_V5,
  ...workspaceSlots,
} as const satisfies Record<AnyPluginSlotKey, PluginSlotContract>;

export const ALL_PLUGIN_SLOT_KEYS = [
  ...PLUGIN_SLOT_KEYS,
  ...PLUGIN_SLOT_KEYS_V5,
  'workspace.pages',
  'workspace.start',
  'inspector.files',
  'inspector.rules',
  'session.stage.embedded',
] as const satisfies readonly AnyPluginSlotKey[];

const SLOT_ALIASES: Readonly<Record<string, AnyPluginSlotKey>> = {
  'inspector.tab': 'inspector.tabs',
};

const allValidSlotSet = new Set<string>(ALL_PLUGIN_SLOT_KEYS);

export function normalizePluginSlotKey(key: string): PluginSlotKey {
  const mapped = SLOT_ALIASES[key] ?? key;
  return mapped as PluginSlotKey;
}

export function normalizeAnyPluginSlotKey(key: string): AnyPluginSlotKey {
  const mapped = SLOT_ALIASES[key] ?? key;
  return mapped as AnyPluginSlotKey;
}

export function isValidPluginSlotKey(key: string): key is AnyPluginSlotKey {
  return allValidSlotSet.has(normalizeAnyPluginSlotKey(key));
}

export function isSafePluginUiPath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) return false;
  const normalized = value.replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return false;
  return /\.(?:html|htm)$/i.test(normalized);
}

export function isSafePluginModulePath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) return false;
  const normalized = value.replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return false;
  return /\.(?:mjs|js)$/i.test(normalized);
}

export const PluginSlotMountModeSchema = z.enum(['iframe', 'trusted-module']);
export type PluginSlotMountMode = z.infer<typeof PluginSlotMountModeSchema>;

export const PluginSlotWhenSchema = z.object({
  harnessKinds: z.array(z.string().trim().min(1).max(40)).min(1).max(16).optional(),
}).strict();
export type PluginSlotWhen = z.infer<typeof PluginSlotWhenSchema>;

export const PluginSlotKeyInputSchema = z.enum([
  'workspace.pages',
  'workspace.start',
  'session.header.title',
  'sidebar.tools',
  'composer.actions',
  'inspector.tabs',
  'inspector.tab',
  'statusbar.items',
  'chat.node',
  'tool.result',
  'approval.detail',
  'chat.message.wrapper',
  'chat.block',
  'composer.traits',
  'harness.settings',
  'inspector.diff',
  'inspector.files',
  'inspector.rules',
  'session.stage.embedded',
  'session.sidebar.badge',
]);

export const PluginSlotContributionSchema = z.object({
  slot: PluginSlotKeyInputSchema,
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  title: z.string().trim().min(1).max(64),
  ui: z.string().trim().min(1).max(240).refine(isSafePluginUiPath, 'UI 入口必须为包内相对 .html/.htm 路径'),
  module: z.string().trim().min(1).max(240).refine(isSafePluginModulePath, '可信模块入口必须为包内相对 .mjs/.js 路径').optional(),
  mountMode: PluginSlotMountModeSchema.optional(),
  when: PluginSlotWhenSchema.optional(),
  order: z.number().int().min(-1000).max(1000).optional(),
  key: z.string().trim().min(1).max(80).optional(),
  height: z.number().int().min(48).max(1200).optional(),
}).strict();
export type PluginSlotContribution = z.infer<typeof PluginSlotContributionSchema>;

export interface PluginRuntimeSlotDescriptor {
  slot: AnyPluginSlotKey;
  id: string;
  title: string;
  ui: string;
  module?: string;
  mountMode?: PluginSlotMountMode;
  when?: PluginSlotWhen;
  order?: number;
  key?: string;
  height?: number;
}

export interface PublicSlotRegistration extends PluginRuntimeSlotDescriptor {
  onMessage?: (
    payload: unknown,
    meta: { sessionId: string | null; slotId: string },
  ) => Promise<unknown> | unknown;
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

export type PluginSlotBridgeHostMessage =
  | { type: 'hm:service:batch'; runId: string; subscriptionId: string; batch: PluginUiServiceBatch }
  | { type: 'hm:browser:frame'; runId: string; frame: PluginBrowserFrame }
  | { type: 'hm:browser:status'; runId: string; status: PluginBrowserStatus }
  | {
      type: 'hm:init';
      pluginId: string;
      runId: string;
      slotId: string;
      slot: AnyPluginSlotKey;
      theme: 'dark' | 'light';
      cssVars: Record<string, string>;
      session: PublicSession | null;
      props: Record<string, unknown>;
    }
  | {
      type: 'hm:theme';
      theme: 'dark' | 'light';
      cssVars: Record<string, string>;
    }
  | {
      type: 'hm:context';
      session: PublicSession | null;
      props: Record<string, unknown>;
    }
  | {
      type: 'hm:rpc:response';
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: { code: string; message: string };
    };

export type PluginSlotBridgeIframeMessage =
  | { type: 'hm:rpc:cancel'; requestId: string; runId: string }
  | { type: 'hm:ready'; slotId: string }
  | { type: 'hm:resize'; slotId: string; height: number }
  | {
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
  events: Array<{ seq: number; emittedAt: number; payload: Record<string, unknown> }>;
}
export interface PluginUiCancellationSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
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
  call<T>(contract: string, method: string, args: unknown[], options?: PluginUiServiceOptions): Promise<{ resolution: unknown; value: T }>;
  subscribe(options: PluginUiServiceOptions & { contract: string; instanceId: string }, listener: (batch: PluginUiServiceBatch) => void): Promise<() => void>;
}
