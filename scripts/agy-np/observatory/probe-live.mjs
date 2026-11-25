import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as interactiveReadline } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { buildFourLayerSummary } from './four-layer.mjs';
import { ProtocolObservatoryRecorder } from './recorder.mjs';
import { safePublicOption } from './sanitizer.mjs';
import { validateCaptureRecords } from './schema-validator.mjs';

export const GEMINI_38_FLASH_RE = /^gemini-3\.8-flash(?:[-_.:][a-z0-9._:-]{1,64})?$/i;

export function requireDPath(value, label) {
  if (!value || !/^D:\\[^\\]/i.test(value) || !/^D:\\[^\\]/i.test(path.resolve(value))) {
    throw new Error(`${label} must be an absolute path on D:\\`);
  }
  return path.resolve(value);
}

export function validateLiveRecordOptions(values, envInfo = {}) {
  const platform = envInfo.platform ?? process.platform;
  const isTTY = envInfo.isTTY ?? Boolean(process.stdin.isTTY);
  const protocol = Number(values.protocol ?? '1');
  const dryRun = Boolean(values['dry-run']);

  if (!dryRun && platform !== 'win32') {
    throw new Error('Live AGY recording requires Windows (win32)');
  }
  if (![1, 2].includes(protocol)) {
    throw new Error('Protocol must be 1 or 2');
  }
  if (!values.agy || !path.isAbsolute(values.agy) || path.basename(values.agy).toLowerCase() !== 'agy.exe') {
    throw new Error('Pass --agy with the absolute path of the official agy.exe');
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
  if (!dryRun && (live || login) && !isTTY) {
    throw new Error('Login and reactive scenarios require an interactive terminal (TTY)');
  }
  if (authorizedProfile && values.catalog) {
    throw new Error('Run --catalog only in clean unauthenticated mode');
  }
  if (live !== Boolean(values.model) || (live && !GEMINI_38_FLASH_RE.test(values.model))) {
    throw new Error('Reactive requires --model with an advertised Gemini 3.8 Flash ID (discover it first)');
  }

  const scratchPath = requireDPath(values.scratch, '--scratch');
  const testProfilePath = authorizedProfile ? requireDPath(values['test-profile'], '--test-profile') : null;
  const outPath = values.out ? requireDPath(values.out, '--out') : null;
  const summaryOutPath = values['summary-out'] ? requireDPath(values['summary-out'], '--summary-out') : null;

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
  };
}

function findModelConfig(options) {
  return Array.isArray(options) ? options.find((o) => o?.category === 'model' || o?.id === 'model') : undefined;
}

export async function runLiveRecord(argv = process.argv.slice(2)) {
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

  const cfg = validateLiveRecordOptions(values);

  if (cfg.dryRun) {
    const plan = {
      dryRun: true,
      mode: cfg.mode,
      scenario: cfg.scenario,
      platform: process.platform,
      agyBinaryPath: path.basename(cfg.agy),
      agyBinaryExists: fs.existsSync(cfg.agy),
      protocol: cfg.protocol,
      authorizedProfile: cfg.authorizedProfile,
      model: cfg.model ? safePublicOption(cfg.model) ?? cfg.model : null,
      catalog: cfg.catalog,
      timeoutMs: cfg.timeoutMs,
      postResponseWindowMs: cfg.postResponseWindowMs,
      redactionPolicy: 'allowlist_v1',
      isolation: {
        dDriveEnforced: true,
        forceFileStorage: true,
        disableAutoUpdate: true,
        disableTelemetry: true,
        sshConnectionIsolation: true,
      },
      plannedSteps: cfg.login
        ? ['official_interactive_login']
        : cfg.live
          ? ['version_check', 'initialize', 'session/new', 'confirm_model_config', 'operator_tty_YES', 'session/prompt', 'post_response_window']
          : cfg.discover
            ? ['version_check', 'initialize', 'session/new', 'observe_discovery_window']
            : ['version_check', ...(cfg.catalog ? ['cli_catalog_models', 'cli_catalog_agents'] : []), 'initialize', 'session/new'],
    };
    console.log(JSON.stringify(plan, null, 2));
    return { dryRun: true, plan };
  }

  fs.mkdirSync(cfg.scratchPath, { recursive: true });
  const scratchReal = requireDPath(fs.realpathSync(cfg.scratchPath), 'resolved scratch');
  const root = fs.mkdtempSync(path.join(scratchReal, 'np01-obs-'));
  const cwd = path.join(root, 'workspace');
  const temp = path.join(root, 'temp');
  const userProfile = path.join(root, 'profile');
  const geminiDir = cfg.authorizedProfile
    ? requireDPath(fs.realpathSync(cfg.testProfilePath), 'resolved test-profile')
    : path.join(userProfile, '.gemini');
  const appdata = path.join(userProfile, 'AppData', 'Roaming');
  const localappdata = path.join(userProfile, 'AppData', 'Local');
  for (const directory of [cwd, temp, geminiDir, appdata, localappdata]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const system32 = path.join(systemRoot, 'System32');
  const env = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    ComSpec: path.join(system32, 'cmd.exe'),
    PATH: [path.dirname(cfg.agy), system32, path.join(system32, 'WindowsPowerShell', 'v1.0')].join(';'),
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
    process.exit(result.status ?? 1);
  }

  if (cfg.outPath) {
    fs.mkdirSync(path.dirname(cfg.outPath), { recursive: true });
    fs.writeFileSync(cfg.outPath, '', 'utf8');
  }

  const versionRes = spawnSync(cfg.agy, ['--version'], { cwd, env, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  const versionStr = versionRes.stdout?.trim() || null;

  const recorder = new ProtocolObservatoryRecorder({
    scenario: cfg.scenario,
    platform: 'win32',
    cliVersion: versionStr,
    protocol: cfg.protocol,
    accountCategory: cfg.authorizedProfile ? 'dedicated_test_personal' : 'none',
    source: 'live_raw',
    producer: 'observatory_cli',
    salt: cfg.salt,
    outputFile: cfg.outPath,
    sink: cfg.outPath ? null : (_rec, serialized) => console.log(serialized),
    provenance: {
      origin: `live_windows_agy_${cfg.mode}`,
      migratedFrom: null,
      timingSynthetic: false,
      notes: 'Captured via NP-01 observatory CLI with allowlist reconstruction',
    },
  });

  recorder.recordCaptureMeta({
    profileSource: cfg.authorizedProfile ? 'dedicated_test' : 'ephemeral',
    mode: cfg.mode,
    requestedProtocol: cfg.protocol,
  });

  if (cfg.catalog) {
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
    const child = spawn(
      cfg.agy,
      [
        'acp',
        '--stdio',
        '--gemini-dir',
        geminiDir,
        '--app-data-dir',
        'antigravity-cli',
        '--disable-telemetry',
        '--log-file',
        path.join(root, 'acp-local.log'),
      ],
      { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );

    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const operator = cfg.live ? interactiveReadline({ input: process.stdin, output: process.stderr }) : null;

    let stderrBytes = 0;
    let stderrBuf = '';
    let parentSession = null;
    let finishing = false;
    let promptSent = false;
    let tailTimer = null;
    let modelConfigId = null;
    let modelResponseAccepted = false;
    let selectedModel = null;
    let confirmationShown = false;

    const finish = (reason) => {
      if (finishing) return;
      finishing = true;
      clearTimeout(deadline);
      if (tailTimer) clearTimeout(tailTimer);
      if (stderrBuf.trim()) {
        recorder.recordStderrLine(stderrBuf.trim());
        stderrBuf = '';
      }
      recorder.recordCaptureEnd({ reason, stderrBytes, promptSent });
      operator?.close();
      try {
        child.stdin.end();
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          spawnSync(path.join(system32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 4_000,
          });
        }
      }, 700).unref();

      const validation = validateCaptureRecords(recorder.records);
      const summary = buildFourLayerSummary(recorder.records);
      if (cfg.summaryOutPath) {
        fs.mkdirSync(path.dirname(cfg.summaryOutPath), { recursive: true });
        fs.writeFileSync(cfg.summaryOutPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      }
      resolve({ reason, recordCount: recorder.records.length, validation, summary });
    };

    const deadline = setTimeout(() => {
      recorder.recordTimeout({ method: 'capture_deadline', timeoutMs: cfg.timeoutMs, scope: 'session_capture', forced: false });
      finish('deadline');
    }, cfg.timeoutMs);

    process.once('SIGINT', () => finish('operator-interrupted'));

    child.on('error', (error) => {
      recorder.recordProcessExit({ exitCode: -1, reason: `spawn_error_${error?.code ?? 'unknown'}` });
      finish('spawn-error');
    });
    child.on('exit', (exitCode, signal) => {
      recorder.recordProcessExit({ exitCode, signal, reason: 'child_exit' });
      finish('child-exit');
    });
    child.stdin.on('error', () => finish('stdin-closed'));
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      stderrBuf += chunk.toString('utf8');
      let nl = stderrBuf.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuf.slice(0, nl).trim();
        stderrBuf = stderrBuf.slice(nl + 1);
        if (line) recorder.recordStderrLine(line);
        nl = stderrBuf.indexOf('\n');
      }
    });

    const send = (envelope) => {
      if (finishing) return;
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
      console.error(`Confirmed model: ${selectedModel}`);
      console.error(prompt);
      void operator
        .question('Use this test session and send the one prompt? Type YES: ')
        .then((answer) => {
          if (answer.trim() !== 'YES') return finish('operator-declined');
          if (finishing) return;
          if (selectedModel !== cfg.model) return finish('model-changed-before-prompt');
          promptSent = true;
          request(3, 'session/prompt', { sessionId: parentSession, prompt: [{ type: 'text', text: prompt }] });
        })
        .catch(() => finish('operator-input-closed'));
    };

    let permissionQueue = Promise.resolve();
    lines.on('line', (line) => {
      if (finishing) return;
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

      recorder.recordInboundFrame(msg);

      if (msg.method && msg.id !== undefined) {
        const p = msg.params ?? {};
        if (msg.method === 'session/request_permission') {
          permissionQueue = permissionQueue
            .then(async () => {
              let outcome = { outcome: 'cancelled' };
              if (!finishing && operator && Array.isArray(p.options)) {
                console.error(JSON.stringify({ tool: p.toolCall, options: p.options }));
                const answer = await operator.question('Choose the 1-based native option number, or Enter to cancel: ');
                const option = /^\d+$/.test(answer.trim()) ? p.options[Number(answer.trim()) - 1] : undefined;
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
        if (cfg.live && parentSession && msg.params?.sessionId === parentSession && u.sessionUpdate === 'config_option_update') {
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
        if (msg.error || initRes.protocolVersion !== cfg.protocol) {
          return finish('version-not-negotiated');
        }
        request(2, 'session/new', { cwd, mcpServers: [] });
      } else if (msg.id === 2) {
        const sessRes = msg.result;
        parentSession = sessRes?.sessionId ?? null;
        if (!parentSession || !cfg.live) {
          tailTimer = setTimeout(() => finish(parentSession ? 'discovery-complete' : 'session-not-opened'), 1_500);
          return;
        }
        const model = findModelConfig(sessRes.configOptions);
        if (!model?.id || model.type !== 'select') return finish('model-config-not-advertised');
        modelConfigId = model.id;
        selectedModel = model.currentValue;
        if (selectedModel === cfg.model) {
          modelResponseAccepted = true;
          confirmPrompt();
          return;
        }
        const offered = model.options?.flatMap((o) => o.options ?? [o]);
        if (!offered?.some((o) => o.value === cfg.model)) return finish('requested-model-not-advertised');
        request(4, 'session/set_config_option', { sessionId: parentSession, configId: modelConfigId, value: cfg.model });
        tailTimer = setTimeout(() => finish('model-not-confirmed'), 12_000);
      } else if (msg.id === 4) {
        if (msg.error) return finish('model-config-rejected');
        const model = findModelConfig(msg.result?.configOptions);
        if (model && model.id === modelConfigId && typeof model.currentValue === 'string') {
          selectedModel = model.currentValue;
        }
        modelResponseAccepted = true;
        confirmPrompt();
      } else if (msg.id === 3) {
        tailTimer = setTimeout(() => finish('post-response-observation-window'), cfg.postResponseWindowMs);
      }
    });

    request(1, 'initialize', {
      protocolVersion: cfg.protocol,
      clientInfo: { name: 'harnessmate-np01-observatory', version: '0.1.0' },
      clientCapabilities: {},
    });
  });
}
