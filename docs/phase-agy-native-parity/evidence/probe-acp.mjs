import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createInterface as interactiveReadline } from 'node:readline/promises';
import { parseArgs } from 'node:util';

// NP-00 investigation tool. Default mode never authenticates or sends a prompt.
const { values } = parseArgs({
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
  },
});

function requireDPath(value, label) {
  if (!value || !/^D:\\[^\\]/i.test(value) || !/^D:\\[^\\]/i.test(path.resolve(value))) {
    throw new Error(`${label} must be an absolute path on D:\\`);
  }
  return path.resolve(value);
}

const protocol = Number(values.protocol);
if (process.platform !== 'win32' || ![1, 2].includes(protocol) || !values.agy ||
    !path.isAbsolute(values.agy) || path.basename(values.agy).toLowerCase() !== 'agy.exe') {
  throw new Error('Use Windows and pass --agy with the absolute path of the official agy.exe');
}
const live = values['reactive-confirmed'];
const discover = values['discover-confirmed'];
const login = values['login-test-profile'];
const authorizedProfile = live || discover || login;
if ([live, discover, login].filter(Boolean).length > 1 ||
    authorizedProfile !== Boolean(values['test-profile']) ||
    (authorizedProfile && protocol !== 1) || ((live || login) && !process.stdin.isTTY)) {
  throw new Error('Use one scenario with --test-profile and protocol 1. Login and reactive require a terminal.');
}
if (authorizedProfile && values.catalog) throw new Error('Run the clean-profile catalog separately');
if (live !== Boolean(values.model) ||
    (live && !/^gemini-3\.8-flash(?:[-_.:][a-z0-9._:-]{1,64})?$/i.test(values.model))) {
  throw new Error('Reactive requires --model with an advertised Gemini 3.8 Flash ID. Discover it first.');
}
const scratch = requireDPath(fs.realpathSync(requireDPath(values.scratch, '--scratch')), 'resolved scratch');
const root = fs.mkdtempSync(path.join(scratch, 'np00-acp-'));
const cwd = path.join(root, 'workspace');
const temp = path.join(root, 'temp');
const userProfile = path.join(root, 'profile');
const geminiDir = authorizedProfile
  ? requireDPath(fs.realpathSync(requireDPath(values['test-profile'], '--test-profile')), 'resolved test-profile')
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
  PATH: [path.dirname(values.agy), system32, path.join(system32, 'WindowsPowerShell', 'v1.0')].join(';'),
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
if (login) {
  const result = spawnSync(values.agy, [
    'acp', '--login', '--gemini-dir', geminiDir, '--app-data-dir', 'antigravity-cli',
    '--disable-telemetry',
  ], { cwd, env, stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

const start = performance.now();
const report = (kind, data = {}) => {
  console.log(JSON.stringify({ ms: Math.round(performance.now() - start), kind, ...data }));
};
const label = (value) => typeof value === 'string' && /^[a-zA-Z0-9_./ -]{1,80}$/.test(value)
  ? value
  : undefined;
const fieldNames = (obj) => (obj && typeof obj === 'object' ? Object.keys(obj) : [])
  .filter((key) => /^[a-zA-Z0-9_.:-]{1,64}$/.test(key)).sort();
const officialCommands = new Set([
  'add-dir', 'agents', 'artifact', 'automation', 'boost', 'browser', 'btw',
  'compact', 'config', 'context', 'diff', 'effort', 'fork', 'goal', 'grill-me',
  'hooks', 'learn', 'mcp', 'model', 'permissions', 'plan', 'plugin', 'projects',
  'resume', 'review', 'rewind', 'run-workflow', 'schedule', 'skills', 'swarm',
  'tasks', 'teamwork', 'usage',
]);
const publicOption = (value) => typeof value === 'string' && value.length <= 96 &&
  /^(default|auto|plan|accept-edits|low|medium|high|extra|max|xhigh|gemini[\w.:-]*|claude[\w.:-]*|orchestrator[\w.:-]*)$/i.test(value)
  ? value
  : undefined;
const errors = (error) => ({
  code: error?.code,
  authenticationRequired: /authentication required|please sign in/i.test(error?.message ?? ''),
});
const version = spawnSync(values.agy, ['--version'], { cwd, env, encoding: 'utf8', timeout: 5_000 });
report('launch', { profileSource: authorizedProfile ? 'dedicated_test' : 'ephemeral', version: label(version.stdout?.trim()), protocol });
if (values.catalog) {
  for (const command of ['models', 'agents']) {
    const result = spawnSync(values.agy, [command], {
      cwd, env, encoding: 'utf8', timeout: 8_000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    report('cli-catalog', {
      command,
      exitCode: result.status,
      timeout: result.error?.code === 'ETIMEDOUT',
      authorizationPrompt: /authentication required|visit the url to log in|please sign in/i
        .test(`${result.stdout ?? ''}\n${result.stderr ?? ''}`),
      stdoutLines: (result.stdout ?? '').split(/\r?\n/).filter((line) => line.trim()).length,
    });
  }
}

const child = spawn(values.agy, [
  'acp', '--stdio', '--gemini-dir', geminiDir, '--app-data-dir', 'antigravity-cli',
  '--disable-telemetry', '--log-file', path.join(root, 'acp-local.log'),
], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
const operator = live ? interactiveReadline({ input: process.stdin, output: process.stderr }) : undefined;
const ids = new Map();
function alias(namespace, value) {
  if (value === undefined || value === null) return undefined;
  const key = `${namespace}:${value}`;
  if (!ids.has(key)) ids.set(key, `${namespace}-${ids.size + 1}`);
  return ids.get(key);
}
let stderrBytes = 0;
let parent;
let finishing = false;
let promptSent = false;
let tail;
let modelConfigId;
let modelResponseAccepted = false;
let selectedModel;
let confirmationShown = false;
const stop = (reason) => {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  clearTimeout(tail);
  report('end', { reason, stderrBytes, promptSent });
  operator?.close();
  child.stdin.end();
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      spawnSync(path.join(system32, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 4_000,
      });
    }
  }, 700).unref();
};
const deadline = setTimeout(() => stop('deadline'), live ? 150_000 : 12_000);
process.on('SIGINT', () => stop('operator-interrupted'));
child.on('error', (error) => { report('spawn-error', { code: label(error.code) }); stop('spawn-error'); });
child.on('exit', (exitCode) => { report('process-exit', { exitCode }); stop('child-exit'); });
child.stdin.on('error', () => stop('stdin-closed'));
child.stderr.on('data', (chunk) => { stderrBytes += chunk.length; });

function send(envelope) {
  if (finishing) return;
  report('send', { id: envelope.method ? envelope.id : alias('request', envelope.id),
    method: envelope.method, session: alias('session', envelope.params?.sessionId) });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...envelope })}\n`);
}
function request(id, method, params) {
  send({ id, method, params });
}

function findModelConfig(options) {
  return Array.isArray(options) ? options.find((option) => option.category === 'model' || option.id === 'model') : undefined;
}

function confirmPrompt() {
  if (confirmationShown || selectedModel !== values.model || !modelResponseAccepted) return;
  confirmationShown = true;
  clearTimeout(tail);
  report('model-confirmed', { model: publicOption(selectedModel) });
  const prompt = '这是一项低成本 ACP 兼容测试。请按普通权限策略执行。'
    + '用你的原生命令工具启动一个非 daemon 的后台命令，不能前台阻塞。唯一启动命令为 '
    + 'powershell.exe -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 20; Write-Output NP00_FINITE_DONE"。'
    + '等待原生完成通知。收到通知后用一次新的只读工具调用执行 Get-Location，再报告结果。'
    + '不要自行轮询、另起脚本、修改文件或使用网络。';
  console.error(`Confirmed model: ${selectedModel}`);
  console.error(prompt);
  void operator.question('Use this test session and send the one prompt? Type YES: ')
    .then((answer) => {
      if (answer.trim() !== 'YES') return stop('operator-declined');
      if (finishing) return;
      if (selectedModel !== values.model) return stop('model-changed-before-prompt');
      promptSent = true;
      request(3, 'session/prompt', { sessionId: parent, prompt: [{ type: 'text', text: prompt }] });
    })
    .catch(() => stop('operator-input-closed'));
}

let permissionQueue = Promise.resolve();
lines.on('line', (line) => {
  if (finishing) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    report('non-json-stdout');
    return;
  }
  if (msg.method && msg.id !== undefined) {
    const p = msg.params ?? {};
    report('server-request', { method: label(msg.method), id: alias('request', msg.id),
      session: alias('session', p.sessionId), tool: alias('tool', p.toolCall?.toolCallId),
      optionKinds: p.options?.map((option) => label(option.kind)) });
    if (msg.method === 'session/request_permission') {
      permissionQueue = permissionQueue.then(async () => {
        let outcome = { outcome: 'cancelled' };
        if (!finishing && operator && Array.isArray(p.options)) {
          // This interactive display is sent to stderr, separate from the evidence stream.
          console.error(JSON.stringify({ tool: p.toolCall, options: p.options }));
          const answer = await operator.question('Choose the 1-based native option number, or Enter to cancel: ');
          const option = /^\d+$/.test(answer.trim()) ? p.options[Number(answer.trim()) - 1] : undefined;
          if (option && ['allow_once', 'reject_once'].includes(option.kind)) {
            outcome = { outcome: 'selected', optionId: option.optionId };
          }
        }
        send({ id: msg.id, result: { outcome } });
      }).catch(() => send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } }));
    } else {
      send({ id: msg.id, error: { code: -32601, message: 'Method not implemented by probe' } });
    }
    return;
  }
  if (msg.method === 'session/update') {
    const u = msg.params?.update ?? {};
    const advertised = Array.isArray(u.availableCommands) ? u.availableCommands : undefined;
    report('update', {
      session: alias('session', msg.params?.sessionId),
      type: label(u.sessionUpdate), status: label(u.status),
      tool: alias('tool', u.toolCallId), child: alias('session', u.sessionId),
      keys: fieldNames(u), rawInputKeys: fieldNames(u.rawInput),
      commandCount: advertised?.length,
      officialCommands: advertised?.map((command) => String(command?.name ?? '').replace(/^\//, ''))
        .filter((name) => officialCommands.has(name)),
      terminalMarker: live && ['tool_call', 'tool_call_update'].includes(u.sessionUpdate) && (u.rawOutput || u.content)
        ? JSON.stringify([u.rawOutput, u.content]).includes('NP00_FINITE_DONE')
        : undefined,
    });
    if (live && parent && msg.params?.sessionId === parent && u.sessionUpdate === 'config_option_update') {
      const model = findModelConfig(u.configOptions);
      if (model && model.id === modelConfigId && typeof model.currentValue === 'string') {
        selectedModel = model.currentValue;
        confirmPrompt();
      }
    }
    return;
  }
  if (msg.method) {
    report('notification', { method: label(msg.method) });
    return;
  }
  if (msg.id === 1) {
    const i = msg.result ?? {};
    report('initialize', {
      protocol: i.protocolVersion, name: label(i.agentInfo?.name), version: label(i.agentInfo?.version),
      auth: i.authMethods?.map((m) => label(m.id)), capabilityKeys: fieldNames(i.agentCapabilities),
      loadSession: i.agentCapabilities?.loadSession,
      prompt: i.agentCapabilities?.promptCapabilities,
      mcp: i.agentCapabilities?.mcpCapabilities,
      sessionCapabilities: i.agentCapabilities?.sessionCapabilities,
      ...(msg.error ? { error: errors(msg.error) } : {}),
    });
    if (msg.error || i.protocolVersion !== protocol) return stop('version-not-negotiated');
    request(2, 'session/new', { cwd, mcpServers: [] });
  } else if (msg.id === 2) {
    const s = msg.result;
    parent = s?.sessionId;
    report('session-new', {
      session: alias('session', parent),
      currentMode: publicOption(s?.modes?.currentModeId),
      modes: s?.modes?.availableModes?.map((mode) => publicOption(mode.id)).filter(Boolean),
      config: s?.configOptions?.map((o) => ({
        id: label(o.id), category: label(o.category), type: label(o.type),
        current: publicOption(o.currentValue), optionCount: o.options?.length,
        publicValues: o.options?.flatMap((option) => option.options ?? [option])
          .map((option) => publicOption(option.value)).filter(Boolean),
      })),
      ...(msg.error ? { error: errors(msg.error) } : {}),
    });
    if (!parent || !live) {
      tail = setTimeout(() => stop(parent ? 'discovery-complete' : 'session-not-opened'), 1_500);
      return;
    }
    const model = findModelConfig(s.configOptions);
    if (!model?.id || model.type !== 'select') return stop('model-config-not-advertised');
    modelConfigId = model.id;
    selectedModel = model.currentValue;
    if (selectedModel === values.model) {
      modelResponseAccepted = true;
      confirmPrompt();
      return;
    }
    const offered = model.options?.flatMap((option) => option.options ?? [option]);
    if (!offered?.some((option) => option.value === values.model)) return stop('requested-model-not-advertised');
    request(4, 'session/set_config_option', { sessionId: parent, configId: modelConfigId, value: values.model });
    tail = setTimeout(() => stop('model-not-confirmed'), 12_000);
  } else if (msg.id === 4) {
    if (msg.error) {
      report('model-config-error', { error: errors(msg.error) });
      return stop('model-config-rejected');
    }
    const model = findModelConfig(msg.result?.configOptions);
    if (model && model.id === modelConfigId && typeof model.currentValue === 'string') selectedModel = model.currentValue;
    modelResponseAccepted = true;
    confirmPrompt();
  } else if (msg.id === 3) {
    report('prompt-response', { stopReason: label(msg.result?.stopReason),
      ...(msg.error ? { error: errors(msg.error) } : {}) });
    tail = setTimeout(() => stop('post-response-observation-window'), 45_000);
  }
});

request(1, 'initialize', {
  protocolVersion: protocol,
  clientInfo: { name: 'harnessmate-np00-probe', version: '0.1.0' },
  clientCapabilities: {},
});
