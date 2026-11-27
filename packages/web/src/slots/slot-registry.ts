import type { ReactNode } from 'react';
import {
  ALL_PLUGIN_UI_SLOTS,
  normalizeAnyPluginSlotKey,
  type AnyPluginSlotKey,
  type ApprovalRequest,
  type Disposer,
  type GitStatusSummary,
  type HarnessInfo,
  type PluginSlotRenderFailure,
  type Session,
  type TurnOptionValue,
} from '@harnessmate/protocol';
import type { FileLink } from '../lib/file-links';
import type { ProjectedToolCall, ProjectedTurn } from '../lib/projector';
import type { TurnBlock } from '../lib/work-groups';

export interface SlotPropsMap {
  'workspace.start': {
    session: Session | null;
  };
  'workspace.pages': Record<string, never>;
  // V4 slots (100% backward compatible)
  'session.header.title': {
    session: Session;
    onRename: () => void;
  };
  'sidebar.tools': {
    session: Session | null;
  };
  'composer.actions': {
    session: Session;
    isRunning: boolean;
  };
  'inspector.tabs': {
    session: Session;
  };
  'statusbar.items': {
    session: Session | null;
  };
  'chat.node': {
    session: Session;
    turn?: ProjectedTurn;
    eventType: string;
    payload?: Record<string, unknown>;
  };
  'tool.result': {
    session: Session;
    tool: ProjectedToolCall;
  };
  'approval.detail': {
    session: Session;
    approval: ApprovalRequest;
  };
  'chat.message.wrapper': {
    session: Session;
    turn: ProjectedTurn;
    children: ReactNode;
  };
  // V5 slots
  'chat.block': {
    session: Session;
    turn?: ProjectedTurn;
    block: TurnBlock;
    onOpenFile?: (file: FileLink) => void;
    onFailover?: (targetHarnessId: string) => void;
  };
  'composer.traits': {
    session: Session;
    harness: HarnessInfo | null;
    disabled: boolean;
    values: Record<string, TurnOptionValue>;
    onChange: (key: string, value: TurnOptionValue | null) => void;
  };
  'harness.settings': {
    harness: HarnessInfo;
    onRefresh: () => void;
  };
  'inspector.diff': {
    session: Session;
    git: GitStatusSummary | null;
    onRefresh: () => void;
  };
  'inspector.files': {
    session: Session;
  };
  'inspector.rules': {
    session: Session;
  };
  'session.stage.embedded': {
    session: Session;
    layout?: 'split' | 'full';
    surface?: string;
  };
  'session.sidebar.badge': {
    session: Session;
  };
}

export type SlotSourceKind = 'builtin' | 'v1-panel' | 'v2-data-panel' | 'iframe';

export interface SlotItemRegistration<K extends AnyPluginSlotKey = AnyPluginSlotKey> {
  slot: K;
  id: string;
  pluginId: string;
  pluginName: string;
  title?: string;
  order?: number;
  key?: string;
  sourceKind?: SlotSourceKind;
  render: (props: SlotPropsMap[K]) => ReactNode;
}

export interface RegisteredSlotItem<K extends AnyPluginSlotKey = AnyPluginSlotKey>
  extends SlotItemRegistration<K> {
  readonly registrationKey: string;
  readonly seq: number;
}

export interface SlotQueryOptions {
  hasSession: boolean;
  matchKey?: string;
}

const MAX_RENDER_FAILURES = 40;
const EMPTY_SLOT_ITEMS: readonly never[] = [];

export class SlotRegistry {
  private readonly itemsBySlot = new Map<AnyPluginSlotKey, Map<string, RegisteredSlotItem>>();
  private readonly listeners = new Set<() => void>();
  private failures: PluginSlotRenderFailure[] = [];
  private seqCounter = 0;
  private version = 0;
  private cachedVersion = -1;
  private cachedFailures: readonly PluginSlotRenderFailure[] = [];
  private readonly queryCache = new Map<string, { version: number; items: readonly RegisteredSlotItem[] }>();

  register<K extends AnyPluginSlotKey>(registration: SlotItemRegistration<K>): Disposer {
    const slot = normalizeAnyPluginSlotKey(registration.slot) as K;
    const registrationKey = `${registration.pluginId}:${registration.id}`;
    const bucket = this.itemsBySlot.get(slot) ?? new Map<string, RegisteredSlotItem>();
    this.itemsBySlot.set(slot, bucket);

    const record: RegisteredSlotItem<K> = {
      ...registration,
      slot,
      registrationKey,
      seq: ++this.seqCounter,
    };
    bucket.set(registrationKey, record as unknown as RegisteredSlotItem);
    this.bump();

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      const currentBucket = this.itemsBySlot.get(slot);
      if (currentBucket?.get(registrationKey) === (record as unknown as RegisteredSlotItem)) {
        currentBucket.delete(registrationKey);
        if (currentBucket.size === 0) this.itemsBySlot.delete(slot);
        this.bump();
      }
    };
  }

  getItems<K extends AnyPluginSlotKey>(
    slot: K,
    options: SlotQueryOptions,
  ): readonly RegisteredSlotItem<K>[] {
    const canonical = normalizeAnyPluginSlotKey(slot) as K;
    const contract = ALL_PLUGIN_UI_SLOTS[canonical];
    if (!contract) return EMPTY_SLOT_ITEMS;
    if (contract.scope === 'session' && !options.hasSession) {
      return EMPTY_SLOT_ITEMS;
    }
    const cacheKey = `${canonical}|${options.hasSession ? '1' : '0'}|${options.matchKey ?? ''}`;
    const cached = this.queryCache.get(cacheKey);
    if (cached && cached.version === this.version) {
      return cached.items as unknown as readonly RegisteredSlotItem<K>[];
    }

    const bucket = this.itemsBySlot.get(canonical);
    let list = bucket ? [...bucket.values()] : [];
    if (contract.cardinality === 'keyed') {
      list = options.matchKey ? list.filter((item) => item.key === options.matchKey) : [];
    }
    list.sort((a, b) => (a.order ?? 500) - (b.order ?? 500) || a.seq - b.seq);
    this.queryCache.set(cacheKey, { version: this.version, items: list });
    return list as unknown as readonly RegisteredSlotItem<K>[];
  }

  reportRenderFailure(input: Omit<PluginSlotRenderFailure, 'id' | 'timestamp'>): PluginSlotRenderFailure {
    const now = Date.now();
    const existingIdx = this.failures.findIndex(
      (item) =>
        item.pluginId === input.pluginId &&
        item.slot === input.slot &&
        item.slotItemId === input.slotItemId &&
        item.message === input.message,
    );
    const entry: PluginSlotRenderFailure = {
      ...input,
      id: `${input.pluginId}:${input.slot}:${input.slotItemId}:${now}`,
      timestamp: now,
    };
    if (existingIdx >= 0) {
      const next = [...this.failures];
      next[existingIdx] = entry;
      this.failures = next;
    } else {
      this.failures = [entry, ...this.failures].slice(0, MAX_RENDER_FAILURES);
    }
    this.bump();
    return entry;
  }

  getRenderFailures(): readonly PluginSlotRenderFailure[] {
    if (this.cachedVersion !== this.version) {
      this.cachedFailures = this.failures;
      this.cachedVersion = this.version;
    }
    return this.cachedFailures;
  }

  clearRenderFailure(id: string): void {
    const next = this.failures.filter((item) => item.id !== id);
    if (next.length !== this.failures.length) {
      this.failures = next;
      this.bump();
    }
  }

  clearPluginRenderFailures(pluginId: string): void {
    const next = this.failures.filter((item) => item.pluginId !== pluginId);
    if (next.length !== this.failures.length) {
      this.failures = next;
      this.bump();
    }
  }

  clearAllRenderFailures(): void {
    if (this.failures.length > 0) {
      this.failures = [];
      this.bump();
    }
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.itemsBySlot.clear();
    this.failures = [];
    this.queryCache.clear();
    this.bump();
  }

  private bump(): void {
    this.version += 1;
    this.queryCache.clear();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // Listener errors must not break registry notifications
      }
    }
  }
}

export const slotRegistry = new SlotRegistry();
