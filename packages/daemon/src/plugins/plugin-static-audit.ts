import { isPeerContractName } from '@harnessmate/plugin-api';
import type {
  PluginAuditIssue,
  PluginAuditPermissionSummary,
  PluginManifest,
  PluginStaticAuditReport,
} from '@harnessmate/protocol';
import { describePermission } from '../plugin-host/permissions/permissions.js';

const FORBIDDEN_PLUGIN_PREFIXES = ['core.', 'broken.'] as const;
const FORBIDDEN_DRIVER_IDS = new Set(['agy']);
const RESERVED_CORE_SERVICES = new Set([
  'auth',
  'permissions',
  'remote',
  'mcpHub',
  'session-kernel',
  'native-commands',
  'failover',
  'harness',
]);

const HIGH_RISK_PERMISSIONS = new Set([
  'harness:driver:register',
  'fs:workspace:write',
  'workspace:git:write',
  'process:pty:workspace',
  'handoff:redact',
]);

const URL_HOST_ALLOWLIST = new Set([
  'www.w3.org',
  'schemas.openxmlformats.org',
]);

function isCodeFile(filePath: string): boolean {
  return /\.(?:mjs|js|cjs|ts|tsx|jsx)$/i.test(filePath);
}

function isHtmlFile(filePath: string): boolean {
  return /\.(?:html|htm)$/i.test(filePath);
}

function isTestFile(filePath: string): boolean {
  return /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[a-z]+$/i.test(filePath);
}

/**
 * Strips single-line (`// ...`) and block (`/* ... * /`) comments while preserving line counts
 * so reported line numbers stay accurate and commented examples don't cause false positives.
 */
function stripJsCommentsPreserveLines(source: string): string {
  let out = '';
  let i = 0;
  const len = source.length;
  let state: 'code' | 'single' | 'double' | 'template' | 'line_comment' | 'block_comment' = 'code';

  while (i < len) {
    const ch = source[i]!;
    const next = i + 1 < len ? source[i + 1] : '';

    if (state === 'line_comment') {
      if (ch === '\n') {
        out += '\n';
        state = 'code';
      }
      i += 1;
      continue;
    }

    if (state === 'block_comment') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 2;
      } else {
        if (ch === '\n') out += '\n';
        i += 1;
      }
      continue;
    }

    if (state === 'single' || state === 'double' || state === 'template') {
      out += ch;
      if (ch === '\\' && i + 1 < len) {
        out += next;
        i += 2;
        continue;
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code';
      }
      i += 1;
      continue;
    }

    // state === 'code'
    if (ch === '/' && next === '/') {
      state = 'line_comment';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      state = 'block_comment';
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = 'single';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      state = 'double';
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '`') {
      state = 'template';
      out += ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }

  return out;
}

function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function isHighRiskCapability(cap: string): boolean {
  return (
    HIGH_RISK_PERMISSIONS.has(cap) ||
    cap.startsWith('process:spawn:') ||
    cap.startsWith('secrets:read:')
  );
}

/**
 * Performs comprehensive static security & capability-minimization auditing on a plugin package
 * before it enters human review or isolated execution.
 */
export function auditPluginPackage(
  rawFiles: Record<string, string>,
  manifestRaw?: Record<string, unknown> | PluginManifest | null,
): PluginStaticAuditReport {
  const blockingIssues: PluginAuditIssue[] = [];
  const warnings: PluginAuditIssue[] = [];

  // Normalize file keys to POSIX relative paths
  const files: Record<string, string> = {};
  for (const [rawKey, content] of Object.entries(rawFiles)) {
    const cleaned = rawKey.replace(/\\/g, '/').replace(/^\.\//, '');
    if (
      !cleaned ||
      cleaned.startsWith('/') ||
      cleaned.includes('\0') ||
      cleaned.split('/').some((seg) => !seg || seg === '.' || seg === '..')
    ) {
      blockingIssues.push({
        code: 'AUDIT_INVALID_FILE_PATH',
        severity: 'error',
        file: rawKey,
        message: `禁止非法或包含路径穿越的文件路径: ${rawKey}`,
        suggestion: '所有插件文件必须使用包内相对路径且禁止包含 ".." 或绝对前缀。',
      });
      continue;
    }
    files[cleaned] = content;
  }

  // Parse manifest from argument or harnessmate-plugin.json
  let manifestObj: Record<string, unknown> = {};
  if (manifestRaw && typeof manifestRaw === 'object') {
    manifestObj = manifestRaw as Record<string, unknown>;
  } else if (files['harnessmate-plugin.json']) {
    try {
      manifestObj = JSON.parse(files['harnessmate-plugin.json']!) as Record<string, unknown>;
    } catch {
      blockingIssues.push({
        code: 'AUDIT_INVALID_MANIFEST_JSON',
        severity: 'error',
        file: 'harnessmate-plugin.json',
        message: 'harnessmate-plugin.json 不是有效的 JSON 文档',
      });
    }
  } else {
    blockingIssues.push({
      code: 'AUDIT_MISSING_MANIFEST',
      severity: 'error',
      file: 'harnessmate-plugin.json',
      message: '插件包缺少 harnessmate-plugin.json 清单文件',
    });
  }

  const pluginId = typeof manifestObj.id === 'string' ? manifestObj.id.trim() : '';
  const permissions = Array.isArray(manifestObj.permissions)
    ? manifestObj.permissions.filter((p): p is string => typeof p === 'string')
    : [];
  const permissionSet = new Set(permissions);
  const provides = Array.isArray(manifestObj.provides)
    ? manifestObj.provides.filter((s): s is string => typeof s === 'string')
    : [];

  // ── 1. Manifest Reserved Surfaces ──────────────────────────────────────
  if (pluginId && FORBIDDEN_PLUGIN_PREFIXES.some((prefix) => pluginId.startsWith(prefix))) {
    blockingIssues.push({
      code: 'AUDIT_RESERVED_PLUGIN_ID',
      severity: 'error',
      file: 'harnessmate-plugin.json',
      message: `禁止抢占系统保留插件 ID 前缀: ${pluginId}`,
      suggestion: '请使用 user.<slug> 或 <org>.<slug> 命名插件 ID。',
    });
  }

  for (const svc of provides) {
    if (RESERVED_CORE_SERVICES.has(svc) || (svc.startsWith('harness.') && !isPeerContractName(svc))) {
      blockingIssues.push({
        code: 'AUDIT_RESERVED_SERVICE',
        severity: 'error',
        file: 'harnessmate-plugin.json',
        message: `禁止在 provides 中覆盖核心保留服务: ${svc}`,
        suggestion: '第三方自定义服务请使用命名空间前缀（例如 acme.helper）或 harness.driver.<driverId>.v1。',
      });
    }
  }

  for (const cap of permissions) {
    if (cap.startsWith('service:provide:')) {
      const target = cap.slice('service:provide:'.length);
      if (RESERVED_CORE_SERVICES.has(target) || (target.startsWith('harness.') && !isPeerContractName(target))) {
        blockingIssues.push({
          code: 'AUDIT_RESERVED_SERVICE',
          severity: 'error',
          file: 'harnessmate-plugin.json',
          message: `禁止申请核心安全服务提供权限: ${cap}`,
        });
      }
    }
  }

  const combinedProdSource: string[] = [];

  // ── 2. Static Code Inspection (JS/TS) ─────────────────────────────────
  const dangerousRules: Array<{
    code: string;
    regex: RegExp;
    message: string;
    suggestion?: string;
  }> = [
    {
      code: 'AUDIT_FORBIDDEN_CHILD_PROCESS',
      regex: /(?:import\s+[\s\S]*?from\s+['"](?:node:)?child_process['"]|import\s*\(\s*['"](?:node:)?child_process['"]\s*\)|require\s*\(\s*['"](?:node:)?child_process['"]\s*\))/,
      message: '禁止直接导入或调用 child_process / node:child_process',
      suggestion: '请声明 process:spawn:<binary> 并改用 ctx.runtime.spawnCli(...) 受控派生进程。',
    },
    {
      code: 'AUDIT_FORBIDDEN_WORKER_THREADS',
      regex: /(?:import\s+[\s\S]*?from\s+['"](?:node:)?worker_threads['"]|import\s*\(\s*['"](?:node:)?worker_threads['"]\s*\)|require\s*\(\s*['"](?:node:)?worker_threads['"]\s*\))/,
      message: '禁止直接导入或使用 worker_threads / node:worker_threads',
      suggestion: '插件代码运行在独立受控子进程中，请直接使用异步事件或宿主 RPC。',
    },
    {
      code: 'AUDIT_FORBIDDEN_VM',
      regex: /(?:import\s+[\s\S]*?from\s+['"](?:node:)?vm['"]|import\s*\(\s*['"](?:node:)?vm['"]\s*\)|require\s*\(\s*['"](?:node:)?vm['"]\s*\))/,
      message: '禁止导入或调用 node:vm 动态代码沙箱模块',
    },
    {
      code: 'AUDIT_FORBIDDEN_EVAL',
      regex: /\beval\s*\(/,
      message: '禁止调用 eval() 执行动态代码',
    },
    {
      code: 'AUDIT_FORBIDDEN_FUNCTION_CTOR',
      regex: /(?:\bnew\s+Function\s*\(|(?<![.\w$])Function\s*\()/,
      message: '禁止使用 new Function() / Function() 动态构造函数',
    },
    {
      code: 'AUDIT_FORBIDDEN_PROCESS_BINDING',
      regex: /\bprocess\.(?:binding|dlopen|_linkedBinding)\s*\(/,
      message: '禁止访问 process.binding / process.dlopen 底层绑定接口',
    },
    {
      code: 'AUDIT_FORBIDDEN_DESTRUCTIVE_FS',
      regex: /\b(?:rmSync|rmdirSync)\s*\(|\bfs\.(?:rm|rmSync|rmdirSync)\s*\(/,
      message: '禁止在插件代码中调用破坏性目录删除 API（rmSync / rmdirSync / fs.rm）',
      suggestion: '文件读写请使用工作区作用域下的 ctx.fs.* 或 ctx.storage.* API。',
    },
  ];

  for (const [filePath, rawContent] of Object.entries(files)) {
    if (isCodeFile(filePath)) {
      const stripped = stripJsCommentsPreserveLines(rawContent);
      const isTest = isTestFile(filePath);
      if (!isTest) combinedProdSource.push(stripped);

      for (const rule of dangerousRules) {
        const match = rule.regex.exec(stripped);
        if (match) {
          blockingIssues.push({
            code: rule.code,
            severity: 'error',
            file: filePath,
            line: lineNumberAt(stripped, match.index),
            message: rule.message,
            suggestion: rule.suggestion,
          });
        }
      }

      if (!isTest) {
        // Check built-in driver hijacking via registerDriver({ driverId: 'agy' ... }) or DRIVER_ID = 'agy'
        const regDriverMatch = /registerDriver\s*\(\s*\{[\s\S]{0,600}?driverId\s*:\s*['"]([a-z0-9_-]+)['"]/i.exec(stripped);
        if (regDriverMatch?.[1] && FORBIDDEN_DRIVER_IDS.has(regDriverMatch[1].toLowerCase())) {
          blockingIssues.push({
            code: 'AUDIT_BUILTIN_DRIVER_HIJACK',
            severity: 'error',
            file: filePath,
            line: lineNumberAt(stripped, regDriverMatch.index),
            message: `禁止通过 registerDriver 劫持保留 AGY 原生驱动 ID: "${regDriverMatch[1]}"`,
            suggestion: 'AGY 原生驱动留待第四批解耦；codex/claude/acp 与自定义 driverId 可正常注册。',
          });
        }
        const driverConstMatch = /\bDRIVER_ID\s*=\s*['"]([a-z0-9_-]+)['"]/i.exec(stripped);
        if (driverConstMatch?.[1] && FORBIDDEN_DRIVER_IDS.has(driverConstMatch[1].toLowerCase())) {
          blockingIssues.push({
            code: 'AUDIT_BUILTIN_DRIVER_HIJACK',
            severity: 'error',
            file: filePath,
            line: lineNumberAt(stripped, driverConstMatch.index),
            message: `禁止将 DRIVER_ID 设为保留 AGY 原生驱动 "${driverConstMatch[1]}"`,
          });
        }

        // Check ctx.provide('<reserved>', ...)
        const provideMatch = /\.provide\s*\(\s*['"]([^'"]+)['"]/g;
        let pm: RegExpExecArray | null;
        while ((pm = provideMatch.exec(stripped)) !== null) {
          const svcName = pm[1] ?? '';
          if (RESERVED_CORE_SERVICES.has(svcName) || (svcName.startsWith('harness.') && !isPeerContractName(svcName))) {
            blockingIssues.push({
              code: 'AUDIT_RESERVED_SERVICE',
              severity: 'error',
              file: filePath,
              line: lineNumberAt(stripped, pm.index),
              message: `禁止通过 ctx.provide() 覆盖不可替换核心服务: ${svcName}`,
            });
          }
        }

        // Check hardcoded external URLs inside string literals -> must match net:<host> permission
        const stringLiteralRegex = /(['"`])((?:\\.|(?!\1)[^\\\r\n])*)\1/g;
        let sm: RegExpExecArray | null;
        while ((sm = stringLiteralRegex.exec(stripped)) !== null) {
          const literal = sm[2] ?? '';
          const urlMatches = literal.matchAll(/https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi);
          for (const um of urlMatches) {
            const host = (um[1] ?? '').toLowerCase();
            if (!host || URL_HOST_ALLOWLIST.has(host)) continue;
            // Skip template-interpolated dynamic host like https://${host}
            if (host.includes('$')) continue;
            if (!permissionSet.has(`net:${host}`)) {
              blockingIssues.push({
                code: 'AUDIT_UNDECLARED_NET_HOST',
                severity: 'error',
                file: filePath,
                line: lineNumberAt(stripped, sm.index),
                message: `代码中引用了外部地址 "${um[0]}"，但未在 permissions 中声明 "net:${host}"`,
                suggestion: `在 harnessmate-plugin.json 的 permissions 中添加 "net:${host}"，或移除未使用的外部请求。`,
              });
            }
          }
        }
      }
    }

    // ── 3. HTML UI Sandbox Safety Inspection ──────────────────────────────
    if (isHtmlFile(filePath)) {
      const extScriptRegex = /<script\b[^>]*\bsrc\s*=\s*["']\s*((?:https?:|\/\/)[^"']+)["']/gi;
      let match: RegExpExecArray | null;
      while ((match = extScriptRegex.exec(rawContent)) !== null) {
        blockingIssues.push({
          code: 'AUDIT_UNSAFE_HTML_EXTERNAL_SCRIPT',
          severity: 'error',
          file: filePath,
          line: lineNumberAt(rawContent, match.index),
          message: `沙箱 UI 禁止加载外部远程脚本: ${match[1]}`,
          suggestion: '仅可使用内联 <script> 或同插件包内相对路径的本地脚本文件。',
        });
      }

      const extLinkRegex = /<link\b[^>]*\bhref\s*=\s*["']\s*((?:https?:|\/\/)[^"']+)["']/gi;
      while ((match = extLinkRegex.exec(rawContent)) !== null) {
        blockingIssues.push({
          code: 'AUDIT_UNSAFE_HTML_EXTERNAL_LINK',
          severity: 'error',
          file: filePath,
          line: lineNumberAt(rawContent, match.index),
          message: `沙箱 UI 禁止引用外部远程资源链接: ${match[1]}`,
        });
      }

      const jsProtoRegex = /\b(?:href|src|action)\s*=\s*["']\s*javascript:/gi;
      while ((match = jsProtoRegex.exec(rawContent)) !== null) {
        blockingIssues.push({
          code: 'AUDIT_UNSAFE_HTML_JS_PROTOCOL',
          severity: 'error',
          file: filePath,
          line: lineNumberAt(rawContent, match.index),
          message: '沙箱 UI 禁止使用 javascript: 伪协议',
        });
      }

      const inlineHandlerRegex = /<[a-z][^>]*\s+(on[a-z]{2,20})\s*=\s*["']/gi;
      while ((match = inlineHandlerRegex.exec(rawContent)) !== null) {
        blockingIssues.push({
          code: 'AUDIT_UNSAFE_HTML_INLINE_HANDLER',
          severity: 'error',
          file: filePath,
          line: lineNumberAt(rawContent, match.index),
          message: `沙箱 UI 禁止内联事件属性 ${match[1]}=，请改用 addEventListener`,
        });
      }

      const traversalRegex = /\b(?:src|href)\s*=\s*["']([^"']*(?:\.\.\/|\.\.\\)[^"']*)["']/gi;
      while ((match = traversalRegex.exec(rawContent)) !== null) {
        blockingIssues.push({
          code: 'AUDIT_UNSAFE_HTML_PATH_TRAVERSAL',
          severity: 'error',
          file: filePath,
          line: lineNumberAt(rawContent, match.index),
          message: `沙箱 UI 资源引用存在路径穿越风险: ${match[1]}`,
        });
      }
    }
  }

  // ── 4. Permission Minimization & Summary ───────────────────────────────
  const fullProdCode = combinedProdSource.join('\n');
  const permissionSummary: PluginAuditPermissionSummary[] = [];

  const usageChecks: Array<{ match: (cap: string) => boolean; check: (code: string) => boolean }> = [
    { match: (c) => c === 'harness:driver:register', check: (code) => /\bregisterDriver\b/.test(code) },
    { match: (c) => c.startsWith('process:spawn:'), check: (code) => /\bspawnCli\b/.test(code) },
    { match: (c) => c.startsWith('secrets:read:'), check: (code) => /\bsecrets\b/.test(code) },
    { match: (c) => c === 'fs:workspace:write', check: (code) => /\bfs\.write\b/.test(code) },
    { match: (c) => c === 'handoff:redact', check: (code) => /\bonRedact\b/.test(code) },
    { match: (c) => c === 'workspace:git:write', check: (code) => /\bgit\b|\bcreateWorktree\b/.test(code) },
  ];

  for (const cap of permissions) {
    const meta = describePermission(cap);
    const usageRule = usageChecks.find((u) => u.match(cap));
    const unused = usageRule ? !usageRule.check(fullProdCode) : false;

    if (unused && isHighRiskCapability(cap)) {
      warnings.push({
        code: 'AUDIT_UNUSED_HIGH_RISK_PERMISSION',
        severity: 'warning',
        file: 'harnessmate-plugin.json',
        message: `声明了高危权限 "${cap}"，但插件源码中未发现对应 API 调用，建议遵循最小权限原则移除`,
        suggestion: `从 permissions 中移除未使用的 ${cap}。`,
      });
    }

    permissionSummary.push({
      capability: cap,
      risk: meta.risk,
      scope: meta.scope,
      description: meta.description,
      ...(unused ? { unused: true } : {}),
    });
  }

  return {
    passed: blockingIssues.length === 0,
    blockingIssues,
    warnings,
    permissionSummary,
  };
}
