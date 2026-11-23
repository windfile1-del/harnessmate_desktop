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

const SLOT_ALIASES: Readonly<Record<string, PluginSlotKey>> = {
  'inspector.tab': 'inspector.tabs',
};

const validSlotSet = new Set<string>(PLUGIN_SLOT_KEYS);

export function normalizePluginSlotKey(key: string): PluginSlotKey {
  const mapped = SLOT_ALIASES[key] ?? key;
  return mapped as PluginSlotKey;
}

export function isValidPluginSlotKey(key: string): key is PluginSlotKey {
  return validSlotSet.has(normalizePluginSlotKey(key));
}

export function isSafePluginUiPath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) return false;
  const normalized = value.replace(/^\.\//, '');
  const segments = normalized.split('/');
  if (segments.some((seg) => !seg || seg === '.' || seg === '..')) return false;
  return /\.(?:html|htm)$/i.test(normalized);
}

export const PluginSlotKeyInputSchema = z.enum([
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
]);

export const PluginSlotContributionSchema = z.object({
  slot: PluginSlotKeyInputSchema,
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  title: z.string().trim().min(1).max(64),
  ui: z.string().trim().min(1).max(240).refine(isSafePluginUiPath, 'UI 入口必须为包内相对 .html/.htm 路径'),
  order: z.number().int().min(-1000).max(1000).optional(),
  key: z.string().trim().min(1).max(80).optional(),
  height: z.number().int().min(48).max(1200).optional(),
}).strict();
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
  onMessage?: (
    payload: unknown,
    meta: { sessionId: string | null; slotId: string },
  ) => Promise<unknown> | unknown;
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

export type PluginSlotBridgeHostMessage =
  | {
      type: 'hm:init';
      pluginId: string;
      runId: string;
      slotId: string;
      slot: PluginSlotKey;
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
  | { type: 'hm:ready'; slotId: string }
  | { type: 'hm:resize'; slotId: string; height: number }
  | {
      type: 'hm:rpc:request';
      requestId: string;
      runId: string;
      method: string;
      params?: Record<string, unknown>;
    };
