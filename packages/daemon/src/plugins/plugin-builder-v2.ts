import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  PluginApiError,
  PluginManifestV4Schema,
} from '@harnessmate/plugin-api';
import {
  PluginManifestSchema,
  type BuilderAttemptLog,
  type BuilderV2GenerateRequest,
  type BuilderV2InstallRequest,
  type BuilderV2Result,
  type BuilderVerificationStep,
  type InstalledPluginInfo,
  type PluginBuilderTemplate,
  type PluginManifest,
  type PluginStaticAuditReport,
} from '@harnessmate/protocol';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { AdapterSessionHandle } from '../harnesses/types.js';
import type { PluginAuthoring } from './plugin-authoring.js';
import type { PluginManager } from './plugin-manager.js';
import { hashFiles, packageFromFilesRecord } from './plugin-package.js';
import { auditPluginPackage } from './plugin-static-audit.js';
import { buildSandboxedPluginHtml } from './plugin-ui.js';

const execFileAsync = promisify(execFile);

function resolveModuleDir(): string {
  try {
    if (typeof import.meta?.url === 'string' && import.meta.url) {
      return path.dirname(fileURLToPath(import.meta.url));
    }
  } catch {
    // fallback for CommonJS bundle (daemon.cjs)
  }
  return typeof __dirname === 'string' ? __dirname : process.cwd();
}

const MODULE_DIR = resolveModuleDir();
const REPO_ROOT = path.resolve(MODULE_DIR, '../../../..');

function resolveDefaultContextDocPath(): string {
  const candidates = [
    path.join(REPO_ROOT, 'docs', 'plugin-api', 'ai-builder-context.md'),
    path.join(MODULE_DIR, 'ai-builder-context.md'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? candidates[0]!;
}

function resolveSdkTestingEntry(): string | null {
  const candidates = [
    path.join(REPO_ROOT, 'packages', 'plugin-sdk', 'dist', 'testing.js'),
    path.join(MODULE_DIR, 'plugin-sdk-testing.mjs'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

const DEFAULT_CONTEXT_DOC_PATH = resolveDefaultContextDocPath();

const FALLBACK_CONTEXT_SUMMARY = [
  '# HarnessMate Plugin SDK Summary',
  '- Export `export function apply(ctx, config) {}` from `index.mjs` (ESM).',
  '- Declare `harnessmate-plugin.json` with `apiVersion: 4`, `engines: { pluginApi: "^4.0.0" }`, minimal `permissions`, and `contributes.slots` if UI is needed.',
  '- Use `ctx.runtime.spawnCli` instead of `child_process`. Use `ctx.net.fetch`/`openStream` with declared `net:<host>`.',
  '- Keep HTML UI strictly local without external `<script src="http...">`, `javascript:`, or inline `onclick=` attributes.',
].join('\n');

const TEMPLATE_GUIDANCE: Record<PluginBuilderTemplate, string> = {
  isolated:
    'Template `isolated`: generate `harnessmate-plugin.json` (main: "index.mjs", minimal permissions), `index.mjs` exporting `apply(ctx)`, and any local `ui/*.html` slot files using `window.harnessMate` + CSS variables.',
  'ui-slot':
    'Template `ui-slot`: generate `harnessmate-plugin.json` (`contributes.slots` pointing to local `ui/panel.html`, optional `index.mjs` only if needed) and CSP-clean `ui/panel.html` using `window.harnessMate` + CSS variables.',
  service:
    'Template `service`: generate `harnessmate-plugin.json` (`main: "index.mjs"`, namespaced `provides: ["<org>.<svc>"]`, never override core services) and `index.mjs` calling `ctx.provide(...)`.',
  'harness-adapter':
    'Template `harness-adapter`: generate `harnessmate-plugin.json` (`category: "harness"`, `main: "index.mjs"`, `permissions: ["harness:driver:register", ...]`, slots for `chat.block` and `harness.settings`), `index.mjs` calling `ctx.harnesses.registerDriver({ driverId, capabilities, capabilitiesV2, presentation, probe, probePassive?, createSession })` and using `ctx.runtime.spawnCli` / `ctx.net.openStream`, plus CSP-clean `ui/*.html`.',
};

export interface TierClassification {
  tier: 'tier1' | 'tier2';
  template?: PluginBuilderTemplate;
  reason: string;
}

/**
 * Classifies natural-language plugin requirements into Tier 1 (fast declarative JSON)
 * vs Tier 2 (full code + sandbox UI / harness adapter engineering).
 */
export function classifyPluginBuilderTier(
  description: string,
  opts?: { tier?: 'auto' | 'tier1' | 'tier2'; template?: PluginBuilderTemplate },
): TierClassification {
  if (opts?.tier === 'tier1') {
    return { tier: 'tier1', reason: '用户显式选择 Tier 1（声明式快速清单模式）' };
  }
  if (opts?.tier === 'tier2') {
    return {
      tier: 'tier2',
      template: opts.template ?? inferTier2Template(description),
      reason: '用户显式选择 Tier 2（完整代码插件工程模式）',
    };
  }

  const text = description.toLowerCase();

  // Check Harness Adapter intent first (highest specialization; strictly vendor-agnostic)
  if (
    /\b(adapter|harness\s*driver|harness\s*adapter|registerdriver|spawncli|non-acp|external\s*cli|custom\s*driver|external\s*engine)\b/i.test(text) ||
    /(适配器|驱动插件|接入.{0,8}(引擎|cli|模型)|新\s*harness)/i.test(description)
  ) {
    return {
      tier: 'tier2',
      template: opts?.template ?? 'harness-adapter',
      reason: '检测到自定义 Harness 引擎适配器需求，自动路由至 Tier 2（harness-adapter）',
    };
  }

  // Check Service provider intent
  if (
    /\b(ctx\.provide|provides|service\s*plugin)\b/i.test(text) ||
    /(提供.{0,6}服务|自定义服务|公共服务提供)/i.test(description)
  ) {
    return {
      tier: 'tier2',
      template: opts?.template ?? 'service',
      reason: '检测到第三方服务提供需求，自动路由至 Tier 2（service）',
    };
  }

  // Check Code + UI / API / Hook / Event / Storage intent
  const hasCodeOrApi =
    /\b(http|https|sse|fetch|api|webhook|stream|onredact|redact|secrets?|storage|index\.mjs|mcp\s*tool|custom\s*code|script|javascript)\b/i.test(
      text,
    ) ||
    /(外部\s*api|脱敏|流式|自定义代码|代码插件|交互式卡片|自定义逻辑|凭据|密钥)/i.test(description);

  const hasSandboxUiSlot =
    /\b(html|css|iframe|ui\s*slot|chat\.block|composer\.traits|harness\.settings|inspector\.diff|session\.sidebar\.badge)\b/i.test(
      text,
    ) ||
    /(沙箱\s*ui|ui\s*插槽|自定义卡片|渲染卡片|html\s*面板)/i.test(description);

  if (hasCodeOrApi || opts?.template === 'isolated') {
    return {
      tier: 'tier2',
      template: opts?.template ?? 'isolated',
      reason: '检测到自定义代码逻辑 / 外部 API / 事件处理需求，自动路由至 Tier 2（isolated）',
    };
  }

  if (hasSandboxUiSlot || opts?.template === 'ui-slot') {
    return {
      tier: 'tier2',
      template: opts?.template ?? 'ui-slot',
      reason: '检测到沙箱 HTML UI 插槽需求，自动路由至 Tier 2（ui-slot）',
    };
  }

  return {
    tier: 'tier1',
    reason: '纯斜杠命令 / 声明式数据面板需求，路由至 Tier 1 快速声明式生成',
  };
}

function inferTier2Template(description: string): PluginBuilderTemplate {
  const c = classifyPluginBuilderTier(description, { tier: 'auto' });
  return c.template ?? 'isolated';
}

function normalizeRelativePackagePath(rawPath: string): string {
  const cleaned = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (
    !cleaned ||
    cleaned.startsWith('/') ||
    cleaned.includes('\0') ||
    cleaned.split('/').some((seg) => !seg || seg === '.' || seg === '..')
  ) {
    throw new PluginApiError('E_PERMISSION_DENIED', `生成包包含非法相对路径: ${rawPath}`);
  }
  return cleaned;
}

function extractJsonObject(rawText: string): unknown {
  const trimmed = rawText.trim();
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Attempt to locate outermost JSON object braces if the model added surrounding commentary
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    throw new Error('模型未返回有效的 JSON 格式代码包 ({ "manifest": ..., "files": ... })');
  }
}

export interface StagedBuilderDraft {
  draftId: string;
  attemptDir: string;
  digest: string;
  manifest: Record<string, unknown>;
  files: Record<string, string>;
  audit: PluginStaticAuditReport;
  steps: BuilderVerificationStep[];
  attempts: BuilderAttemptLog[];
  createdAt: number;
}

const DRY_RUN_BOOTSTRAP_STUB =
  "const chunks=[];process.stdin.on('data',(c)=>chunks.push(c));process.stdin.on('end',async()=>{const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));const{createMockPluginHost}=await import(payload.testingUrl);const host=createMockPluginHost({pluginId:payload.pluginId,permissions:payload.permissions});const mod=await import(payload.entryUrl);const pluginModule=mod.default&&typeof mod.default.apply==='function'?mod.default:mod;if(typeof pluginModule.apply!=='function')throw new Error('Entry file must export apply(ctx)');await host.activate(pluginModule,{});for(const driver of host.drivers.values()){if(typeof driver.probe==='function')await driver.probe();}const summary={ok:true,drivers:[...host.drivers.keys()],slots:[...host.slots.keys()],commands:[...host.commands.keys()],tools:[...host.tools.keys()],services:[...host.services.keys()]};host.dispose();process.stdout.write(JSON.stringify(summary)+'\\n');});";

export class PluginBuilderV2 {
  private active?: AbortController;
  private readonly stagedDrafts = new Map<string, StagedBuilderDraft>();
  private readonly stagingRoot: string;

  constructor(
    private readonly dataDir: string,
    private readonly registry: HarnessRegistry,
    private readonly authoring: PluginAuthoring,
    private readonly pluginManager: PluginManager,
    private readonly contextDocPath: string = DEFAULT_CONTEXT_DOC_PATH,
  ) {
    this.stagingRoot = path.join(dataDir, 'builder-v2-staging');
  }

  cancel(): void {
    this.active?.abort(new Error('AI Plugin Builder v2 生成已取消'));
    this.authoring.cancel();
  }

  loadBuilderContextPack(): string {
    try {
      if (fs.existsSync(this.contextDocPath)) {
        return fs.readFileSync(this.contextDocPath, 'utf8');
      }
    } catch {
      // ignore and fall through to fallback
    }
    return FALLBACK_CONTEXT_SUMMARY;
  }

  getStagedDraft(draftId: string): StagedBuilderDraft | undefined {
    return this.stagedDrafts.get(draftId);
  }

  async generate(
    req: BuilderV2GenerateRequest,
    cwd: string,
    requestSignal: AbortSignal,
  ): Promise<BuilderV2Result> {
    const classification = classifyPluginBuilderTier(req.description, {
      tier: req.tier,
      template: req.template,
    });

    // Tier 1: Preserve existing PluginAuthoring fast JSON draft flow (100% compatible)
    if (classification.tier === 'tier1') {
      const base = req.editing
        ? this.pluginManager.getAuthoringBase(req.editing.id, req.editing.digest)
        : undefined;
      const manifest = await this.authoring.generate(
        {
          description: req.description,
          harnessId: req.harnessId,
          workspaceId: req.workspaceId,
          model: req.model,
          previous: req.previous as PluginManifest | undefined,
          editing: req.editing,
        },
        cwd,
        requestSignal,
        base,
      );
      if (req.editing) this.pluginManager.getAuthoringBase(req.editing.id, req.editing.digest);
      this.pluginManager.validateManifest(manifest);
      return {
        tierUsed: 'tier1',
        classificationReason: classification.reason,
        verified: true,
        manifest: manifest as unknown as Record<string, unknown>,
      };
    }

    // Tier 2: Full code plugin generation + 4-step sandbox pipeline + max 3 self-repair rounds
    if (this.active) {
      throw new PluginApiError('E_CONFLICT', '已有插件工程正在生成，请稍候或取消当前任务');
    }

    const adapter = this.registry.get(req.harnessId);
    if (!adapter) {
      throw new PluginApiError('E_SERVICE_UNAVAILABLE', '所选 Harness 不可用');
    }

    const template = classification.template ?? 'isolated';
    const maxAttempts = Math.min(3, Math.max(1, req.maxAttempts ?? 3));
    const draftId = `b2_${crypto.randomBytes(6).toString('hex')}`;
    const draftRoot = path.join(this.stagingRoot, draftId);
    fs.mkdirSync(draftRoot, { recursive: true });

    const controller = new AbortController();
    this.active = controller;
    const signal = AbortSignal.any([controller.signal, requestSignal, AbortSignal.timeout(180_000)]);

    const contextPack = this.loadBuilderContextPack();
    const attempts: BuilderAttemptLog[] = [];
    let lastErrorFeedback: string | null = null;
    let lastGeneratedPayload: unknown = null;
    let lastManifest: Record<string, unknown> | undefined;
    let lastFiles: Record<string, string> | undefined;
    let lastAudit: PluginStaticAuditReport | undefined;
    let lastSteps: BuilderVerificationStep[] = [];

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        signal.throwIfAborted();
        const attemptStart = Date.now();
        const attemptDir = path.join(draftRoot, `attempt-${attempt}`);
        fs.mkdirSync(attemptDir, { recursive: true });

        const prompt = this.buildTier2Prompt({
          description: req.description,
          template,
          contextPack,
          pluginId: req.pluginId,
          name: req.name,
          attempt,
          previousPayload: lastGeneratedPayload,
          errorFeedback: lastErrorFeedback,
        });

        const rawReply = await this.invokeHarnessSingleTurn(adapter, cwd, req.model, prompt, signal);

        let attemptFiles: Record<string, string> = {};
        let attemptManifest: Record<string, unknown> = {};
        let parseError: string | null = null;

        try {
          const parsedObj = extractJsonObject(rawReply) as {
            manifest?: Record<string, unknown>;
            files?: Record<string, unknown>;
          };
          if (!parsedObj || typeof parsedObj !== 'object' || !parsedObj.files || typeof parsedObj.files !== 'object') {
            throw new Error('返回 JSON 必须包含 files 对象映射 ({ "manifest": {...}, "files": { ... } })');
          }
          for (const [k, v] of Object.entries(parsedObj.files)) {
            if (typeof v !== 'string') {
              throw new Error(`文件 "${k}" 的内容必须是 UTF-8 字符串`);
            }
            const clean = normalizeRelativePackagePath(k);
            attemptFiles[clean] = v;
          }
          if (parsedObj.manifest && typeof parsedObj.manifest === 'object') {
            attemptManifest = parsedObj.manifest;
            attemptFiles['harnessmate-plugin.json'] = JSON.stringify(attemptManifest, null, 2) + '\n';
          } else if (attemptFiles['harnessmate-plugin.json']) {
            attemptManifest = JSON.parse(attemptFiles['harnessmate-plugin.json']!) as Record<string, unknown>;
          } else {
            throw new Error('返回 JSON 必须包含 manifest 对象或 files["harnessmate-plugin.json"]');
          }
          lastGeneratedPayload = { manifest: attemptManifest, files: attemptFiles };
        } catch (err) {
          parseError = err instanceof Error ? err.message : String(err);
        }

        if (parseError) {
          const step: BuilderVerificationStep = {
            step: 'manifest_schema',
            label: '1. Manifest Schema & 结构检查',
            status: 'failed',
            durationMs: Date.now() - attemptStart,
            details: parseError,
            errors: [parseError],
          };
          lastSteps = [step];
          attempts.push({
            attempt,
            durationMs: Date.now() - attemptStart,
            passed: false,
            steps: lastSteps,
            errorSummary: parseError,
          });
          lastErrorFeedback = `Attempt ${attempt} output could not be parsed:\n- ${parseError}\nReturn strictly ONE JSON object { "manifest": {...}, "files": { "harnessmate-plugin.json": "...", ... } }.`;
          continue;
        }

        // Materialize staged files strictly inside isolated attemptDir
        for (const [rel, content] of Object.entries(attemptFiles)) {
          const full = path.join(attemptDir, rel);
          const relCheck = path.relative(attemptDir, full);
          if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
            throw new PluginApiError('E_PERMISSION_DENIED', `路径越界被拦截: ${rel}`);
          }
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content, 'utf8');
        }

        const verification = await this.verifyStagedPackage(attemptDir, attemptFiles, attemptManifest, cwd);
        lastManifest = verification.normalizedManifest ?? attemptManifest;
        lastFiles = attemptFiles;
        lastAudit = verification.audit;
        lastSteps = verification.steps;

        const attemptErrors = verification.steps.flatMap((s) =>
          s.status === 'failed' ? s.errors.map((e) => `[${s.step}] ${e}`) : [],
        );
        const passed = verification.passed;

        attempts.push({
          attempt,
          durationMs: Date.now() - attemptStart,
          passed,
          steps: verification.steps,
          ...(attemptErrors.length > 0 ? { errorSummary: attemptErrors.slice(0, 6).join(' | ') } : {}),
        });

        if (passed && verification.audit) {
          const fileBuffers = new Map<string, Buffer>(
            Object.entries(attemptFiles)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, Buffer.from(v, 'utf8')]),
          );
          const digest = hashFiles(fileBuffers);
          const staged: StagedBuilderDraft = {
            draftId,
            attemptDir,
            digest,
            manifest: lastManifest,
            files: attemptFiles,
            audit: verification.audit,
            steps: verification.steps,
            attempts,
            createdAt: Date.now(),
          };
          this.stagedDrafts.set(draftId, staged);

          return {
            tierUsed: 'tier2',
            classificationReason: classification.reason,
            templateUsed: template,
            draftId,
            digest,
            verified: true,
            manifest: lastManifest,
            files: attemptFiles,
            audit: verification.audit,
            steps: verification.steps,
            attempts,
          };
        }

        lastErrorFeedback = [
          `Attempt ${attempt} failed sandbox verification. Fix EVERY issue below carefully while preserving intended features:`,
          ...attemptErrors.map((e) => `- ${e}`),
        ].join('\n');
      }

      // Hard circuit-breaker after maxAttempts (3 rounds)
      return {
        tierUsed: 'tier2',
        classificationReason: classification.reason,
        templateUsed: template,
        draftId,
        verified: false,
        manifest: lastManifest,
        files: lastFiles,
        audit: lastAudit,
        steps: lastSteps,
        attempts,
        error: `已达最大自动修复轮次（${maxAttempts} 轮），验证仍未通过，已熔断停止：${attempts[attempts.length - 1]?.errorSummary ?? '未知错误'}`,
      };
    } finally {
      this.active = undefined;
    }
  }

  async verifyStagedPackage(
    attemptDir: string,
    files: Record<string, string>,
    manifestObj: Record<string, unknown>,
    workspaceRoot: string,
  ): Promise<{
    passed: boolean;
    normalizedManifest?: Record<string, unknown>;
    audit: PluginStaticAuditReport;
    steps: BuilderVerificationStep[];
  }> {
    const steps: BuilderVerificationStep[] = [];
    let normalizedManifest: PluginManifest | undefined;

    // Step 1: Manifest V4/V5 Schema & package integrity
    const s1Start = Date.now();
    const s1Errors: string[] = [];
    try {
      const parsedV4 = PluginManifestV4Schema.parse(manifestObj);
      normalizedManifest = PluginManifestSchema.parse(parsedV4);
      packageFromFilesRecord(files);
      this.pluginManager.validateManifest(normalizedManifest);
    } catch (err) {
      s1Errors.push(err instanceof Error ? err.message : String(err));
    }
    steps.push({
      step: 'manifest_schema',
      label: '1. Manifest V4/V5 Schema & 文件引用校验',
      status: s1Errors.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - s1Start,
      details:
        s1Errors.length === 0
          ? `清单结构合法（ID: ${String(manifestObj.id ?? '')}）`
          : s1Errors.join('; '),
      errors: s1Errors,
    });

    // Step 2: Static Security Audit + Node ESM syntax check (--check)
    const s2Start = Date.now();
    const audit = auditPluginPackage(files, manifestObj);
    const s2Errors: string[] = audit.blockingIssues.map(
      (iss) => `${iss.code}${iss.file ? ` (${iss.file}${iss.line ? `:${iss.line}` : ''})` : ''}: ${iss.message}`,
    );

    const codePaths = Object.keys(files).filter((f) => /\.(?:mjs|js|cjs)$/i.test(f));
    for (const rel of codePaths) {
      const full = path.join(attemptDir, rel);
      try {
        await execFileAsync(process.execPath, ['--check', full], {
          timeout: 5_000,
          windowsHide: true,
        });
      } catch (err) {
        const e = err as { stderr?: string; message?: string };
        s2Errors.push(`SYNTAX_ERROR (${rel}): ${String(e.stderr || e.message || '语法检查失败').trim().slice(0, 400)}`);
      }
    }
    steps.push({
      step: 'static_audit_and_syntax',
      label: '2. 静态安全审计 & 语法校验',
      status: s2Errors.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - s2Start,
      details:
        s2Errors.length === 0
          ? `零阻断安全风险（${audit.warnings.length} 条告警），${codePaths.length} 个脚本语法通过`
          : s2Errors.join('; '),
      errors: s2Errors,
    });

    // Step 3: Isolated Mock Host Activation (`@harnessmate/plugin-sdk/testing`)
    const s3Start = Date.now();
    const s3Errors: string[] = [];
    let s3Details = '纯 UI/声明式插件，无需脚本激活';
    const entryRel =
      typeof manifestObj.main === 'string'
        ? manifestObj.main
        : typeof manifestObj.entry === 'string'
          ? manifestObj.entry
          : '';

    if (entryRel && s1Errors.length === 0 && s2Errors.length === 0) {
      const cleanedEntry = normalizeRelativePackagePath(entryRel);
      const entryFull = path.join(attemptDir, cleanedEntry);
      if (!fs.existsSync(entryFull)) {
        s3Errors.push(`找不到入口文件: ${cleanedEntry}`);
      } else {
        try {
          const dryRunRes = await this.runIsolatedMockActivation(
            attemptDir,
            entryFull,
            String(manifestObj.id ?? 'test.plugin'),
            Array.isArray(manifestObj.permissions)
              ? manifestObj.permissions.filter((p): p is string => typeof p === 'string')
              : [],
            workspaceRoot,
          );
          s3Details = `Mock 宿主激活成功（驱动: ${dryRunRes.drivers.length}, 插槽: ${dryRunRes.slots.length}, 命令: ${dryRunRes.commands.length}, 服务: ${dryRunRes.services.length}）`;
        } catch (err) {
          s3Errors.push(err instanceof Error ? err.message : String(err));
          s3Details = s3Errors[0]!;
        }
      }
    } else if (entryRel && (s1Errors.length > 0 || s2Errors.length > 0)) {
      steps.push({
        step: 'mock_host_activation',
        label: '3. 离线模拟宿主激活验证',
        status: 'skipped',
        durationMs: 0,
        details: '前置安全审计或 Schema 未通过，已跳过执行',
        errors: [],
      });
    }
    if (!entryRel || (s1Errors.length === 0 && s2Errors.length === 0)) {
      steps.push({
        step: 'mock_host_activation',
        label: '3. 离线模拟宿主激活验证',
        status: s3Errors.length === 0 ? 'passed' : 'failed',
        durationMs: Date.now() - s3Start,
        details: s3Details,
        errors: s3Errors,
      });
    }

    // Step 4: Sandboxed HTML UI CSP & Local Inline Check
    const s4Start = Date.now();
    const s4Errors: string[] = [];
    const htmlEntries = new Set<string>();
    const contributes = manifestObj.contributes as { slots?: Array<{ ui?: string }> } | undefined;
    for (const slot of contributes?.slots ?? []) {
      if (typeof slot?.ui === 'string') {
        htmlEntries.add(slot.ui.replace(/\\/g, '/').replace(/^\.\//, ''));
      }
    }
    for (const f of Object.keys(files)) {
      if (/\.(?:html|htm)$/i.test(f)) htmlEntries.add(f);
    }

    let checkedUiCount = 0;
    for (const rel of htmlEntries) {
      if (audit.blockingIssues.some((i) => i.file === rel && i.code.startsWith('AUDIT_UNSAFE_HTML'))) {
        s4Errors.push(`${rel}: HTML 包含安全审计阻断的不安全脚本或内联事件`);
        continue;
      }
      try {
        buildSandboxedPluginHtml(attemptDir, rel);
        checkedUiCount += 1;
      } catch (err) {
        s4Errors.push(`${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    steps.push({
      step: 'sandbox_ui_check',
      label: '4. 沙箱 HTML UI / CSP 打包自检',
      status: s4Errors.length === 0 ? 'passed' : 'failed',
      durationMs: Date.now() - s4Start,
      details:
        s4Errors.length === 0
          ? checkedUiCount > 0
            ? `${checkedUiCount} 个沙箱 HTML 插槽通过 CSP 本地打包校验`
            : '无 HTML 插槽文件'
          : s4Errors.join('; '),
      errors: s4Errors,
    });

    const passed = steps.every((s) => s.status === 'passed');
    return {
      passed,
      normalizedManifest: (normalizedManifest ?? manifestObj) as Record<string, unknown>,
      audit,
      steps,
    };
  }

  private async runIsolatedMockActivation(
    attemptDir: string,
    entryFull: string,
    pluginId: string,
    permissions: string[],
    workspaceRoot: string,
  ): Promise<{
    drivers: string[];
    slots: string[];
    commands: string[];
    tools: string[];
    services: string[];
  }> {
    const sdkTestingEntry = resolveSdkTestingEntry();
    if (!sdkTestingEntry) {
      throw new Error(
        `Missing built @harnessmate/plugin-sdk testing entry (checked ${path.join(REPO_ROOT, 'packages', 'plugin-sdk', 'dist', 'testing.js')} and ${path.join(MODULE_DIR, 'plugin-sdk-testing.mjs')})`,
      );
    }

    const fsReadAllow = [attemptDir, path.dirname(sdkTestingEntry)];
    for (const extraDir of [
      path.join(REPO_ROOT, 'packages'),
      path.join(REPO_ROOT, 'node_modules'),
    ]) {
      if (fs.existsSync(extraDir) && !fsReadAllow.includes(extraDir)) {
        fsReadAllow.push(extraDir);
      }
    }
    if (fs.existsSync(workspaceRoot) && !fsReadAllow.includes(workspaceRoot)) {
      fsReadAllow.push(workspaceRoot);
    }

    const args = [
      '--permission',
      ...fsReadAllow.map((dir) => `--allow-fs-read=${dir}`),
      '--max-old-space-size=128',
      '--input-type=module',
      '-e',
      DRY_RUN_BOOTSTRAP_STUB,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd: attemptDir,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        stdout += d;
      });
      child.stderr.on('data', (d: string) => {
        stderr += d;
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('模拟宿主激活超时 (8s)'));
      }, 8_000);
      timer.unref?.();

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`模拟宿主激活失败 (exit ${code}): ${stderr.trim() || stdout.trim() || '未知错误'}`));
          return;
        }
        const lines = stdout
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        const lastLine = lines[lines.length - 1] ?? '';
        try {
          resolve(JSON.parse(lastLine));
        } catch {
          reject(new Error(`模拟宿主未返回有效结果: ${stdout.trim().slice(0, 300)}`));
        }
      });

      child.stdin.write(
        JSON.stringify({
          testingUrl: pathToFileURL(sdkTestingEntry).href,
          entryUrl: pathToFileURL(entryFull).href,
          pluginId,
          permissions,
        }),
      );
      child.stdin.end();
    });
  }

  async installDraft(req: BuilderV2InstallRequest): Promise<{
    plugins: InstalledPluginInfo[];
    installedId: string;
    installMode: 'local_install' | 'dev_link';
    dirPath: string;
  }> {
    if (!req.trustCode) {
      throw new PluginApiError('E_PERMISSION_DENIED', '安装或热加载代码插件前必须显式确认安全信任授权');
    }

    let files: Record<string, string>;
    let sourceDir: string;

    if (req.draftId) {
      const staged = this.stagedDrafts.get(req.draftId);
      if (!staged) {
        throw new PluginApiError('E_INVALID_INPUT', `找不到或已过期的草稿ID: ${req.draftId}`);
      }
      if (staged.digest !== req.expectedDigest) {
        throw new PluginApiError('E_CONFLICT', '草稿内容摘要已变更，请重新审阅安全报告');
      }
      files = req.files ?? staged.files;
      sourceDir = staged.attemptDir;
    } else if (req.files) {
      files = req.files;
      sourceDir = path.join(this.stagingRoot, `direct-${crypto.randomBytes(5).toString('hex')}`);
      fs.mkdirSync(sourceDir, { recursive: true });
      for (const [rawKey, content] of Object.entries(files)) {
        const clean = normalizeRelativePackagePath(rawKey);
        const full = path.join(sourceDir, clean);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
    } else {
      throw new PluginApiError('E_INVALID_INPUT', '请提供 draftId 或完整 files 映射');
    }

    const actualBuffers = new Map<string, Buffer>(
      Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [normalizeRelativePackagePath(k), Buffer.from(v, 'utf8')]),
    );
    const actualDigest = hashFiles(actualBuffers);
    if (actualDigest !== req.expectedDigest) {
      throw new PluginApiError('E_CONFLICT', '插件包摘要不匹配，请重新校验后安装');
    }

    const audit = auditPluginPackage(files);
    if (!audit.passed) {
      throw new PluginApiError(
        'E_PERMISSION_DENIED',
        `静态安全审计拦截了安装：${audit.blockingIssues.map((i) => i.message).join('; ')}`,
      );
    }

    const manifestJson = files['harnessmate-plugin.json'];
    if (!manifestJson) {
      throw new PluginApiError('E_INVALID_INPUT', '缺少 harnessmate-plugin.json');
    }
    const manifest = PluginManifestSchema.parse(JSON.parse(manifestJson));

    if (req.installMode === 'dev_link') {
      const destDir = req.targetDir?.trim()
        ? path.resolve(req.targetDir.trim())
        : path.join(this.dataDir, 'dev-plugins', manifest.id);
      fs.mkdirSync(destDir, { recursive: true });
      for (const [rawKey, content] of Object.entries(files)) {
        const clean = normalizeRelativePackagePath(rawKey);
        const full = path.join(destDir, clean);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
      const plugins = await this.pluginManager.linkDevPlugin(destDir);
      return {
        plugins,
        installedId: manifest.id,
        installMode: 'dev_link',
        dirPath: fs.realpathSync(destDir),
      };
    }

    const plugins = await this.pluginManager.installPlugin({
      mode: 'local_dir',
      dirPath: sourceDir,
      expectedDigest: req.expectedDigest,
      trustCode: true,
    });
    return {
      plugins,
      installedId: manifest.id,
      installMode: 'local_install',
      dirPath: sourceDir,
    };
  }

  private buildTier2Prompt(opts: {
    description: string;
    template: PluginBuilderTemplate;
    contextPack: string;
    pluginId?: string;
    name?: string;
    attempt: number;
    previousPayload?: unknown;
    errorFeedback?: string | null;
  }): string {
    const sections = [
      'Return ONLY a single valid JSON object (no markdown commentary) with schema:',
      '{ "manifest": { ... }, "files": { "harnessmate-plugin.json": "...", "index.mjs": "...", "ui/...": "..." } }',
      '',
      'SDK CONTRACT & SECURITY RULES:',
      opts.contextPack,
      '',
      `SELECTED TEMPLATE GUIDANCE: ${TEMPLATE_GUIDANCE[opts.template]}`,
      opts.pluginId ? `REQUIRED PLUGIN ID: ${opts.pluginId}` : 'PLUGIN ID RULE: use `user.<slug>`.',
      opts.name ? `REQUIRED PLUGIN NAME: ${opts.name}` : '',
      '',
      `USER REQUIREMENTS:\n${opts.description}`,
    ];

    if (opts.attempt > 1 && opts.errorFeedback) {
      sections.push(
        '',
        `PREVIOUS ATTEMPT FAILED VALIDATION (Repair Round ${opts.attempt}/3):`,
        opts.errorFeedback,
      );
      if (opts.previousPayload) {
        sections.push('', `PREVIOUS DRAFT JSON:\n${JSON.stringify(opts.previousPayload)}`);
      }
    }

    return sections.filter(Boolean).join('\n');
  }

  private async invokeHarnessSingleTurn(
    adapter: NonNullable<ReturnType<HarnessRegistry['get']>>,
    cwd: string,
    model: string | undefined,
    promptText: string,
    signal: AbortSignal,
  ): Promise<string> {
    let handle: AdapterSessionHandle | undefined;
    let unsubscribe: (() => void) | undefined;
    let onAbort: (() => void) | undefined;
    try {
      handle = await adapter.createSession({ cwd, model: model ?? null, permissionMode: 'plan' });
      signal.throwIfAborted();
      const session = handle;
      const turnId = crypto.randomUUID();
      let streamed = '';
      let completed = '';

      const response = new Promise<string>((resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        unsubscribe = session.onEvent((event) => {
          if (!('turnId' in event) || event.turnId !== turnId) return;
          switch (event.type) {
            case 'approval.requested':
              void session.resolveApproval(event.nativeRequestId, 'deny').catch(() => {});
              reject(new Error('AI Plugin Builder 需要纯文本 JSON 输出，已拒绝工具审批'));
              break;
            case 'message.assistant.delta':
              streamed += event.text;
              break;
            case 'message.assistant.completed':
              completed = event.text || completed;
              break;
            case 'turn.completed':
              resolve(completed || streamed);
              break;
            case 'turn.failed':
              reject(new Error(event.message));
              break;
            case 'turn.cancelled':
              reject(new Error('Harness 取消了代码插件生成'));
              break;
          }
          if (streamed.length + completed.length > 512_000) {
            reject(new Error('生成的插件源码超出大小限制'));
          }
        });
      });

      return await Promise.race([
        response,
        session
          .sendTurn({ turnId, permissionMode: 'plan', model: model ?? null, text: promptText })
          .then(() => response),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      unsubscribe?.();
      await handle?.dispose().catch(() => {});
    }
  }
}
