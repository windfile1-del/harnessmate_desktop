import { PLUGIN_EVENT_VERSION, pluginEventContracts, type Disposer, type PluginEventName,
  type PluginEventV4 } from '@harnessmate/plugin-api';

type Listener = (event: PluginEventV4) => void | Promise<void>;
type Middleware<Value> = (value: Value, next: () => void) => void;

export class PluginEvents {
  private readonly listeners = new Map<PluginEventName, Set<Listener>>();

  constructor(private readonly report: (error: unknown) => void) {}

  on<Name extends PluginEventName>(name: Name, listener: (event: PluginEventV4<Name>) => void | Promise<void>): Disposer {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    this.listeners.set(name, listeners);
    const wrapped: Listener = (event) => listener(event as PluginEventV4<Name>);
    listeners.add(wrapped);
    return () => { listeners.delete(wrapped); };
  }

  async dispatch(event: PluginEventV4): Promise<void> {
    const listeners = this.listeners.get(event.type);
    const invoke = async (listener: Listener) => {
      if (!listeners?.has(listener)) return;
      try { await listener(structuredClone(event)); }
      catch (error) { this.report(error); }
    };
    const targets = [...(listeners ?? [])];
    const mode = pluginEventContracts[event.type].mode;
    if (mode === 'serial') {
      for (const listener of targets) await invoke(listener);
    } else if (mode === 'parallel') {
      await Promise.all(targets.map(invoke));
    } else {
      for (const listener of targets) queueMicrotask(() => void invoke(listener));
    }
  }

  waterfall<Value>(name: 'handoff.compose' | 'approval.annotate', value: Value, listeners: readonly Middleware<Value>[]): void {
    if (pluginEventContracts[name].mode !== 'waterfall') return;
    const run = (index: number) => {
      const listener = listeners[index];
      if (!listener) return;
      let called = false;
      const next = () => {
        if (called) return;
        called = true;
        run(index + 1);
      };
      try { listener(value, next); }
      catch (error) { this.report(error); next(); }
    };
    run(0);
  }

  bail<Value>(name: 'handoff.shouldOffer', listeners: readonly (() => Value | undefined)[]): Value | undefined {
    if (pluginEventContracts[name].mode !== 'bail') return;
    for (const listener of listeners) {
      try {
        const result = listener();
        if (result !== undefined) return result;
      } catch (error) { this.report(error); }
    }
  }
}

export function sessionPluginEvent(type: 'session.created' | 'session.closing',
  session: { id: string; title: string; harnessId: string }): PluginEventV4 {
  return { version: PLUGIN_EVENT_VERSION, type, sessionId: session.id, turnId: null, seq: null,
    createdAt: Date.now(), data: { title: session.title, harnessId: session.harnessId } };
}
