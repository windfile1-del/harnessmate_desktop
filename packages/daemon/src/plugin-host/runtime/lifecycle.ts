import {
  HOST_SUPPORTED_FEATURES,
  PLUGIN_API_VERSION, PLUGIN_EVENT_VERSION, PluginApiError,
  type Disposer, type PluginContext, type PluginState,
} from '@harnessmate/plugin-api';
import type { HarnessRegistry } from '../../harnesses/registry.js';
import { PluginEvents } from './events.js';

export interface HandoffRedactionRequest {
  text: string;
  targetDriverId: string;
  sessionId?: string;
  workspaceId: string;
  targetInstanceId?: string;
}

export interface HandoffRedactionOutcome {
  text: string;
  categories: string[];
  redactedCount: number;
}

export type HandoffRedactorFn = (input: HandoffRedactionRequest) => Promise<HandoffRedactionOutcome>;

export interface ServiceProvideOptions {
  version?: string;
  metadata?: Record<string, unknown>;
  runId?: string;
}

export interface ServiceProviderInfo {
  pluginId: string;
  instanceId: string;
  contract: string;
  version: string;
  metadata?: Record<string, unknown>;
  runId?: string;
}

export interface HostPluginContext extends PluginContext {
  readonly host?: PluginHost;
  readonly instanceId?: string;
  provide(name: string, value: object, opts?: ServiceProvideOptions): Disposer;
}

export interface HostPluginDependency {
  contract: string;
  version?: string;
  optional?: boolean;
}

export interface HostPlugin {
  id: string;
  pluginId?: string;
  revision?: string;
  inject?: readonly string[];
  provides?: readonly string[];
  dependencies?: readonly HostPluginDependency[];
  bindings?: Readonly<Record<string, string>>;
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
  cycleFailed?: boolean;
}

interface ServiceRecord extends ServiceProviderInfo {
  owner: Instance;
  value: object;
}

export class PluginHost {
  private readonly instances = new Map<string, Instance>();
  private readonly servicesByContract = new Map<string, Map<string, ServiceRecord>>();
  private readonly serviceListeners = new Set<(services: string[]) => void>();
  private defaultBindings: Record<string, string> = {};
  private registryBridge?: HarnessRegistry;
  private handoffRedactor?: HandoffRedactorFn;
  readonly events: PluginEvents;

  constructor(private readonly report: (error: unknown) => void = () => {}) {
    this.events = new PluginEvents(report);
  }

  setRegistryBridge(registry: HarnessRegistry): void {
    this.registryBridge = registry;
  }

  getRegistryBridge(): HarnessRegistry | undefined {
    return this.registryBridge;
  }

  setHandoffRedactor(fn: HandoffRedactorFn): void {
    this.handoffRedactor = fn;
  }

  getHandoffRedactor(): HandoffRedactorFn | undefined {
    return this.handoffRedactor;
  }

  setDefaultBindings(bindings: Readonly<Record<string, string>>): void {
    this.defaultBindings = { ...bindings };
  }

  getDefaultBindings(): Readonly<Record<string, string>> {
    return this.defaultBindings;
  }

  private resolveRecord(
    contract: string,
    callerInstanceId?: string,
    overrideInstanceId?: string,
  ): ServiceRecord | undefined {
    const bucket = this.servicesByContract.get(contract);
    if (!bucket || bucket.size === 0) return undefined;
    if (overrideInstanceId) {
      return bucket.get(overrideInstanceId);
    }
    if (callerInstanceId) {
      const caller = this.instances.get(callerInstanceId);
      const boundId = caller?.definition.bindings?.[contract];
      if (boundId) return bucket.get(boundId);
    }
    const defaultId = this.defaultBindings[contract];
    if (defaultId) {
      const preferred = bucket.get(defaultId);
      if (preferred) return preferred;
    }
    return bucket.values().next().value;
  }

  get<Service = unknown>(name: string): Service | undefined {
    return this.resolveRecord(name)?.value as Service | undefined;
  }

  getServiceByInstance<Service = unknown>(instanceId: string, contract: string): Service | undefined {
    return this.servicesByContract.get(contract)?.get(instanceId)?.value as Service | undefined;
  }

  resolveServiceFor<Service = unknown>(
    callerInstanceId: string | undefined,
    contract: string,
    overrideInstanceId?: string,
  ): Service | undefined {
    return this.resolveRecord(contract, callerInstanceId, overrideInstanceId)?.value as Service | undefined;
  }

  listServices(): string[] {
    return [...this.servicesByContract.keys()].sort();
  }

  listServiceProviders(contract?: string): ServiceProviderInfo[] {
    const out: ServiceProviderInfo[] = [];
    if (contract) {
      const bucket = this.servicesByContract.get(contract);
      if (!bucket) return out;
      for (const rec of bucket.values()) {
        out.push({
          pluginId: rec.pluginId,
          instanceId: rec.instanceId,
          contract: rec.contract,
          version: rec.version,
          ...(rec.metadata ? { metadata: rec.metadata } : {}),
          ...(rec.runId ? { runId: rec.runId } : {}),
        });
      }
      return out.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
    }
    for (const bucket of this.servicesByContract.values()) {
      for (const rec of bucket.values()) {
        out.push({
          pluginId: rec.pluginId,
          instanceId: rec.instanceId,
          contract: rec.contract,
          version: rec.version,
          ...(rec.metadata ? { metadata: rec.metadata } : {}),
          ...(rec.runId ? { runId: rec.runId } : {}),
        });
      }
    }
    return out.sort((a, b) => a.contract.localeCompare(b.contract) || a.instanceId.localeCompare(b.instanceId));
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
      const ownedContracts = this.ownedContracts(instance);
      this.disposeEffects(instance);
      this.stopDependents(instance.definition.id, ownedContracts);
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
      const readyBatch: Instance[] = [];
      for (const instance of [...this.instances.values()]) {
        if (instance.status.state !== 'PENDING') continue;
        const missing = this.missing(instance);
        if (missing.length) {
          this.transition(instance, 'PENDING', missing);
        } else {
          readyBatch.push(instance);
        }
      }
      if (readyBatch.length > 0) {
        const results = await Promise.all(readyBatch.map((instance) => this.startAsync(instance)));
        if (results.some(Boolean)) activated = true;
      }
    } while (activated);
  }

  private prepareDefinitions(definitions: readonly HostPlugin[]): void {
    const desired = new Map(definitions.map((definition) => [definition.id, definition]));
    for (const [id, instance] of this.instances) {
      const next = desired.get(id);
      if (
        !next
        || next.revision !== instance.definition.revision
        || next.enabled !== instance.definition.enabled
        || next.error !== instance.definition.error
        || (next.pluginId ?? next.id) !== (instance.definition.pluginId ?? instance.definition.id)
        || JSON.stringify(next.bindings ?? {}) !== JSON.stringify(instance.definition.bindings ?? {})
        || (instance.cycleFailed && next.enabled && !next.error)
      ) {
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
    this.detectCircularDependencies();
  }

  private requiredContracts(definition: HostPlugin): string[] {
    const set = new Set<string>(definition.inject ?? []);
    for (const dep of definition.dependencies ?? []) {
      if (!dep.optional) set.add(dep.contract);
    }
    return [...set];
  }

  private ownedContracts(instance: Instance): string[] {
    const owned: string[] = [];
    for (const [contract, bucket] of this.servicesByContract) {
      if (bucket.get(instance.definition.id)?.owner === instance) {
        owned.push(contract);
      }
    }
    return owned;
  }

  private detectCircularDependencies(): void {
    const candidates = new Map<string, Instance>();
    const providersByService = new Map<string, string[]>();
    for (const instance of this.instances.values()) {
      const { definition, status } = instance;
      if (!definition.enabled || definition.error) continue;
      if (status.state === 'PENDING') {
        candidates.set(definition.id, instance);
      }
      if (status.state === 'PENDING' || status.state === 'LOADING' || status.state === 'ACTIVE') {
        for (const svc of definition.provides ?? []) {
          const list = providersByService.get(svc) ?? [];
          list.push(definition.id);
          providersByService.set(svc, list);
        }
      }
    }
    if (candidates.size === 0) return;

    const edges = new Map<string, string[]>();
    for (const [id, instance] of candidates) {
      const deps: string[] = [];
      for (const svc of this.requiredContracts(instance.definition)) {
        const boundId = instance.definition.bindings?.[svc];
        if (boundId) {
          if (candidates.has(boundId) && (providersByService.get(svc) ?? []).includes(boundId)) {
            deps.push(boundId);
          }
          continue;
        }
        for (const providerId of providersByService.get(svc) ?? []) {
          if (candidates.has(providerId)) deps.push(providerId);
        }
      }
      edges.set(id, deps);
    }

    const color = new Map<string, 0 | 1 | 2>();
    for (const id of candidates.keys()) color.set(id, 0);
    const stack: string[] = [];
    const failedCycles = new Map<string, string>();

    const dfs = (u: string): void => {
      color.set(u, 1);
      stack.push(u);
      for (const v of edges.get(u) ?? []) {
        const c = color.get(v);
        if (c === 1) {
          const idx = stack.indexOf(v);
          const cycle = [...stack.slice(idx), v];
          const message = `E_CIRCULAR_DEPENDENCY: 检测到循环依赖 ${cycle.join(' -> ')}`;
          for (const memberId of cycle.slice(0, -1)) {
            if (!failedCycles.has(memberId)) failedCycles.set(memberId, message);
          }
        } else if (c === 0) {
          dfs(v);
        }
      }
      stack.pop();
      color.set(u, 2);
    };

    for (const id of candidates.keys()) {
      if (color.get(id) === 0) dfs(id);
    }

    if (failedCycles.size > 0) {
      const reportedMessages = new Set<string>();
      for (const [id, message] of failedCycles) {
        const instance = candidates.get(id);
        if (!instance) continue;
        instance.cycleFailed = true;
        this.transition(instance, 'FAILED', [], message);
        if (!reportedMessages.has(message)) {
          reportedMessages.add(message);
          this.report(new PluginApiError('E_CIRCULAR_DEPENDENCY', message));
        }
      }
    }
  }

  private missing(instance: Instance): string[] {
    const out: string[] = [];
    for (const contract of this.requiredContracts(instance.definition)) {
      const bucket = this.servicesByContract.get(contract);
      const boundId = instance.definition.bindings?.[contract];
      if (boundId) {
        if (!bucket?.has(boundId)) out.push(`${contract}@${boundId}`);
      } else if (!bucket || bucket.size === 0) {
        out.push(contract);
      }
    }
    return out;
  }

  private transition(instance: Instance, state: PluginState, missingServices: string[] = [], error?: string) {
    const old = instance.status;
    if (old.state === state && old.error === error && old.missingServices.join(',') === missingServices.join(',')) return;
    instance.status = { state, missingServices, error };
    void this.events.dispatch({
      version: PLUGIN_EVENT_VERSION,
      type: 'plugin.state',
      sessionId: null,
      turnId: null,
      seq: null,
      createdAt: Date.now(),
      data: { pluginId: instance.definition.id, state, missingServices },
    });
  }

  private createContext(instance: Instance, run: symbol): HostPluginContext {
    const instanceId = instance.definition.id;
    const pluginId = instance.definition.pluginId ?? instanceId;
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
      host: this,
      instanceId,
      api: {
        version: PLUGIN_API_VERSION,
        has: (name) => {
          assertCurrent();
          return (HOST_SUPPORTED_FEATURES as readonly string[]).includes(name)
            || Boolean(this.resolveRecord(name, instanceId));
        },
      },
      effect,
      get: (name) => {
        assertCurrent();
        return this.resolveServiceFor(instanceId, name);
      },
      on: (name, listener) => effect(() => this.events.on(name, listener)),
      provide: (name, value, opts) => {
        assertCurrent();
        if (instance.status.state !== 'LOADING' || !instance.definition.provides?.includes(name)) {
          throw new PluginApiError('E_PERMISSION_DENIED', `无法注册服务 ${name}`);
        }
        const existingBucket = this.servicesByContract.get(name);
        if (existingBucket?.has(instanceId)) {
          throw new PluginApiError('E_CONFLICT', `服务 ${name} 已经在此实例 (${instanceId}) 注册`);
        }
        return effect(() => {
          const bucket = this.servicesByContract.get(name) ?? new Map<string, ServiceRecord>();
          bucket.set(instanceId, {
            pluginId,
            instanceId,
            contract: name,
            version: opts?.version ?? '1.0.0',
            ...(opts?.metadata ? { metadata: opts.metadata } : {}),
            ...(opts?.runId ? { runId: opts.runId } : {}),
            owner: instance,
            value,
          });
          this.servicesByContract.set(name, bucket);
          this.notifyServicesChanged();
          return () => {
            const currentBucket = this.servicesByContract.get(name);
            if (currentBucket?.get(instanceId)?.owner === instance) {
              currentBucket.delete(instanceId);
              if (currentBucket.size === 0) this.servicesByContract.delete(name);
              this.notifyServicesChanged();
              this.stopDependents(instanceId, [name]);
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

  private stopDependents(stoppedInstanceId: string, contracts: readonly string[]): void {
    if (contracts.length === 0) return;
    for (const consumer of this.instances.values()) {
      if (consumer.status.state !== 'ACTIVE') continue;
      const reqs = this.requiredContracts(consumer.definition);
      const affected = reqs.some((contract) => {
        if (!contracts.includes(contract)) return false;
        const boundId = consumer.definition.bindings?.[contract];
        if (boundId) return boundId === stoppedInstanceId;
        return !this.servicesByContract.get(contract)?.size;
      });
      if (!affected) continue;
      this.stop(consumer, 'PENDING');
    }
  }

  private stop(instance: Instance, next: 'PENDING' | 'DISPOSED'): void {
    if (instance.status.state === 'ACTIVE' || instance.status.state === 'LOADING') {
      this.transition(instance, 'UNLOADING');
      instance.run = undefined;
      const ownedContracts = this.ownedContracts(instance);
      this.disposeEffects(instance);
      this.stopDependents(instance.definition.id, ownedContracts);
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
