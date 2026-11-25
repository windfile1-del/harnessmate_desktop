import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as interactiveReadline } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { buildFourLayerSummary } from './four-layer.mjs';
import { ProtocolObservatoryRecorder } from './recorder.mjs';
import { extractMarkersFromUnknown, safePublicOption } from './sanitizer.mjs';
import { validateCaptureRecords } from './schema-validator.mjs';

export const GEMINI_38_FLASH_RE = /^gemini-3\.8-flash(?:[-_.:][a-z0-9._:-]{1,64})?$/i;

export const G0_DEDICATED_TEST_ROOT = 'D:\\HarnessMate\\agy-np-test-profile';
export const G0_DEDICATED_PROFILE_DIR = 'D:\\HarnessMate\\agy-np-test-profile\\gemini';
export const G0_ALLOWED_CLEAN_ROOTS = [
  'D:\\HarnessMate\\np00-research',
  'D:\\HarnessMate\\agy-np-test-profile\\runs',
  'D:\\HarnessMate\\agy-np-test-profile\\temp',
];

const MAX_STDERR_LINE_BYTES = 4_096;

function normalizeWinPath(p) {
  return path.win32.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
}

function isUnderRoot(targetPath, rootPath) {
  const target = normalizeWinPath(targetPath);
  const root = normalizeWinPath(rootPath);
  return target === root || target.startsWith(`${root}\\`);
}

export function requireDPath(value, label) {
  if (!value || !/^D:\\[^\\]/i.test(value) || !/^D:\\[^\\]/i.test(path.win32.resolve(value))) {
    throw new Error(`${label} must be an absolute path on D:\\`);
  }
  return path.win32.resolve(value);
}

export function requireAllowedDir(value, label, allowedRoots) {
  const resolved = requireDPath(value, label);
  if (!allowedRoots.some((root) => isUnderRoot(resolved, root))) {
    throw new Error(`${label} must stay inside the approved D:\\ test directories (${allowedRoots.join(', ')})`);
  }
  return resolved;
}

export function isOfficialAgyBinaryPath(binaryPath, envInfo = {}) {
  if (!binaryPath || !path.win32.isAbsolute(binaryPath)) return false;
  if (path.win32.basename(binaryPath).toLowerCase() !== 'agy.exe') return false;
  const norm = normalizeWinPath(binaryPath);
  const localAppData = envInfo.localAppData ?? process.env.LOCALAPPDATA ?? path.win32.join(os.homedir(), 'AppData', 'Local');
  const programFiles = envInfo.programFiles ?? process.env.ProgramFiles ?? 'C:\\Program Files';
  const expectedCandidates = [
    normalizeWinPath(path.win32.join(localAppData, 'agy', 'bin', 'agy.exe')),
    normalizeWinPath(path.win32.join(programFiles, 'Antigravity', 'bin', 'agy.exe')),
    normalizeWinPath(path.win32.join(programFiles, 'Google', 'Antigravity', 'bin', 'agy.exe')),
  ];
  return expectedCandidates.includes(norm);
}

export function verifyWindowsAuthenticodeGoogle(binaryPath) {
  if (process.platform !== 'win32') {
    return { verified: false, reason: 'non_windows_platform' };
  }
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script =
    `$sig = Get-AuthenticodeSignature -LiteralPath $env:NP01_VERIFY_BIN; ` +
    `if ($sig.Status -eq 'Valid' -and $sig.SignerCertificate.Subject -match 'Google LLC') { 'VALID_GOOGLE' } else { 'INVALID:' + $sig.Status }`;
  const res = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, NP01_VERIFY_BIN: binaryPath },
    encoding: 'utf8',
    timeout: 25_000,
    windowsHide: true,
  });
  const out = (res.stdout ?? '').trim();
  return {
    verified: res.status === 0 && out === 'VALID_GOOGLE',
    reason: out || (res.error?.code ? `err_${res.error.code}` : `exit_${res.status ?? 'unknown'}`),
  };
}

export function validateLiveRecordOptions(values, envInfo = {}) {
  const platform = envInfo.platform ?? process.platform;
  const isTTY = envInfo.isTTY ?? Boolean(process.stdin.isTTY);
  const allowMockBinaryForTest = Boolean(envInfo.allowMockBinaryForTest);
  const protocol = Number(values.protocol ?? '1');
  const dryRun = Boolean(values['dry-run']);

  if (!dryRun && !allowMockBinaryForTest && platform !== 'win32') {
    throw new Error('Live AGY recording requires Windows (win32)');
  }
  if (![1, 2].includes(protocol)) {
    throw new Error('Protocol must be 1 or 2');
  }

  if (!allowMockBinaryForTest) {
    if (!values.agy || !path.win32.isAbsolute(values.agy) || path.win32.basename(values.agy).toLowerCase() !== 'agy.exe') {
      throw new Error('Pass --agy with the absolute path of the official agy.exe');
    }
    if (!isOfficialAgyBinaryPath(values.agy, envInfo)) {
      throw new Error('Binary path is outside official Google AGY installation locations');
    }
  } else if (!values.agy) {
    throw new Error('Test runner requires --agy command');
  }

  const live = Boolean(values['reactive-confirmed']);
  const discover = Boolean(values['discover-confirmed']);
  const login = Boolean(values['login-test-profile']);
  const authorizedProfile = live || discover || login;

  if ([live, discover, login].filter(Boolean).length > 1) {
    throw new Error('Choose at most one authorized scenario: --login-test-profile, --discover-confirmed, or --reactive-confirmed');
  }
  if (authorizedProfile !== Boolean(values['test-profile'])) {
    throw new Error('Authorized scenarios require --test-profile, and clean mode must omit --test-profile');
  }
  if (authorizedProfile && protocol !== 1) {
    throw new Error('Authorized scenarios currently require --protocol 1');
  }
  if (!dryRun && !allowMockBinaryForTest && (live || login) && !isTTY) {
    throw new Error('Login and reactive scenarios require an interactive terminal (TTY)');
  }
  if (authorizedProfile && values.catalog) {
    throw new Error('Run --catalog only in clean unauthenticated mode');
  }
  if (live !== Boolean(values.model) || (live && !GEMINI_38_FLASH_RE.test(values.model))) {
    throw new Error('Reactive requires --model with an advertised Gemini 3.8 Flash ID (discover it first)');
  }

  const dedicatedProfileExpected = envInfo.dedicatedProfileOverride ?? G0_DEDICATED_PROFILE_DIR;
  const allowedCleanRoots = envInfo.allowedRootsOverride ?? G0_ALLOWED_CLEAN_ROOTS;
  const allowedAuthorizedRoots = envInfo.allowedAuthorizedRootsOverride ?? [
    path.win32.join(G0_DEDICATED_TEST_ROOT, 'runs'),
    path.win32.join(G0_DEDICATED_TEST_ROOT, 'temp'),
  ];

  let testProfilePath = null;
  if (authorizedProfile) {
    const resolvedProfile = allowMockBinaryForTest
      ? path.resolve(values['test-profile'])
      : requireDPath(values['test-profile'], '--test-profile');
    const normProfile = allowMockBinaryForTest
      ? path.resolve(resolvedProfile).toLowerCase()
      : normalizeWinPath(resolvedProfile);
    const normExpected = allowMockBinaryForTest
      ? path.resolve(dedicatedProfileExpected).toLowerCase()
      : normalizeWinPath(dedicatedProfileExpected);
    if (normProfile !== normExpected) {
      throw new Error(`--test-profile must be the G0 dedicated test profile (${dedicatedProfileExpected})`);
    }
    testProfilePath = resolvedProfile;
  }

  const allowedIoRoots = authorizedProfile ? allowedAuthorizedRoots : allowedCleanRoots;
  const scratchPath = allowMockBinaryForTest
    ? path.resolve(values.scratch)
    : requireAllowedDir(values.scratch, '--scratch', allowedIoRoots);
  const outPath = values.out
    ? allowMockBinaryForTest
      ? path.resolve(values.out)
      : requireAllowedDir(values.out, '--out', allowedIoRoots)
    : null;
  const summaryOutPath = values['summary-out']
    ? allowMockBinaryForTest
      ? path.resolve(values['summary-out'])
      : requireAllowedDir(values['summary-out'], '--summary-out', allowedIoRoots)
    : null;

  const mode = login
    ? 'login_test_profile'
    : live
      ? 'reactive_confirmed'
      : discover
        ? 'discover_confirmed'
        : 'clean_unauthenticated';

  const scenario =
    values.scenario ??
    (mode === 'reactive_confirmed'
      ? 'T02'
      : mode === 'discover_confirmed'
        ? 'T01_discover'
        : protocol === 2
          ? 'clean_v2'
          : 'clean_v1');

  return {
    agy: values.agy,
    protocol,
    dryRun,
    catalog: Boolean(values.catalog),
    live,
    discover,
    login,
    authorizedProfile,
    model: values.model ?? null,
    scratchPath,
    testProfilePath,
    outPath,
    summaryOutPath,
    scenario,
    mode,
    timeoutMs: Number(values['timeout-ms'] ?? (live ? '150000' : '12000')),
    postResponseWindowMs: Number(values['post-window-ms'] ?? '45000'),
    salt: values.salt ?? undefined,
    allowMockBinaryForTest,
  };
}

function findModelConfig(options) {
  return Array.isArray(options) ? options.find((o) => o?.category === 'model' || o?.id === 'model') : undefined;
}

export function evaluateCaptureOutcome({ mode, protocol, reason, negotiatedProtocol, authRequiredObserved, promptSent, reactiveObserved, validationValid }) {
  if (!validationValid) {
    return { success: false, outcome: 'validation_failed' };
  }
  if (mode === 'clean_unauthenticated') {
    if (protocol === 1 && reason === 'session-not-opened' && authRequiredObserved) {
      return { success: true, outcome: 'expected_auth_required' };
    }
    if (protocol === 2 && reason === 'version-not-negotiated' && negotiatedProtocol === 1) {
      return { success: true, outcome: 'expected_v2_downgrade_to_v1' };
    }
    return { success: false, outcome: `unexpected_clean_exit_${reason}` };
  }
  if (mode === 'discover_confirmed') {
    if (reason === 'discovery-complete') {
      return { success: true, outcome: 'discovery_complete' };
    }
    return { success: false, outcome: `discovery_failed_${reason}` };
  }
  if (mode === 'reactive_confirmed') {
    if (reason === 'post-response-observation-window' && promptSent) {
      return { success: true, outcome: reactiveObserved ? 'reactive_observed' : 'reactive_not_observed' };
    }
    return { success: false, outcome: `reactive_failed_${reason}` };
  }
  return { success: false, outcome: `unknown_mode_${reason}` };
}

export async function runLiveRecord(argv = process.argv.slice(2), internalTestHooks = {}) {
  const { values } = parseArgs({
    args: argv,
    options: {
      agy: { type: 'string' },
      scratch: { type: 'string' },
      protocol: { type: 'string', default: '1' },
      catalog: { type: 'boolean', default: false },
      'test-profile': { type: 'string' },
      model: { type: 'string' },
      'login-test-profile': { type: 'boolean', default: false },
      'discover-confirmed': { type: 'boolean', default: false },
      'reactive-confirmed': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      out: { type: 'string' },
      'summary-out': { type: 'string' },
      scenario: { type: 'string' },
      'timeout-ms': { type: 'string' },
      'post-window-ms': { type: 'string' },
      salt: { type: 'string' },
    },
  });

  const cfg = validateLiveRecordOptions(values, internalTestHooks);

  if (cfg.dryRun) {
    const plan = {
      dryRun: true,
      mode: cfg.mode,
      scenario: cfg.scenario,
      platform: process.platform,
      agyBinaryPath: path.win32.basename(cfg.agy),
      agyBinaryExists: fs.existsSync(cfg.agy),
      officialPathVerified: cfg.allowMockBinaryForTest ? false : isOfficialAgyBinaryPath(cfg.agy, internalTestHooks),
      signatureCheckPlanned: !cfg.allowMockBinaryForTest,
      requestedProtocol: cfg.protocol,
      authorizedProfile: cfg.authorizedProfile,
      dedicatedProfileBound: cfg.authorizedProfile,
      model: cfg.model ? safePublicOption(cfg.model) ?? cfg.model : null,
      catalog: cfg.catalog,
      timeoutMs: cfg.timeoutMs,
      postResponseWindowMs: cfg.postResponseWindowMs,
      redactionPolicy: 'allowlist_v1',
      isolation: {
        dDriveEnforced: !cfg.allowMockBinaryForTest,
        dedicatedG0ProfileOnly: true,
        forceFileStorage: true,
        disableAutoUpdate: true,
        disableTelemetry: true,
        sshConnectionIsolation: true,
      },
      plannedSteps: cfg.login
        ? ['verify_official_signature', 'official_interactive_login']
        : cfg.live
          ? [
              'verify_official_signature',
              'version_check',
              'initialize',
              'session/new',
              'confirm_model_config',
              'operator_tty_YES',
              'session/prompt',
              'post_response_window',
            ]
          : cfg.discover
            ? ['verify_official_signature', 'version_check', 'initialize', 'session/new', 'observe_discovery_window']
            : [
                'verify_official_signature',
                'version_check',
                ...(cfg.catalog ? ['cli_catalog_models', 'cli_catalog_agents'] : []),
                'initialize',
                'session/new',
              ],
    };
    console.log(JSON.stringify(plan, null, 2));
    return { dryRun: true, success: true, outcome: 'dry_run_valid', plan };
  }

  if (!cfg.allowMockBinaryForTest) {
    if (!fs.existsSync(cfg.agy)) {
      throw new Error('Official agy.exe binary does not exist at the specified path');
    }
    const sig = verifyWindowsAuthenticodeGoogle(cfg.agy);
    if (!sig.verified) {
      throw new Error(`Refusing to launch agy.exe: Authenticode Google signature check failed (${sig.reason})`);
    }
  }

  fs.mkdirSync(cfg.scratchPath, { recursive: true });
  const scratchReal = cfg.allowMockBinaryForTest
    ? fs.realpathSync(cfg.scratchPath)
    : requireAllowedDir(
        fs.realpathSync(cfg.scratchPath),
        'resolved scratch',
        cfg.authorizedProfile
          ? [path.win32.join(G0_DEDICATED_TEST_ROOT, 'runs'), path.win32.join(G0_DEDICATED_TEST_ROOT, 'temp')]
          : G0_ALLOWED_CLEAN_ROOTS,
      );
  const root = fs.mkdtempSync(path.join(scratchReal, 'np01-obs-'));
  const cwd = path.join(root, 'workspace');
  const temp = path.join(root, 'temp');
  const userProfile = path.join(root, 'profile');
  let geminiDir = path.join(userProfile, '.gemini');
  if (cfg.authorizedProfile) {
    fs.mkdirSync(cfg.testProfilePath, { recursive: true });
    const resolvedProfileReal = fs.realpathSync(cfg.testProfilePath);
    if (!cfg.allowMockBinaryForTest && normalizeWinPath(resolvedProfileReal) !== normalizeWinPath(G0_DEDICATED_PROFILE_DIR)) {
      throw new Error(`Resolved --test-profile symlink/junction escapes G0 dedicated profile (${G0_DEDICATED_PROFILE_DIR})`);
    }
    geminiDir = resolvedProfileReal;
  }
  const appdata = path.join(userProfile, 'AppData', 'Roaming');
  const localappdata = path.join(userProfile, 'AppData', 'Local');
  for (const directory of [cwd, temp, geminiDir, appdata, localappdata]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  const env = {
    ...(cfg.allowMockBinaryForTest ? process.env : {}),
    SystemRoot: systemRoot,
    windir: systemRoot,
    ComSpec: path.join(system32, 'cmd.exe'),
    PATH: cfg.allowMockBinaryForTest
      ? process.env.PATH
      : [path.dirname(cfg.agy), system32, path.join(system32, 'WindowsPowerShell', 'v1.0')].join(';'),
    USERPROFILE: userProfile,
    APPDATA: appdata,
    LOCALAPPDATA: localappdata,
    TMP: temp,
    TEMP: temp,
    TMPDIR: temp,
    GEMINI_HOME: geminiDir,
    AGY_ACP_FORCE_FILE_STORAGE: '1',
    AGY_CLI_DISABLE_AUTO_UPDATE: '1',
    SSH_CONNECTION: '127.0.0.1 0 127.0.0.1 0',
  };

  if (cfg.login) {
    const result = spawnSync(
      cfg.agy,
      ['acp', '--login', '--gemini-dir', geminiDir, '--app-data-dir', 'antigravity-cli', '--disable-telemetry'],
      { cwd, env, stdio: 'inherit' },
    );
    const status = result.status ?? 1;
    return { dryRun: false, success: status === 0, outcome: status === 0 ? 'login_completed' : 'login_failed', exitCode: status };
  }

  if (cfg.outPath) {
    fs.mkdirSync(path.dirname(cfg.outPath), { recursive: true });
    fs.writeFileSync(cfg.outPath, '', 'utf8');
  }

  const spawnCommand = cfg.allowMockBinaryForTest && internalTestHooks.mockSpawnCommand
    ? internalTestHooks.mockSpawnCommand
    : cfg.agy;
  const spawnBaseArgs = cfg.allowMockBinaryForTest && internalTestHooks.mockSpawnArgs
    ? internalTestHooks.mockSpawnArgs
    : [
        'acp',
        '--stdio',
        '--gemini-dir',
        geminiDir,
        '--app-data-dir',
        'antigravity-cli',
        '--disable-telemetry',
        '--log-file',
        path.join(root, 'acp-local.log'),
      ];

  const versionRes = cfg.allowMockBinaryForTest
    ? { stdout: internalTestHooks.mockVersion ?? '1.5.16-mock' }
    : spawnSync(cfg.agy, ['--version'], { cwd, env, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  const versionStr = versionRes.stdout?.trim() || null;

  const recorder = new ProtocolObservatoryRecorder({
    scenario: cfg.scenario,
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    cliVersion: versionStr,
    protocol: null, // Populated once initialize response confirms negotiated protocol
    accountCategory: cfg.authorizedProfile ? 'dedicated_test_personal' : 'none',
    source: cfg.allowMockBinaryForTest ? 'synthetic' : 'live_raw',
    producer: 'observatory_cli',
    salt: cfg.salt,
    outputFile: cfg.outPath,
    sink: cfg.outPath || internalTestHooks.quietStdout ? null : (_rec, serialized) => console.log(serialized),
    provenance: {
      origin: cfg.allowMockBinaryForTest ? `mock_probe_${cfg.mode}` : `live_windows_agy_${cfg.mode}`,
      migratedFrom: null,
      timingSynthetic: cfg.allowMockBinaryForTest,
      notes: 'Captured via NP-01 observatory CLI v0.2 with allowlist reconstruction',
    },
  });

  recorder.recordCaptureMeta({
    profileSource: cfg.authorizedProfile ? 'dedicated_test' : 'ephemeral',
    mode: cfg.mode,
    requestedProtocol: cfg.protocol,
  });

  if (cfg.catalog && !cfg.allowMockBinaryForTest) {
    for (const command of ['models', 'agents']) {
      const result = spawnSync(cfg.agy, [command], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 8_000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      });
      recorder.recordCliCatalog({
        command,
        exitCode: result.status,
        timeout: result.error?.code === 'ETIMEDOUT',
        authorizationPrompt: /authentication required|visit the url to log in|please sign in/i.test(
          `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
        ),
        stdoutLines: (result.stdout ?? '').split(/\r?\n/).filter((l) => l.trim()).length,
      });
    }
  }

  return new Promise((resolve) => {
    const child = spawn(spawnCommand, spawnBaseArgs, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const operator = cfg.live
      ? internalTestHooks.mockOperator ?? interactiveReadline({ input: process.stdin, output: process.stderr })
      : null;

    let stderrBytes = 0;
    let stderrBuf = '';
    let stderrOverlongDiscard = false;
    let parentSession = null;
    let stopReason = null;
    let finalized = false;
    let promptSent = false;
    let authRequiredObserved = false;
    let promptResponseSeen = false;
    let completedBackgroundTool = null;
    let reactiveObserved = false;
    const backgroundTools = new Set();
    const seenTools = new Set();
    let negotiatedProtocol = null;
    let tailTimer = null;
    let closeWaitTimer = null;
    let modelConfigId = null;
    let modelResponseAccepted = false;
    let selectedModel = null;
    let confirmationShown = false;

    const flushBoundedStderrLine = (rawLine) => {
      const trimmed = rawLine.trim();
      if (trimmed) recorder.recordStderrLine(trimmed);
    };

    const finalize = async (exitInfo) => {
      if (finalized) return;
      finalized = true;
      clearTimeout(deadline);
      if (tailTimer) clearTimeout(tailTimer);
      if (closeWaitTimer) clearTimeout(closeWaitTimer);
      operator?.close?.();

      if (stderrBuf.trim()) {
        flushBoundedStderrLine(stderrBuf);
        stderrBuf = '';
      }
      if (exitInfo) {
        recorder.recordProcessExit(
          { exitCode: exitInfo.exitCode, signal: exitInfo.signal, reason: exitInfo.reason },
          { bypassCap: true },
        );
      }

      const finalReason = stopReason ?? exitInfo?.reason ?? 'child-exit';
      const preValidation = validateCaptureRecords(recorder.records);
      const outcomeRes = evaluateCaptureOutcome({
        mode: cfg.mode,
        protocol: cfg.protocol,
        reason: finalReason,
        negotiatedProtocol,
        authRequiredObserved,
        promptSent,
        reactiveObserved,
        validationValid: preValidation.valid,
      });

      recorder.recordCaptureEnd({
        reason: finalReason,
        outcome: outcomeRes.outcome,
        stderrBytes,
        promptSent,
      });

      await recorder.flush();

      const validation = validateCaptureRecords(recorder.records);
      const summary = buildFourLayerSummary(recorder.records);
      const finalSuccess = outcomeRes.success && validation.valid;

      if (cfg.summaryOutPath && validation.valid) {
        fs.mkdirSync(path.dirname(cfg.summaryOutPath), { recursive: true });
        fs.writeFileSync(cfg.summaryOutPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      }

      resolve({
        dryRun: false,
        success: finalSuccess,
        reason: finalReason,
        outcome: outcomeRes.outcome,
        negotiatedProtocol,
        promptSent,
        exitCode: exitInfo?.exitCode ?? null,
        recordCount: recorder.records.length,
        validation,
        summary,
      });
    };

    const initiateStop = (reason) => {
      if (stopReason !== null) return;
      stopReason = reason;
      clearTimeout(deadline);
      if (tailTimer) clearTimeout(tailTimer);
      operator?.close?.();
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          if (process.platform === 'win32') {
            spawnSync(path.join(system32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
              stdio: 'ignore',
              timeout: 4_000,
            });
          } else {
            try {
              child.kill('SIGKILL');
            } catch {
              // ignore
            }
          }
        }
      }, 400).unref();

      // Guarantee finalize even if OS close event is delayed
      closeWaitTimer = setTimeout(() => {
        void finalize({ exitCode: child.exitCode, signal: child.signalCode, reason: 'close_timeout' });
      }, 2_500);
      closeWaitTimer.unref();
    };

    const deadline = setTimeout(() => {
      recorder.recordTimeout({ method: 'capture_deadline', timeoutMs: cfg.timeoutMs, scope: 'session_capture', forced: false });
      initiateStop('deadline');
    }, cfg.timeoutMs);

    process.once('SIGINT', () => initiateStop('operator-interrupted'));

    child.on('error', (error) => {
      stopReason = stopReason ?? 'spawn-error';
      void finalize({ exitCode: -1, signal: null, reason: `spawn_error_${error?.code ?? 'unknown'}` });
    });

    child.on('close', (exitCode, signal) => {
      void finalize({ exitCode, signal, reason: 'child_exit' });
    });

    child.stdin.on('error', () => initiateStop('stdin-closed'));

    // Strictly bounded stderr accumulation before newline (R4)
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      const text = chunk.toString('utf8');
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n') {
          if (!stderrOverlongDiscard) {
            flushBoundedStderrLine(stderrBuf);
          }
          stderrBuf = '';
          stderrOverlongDiscard = false;
        } else if (!stderrOverlongDiscard) {
          stderrBuf += ch;
          if (Buffer.byteLength(stderrBuf, 'utf8') >= MAX_STDERR_LINE_BYTES) {
            flushBoundedStderrLine(stderrBuf);
            stderrBuf = '';
            stderrOverlongDiscard = true;
          }
        }
      }
    });

    const send = (envelope) => {
      if (stopReason !== null) return;
      const full = { jsonrpc: '2.0', ...envelope };
      recorder.recordOutboundFrame(full);
      child.stdin.write(`${JSON.stringify(full)}\n`);
    };

    const request = (id, method, params) => send({ id, method, params });

    const confirmPrompt = () => {
      if (confirmationShown || selectedModel !== cfg.model || !modelResponseAccepted) return;
      confirmationShown = true;
      if (tailTimer) clearTimeout(tailTimer);
      const prompt =
        '这是一项低成本 ACP 兼容测试。请按普通权限策略执行。' +
        '用你的原生命令工具启动一个非 daemon 的后台命令，不能前台阻塞。唯一启动命令为 ' +
        'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 20; Write-Output NP00_FINITE_DONE"。' +
        '等待原生完成通知。收到通知后用一次新的只读工具调用执行 Get-Location，再报告结果。' +
        '不要自行轮询、另起脚本、修改文件或使用网络。';
      // Interactive operator review goes strictly to stderr TTY, never to evidence stdout/--out
      if (!internalTestHooks.quietStderr) {
        console.error(`Confirmed model: ${selectedModel}`);
        console.error(prompt);
      }
      void operator
        .question('Use this test session and send the one prompt? Type YES: ')
        .then((answer) => {
          if (String(answer ?? '').trim() !== 'YES') return initiateStop('operator-declined');
          if (stopReason !== null) return;
          if (selectedModel !== cfg.model) return initiateStop('model-changed-before-prompt');
          promptSent = true;
          request(3, 'session/prompt', { sessionId: parentSession, prompt: [{ type: 'text', text: prompt }] });
        })
        .catch(() => initiateStop('operator-input-closed'));
    };

    let permissionQueue = Promise.resolve();
    lines.on('line', (line) => {
      if (stopReason !== null) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        recorder.recordMalformedLine(line, { stream: 'stdout' });
        return;
      }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        recorder.recordMalformedLine(line, { stream: 'stdout' });
        return;
      }

      const rec = recorder.recordInboundFrame(msg);

      if (msg.method && msg.id !== undefined) {
        const p = msg.params ?? {};
        if (msg.method === 'session/request_permission') {
          permissionQueue = permissionQueue
            .then(async () => {
              let outcome = { outcome: 'cancelled' };
              if (stopReason === null && operator && Array.isArray(p.options)) {
                // Keep official permission details strictly on operator stderr TTY
                if (!internalTestHooks.quietStderr) {
                  console.error(JSON.stringify({ tool: p.toolCall, options: p.options }));
                }
                const answer = await operator.question('Choose the 1-based native option number, or Enter to cancel: ');
                const option = /^\d+$/.test(String(answer ?? '').trim())
                  ? p.options[Number(String(answer).trim()) - 1]
                  : undefined;
                if (option && ['allow_once', 'reject_once'].includes(option.kind)) {
                  outcome = { outcome: 'selected', optionId: option.optionId };
                }
              }
              send({ id: msg.id, result: { outcome } });
            })
            .catch(() => send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } }));
        } else {
          send({ id: msg.id, error: { code: -32601, message: 'Method not implemented by observatory' } });
        }
        return;
      }

      if (msg.method === 'session/update') {
        const u = msg.params?.update ?? {};
        const belongsToProbe = cfg.live && parentSession && msg.params?.sessionId === parentSession;
        if (belongsToProbe && promptSent && rec && !rec.truncated && !rec.correlation.childAlias) {
          const tool = rec.correlation.toolAlias;
          if (u.sessionUpdate === 'tool_call' && tool) {
            if (!promptResponseSeen && rec.shape.detectedRole === 'background_command' &&
                (u.status === 'pending' || u.status === 'in_progress')) {
              backgroundTools.add(tool);
            }
            if (completedBackgroundTool && !seenTools.has(tool)) {
              reactiveObserved = true;
            }
            seenTools.add(tool);
          } else if (u.sessionUpdate === 'tool_call_update' && tool && backgroundTools.has(tool) &&
                     ['completed', 'failed', 'cancelled'].includes(u.status)) {
            backgroundTools.delete(tool);
            if (promptResponseSeen && u.status === 'completed' &&
                extractMarkersFromUnknown(u.rawOutput, recorder.aliases)?.some(({ marker }) => marker === 'NP00_FINITE_DONE')) {
              completedBackgroundTool = tool;
            }
          }
        }
        if (belongsToProbe && u.sessionUpdate === 'config_option_update') {
          const model = findModelConfig(u.configOptions);
          if (model && model.id === modelConfigId && typeof model.currentValue === 'string') {
            selectedModel = model.currentValue;
            confirmPrompt();
          }
        }
        return;
      }

      if (msg.id === 1) {
        const initRes = msg.result ?? {};
        negotiatedProtocol = typeof initRes.protocolVersion === 'number' ? initRes.protocolVersion : null;
        if (msg.error || negotiatedProtocol !== cfg.protocol) {
          return initiateStop('version-not-negotiated');
        }
        request(2, 'session/new', { cwd, mcpServers: [] });
      } else if (msg.id === 2) {
        if (msg.error && (msg.error.code === -32000 || rec?.shape?.error?.authenticationRequired)) {
          authRequiredObserved = true;
        }
        const sessRes = msg.result;
        parentSession = sessRes?.sessionId ?? null;
        if (!parentSession || !cfg.live) {
          tailTimer = setTimeout(
            () => initiateStop(parentSession ? 'discovery-complete' : 'session-not-opened'),
            cfg.allowMockBinaryForTest ? 80 : 1_500,
          );
          return;
        }
        const model = findModelConfig(sessRes.configOptions);
        if (!model?.id || model.type !== 'select') return initiateStop('model-config-not-advertised');
        modelConfigId = model.id;
        selectedModel = model.currentValue;
        if (selectedModel === cfg.model) {
          modelResponseAccepted = true;
          confirmPrompt();
          return;
        }
        const offered = model.options?.flatMap((o) => o.options ?? [o]);
        if (!offered?.some((o) => o.value === cfg.model)) return initiateStop('requested-model-not-advertised');
        request(4, 'session/set_config_option', { sessionId: parentSession, configId: modelConfigId, value: cfg.model });
        tailTimer = setTimeout(() => initiateStop('model-not-confirmed'), cfg.allowMockBinaryForTest ? 500 : 12_000);
      } else if (msg.id === 4) {
        if (msg.error) return initiateStop('model-config-rejected');
        const model = findModelConfig(msg.result?.configOptions);
        if (model && model.id === modelConfigId && typeof model.currentValue === 'string') {
          selectedModel = model.currentValue;
        }
        modelResponseAccepted = true;
        confirmPrompt();
      } else if (msg.id === 3 && promptSent && !promptResponseSeen) {
        if (msg.error) return initiateStop('prompt-rpc-error');
        if (msg.result?.stopReason !== 'end_turn') return initiateStop('prompt-not-successful');
        promptResponseSeen = true;
        tailTimer = setTimeout(
          () => initiateStop('post-response-observation-window'),
          cfg.allowMockBinaryForTest ? Math.min(cfg.postResponseWindowMs, 150) : cfg.postResponseWindowMs,
        );
      }
    });

    request(1, 'initialize', {
      protocolVersion: cfg.protocol,
      clientInfo: { name: 'harnessmate-np01-observatory', version: '0.2.0' },
      clientCapabilities: {},
    });
  });
}
