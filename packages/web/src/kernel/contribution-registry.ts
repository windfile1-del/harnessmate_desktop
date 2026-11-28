import type {
  DesktopMenuContributionDto,
  Disposer,
  UiContributionInput,
  UiContributionInvocation,
  UiContributionKind,
  UiContributionOwner,
  UiContributionRecord,
} from '@harnessmate/protocol';
import { isImeComposing, trackComposition } from '../lib/ime';

export interface UiContributionQuery {
  kind?: UiContributionKind | readonly UiContributionKind[];
  target?: string;
  ownerInstanceId?: string;
  enabledOnly?: boolean;
}

interface ParsedShortcut {
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  esc: 'escape',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  space: ' ',
};

export function parseShortcutSpec(spec: string): ParsedShortcut | null {
  const parts = spec
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  let mod = false;
  let ctrl = false;
  let meta = false;
  let alt = false;
  let shift = false;
  let key = '';
  for (const raw of parts) {
    const lower = raw.toLowerCase();
    if (lower === 'mod' || lower === 'cmdorctrl') mod = true;
    else if (lower === 'ctrl' || lower === 'control') ctrl = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') meta = true;
    else if (lower === 'alt' || lower === 'option') alt = true;
    else if (lower === 'shift') shift = true;
    else key = KEY_ALIASES[lower] ?? lower;
  }
  if (!key) return null;
  return { mod, ctrl, meta, alt, shift, key };
}

export function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!target || typeof target !== 'object') return false;
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null };
  if (el.isContentEditable) return true;
  if (typeof el.getAttribute === 'function' && el.getAttribute('contenteditable') === 'true') return true;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function matchesShortcutEvent(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'target'>,
  spec: string,
  options?: { allowInInput?: boolean },
): boolean {
  const parsed = parseShortcutSpec(spec);
  if (!parsed) return false;
  const eventKey = (KEY_ALIASES[event.key.toLowerCase()] ?? event.key.toLowerCase());
  if (eventKey !== parsed.key) return false;

  const hasMod = Boolean(event.ctrlKey || event.metaKey);
  if (parsed.mod) {
    if (!hasMod) return false;
  } else {
    if (Boolean(event.ctrlKey) !== parsed.ctrl) return false;
    if (Boolean(event.metaKey) !== parsed.meta) return false;
  }
  if (Boolean(event.altKey) !== parsed.alt) return false;
  if (Boolean(event.shiftKey) !== parsed.shift) return false;

  if (isEditableEventTarget(event.target)) {
    const isEscape = parsed.key === 'escape';
    const hasPrimaryModifier = parsed.mod || parsed.ctrl || parsed.meta;
    if (!options?.allowInInput && !isEscape && !hasPrimaryModifier) {
      return false;
    }
  }
  return true;
}

let invocationSeq = 0;

interface DesktopMenuBridge {
  syncContributions?: (items: DesktopMenuContributionDto[]) => void;
  onInvoke?: (listener: (payload: { key: string; ownerInstanceId: string; ownerRunId: string }) => void) => () => void;
}

function getDesktopMenuBridge(): DesktopMenuBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { harnessMateBridge?: { menu?: DesktopMenuBridge } }).harnessMateBridge?.menu;
}

/**
 * Public kernel UI Contribution Registry.
 * Supports pages, regions, commands, shortcuts, menus, tray actions, and settings.
 * Every contribution is scoped to `{ instanceId, runId }` and revoked on unload.
 */
export class UiContributionRegistry {
  private readonly records = new Map<string, UiContributionRecord>();
  private readonly listeners = new Set<() => void>();
  private version = 0;
  private snapshotCache: { version: number; items: readonly UiContributionRecord[] } = {
    version: -1,
    items: [],
  };

  register(owner: UiContributionOwner, input: UiContributionInput): Disposer {
    const key = `${owner.instanceId}:${input.kind}:${input.id}`;
    const record: UiContributionRecord = {
      ...input,
      enabled: input.enabled ?? true,
      order: input.order ?? 500,
      key,
      owner: { ...owner },
      registeredAt: Date.now(),
    };
    this.records.set(key, record);
    this.bump(input.kind === 'menu' || input.kind === 'tray');

    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      if (this.records.get(key) === record) {
        this.records.delete(key);
        this.bump(input.kind === 'menu' || input.kind === 'tray');
      }
    };
  }

  revokeByOwner(instanceId: string, runId?: string): number {
    let removed = 0;
    let menuChanged = false;
    for (const [key, record] of [...this.records.entries()]) {
      if (record.owner.instanceId !== instanceId) continue;
      if (runId !== undefined && record.owner.runId !== runId) continue;
      this.records.delete(key);
      removed += 1;
      if (record.kind === 'menu' || record.kind === 'tray') menuChanged = true;
    }
    if (removed > 0) this.bump(menuChanged);
    return removed;
  }

  getAll(): readonly UiContributionRecord[] {
    if (this.snapshotCache.version !== this.version) {
      const items = [...this.records.values()].sort(
        (a, b) => (a.order ?? 500) - (b.order ?? 500) || a.registeredAt - b.registeredAt,
      );
      this.snapshotCache = { version: this.version, items };
    }
    return this.snapshotCache.items;
  }

  query(filter?: UiContributionQuery): readonly UiContributionRecord[] {
    const all = this.getAll();
    if (!filter) return all;
    const kinds = filter.kind
      ? Array.isArray(filter.kind)
        ? new Set(filter.kind)
        : new Set([filter.kind])
      : null;
    return all.filter((item) => {
      if (kinds && !kinds.has(item.kind)) return false;
      if (filter.target !== undefined && item.target !== filter.target) return false;
      if (filter.ownerInstanceId !== undefined && item.owner.instanceId !== filter.ownerInstanceId) return false;
      if (filter.enabledOnly && item.enabled === false) return false;
      return true;
    });
  }

  getByKey(key: string): UiContributionRecord | undefined {
    return this.records.get(key);
  }

  async execute(
    keyOrId: string,
    invocation?: Partial<UiContributionInvocation>,
  ): Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }> {
    let record = this.records.get(keyOrId);
    if (!record) {
      record = this.getAll().find(
        (item) => item.enabled !== false && (item.id === keyOrId || `${item.owner.instanceId}:${item.id}` === keyOrId),
      );
    }
    if (!record || record.enabled === false) {
      return { ok: false, code: 'E_SERVICE_UNAVAILABLE', message: `贡献项不可用: ${keyOrId}` };
    }
    if (typeof record.execute !== 'function') {
      return { ok: false, code: 'E_NOT_SUPPORTED', message: `贡献项不支持执行: ${record.id}` };
    }
    const payload: UiContributionInvocation = {
      requestId: invocation?.requestId ?? `contrib_${Date.now()}_${++invocationSeq}`,
      sourceInstanceId: invocation?.sourceInstanceId,
      args: invocation?.args,
    };
    const value = await record.execute(payload);
    return { ok: true, value };
  }

  dispatchShortcutEvent(event: KeyboardEvent, composing: boolean): boolean {
    if (event.defaultPrevented || isImeComposing(event, composing)) return false;
    const shortcuts = this.query({ kind: 'shortcut', enabledOnly: true });
    for (const item of shortcuts) {
      if (!item.shortcut || typeof item.execute !== 'function') continue;
      if (!matchesShortcutEvent(event, item.shortcut, { allowInInput: item.allowInInput })) continue;
      const isArrowRepeatAllowed = item.shortcut.toLowerCase().includes('arrow');
      if (event.repeat && !isArrowRepeatAllowed) {
        event.preventDefault();
        return true;
      }
      event.preventDefault();
      void Promise.resolve(
        item.execute({
          requestId: `shortcut_${Date.now()}_${++invocationSeq}`,
          args: { shortcut: item.shortcut },
        }),
      ).catch(() => {});
      return true;
    }
    return false;
  }

  getDesktopMenuContributions(): DesktopMenuContributionDto[] {
    return this.query({ kind: ['menu', 'tray'], enabledOnly: true }).map((item) => ({
      key: item.key,
      id: item.id,
      kind: item.kind as 'menu' | 'tray',
      label: item.title,
      ...(item.shortcut ? { accelerator: item.shortcut } : {}),
      enabled: item.enabled !== false,
      order: item.order ?? 500,
      ownerInstanceId: item.owner.instanceId,
      ownerRunId: item.owner.runId,
    }));
  }

  syncDesktopMenus(): void {
    const menuBridge = getDesktopMenuBridge();
    if (!menuBridge?.syncContributions) return;
    try {
      menuBridge.syncContributions(this.getDesktopMenuContributions());
    } catch {
      // ignore desktop bridge sync errors outside Electron
    }
  }

  handleDesktopMenuInvoke(payload: { key: string; ownerInstanceId: string; ownerRunId: string }): boolean {
    const record = this.records.get(payload.key);
    if (!record || record.enabled === false) return false;
    if (record.owner.instanceId !== payload.ownerInstanceId || record.owner.runId !== payload.ownerRunId) {
      return false;
    }
    if (typeof record.execute !== 'function') return false;
    void Promise.resolve(
      record.execute({
        requestId: `menu_${Date.now()}_${++invocationSeq}`,
        sourceInstanceId: 'electron-menu',
      }),
    ).catch(() => {});
    return true;
  }

  subscribe(listener: () => void): Disposer {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getVersion(): number {
    return this.version;
  }

  reset(): void {
    const hadMenu = this.getDesktopMenuContributions().length > 0;
    this.records.clear();
    this.bump(hadMenu);
  }

  private bump(syncMenu: boolean): void {
    this.version += 1;
    if (syncMenu) this.syncDesktopMenus();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // isolate listener errors
      }
    }
  }
}

export const contributionRegistry = new UiContributionRegistry();

/**
 * Installs window-level keyboard shortcut dispatch (with IME composition guard)
 * and Electron desktop menu invocation listener. Returns a disposer.
 */
export function installKernelContributionRuntime(
  registry: UiContributionRegistry = contributionRegistry,
  target: Window = window,
): Disposer {
  const composing = { current: false };
  const stopComposition = trackComposition(target, composing);
  const onKeyDown = (event: KeyboardEvent) => {
    registry.dispatchShortcutEvent(event, composing.current);
  };
  target.addEventListener('keydown', onKeyDown);

  const menuBridge = getDesktopMenuBridge();
  const stopMenuInvoke = menuBridge?.onInvoke?.((payload) => {
    registry.handleDesktopMenuInvoke(payload);
  });
  registry.syncDesktopMenus();

  return () => {
    target.removeEventListener('keydown', onKeyDown);
    stopComposition();
    stopMenuInvoke?.();
  };
}
