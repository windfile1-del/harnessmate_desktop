#!/usr/bin/env node
/**
 * Phase AGY-6 Windows Profile Isolation & Real `agy.exe` Verification Script
 *
 * Modes:
 *   --dry-run      (default) Runs live offline-credential checks against local Windows `agy.exe`:
 *                  - Locates official `agy.exe` and checks `--version`
 *                  - Creates two isolated temporary profiles under `os.tmpdir()`
 *                  - Enforces Windows `icacls` current-user-only ACL inheritance lockdown
 *                  - Spawns `agy acp --gemini-dir <profile>/.gemini --app-data-dir antigravity-cli`
 *                    for BOTH profiles with host env stripped + `SSH_CONNECTION` isolation
 *                  - Runs JSON-RPC `initialize` & `session/new` to confirm authentic CLI version
 *                    and fail-closed `-32000 Authentication required` (confirming host credentials
 *                    are NOT leaked into fresh profiles)
 *                  - Probes `agy -p /usage` under an isolated `GEMINI_HOME` with bounded timeout
 *   --interactive  Prints the manual 6-step dual-Google-account OAuth verification runbook.
 *                  Does NOT automate OAuth or bypass Google login.
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const STRIP_HOST_AUTH_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GEMINI_CLI_OAUTH_TOKEN',
  'GEMINI_CLI_REFRESH_TOKEN',
  'GEMINI_OAUTH_TOKEN',
  'ANTIGRAVITY_API_KEY',
  'ANTIGRAVITY_TOKEN',
  'ANTIGRAVITY_HOME',
  'GEMINI_HOME',
  'GEMINI_DIR',
  'ANTIGRAVITY_APP_DATA_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'SSH_CONNECTION',
  'SSH_CLIENT',
  'SSH_TTY',
];

function resolveAgyBinary() {
  if (process.env.AGY_BINARY && fs.existsSync(process.env.AGY_BINARY)) {
    return process.env.AGY_BINARY;
  }
  const defaultLocal = path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe');
  if (fs.existsSync(defaultLocal)) {
    return defaultLocal;
  }
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['agy'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (found && fs.existsSync(found)) return found;
  } catch {
    // ignore
  }
  return null;
}

function buildIsolatedEnv(profileRoot, geminiDir) {
  const env = { ...process.env };
  for (const key of STRIP_HOST_AUTH_VARS) {
    delete env[key];
  }
  const roamingAppData = path.join(profileRoot, 'AppData', 'Roaming');
  const localAppData = path.join(profileRoot, 'AppData', 'Local');
  fs.mkdirSync(geminiDir, { recursive: true });
  fs.mkdirSync(roamingAppData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });

  env.HOME = profileRoot;
  env.USERPROFILE = profileRoot;
  env.GEMINI_HOME = geminiDir;
  env.APPDATA = roamingAppData;
  env.LOCALAPPDATA = localAppData;
  env.SSH_CONNECTION = '127.0.0.1 0 127.0.0.1 0';
  return env;
}

function resolveSystemExe(name) {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(sysRoot, 'System32', name);
  return fs.existsSync(full) ? full : name;
}

function lockWindowsProfileAcl(profileDir) {
  if (process.platform !== 'win32') {
    fs.chmodSync(profileDir, 0o700);
    return { applied: true, mode: 'posix-0700', output: 'chmod 0700 applied' };
  }
  const icaclsBin = resolveSystemExe('icacls.exe');
  const username = os.userInfo().username;
  const output = execFileSync(
    icaclsBin,
    [profileDir, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)F`],
    { encoding: 'utf8', timeout: 10_000 },
  ).trim();
  const inspect = execFileSync(icaclsBin, [profileDir], { encoding: 'utf8', timeout: 10_000 }).trim();
  return { applied: true, mode: 'windows-icacls', username, output, inspect };
}

function probeAcpProfile(binaryPath, profileName, profileRoot, cwd) {
  return new Promise((resolve) => {
    const geminiDir = path.join(profileRoot, '.gemini');
    const env = buildIsolatedEnv(profileRoot, geminiDir);
    const acl = lockWindowsProfileAcl(profileRoot);
    const args = ['acp', '--gemini-dir', geminiDir, '--app-data-dir', 'antigravity-cli'];

    const child = spawn(binaryPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stderrText = '';
    let initResult = null;
    let sessionResult = null;
    let sessionError = null;
    let finished = false;

    const finish = (timedOut = false) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        if (process.platform === 'win32' && child.pid) {
          execFileSync(resolveSystemExe('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            timeout: 5_000,
          });
        } else {
          child.kill('SIGKILL');
        }
      } catch {
        // ignore if already exited
      }
      resolve({
        profileName,
        aclMode: acl.mode,
        geminiDir,
        agentInfo: initResult?.agentInfo ?? null,
        authMethods: Array.isArray(initResult?.authMethods)
          ? initResult.authMethods.map((m) => m.id ?? m.name ?? String(m))
          : [],
        sessionResult: sessionResult ? 'opened' : null,
        sessionError,
        timedOut,
        stderrPreview: stderrText.trim().slice(0, 400),
      });
    };

    const timer = setTimeout(() => finish(true), 12_000);

    child.stderr.on('data', (chunk) => {
      stderrText += chunk.toString('utf8');
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id === 1) {
        initResult = msg.result ?? null;
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'session/new',
            params: { cwd, mcpServers: [] },
          })}\n`,
        );
      } else if (msg.id === 2) {
        if (msg.error) {
          sessionError = { code: msg.error.code, message: msg.error.message };
        } else {
          sessionResult = msg.result ?? null;
        }
        finish(false);
      }
    });

    child.on('exit', () => {
      if (!finished && (initResult || sessionError || stderrText)) {
        finish(false);
      }
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientInfo: { name: 'harnessmate-agy-isolation-probe', version: '0.1.0' },
          clientCapabilities: {},
        },
      })}\n`,
    );
  });
}

function probeUsageCli(binaryPath, profileRoot, cwd) {
  return new Promise((resolve) => {
    const geminiDir = path.join(profileRoot, '.gemini');
    const env = buildIsolatedEnv(profileRoot, geminiDir);
    const child = spawn(binaryPath, ['-p', '/usage'], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let fastAbortedAuth = false;
    let done = false;
    const finish = (code, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (timedOut || fastAbortedAuth) {
        try {
          if (process.platform === 'win32' && child.pid) {
            execFileSync(resolveSystemExe('taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
              stdio: 'ignore',
              timeout: 5_000,
            });
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // ignore
        }
      }
      resolve({
        exitCode: code,
        timedOut,
        fastAbortedAuth,
        stdoutPreview: stdout.trim().slice(0, 300),
        stderrPreview: stderr.trim().slice(0, 300),
      });
    };
    const timer = setTimeout(() => finish(null, true), 10_000);
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
      if (!fastAbortedAuth && /Authentication required\b/i.test(stderr)) {
        fastAbortedAuth = true;
        finish(null, false);
      }
    });
    child.on('exit', (code) => finish(code, false));
  });
}

async function runDryRun() {
  const binaryPath = resolveAgyBinary();
  if (!binaryPath) {
    console.error('[verify-agy-windows-isolation] Official `agy.exe` binary not found.');
    process.exit(1);
  }
  const versionOutput = execFileSync(binaryPath, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  }).trim();

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-agy-e2e-'));
  const workDir = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workDir, { recursive: true });
  const profileA = path.join(tempRoot, 'profile-a');
  const profileB = path.join(tempRoot, 'profile-b');

  try {
    const probeA = await probeAcpProfile(binaryPath, 'agy-iso-a', profileA, workDir);
    const probeB = await probeAcpProfile(binaryPath, 'agy-iso-b', profileB, workDir);
    const usageProbe = await probeUsageCli(binaryPath, profileA, workDir);

    const summary = {
      mode: 'dry-run',
      platform: process.platform,
      binaryPath,
      cliVersion: versionOutput,
      profileA: probeA,
      profileB: probeB,
      isolatedUsageCliProbe: usageProbe,
      isolationVerified: Boolean(
        probeA.agentInfo?.version &&
          probeB.agentInfo?.version &&
          probeA.sessionError?.code === -32000 &&
          probeB.sessionError?.code === -32000,
      ),
      humanOAuthStatus: '[未真机验证 / 需人工双 Google 账号交互登录]',
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.isolationVerified) {
      process.exitCode = 1;
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

function printInteractiveRunbook() {
  console.log(`
=== HarnessMate AGY 双 Google 账号真机隔离验收手册 (--interactive) ===

合规红线：本脚本不会自动化 Google 登录，亦不会复用或复制凭据。请由测试人员在真实图形界面手动完成：

1. [创建双 Profile]
   - 在 HarnessMate Settings -> Antigravity 中分别新建 \`agy-a\` 与 \`agy-b\`（均选择 profile_isolated）。
   - 验证 \`%USERPROFILE%\\.harnessmate-desktop\\agy-profiles\\\` 下生成两个独立 SHA-256 哈希目录；
   - 执行 \`icacls <profileDir>\` 验证仅当前 Windows 用户拥有 \`(OI)(CI)F\` 完全控制权限。

2. [分别执行官方 Google OAuth 登录]
   - 先对 \`agy-a\` 点击“官方 Google 登录”，在浏览器登录 Google 账号 A 并回填 callback URL / 授权码；
   - 再对 \`agy-b\` 点击“官方 Google 登录”，使用无痕窗口或另一账号 Profile 登录 Google 账号 B；
   - 验证各自 \`<profile>\\antigravity-cli\\antigravity-oauth-token\`（或官方落盘凭据）互相独立存在。

3. [核实本机 official_default 未受污染]
   - 运行宿主原生 \`agy --version\` / 检查原生 \`official_default\` 实例，确认原有登录态未被登出或覆写。

4. [跨子命令 /usage 与额度查询实测 (关闭 R-05)]
   - 分别打开 \`agy-a\` 与 \`agy-b\` 会话并执行 \`/usage\`；
   - 打开 Usage Center 确认两个账号各自展示独立配额与 tier，无自动轮换发生。

5. [单独登出隔离检验]
   - 对 \`agy-b\` 执行登出（\`POST /api/v1/harnesses/agy/instances/agy-b/auth/logout\`）；
   - 验证 \`agy-a\` 仍可继续发送 Turn 并收到回复。

6. [跨账号 Context Handoff V2 手动切换]
   - 在 \`agy-a\` 会话运行几轮后，点击“手动切换至该账号 -> agy-b”，确认通过 Context Handoff V2 无损接续且零凭据复制。
`);
}

if (process.argv.includes('--interactive')) {
  printInteractiveRunbook();
} else {
  await runDryRun();
}
