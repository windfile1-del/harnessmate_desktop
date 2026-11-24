import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import type { CanonicalEvent, HarnessCapabilities, HarnessInfo, Session } from '@harnessmate/protocol';
import {
  CONTEXT_COMPRESSION_PLUGIN_ID,
  ContextCompressionService,
  WORKSPACE_CACHE_MAX_BYTES,
  extractFileSymbols,
  validateReferencedPaths,
  type ContextCompressorProvider,
} from '../src/core/context-compression-service.js';
import { ContextCompiler } from '../src/core/context-compiler.js';
import { TaskLedgerService } from '../src/core/task-ledger-service.js';
import { HarnessMateStore } from '../src/db/sqlite.js';
import { HarnessRegistry } from '../src/harnesses/registry.js';
import type { AdapterSessionConfig, AdapterSessionHandle, HarnessAdapter } from '../src/harnesses/types.js';
import { PluginEvents } from '../src/plugin-host/runtime/events.js';
import { createDaemon, type DaemonInstance } from '../src/server/app.js';

const tempDirs: string[] = [];
const activeDaemons: DaemonInstance[] = [];
const openStores: HarnessMateStore[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTestStore(): { store: HarnessMateStore; workspaceId: string; workspacePath: string } {
  const dataDir = makeTempDir('hm-cmp-data-');
  const workspacePath = makeTempDir('hm-cmp-ws-');
  const store = new HarnessMateStore(path.join(dataDir, 'daemon.sqlite'));
  openStores.push(store);
  const ws = store.createWorkspace({
    id: `ws_${crypto.randomBytes(4).toString('hex')}`,
    name: 'compression-ws',
    rootPath: workspacePath,
    isGitRepo: false,
    gitBranch: null,
    createdAt: Date.now(),
  });
  return { store, workspaceId: ws.id, workspacePath };
}

function seedSession(
  store: HarnessMateStore,
  workspaceId: string,
  cwd: string,
  opts: { harnessId?: string; title?: string } = {},
): Session {
  const now = Date.now();
  return store.createSession({
    id: `sess_${crypto.randomBytes(5).toString('hex')}`,
    workspaceId,
    harnessId: opts.harnessId ?? 'codex-main',
    harnessKind: 'codex',
    nativeSessionId: null,
    participatingHarnesses: [opts.harnessId ?? 'codex-main'],
    contextSyncMode: 'auto',
    cwd,
    title: opts.title ?? 'Context Compression Session',
    status: 'idle',
    model: 'gpt-5',
    actualModel: null,
    modelReroutedReason: null,
    reasoningEffort: 'medium',
    permissionMode: 'manual',
    lastSeq: 0,
    usage: null,
    pendingApprovalCount: 0,
    createdAt: now,
    updatedAt: now,
  });
}

function seedTurns(
  store: HarnessMateStore,
  sessionId: string,
  turnCount: number,
  opts: {
    harnessId?: string;
    bodySize?: number;
    touchedFile?: string;
  } = {},
): void {
  const harnessId = opts.harnessId ?? 'codex-main';
  const padding = 'Detail line explaining architectural invariant and state flow. '.repeat(
    Math.max(1, Math.floor((opts.bodySize ?? 240) / 62)),
  );
  const filePath = opts.touchedFile ?? 'src/engine.ts';

  for (let i = 1; i <= turnCount; i++) {
    const turnId = `turn_${i}`;
    store.appendEvent(
      sessionId,
      'turn.started',
      { harnessId, harnessKind: 'codex' },
      turnId,
    );
    store.appendEvent(
      sessionId,
      'message.user',
      {
        text: `Turn ${i}: Refactor module ${filePath} step ${i} and verify invariants. ${padding}`,
        harnessId,
      },
      turnId,
    );
    const callId = `call_${i}`;
    store.appendEvent(
      sessionId,
      'tool.call.started',
      {
        toolCallId: callId,
        toolName: 'edit_file',
        toolKind: 'file_edit',
        summary: `Edit ${filePath}`,
        input: { path: filePath },
        harnessId,
      },
      turnId,
    );
    store.appendEvent(
      sessionId,
      'tool.call.completed',
      {
        toolCallId: callId,
        toolName: 'edit_file',
        status: 'success',
        output: `Updated ${filePath} at section ${i}`,
        diff: `--- a/${filePath}\n+++ b/${filePath}\n@@ -1,1 +1,1 @@\n+export const step${i} = ${i};`,
        harnessId,
      },
      turnId,
    );
    store.appendEvent(
      sessionId,
      'message.assistant.completed',
      {
        text: `Completed turn ${i} changes to \`${filePath}\` with passing checks. ${padding}`,
        harnessId,
      },
      turnId,
    );
    store.appendEvent(
      sessionId,
      'turn.completed',
      { harnessId, harnessKind: 'codex' },
      turnId,
    );
  }
}

function makeStubAdapter(id = 'stub-engine', kind: HarnessAdapter['kind'] = 'codex'): HarnessAdapter {
  const caps: HarnessCapabilities = {
    streaming: true,
    interactiveApproval: false,
    reasoningEfforts: ['medium'],
    permissionModes: ['plan', 'manual'],
    sessionResume: false,
    sessionFork: false,
    imageInput: false,
    subagents: false,
  };
  const info: HarnessInfo = {
    id,
    kind,
    driverId: kind,
    instanceId: id,
    displayName: 'Stub Engine',
    description: 'Stub adapter for tests',
    protocolLabel: 'stub',
    binaryPath: null,
    version: '1.0.0',
    health: 'ready',
    capabilities: caps,
    models: [{ id: 'stub-model', label: 'Stub Model', default: true }],
  };
  return {
    id,
    kind,
    displayName: 'Stub Engine',
    description: 'Stub',
    protocolLabel: 'stub',
    capabilities: caps,
    probe: async () => info,
    probePassive: async () => info,
    createSession: async (_cfg: AdapterSessionConfig): Promise<AdapterSessionHandle> => ({
      nativeSessionId: `nat_${crypto.randomBytes(4).toString('hex')}`,
      sendTurn: async () => {},
      interrupt: async () => {},
      resolveApproval: async () => {},
      dispose: async () => {},
      onEvent: () => () => {},
    }),
  };
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const daemon = activeDaemons.pop()!;
    await daemon.stop().catch(() => {});
  }
  while (openStores.length > 0) {
    const store = openStores.pop()!;
    store.close();
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // ignore Windows handle cleanup timing
    }
  }
});

describe('Phase 4.1: AI Context Compression & Symbol Index', () => {
  it('extracts multi-language symbols accurately and enforces 512KB, binary, traversal, mtime cache, and LRU caps', async () => {
    const { store, workspacePath } = createTestStore();
    const registry = new HarnessRegistry();
    const svc = new ContextCompressionService(store, registry, {
      maxWorkspaceCacheBytes: 950,
    });
    svc.setPluginActive(true);

    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    const tsFile = path.join(workspacePath, 'src', 'app.ts');
    fs.writeFileSync(
      tsFile,
      [
        '// header comment',
        'export interface ServiceConfig {',
        '  port: number;',
        '}',
        '',
        'export class EngineService {',
        '  run() { return true; }',
        '}',
        '',
        'export async function startEngine(cfg: ServiceConfig) {',
        '  return new EngineService();',
        '}',
        '',
        'export type EngineId = string;',
        'export const DEFAULT_PORT = 8080;',
      ].join('\n'),
      'utf8',
    );

    const pyFile = path.join(workspacePath, 'src', 'worker.py');
    fs.writeFileSync(
      pyFile,
      [
        '# worker module',
        'class TaskRunner:',
        '    def execute(self):',
        '        pass',
        '',
        'async def dispatch_job(job_id):',
        '    return job_id',
      ].join('\n'),
      'utf8',
    );

    const goFile = path.join(workspacePath, 'src', 'server.go');
    fs.writeFileSync(
      goFile,
      [
        'package main',
        '',
        'type Router struct {',
        '    Port int',
        '}',
        '',
        'type Handler interface {',
        '    Serve()',
        '}',
        '',
        'func (r *Router) Start() error {',
        '    return nil',
        '}',
      ].join('\n'),
      'utf8',
    );

    const rsFile = path.join(workspacePath, 'src', 'lib.rs');
    fs.writeFileSync(
      rsFile,
      [
        'pub struct Indexer {',
        '    limit: usize,',
        '}',
        '',
        'pub trait Searchable {',
        '    fn query(&self);',
        '}',
        '',
        'impl Searchable for Indexer {',
        '    fn query(&self) {}',
        '}',
        '',
        'pub async fn build_index() {}',
      ].join('\n'),
      'utf8',
    );

    const hugeFile = path.join(workspacePath, 'src', 'huge.ts');
    fs.writeFileSync(hugeFile, 'export const BIG = 1;\n'.repeat(35_000), 'utf8'); // > 512KB

    const binFile = path.join(workspacePath, 'src', 'blob.ts');
    fs.writeFileSync(binFile, Buffer.from([0x65, 0x78, 0x00, 0x01, 0x02, 0x70]));

    expect(WORKSPACE_CACHE_MAX_BYTES).toBe(20 * 1024 * 1024);

    // Quick pure helper check
    const pyCheck = extractFileSymbols(fs.readFileSync(pyFile, 'utf8'), 'src/worker.py');
    expect(pyCheck.language).toBe('python');
    expect(pyCheck.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'class', name: 'TaskRunner', line: 2 }),
        expect.objectContaining({ kind: 'def', name: 'TaskRunner.execute', line: 3 }),
        expect.objectContaining({ kind: 'def', name: 'dispatch_job', line: 6 }),
      ]),
    );

    const files = [
      'src/app.ts',
      'src/worker.py',
      'src/server.go',
      'src/lib.rs',
      'src/huge.ts',
      'src/blob.ts',
      '../outside-secret.ts',
    ];
    const res1 = await svc.buildSymbolOutline(workspacePath, files, 8000);

    expect(res1.skippedFiles).toEqual(
      expect.arrayContaining([
        { path: '../outside-secret.ts', reason: 'path_traversal_or_invalid' },
        { path: 'src/huge.ts', reason: 'exceeds_512kb_limit' },
        { path: 'src/blob.ts', reason: 'binary_file' },
      ]),
    );
    expect(res1.parsedCount).toBe(4);
    expect(res1.outlines.map((o) => o.path)).toEqual([
      'src/app.ts',
      'src/worker.py',
      'src/server.go',
      'src/lib.rs',
    ]);

    const appOutline = res1.outlines.find((o) => o.path === 'src/app.ts')!;
    expect(appOutline.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'interface', name: 'ServiceConfig', line: 2, exported: true }),
        expect.objectContaining({ kind: 'class', name: 'EngineService', line: 6, exported: true }),
        expect.objectContaining({ kind: 'function', name: 'startEngine', line: 10, exported: true }),
        expect.objectContaining({ kind: 'type', name: 'EngineId', line: 14, exported: true }),
        expect.objectContaining({ kind: 'const', name: 'DEFAULT_PORT', line: 15, exported: true }),
      ]),
    );
    const goOutline = res1.outlines.find((o) => o.path === 'src/server.go')!;
    expect(goOutline.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'struct', name: 'Router', line: 3, exported: true }),
        expect.objectContaining({ kind: 'interface', name: 'Handler', line: 7, exported: true }),
        expect.objectContaining({ kind: 'function', name: 'Start', line: 11, exported: true }),
      ]),
    );
    const rsOutline = res1.outlines.find((o) => o.path === 'src/lib.rs')!;
    expect(rsOutline.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'struct', name: 'Indexer', line: 1, exported: true }),
        expect.objectContaining({ kind: 'trait', name: 'Searchable', line: 5, exported: true }),
        expect.objectContaining({ kind: 'impl', name: 'Searchable for Indexer', line: 9 }),
        expect.objectContaining({ kind: 'function', name: 'build_index', line: 13, exported: true }),
      ]),
    );

    // LRU cap was 950 bytes, so earlier cached entries must have been evicted in KV
    const wsObj = store.listWorkspaces()[0]!;
    const remainingSymKeys = store
      .listPluginStorageKeys(wsObj.id, CONTEXT_COMPRESSION_PLUGIN_ID)
      .filter((k) => k.startsWith('sym:'));
    expect(remainingSymKeys.length).toBeLessThan(4);

    // Repeat with standard workspace byte cap to test mtimeMs cache hit + invalidation
    const svcFull = new ContextCompressionService(store, registry);
    svcFull.setPluginActive(true);
    await svcFull.buildSymbolOutline(workspacePath, ['src/app.ts'], 4000);
    const hitRes = await svcFull.buildSymbolOutline(workspacePath, ['src/app.ts'], 4000);
    expect(hitRes.cacheHits).toBe(1);
    expect(hitRes.parsedCount).toBe(0);

    // Update file -> mtimeMs/size changes -> cache invalidates and reparses
    fs.writeFileSync(
      tsFile,
      `${fs.readFileSync(tsFile, 'utf8')}\nexport function stopEngine() {}\n`,
      'utf8',
    );
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(tsFile, future, future);
    const afterEdit = await svcFull.buildSymbolOutline(workspacePath, ['src/app.ts'], 4000);
    expect(afterEdit.parsedCount).toBe(1);
    expect(afterEdit.outlines[0]!.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'stopEngine', exported: true })]),
    );
  });

  it('validates referenced file paths and annotates hallucinated or missing paths with [已删除/已重命名]', async () => {
    const { store, workspaceId, workspacePath } = createTestStore();
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspacePath, 'src', 'real.ts'), 'export const OK = true;\n', 'utf8');

    const pureCheck = validateReferencedPaths(
      'Modified `src/real.ts` and removed `src/ghost-file.ts` plus src/phantom.py.',
      workspacePath,
    );
    expect(pureCheck.referencedPaths).toEqual([
      { path: 'src/ghost-file.ts', existsAtCheck: false },
      { path: 'src/phantom.py', existsAtCheck: false },
      { path: 'src/real.ts', existsAtCheck: true },
    ]);
    expect(pureCheck.markdown).toContain('`src/real.ts`');
    expect(pureCheck.markdown).not.toContain('`src/real.ts` [已删除/已重命名]');
    expect(pureCheck.markdown).toContain('`src/ghost-file.ts` [已删除/已重命名]');
    expect(pureCheck.markdown).toContain('src/phantom.py [已删除/已重命名]');

    // Also verify end-to-end inside LLM compressRange
    const registry = new HarnessRegistry();
    registry.register(makeStubAdapter('llm-a'));
    const session = seedSession(store, workspaceId, workspacePath);
    seedTurns(store, session.id, 3, { touchedFile: 'src/real.ts' });

    const svc = new ContextCompressionService(store, registry, {
      llmSummarizer: async () =>
        'Updated `src/real.ts` and referenced hallucinated `src/nonexistent-module.ts`.',
    });
    svc.setPluginActive(true);
    svc.updateConfig({ summarizerInstanceId: 'llm-a' });

    const result = await svc.compressRange(session.id, 1, store.getSession(session.id)!.lastSeq, 2000);
    expect(result.usedLlm).toBe(true);
    expect(result.chunks[0]!.summaryMarkdown).toContain('`src/nonexistent-module.ts` [已删除/已重命名]');
    expect(result.chunks[0]!.referencedPaths).toEqual(
      expect.arrayContaining([
        { path: 'src/real.ts', existsAtCheck: true },
        { path: 'src/nonexistent-module.ts', existsAtCheck: false },
      ]),
    );
  });

  it('makes 0 external LLM calls by default and hits SHA-256 cache on repeated compressRange', async () => {
    const { store, workspaceId, workspacePath } = createTestStore();
    const registry = new HarnessRegistry();
    let llmInvokeCount = 0;
    const svc = new ContextCompressionService(store, registry, {
      llmSummarizer: async () => {
        llmInvokeCount++;
        return 'Should not be called in zero-cost mode';
      },
    });
    svc.setPluginActive(true);

    const session = seedSession(store, workspaceId, workspacePath);
    seedTurns(store, session.id, 12, { bodySize: 600 });
    const lastSeq = store.getSession(session.id)!.lastSeq;

    const first = await svc.compressRange(session.id, 1, lastSeq, 2000);
    expect(llmInvokeCount).toBe(0);
    expect(first.usedLlm).toBe(false);
    expect(first.llmCallsMade).toBe(0);
    expect(first.chunks.length).toBe(2); // 10 + 2 turns
    expect(first.cacheHits).toBe(0);

    const second = await svc.compressRange(session.id, 1, lastSeq, 2000);
    expect(llmInvokeCount).toBe(0);
    expect(second.cacheHits).toBe(2);
    expect(second.chunks.every((c) => c.cacheHit)).toBe(true);
    expect(second.combinedMarkdown).toBe(first.combinedMarkdown);
  });

  it('enforces daily/budget caps and degrades gracefully within timeout on 500 error or hang', async () => {
    const { store, workspaceId, workspacePath } = createTestStore();
    const registry = new HarnessRegistry();
    registry.register(makeStubAdapter('llm-test'));

    const emittedEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];
    let mode: 'ok' | 'error500' | 'hang' = 'ok';
    let callCount = 0;

    const svc = new ContextCompressionService(store, registry, {
      llmSummarizer: async ({ signal }) => {
        callCount++;
        if (mode === 'error500') {
          throw new Error('HTTP 500 Upstream Summarizer Error');
        }
        if (mode === 'hang') {
          return await new Promise<string>((_, reject) => {
            signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
          });
        }
        return `Concise LLM digest call #${callCount}`;
      },
    });
    svc.setPluginActive(true);
    svc.attachHooks({
      emitEvent: (_sid, type, payload) => {
        emittedEvents.push({ type, payload });
      },
    });

    const session = seedSession(store, workspaceId, workspacePath);
    seedTurns(store, session.id, 4, { bodySize: 300 });
    const lastSeq = store.getSession(session.id)!.lastSeq;

    // 1. 500 Error fallback
    mode = 'error500';
    svc.updateConfig({ summarizerInstanceId: 'llm-test', timeoutMs: 200, dailyCallLimit: 1 });
    const errRes = await svc.compressRange(session.id, 1, lastSeq, 1500);
    expect(errRes.fallback).toBe(true);
    expect(errRes.fallbackReason).toBe('adapter_error');
    expect(errRes.usedLlm).toBe(false);
    expect(errRes.combinedMarkdown.length).toBeGreaterThan(20);
    expect(emittedEvents.some((e) => e.type === 'compression.fallback_triggered')).toBe(true);

    // 2. Timeout hang fallback
    mode = 'hang';
    const timeoutStart = performance.now();
    const timeoutRes = await svc.compressRange(session.id, 1, lastSeq, 1500, { forceRecompute: true });
    const timeoutElapsed = performance.now() - timeoutStart;
    expect(timeoutElapsed).toBeLessThan(800);
    expect(timeoutRes.fallback).toBe(true);
    expect(timeoutRes.fallbackReason).toBe('timeout');
    expect(timeoutRes.usedLlm).toBe(false);

    // 3. Budget / daily limit enforcement (1 allowed call -> 2nd exceeds limit with 0 extra calls)
    mode = 'ok';
    const beforeCapCount = callCount;
    const okRes = await svc.compressRange(session.id, 1, lastSeq, 1500, { forceRecompute: true });
    expect(okRes.usedLlm).toBe(true);
    expect(okRes.fallback).toBe(false);
    expect(callCount).toBe(beforeCapCount + 1);

    const cappedRes = await svc.compressRange(session.id, 1, lastSeq, 1500, { forceRecompute: true });
    expect(callCount).toBe(beforeCapCount + 1); // MUST NOT call external LLM once cap is reached
    expect(cappedRes.fallback).toBe(true);
    expect(cappedRes.fallbackReason).toBe('budget_exceeded');
    expect(cappedRes.usedLlm).toBe(false);

    // 4. ContextCompiler degrades in < 50ms when compressor throws and preserves L0/L1
    const ledger = new TaskLedgerService(store, () => undefined);
    const taskState = ledger.getOrCreate(store.getSession(session.id)!);
    ledger.updateManual(store.getSession(session.id)!, {
      objective: 'Keep L1 Objective Authoritative',
      pinnedFacts: ['NEVER_OVERWRITE_TRUTH'],
    });
    expect(taskState.sessionId).toBe(session.id);

    const throwingCompressor: ContextCompressorProvider = {
      isEnabled: () => true,
      getConfig: () => svc.getConfig(),
      compressRange: async () => {
        throw new Error('Simulated compressor crash');
      },
      buildSymbolOutline: async () => ({
        outlines: [],
        markdown: '',
        skippedFiles: [],
        cacheHits: 0,
        parsedCount: 0,
      }),
    };
    const compiler = new ContextCompiler(
      store,
      ledger,
      { budgetTokens: 2200, autoAttach: true },
      () => undefined,
      new PluginEvents(() => {}),
      undefined,
      undefined,
      () => throwingCompressor,
    );

    // Warm one baseline compile so V8 JIT / SQLite prepared statements do not skew fallback delta
    const baselineCompiler = new ContextCompiler(
      store,
      ledger,
      { budgetTokens: 2200, autoAttach: true },
      () => undefined,
      new PluginEvents(() => {}),
    );
    await baselineCompiler.compile({
      session: store.getSession(session.id)!,
      targetHarnessId: 'codex-main',
      targetHarnessKind: 'codex',
      binding: null,
      budgetTokens: 2200,
    });

    const compileStart = performance.now();
    const packet = await compiler.compile({
      session: store.getSession(session.id)!,
      targetHarnessId: 'codex-main',
      targetHarnessKind: 'codex',
      binding: null,
      budgetTokens: 2200,
    });
    expect(performance.now() - compileStart).toBeLessThan(50);
    expect(packet.deltaMarkdown).toContain('Workspace Truth Anchor');
    expect(packet.deltaMarkdown).toContain('Keep L1 Objective Authoritative');
    expect(packet.deltaMarkdown).toContain('NEVER_OVERWRITE_TRUTH');
    expect(packet.deltaMarkdown).toContain('Turn 1'); // deterministic skeleton fallback
  });

  it('handles 100-turn session -> 32k window compression >= 6x with < 120ms cached compile and zero disabled regression', async () => {
    const dataDir = makeTempDir('hm-cmp-daemon-');
    const workspacePath = makeTempDir('hm-cmp-repo-');
    fs.mkdirSync(path.join(workspacePath, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(workspacePath, 'src', 'core.ts'),
      'export class CoreKernel {\n  compile(input: string) { return input; }\n}\n',
      'utf8',
    );

    const daemon = createDaemon({
      dataDir,
      port: 0,
      customAdapters: [makeStubAdapter('codex', 'codex')],
      webDistDir: null,
    });
    activeDaemons.push(daemon);
    await daemon.pluginManager.reloadAll();
    await daemon.app.ready();

    // 1. Plugin is disabled by default; REST compress fails 409, core.context-bridge remains ACTIVE
    const pluginsRes = await daemon.app.inject({ method: 'GET', url: '/api/v1/plugins' });
    const pluginsPayload = pluginsRes.json() as {
      plugins?: Array<{ id: string; enabled: boolean; runtimeState?: string }>;
    };
    const plugins = Array.isArray(pluginsPayload)
      ? pluginsPayload
      : (pluginsPayload.plugins ?? []);
    const compPlugin = plugins.find((p) => p.id === CONTEXT_COMPRESSION_PLUGIN_ID);
    const bridgePlugin = plugins.find((p) => p.id === 'core.context-bridge');
    expect(compPlugin?.enabled).toBe(false);
    expect(bridgePlugin?.enabled).toBe(true);
    expect(bridgePlugin?.runtimeState).toBe('ACTIVE');

    const wsRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/workspaces',
      payload: { name: 'Bench Repo', rootPath: workspacePath },
    });
    const workspace = (wsRes.json() as { workspace: { id: string } }).workspace;

    const sessRes = await daemon.app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      payload: {
        workspaceId: workspace.id,
        harnessId: 'codex',
        title: '100-Turn Benchmark Session',
      },
    });
    const session = (sessRes.json() as { session: Session }).session;

    const disabledCompress = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/compression/compress`,
      payload: {},
    });
    expect(disabledCompress.statusCode).toBe(409);
    expect((disabledCompress.json() as { code: string }).code).toBe('E_PLUGIN_DISABLED');

    // Seed 100 verbose turns in Core SQLite
    seedTurns(daemon.store, session.id, 100, {
      harnessId: 'codex',
      bodySize: 1800,
      touchedFile: 'src/core.ts',
    });
    const seededSession = daemon.store.getSession(session.id)!;
    const baselineEventCount = daemon.store.getEventsAfter(session.id, 0, 5000).length;
    expect(baselineEventCount).toBe(601); // 1 initial session.status + 100 * 6 turn events

    // Baseline handoff compile when compression plugin is disabled still succeeds
    const disabledPreview = await daemon.app.inject({
      method: 'GET',
      url: `/api/v1/sessions/${session.id}/context-preview?targetHarnessId=codex`,
    });
    expect(disabledPreview.statusCode).toBe(200);

    // 2. Enable hm.plugin.context-compression (via PluginManager to avoid probing host CLI binaries)
    await daemon.pluginManager.togglePlugin(CONTEXT_COMPRESSION_PLUGIN_ID, true);
    expect(daemon.pluginManager.isPluginEnabled(CONTEXT_COMPRESSION_PLUGIN_ID)).toBe(true);

    // 3. Compress via REST endpoint (default zero-cost local mode)
    const compressRes = await daemon.app.inject({
      method: 'POST',
      url: `/api/v1/sessions/${session.id}/compression/compress`,
      payload: { budgetChars: 6000 },
    });
    expect(compressRes.statusCode).toBe(200);
    const body = compressRes.json() as {
      result: { chunks: unknown[]; usedLlm: boolean; compressionRatio: number };
      status: { enabled: boolean; chunks: unknown[]; symbolOutlines: Array<{ path: string }> };
    };
    expect(body.result.usedLlm).toBe(false);
    expect(body.result.compressionRatio).toBeGreaterThanOrEqual(6);
    expect(body.status.enabled).toBe(true);
    expect(body.status.chunks.length).toBe(10); // 100 turns / 10 per chunk

    // Check GET/PUT config REST APIs
    const putCfg = await daemon.app.inject({
      method: 'PUT',
      url: '/api/v1/compression/config',
      payload: { dailyCallLimit: 25, backgroundRollupEnabled: false },
    });
    expect(putCfg.statusCode).toBe(200);
    const getCfg = await daemon.app.inject({ method: 'GET', url: '/api/v1/compression/config' });
    expect((getCfg.json() as { config: { dailyCallLimit: number; backgroundRollupEnabled: boolean } }).config.dailyCallLimit).toBe(25);
    expect((getCfg.json() as { config: { backgroundRollupEnabled: boolean } }).config.backgroundRollupEnabled).toBe(false);

    // 4. Cached ContextCompiler compile benchmark on 100-turn -> ~32k (8000 tokens) window
    const activeCompressor = daemon.pluginManager.host.get<ContextCompressorProvider>('compressor')!;
    const daemonCompiler = daemon.pluginManager.host.get<ContextCompiler>('handoff')!;
    const benchLedger = new TaskLedgerService(daemon.store, () => undefined);
    const benchCompiler = new ContextCompiler(
      daemon.store,
      benchLedger,
      { budgetTokens: 8_000, autoAttach: true },
      () => undefined,
      new PluginEvents(() => {}),
      undefined,
      undefined,
      () => activeCompressor,
    );

    // First compile warms exact overflow slice chunks if last partial chunk changed
    const livePacket = await daemonCompiler.compile({
      session: seededSession,
      targetHarnessId: 'codex',
      targetHarnessKind: 'codex',
      binding: null,
      budgetTokens: 8_000,
    });
    expect(livePacket.deltaMarkdown).toContain('Hot File Symbol Outlines');
    expect(livePacket.deltaMarkdown).toContain('CoreKernel');

    // Warm ledger & redactor paths once before timing cached compile latency
    await benchCompiler.compile({
      session: seededSession,
      targetHarnessId: 'codex',
      targetHarnessKind: 'codex',
      binding: null,
      budgetTokens: 8_000,
    });

    const t0 = performance.now();
    const cachedPacket = await benchCompiler.compile({
      session: seededSession,
      targetHarnessId: 'codex',
      targetHarnessKind: 'codex',
      binding: null,
      budgetTokens: 8_000,
    });
    const cachedLatencyMs = performance.now() - t0;

    expect(cachedLatencyMs).toBeLessThan(120);
    expect(cachedPacket.deltaMarkdown).toContain('Hot File Symbol Outlines');
    expect(cachedPacket.deltaMarkdown).toContain('CoreKernel');
    expect(cachedPacket.deltaMarkdown).toContain('Workspace Truth Anchor');

    // Original Core SQLite turn history MUST be 100% untouched (ignoring compression events)
    const turnUserEvents = daemon.store
      .getEventsAfter(session.id, 0, 5000)
      .filter((e: CanonicalEvent) => !e.type.startsWith('compression.'));
    expect(turnUserEvents.length).toBe(baselineEventCount);

    // 5. Clear cache endpoint
    const clearRes = await daemon.app.inject({
      method: 'DELETE',
      url: `/api/v1/sessions/${session.id}/compression/cache`,
    });
    expect(clearRes.statusCode).toBe(200);
    expect((clearRes.json() as { clearedCount: number }).clearedCount).toBeGreaterThanOrEqual(10);
  }, 25_000);
});
