import type { CustomAcpHarnessConfig, HarnessInfo } from '@harnessmate/protocol';
import { AcpAdapter } from './acp-adapter.js';
import { ClaudeStreamJsonAdapter } from './claude-adapter.js';
import { CodexAppServerAdapter } from './codex-adapter.js';
import type { HarnessAdapter } from './types.js';

export class HarnessRegistry {
  private readonly adapters = new Map<string, HarnessAdapter>();
  private cachedProbes = new Map<string, HarnessInfo>();

  constructor(
    binaryOverrides: Record<string, string> = {},
    customAcpHarnesses: CustomAcpHarnessConfig[] = [],
  ) {
    this.register(new CodexAppServerAdapter(binaryOverrides.codex));
    this.register(
      new AcpAdapter({
        id: 'agy',
        kind: 'agy',
        displayName: 'Antigravity CLI',
        description: 'Google Antigravity CLI via native Agent Client Protocol (ACP)',
        command: 'agy',
        args: ['acp', '--stdio'],
        binaryOverride: binaryOverrides.agy,
      }),
    );
    this.register(new ClaudeStreamJsonAdapter(binaryOverrides.claude));

    for (const custom of customAcpHarnesses) {
      this.registerCustomAcp(custom);
    }
  }

  register(adapter: HarnessAdapter): void {
    this.adapters.set(adapter.id, adapter);
    this.cachedProbes.delete(adapter.id);
  }

  registerCustomAcp(config: CustomAcpHarnessConfig): void {
    this.register(
      new AcpAdapter({
        id: config.id,
        kind: 'acp',
        displayName: config.displayName,
        description: config.description,
        command: config.command,
        args: config.args,
        env: config.env,
        isCustom: true,
      }),
    );
  }

  unregister(id: string): boolean {
    this.cachedProbes.delete(id);
    return this.adapters.delete(id);
  }

  get(id: string): HarnessAdapter | undefined {
    return this.adapters.get(id);
  }

  listAdapters(): HarnessAdapter[] {
    return Array.from(this.adapters.values());
  }

  async probeAll(forceRefresh = false): Promise<HarnessInfo[]> {
    const list = this.listAdapters();
    const results = await Promise.all(
      list.map(async (adapter) => {
        if (!forceRefresh && this.cachedProbes.has(adapter.id)) {
          return this.cachedProbes.get(adapter.id)!;
        }
        try {
          const info = await adapter.probe();
          this.cachedProbes.set(adapter.id, info);
          return info;
        } catch (err) {
          const fallback: HarnessInfo = {
            id: adapter.id,
            kind: adapter.kind,
            displayName: adapter.displayName,
            description: adapter.description,
            protocolLabel: adapter.protocolLabel,
            binaryPath: null,
            version: null,
            health: 'unavailable',
            healthMessage: err instanceof Error ? err.message : String(err),
            capabilities: adapter.capabilities,
            models: [],
            isCustom: adapter.isCustom,
          };
          this.cachedProbes.set(adapter.id, fallback);
          return fallback;
        }
      }),
    );
    return results;
  }
}
