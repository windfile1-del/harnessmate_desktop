import {
  PLUGIN_API_VERSION, PLUGIN_EVENT_VERSION, PluginApiError,
  type Disposer, type PluginContext, type PluginState,
} from '@harnessmate/plugin-api';
import { PluginEvents } from './events.js';

export interface HostPluginContext extends PluginContext {
  provide(name: string, value: object): Disposer;
}

export interface HostPlugin {
  id: string;
  revision?: string;
  inject?: readonly string[];
  provides?: readonly string[];
  enabled: boolean;
  error?: string;
  config?: Readonly<Record<string, unknown>>;
  apply(ctx: HostPluginContext, config: Readonly<Record<string, unknown>>): void | Promise<void>;
}

export interface PluginStatus {
  state: PluginState;
  missingServices: string[];
  error?: string;
}

interface Instance {
  definition: HostPlugin;
  status: PluginStatus;
  effects: Set<Disposer>;
  run?: symbol;
}

export class PluginHost {
  private readonly instances = new Map<string, Instance>();
  private readonly services = new Map<string, { owner: Instance; value: object }>();
  private readonly serviceListeners = new Set<(services: string[]) => void>();
  readonly events: PluginEvents;

  constructor(private readonly report: (error: unknown) => void = () => {}) {
    this.events = new PluginEvents(report);
  }

  get<Service = unknown>(name: string): Service | undefined {
    return this.services.get(name)?.value as Service | undefined;
  }

  listServices(): string[] {
    return [...this.services.keys()].sort();
  }

  onServicesChanged(listener: (services: string[]) => void): Disposer {
    this.serviceListeners.add(listener);
    return () => { this.serviceListeners.delete(listener); };
  }

  private notifyServicesChanged(): void {
    const names = this.listServices();
    for (const listener of this.serviceListeners) {
      try { listener(names); } catch (error) { this.report(error); }
    }
  }

  status(id: string): PluginStatus | undefined {
    return this.instances.get(id)?.status;
  }

  fail(id: string, error: string): void {
    const instance = this.instances.get(id);
    if (!instance) return;
    if (instance.status.state === 'ACTIVE' || instance.status.state === 'LOADING') {
      this.transition(instance, 'UNLOADING');
      instance.run = undefined;
      const names = [...this.services.entries()].filter(([, service]) => service.owner === instance).map(([name]) => name);
      this.stopDependents(names);
      this.disposeEffects(instance);
    }
    this.transition(instance, 'FAILED', [], error);
  }

  reconcile(definitions: readonly HostPlugin[]): void {
    this.prepareDefinitions(definitions);
    let activated: boolean;
    do {
      activated = false;
      for (const instance of this.instances.values()) {
        if (instance.status.state !== 'PENDING') continue;
        const missing = this.missing(instance);
        if (missing.length) this.transition(instance, 'PENDING', missing);
        else if (this.startSync(instance)) activated = true;
      }
    } while (activated);
  }

  async reconcileAsync(definitions: readonly HostPlugin[]): Promise<void> {
    this.prepareDefinitions(definitions);
    let activated: boolean;
    do {
      activated = false;
      for (const instance of [...this.instances.values()]) {
        if (instance.status.state !== 'PENDING') continue;
        const missing = this.missing(instance);
        if (missing.length) this.transition(instance, 'PENDING', missing);
        else if (await this.startAsync(instance)) activated = true;
      }
    } while (activated);
  }

  private prepareDefinitions(definitions: readonly HostPlugin[]): void {
    const desired = new Map(definitions.map((definition) => [definition.id, definition]));
    for (const [id, instance] of this.instances) {
      const next = desired.get(id);
      if (!next || next.revision !== instance.definition.revision || next.enabled !== instance.definition.enabled
        || next.error !== instance.definition.error) {
        this.stop(instance, 'DISPOSED');
        this.instances.delete(id);
      }
    }
    for (const definition of definitions) {
      if (this.instances.has(definition.id)) continue;
      const instance: Instance = { definition, effects: new Set(), status: { state: 'DISPOSED', missingServices: [] } };
      this.instances.set(definition.id, instance);
      if (definition.error) this.transition(instance, 'FAILED', [], definition.error);
      else if (definition.enabled) this.transition(instance, 'PENDING', this.missing(instance));
    }
  }

  private missing(instance: Instance): string[] {
    return (instance.definition.inject ?? []).filter((name) => !this.services.has(name));
  }

  private transition(instance: Instance, state: PluginState, missingServices: string[] = [], error?: string) {
    const old = instance.status;
    if (old.state === state && old.error === error && old.missingServices.join(',') === missingServices.join(',')) return;
    instance.status = { state, missingServices, error };
    void this.events.dispatch({ version: PLUGIN_EVENT_VERSION, type: 'plugin.state',
      sessionId: null, turnId: null, seq: null, createdAt: Date.now(),
      data: { pluginId: instance.definition.id, state, missingServices } });
  }

  private createContext(instance: Instance, run: symbol): HostPluginContext {
    const assertCurrent = () => {
      if (instance.run !== run || (instance.status.state !== 'LOADING' && instance.status.state !== 'ACTIVE')) {
        throw new PluginApiError('E_STALE_RUN', '插件实例已停止');
      }
    };
    const effect: PluginContext['effect'] = (activate) => {
      assertCurrent();
      const dispose = activate();
      const undo = () => { if (instance.effects.delete(undo)) dispose(); };
      instance.effects.add(undo);
      return undo;
    };
    return {
      api: { version: PLUGIN_API_VERSION, has: (name) => { assertCurrent(); return this.services.has(name); } },
      effect,
      get: (name) => { assertCurrent(); return this.get(name); },
      on: (name, listener) => effect(() => this.events.on(name, listener)),
      provide: (name, value) => {
        assertCurrent();
        if (instance.status.state !== 'LOADING' || !instance.definition.provides?.includes(name)) {
          throw new PluginApiError('E_PERMISSION_DENIED', `无法注册服务 ${name}`);
        }
        if (this.services.has(name)) throw new PluginApiError('E_CONFLICT', `服务 ${name} 已经注册`);
        return effect(() => {
          this.services.set(name, { owner: instance, value });
          this.notifyServicesChanged();
          return () => {
            if (this.services.get(name)?.owner === instance) {
              this.services.delete(name);
              this.notifyServicesChanged();
              this.stopDependents([name]);
            }
          };
        });
      },
    };
  }

  private startSync(instance: Instance): boolean {
    const run = Symbol(instance.definition.id);
    instance.run = run;
    this.transition(instance, 'LOADING');
    try {
      const ctx = this.createContext(instance, run);
      instance.definition.apply(ctx, instance.definition.config ?? {});
      this.transition(instance, 'ACTIVE');
      return true;
    } catch (error) {
      instance.run = undefined;
      this.disposeEffects(instance);
      this.transition(instance, 'FAILED', [], error instanceof Error ? error.message : String(error));
      this.report(error);
      return false;
    }
  }

  private async startAsync(instance: Instance): Promise<boolean> {
    const run = Symbol(instance.definition.id);
    instance.run = run;
    this.transition(instance, 'LOADING');
    try {
      const ctx = this.createContext(instance, run);
      await instance.definition.apply(ctx, instance.definition.config ?? {});
      if (instance.run !== run) return false;
      this.transition(instance, 'ACTIVE');
      return true;
    } catch (error) {
      if (instance.run === run) instance.run = undefined;
      this.disposeEffects(instance);
      this.transition(instance, 'FAILED', [], error instanceof Error ? error.message : String(error));
      this.report(error);
      return false;
    }
  }

  private stopDependents(names: readonly string[]): void {
    for (const consumer of this.instances.values()) {
      if (consumer.status.state !== 'ACTIVE' || !consumer.definition.inject?.some((name) => names.includes(name))) continue;
      this.stop(consumer, 'PENDING');
    }
  }

  private stop(instance: Instance, next: 'PENDING' | 'DISPOSED'): void {
    if (instance.status.state === 'ACTIVE' || instance.status.state === 'LOADING') {
      this.transition(instance, 'UNLOADING');
      instance.run = undefined;
      const names = [...this.services.entries()].filter(([, service]) => service.owner === instance).map(([name]) => name);
      this.stopDependents(names);
      this.disposeEffects(instance);
    }
    this.transition(instance, next, next === 'PENDING' ? this.missing(instance) : []);
  }

  private disposeEffects(instance: Instance) {
    for (const dispose of [...instance.effects].reverse()) {
      try { dispose(); }
      catch (error) { this.report(error); }
    }
  }
}
