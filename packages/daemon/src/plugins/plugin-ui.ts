import fs from 'node:fs';
import path from 'node:path';
import { PluginApiError, isSafePluginUiPath } from '@harnessmate/plugin-api';

const MAX_UI_ASSET_BYTES = 512 * 1024;
const MAX_INLINE_HTML_BYTES = 1024 * 1024;

export const SANDBOX_IFRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function isSafeRelativeAssetPath(value: string): boolean {
  if (!value || value.includes('\0') || value.includes('\\')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('/')) return false;
  const normalized = value.replace(/^\.\//, '');
  const segments = normalized.split('/');
  return !segments.some((seg) => !seg || seg === '.' || seg === '..');
}

export function resolvePluginUiAsset(packageRoot: string, relativePath: string): {
  fullPath: string;
  normalizedPath: string;
  contentType: string;
  buffer: Buffer;
} {
  if (!isSafeRelativeAssetPath(relativePath)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '非法的插件 UI 资源路径');
  }
  const realRoot = fs.realpathSync(packageRoot);
  const cleaned = relativePath.replace(/^\.\//, '');
  const candidate = path.resolve(realRoot, cleaned);
  const rel = path.relative(realRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止访问插件包之外的 UI 资源');
  }
  if (!fs.existsSync(candidate)) {
    throw new PluginApiError('E_INVALID_INPUT', `找不到插件 UI 资源: ${cleaned}`);
  }
  const realTarget = fs.realpathSync(candidate);
  const realRel = path.relative(realRoot, realTarget);
  if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
    throw new PluginApiError('E_PERMISSION_DENIED', '禁止通过符号链接逃逸插件包目录');
  }
  const stat = fs.statSync(realTarget);
  if (!stat.isFile()) {
    throw new PluginApiError('E_INVALID_INPUT', 'UI 资源路径不是普通文件');
  }
  if (stat.size > MAX_UI_ASSET_BYTES) {
    throw new PluginApiError('E_LIMIT_EXCEEDED', '插件 UI 资源超过 512 KiB 限制');
  }
  const ext = path.extname(realTarget).toLowerCase();
  const contentType = MIME_BY_EXT[ext];
  if (!contentType) {
    throw new PluginApiError('E_PERMISSION_DENIED', `不支持的插件 UI 文件类型: ${ext || '(无扩展名)'}`);
  }
  return {
    fullPath: realTarget,
    normalizedPath: realRel.replace(/\\/g, '/'),
    contentType,
    buffer: fs.readFileSync(realTarget),
  };
}

function resolveSiblingAssetPath(htmlRelPath: string, ref: string): string | null {
  const trimmed = ref.trim();
  if (!trimmed || /^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith('//') || trimmed.startsWith('/')) {
    return null;
  }
  const noQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
  if (!noQuery || noQuery.includes('\\') || noQuery.includes('\0')) return null;
  const htmlDir = path.posix.dirname(htmlRelPath);
  const joined = path.posix.normalize(htmlDir === '.' ? noQuery : `${htmlDir}/${noQuery}`);
  if (joined.startsWith('..') || joined.startsWith('/')) return null;
  return joined;
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/script/gi, '<\\/script');
}

function escapeInlineStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

/**
 * Reads a plugin's HTML UI entry and safely inlines local relative CSS/JS assets
 * from the same plugin package so it can render inside a strict `sandbox="allow-scripts"` iframe.
 */
export function buildSandboxedPluginHtml(packageRoot: string, uiRelativePath: string): {
  html: string;
  csp: string;
  normalizedPath: string;
} {
  if (!isSafePluginUiPath(uiRelativePath)) {
    throw new PluginApiError('E_PERMISSION_DENIED', 'UI 入口必须为包内相对 .html/.htm 路径');
  }
  const entry = resolvePluginUiAsset(packageRoot, uiRelativePath);
  let html = entry.buffer.toString('utf8');

  // Inline local <link rel="stylesheet" href="..."> from within the same plugin package
  html = html.replace(
    /<link\b([^>]*?)\brel=["']stylesheet["']([^>]*?)>/gi,
    (match, before: string, after: string) => {
      const attrs = `${before} ${after}`;
      const hrefMatch = /\bhref=["']([^"']+)["']/i.exec(attrs);
      if (!hrefMatch?.[1]) return match;
      const resolved = resolveSiblingAssetPath(entry.normalizedPath, hrefMatch[1]);
      if (!resolved || !resolved.toLowerCase().endsWith('.css')) return '';
      try {
        const asset = resolvePluginUiAsset(packageRoot, resolved);
        return `<style data-inlined-from="${asset.normalizedPath}">\n${escapeInlineStyle(asset.buffer.toString('utf8'))}\n</style>`;
      } catch {
        return '';
      }
    },
  );

  // Inline local <script src="..."></script> from within the same plugin package
  html = html.replace(
    /<script\b([^>]*?)\bsrc=["']([^"']+)["']([^>]*?)>\s*<\/script>/gi,
    (_match, before: string, src: string, after: string) => {
      const resolved = resolveSiblingAssetPath(entry.normalizedPath, src);
      if (!resolved || !/\.(?:js|mjs)$/i.test(resolved)) return '';
      try {
        const asset = resolvePluginUiAsset(packageRoot, resolved);
        const typeMatch = /\btype=["']([^"']+)["']/i.exec(`${before} ${after}`);
        const typeAttr = typeMatch?.[1] === 'module' ? ' type="module"' : '';
        return `<script${typeAttr} data-inlined-from="${asset.normalizedPath}">\n${escapeInlineScript(asset.buffer.toString('utf8'))}\n</script>`;
      } catch {
        return '';
      }
    },
  );

  if (Buffer.byteLength(html, 'utf8') > MAX_INLINE_HTML_BYTES) {
    throw new PluginApiError('E_LIMIT_EXCEEDED', '打包后的插件 UI 文档超过 1 MiB 限制');
  }

  return { html, csp: SANDBOX_IFRAME_CSP, normalizedPath: entry.normalizedPath };
}
