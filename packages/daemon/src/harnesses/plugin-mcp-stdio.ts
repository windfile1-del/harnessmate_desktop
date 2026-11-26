import { pluginMcpServerName, pluginMcpTokenEnv, type PluginMcpConnection } from './types.js';

const urlEnv = 'HARNESSMATE_SESSION_MCP_URL';
const bridge = `
const { createInterface } = require('node:readline');
const url = process.env.${urlEnv};
const authorization = 'Bearer ' + process.env.${pluginMcpTokenEnv};
const input = createInterface({ input: process.stdin });
const headers = { authorization, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let checkingLease = false;
const checkLease = setInterval(async () => {
  if (checkingLease) return;
  checkingLease = true;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'ping' }),
      signal: AbortSignal.timeout(2000),
    });
    if (response.status === 403) input.close();
  } catch {
    // The CLI transport can recover from a temporary daemon connection failure.
  } finally {
    checkingLease = false;
  }
}, 2000);
checkLease.unref();
input.once('close', () => clearInterval(checkLease));
input.on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: line,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error('tool bridge unavailable');
    if (response.status === 202 || response.status === 204) return;
    process.stdout.write(JSON.stringify(await response.json()) + '\\n');
  } catch {
    if (request?.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      error: { code: -32000, message: 'HarnessMate plugin tool connection unavailable' } }) + '\\n');
  }
});
`;

export function pluginMcpStdioConfig(connection: PluginMcpConnection) {
  return {
    name: pluginMcpServerName,
    command: process.execPath,
    args: ['--no-warnings', '-e', bridge],
    env: [{ name: 'ELECTRON_RUN_AS_NODE', value: '1' }, { name: urlEnv, value: connection.url },
      { name: pluginMcpTokenEnv, value: connection.token }],
  };
}
