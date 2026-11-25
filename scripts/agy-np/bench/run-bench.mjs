#!/usr/bin/env node
/**
 * NP-16 Unified T18 Runner (Daemon + Web Benchmarks)
 *
 * Usage:
 *   node scripts/agy-np/bench/run-bench.mjs [--samples 3] [--out scripts/agy-np/bench/baseline-latest.json]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDaemonBench } from './run-daemon-bench.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function parseArgs(argv) {
  const opts = {
    samples: 3,
    webSamples: 5,
    webOnly: false,
    daemonOnly: false,
    tmpRoot: process.env.HM_BENCH_TMP || 'D:\\AppDataCache\\np16-bench',
    out: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--samples' && argv[i + 1]) opts.samples = Math.max(1, Number(argv[++i]) || 3);
    else if (arg === '--web-samples' && argv[i + 1]) opts.webSamples = Math.max(1, Number(argv[++i]) || 5);
    else if (arg === '--web-only') opts.webOnly = true;
    else if (arg === '--daemon-only') opts.daemonOnly = true;
    else if (arg === '--tmp-root' && argv[i + 1]) opts.tmpRoot = argv[++i];
    else if (arg === '--out' && argv[i + 1]) opts.out = argv[++i];
  }
  return opts;
}

async function runWebBenchViaEsbuild(tmpRoot, webSamples) {
  const webRequire = createRequire(path.join(REPO_ROOT, 'packages', 'web', 'package.json'));
  const viteRequire = createRequire(webRequire.resolve('vite'));
  const esbuildPath = viteRequire.resolve('esbuild');
  const esbuild = await import(`file:///${esbuildPath.replace(/\\/g, '/')}`);

  fs.mkdirSync(tmpRoot, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(tmpRoot, 'web-bundle-'));
  const outFile = path.join(tempDir, 'web-bench.cjs');
  try {
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'run-web-bench.tsx')],
      outfile: outFile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      jsx: 'automatic',
      nodePaths: [path.join(REPO_ROOT, 'packages', 'web', 'node_modules')],
      logLevel: 'silent',
    });

    const stdout = execFileSync(process.execPath, [outFile], {
      cwd: REPO_ROOT,
      env: { ...process.env, HM_WEB_BENCH_SAMPLES: String(webSamples) },
      encoding: 'utf8',
    });
    return JSON.parse(stdout);
  } finally {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const daemonReport = opts.webOnly
    ? null
    : await runDaemonBench(['--samples', String(opts.samples), '--tmp-root', opts.tmpRoot]);
  const webReport = opts.daemonOnly
    ? null
    : await runWebBenchViaEsbuild(opts.tmpRoot, opts.webSamples);

  const combined = {
    schemaVersion: 1,
    suite: 'np16-t18-full-baseline',
    generatedAt: new Date().toISOString(),
    daemon: daemonReport,
    web: webReport,
  };

  if (opts.out) {
    const outPath = path.resolve(REPO_ROOT, opts.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(combined, null, 2));
  }
  console.log(JSON.stringify(combined, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
