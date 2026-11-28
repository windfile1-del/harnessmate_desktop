import { randomUUID } from 'node:crypto';
import type { DaemonInstance } from '../../src/server/app.js';
export const developerBase = '/api/v1/plugin-instances/hm.plugin.developer-tools/routes';
export async function generateDeveloper(daemon: DaemonInstance, input: unknown, kind: 'generate' | 'author' = 'generate') {
  const started = await daemon.app.inject({ method: 'POST', url: developerBase + '/tasks', payload: { taskId: randomUUID(), input, kind, closePolicy: 'background' } });
  if (started.statusCode !== 202) return { statusCode: started.statusCode, body: started.body, json: () => started.json() };
  const id = started.json().task.taskId;
  for (let i = 0; i < 500; i++) {
    const response = await daemon.app.inject({ url: developerBase + '/tasks/' + id }); const task = response.json().task;
    if (task.status !== 'running' && task.status !== 'queued') { const result = task.result ?? { error: task.error }; return { statusCode: task.result ? 200 : 400, body: JSON.stringify(result), json: () => result }; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error('Developer task did not settle');
}
