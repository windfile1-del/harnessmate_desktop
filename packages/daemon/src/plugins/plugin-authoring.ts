import { randomUUID } from 'node:crypto';
import {
  GeneratedPluginManifestSchema,
  type GeneratePluginDraftRequest,
  type PluginManifest,
} from '@harnessmate/protocol';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { AdapterSessionHandle } from '../harnesses/types.js';

const schemaGuide = `Return exactly one JSON object, with no Markdown, implementation plan, tools, or file operations.
The JSON defines a data-only HarnessMate plugin. Use labels and prompts in the user's language.
Top level: id (user.<lowercase slug>), name, description, version, apiVersion (2, or 1 for legacy manifests), category ("workflow" or "ui"), contributes.
contributes supports:
- slashCommands: [{command, description, argumentHint?, template}]. Use lowercase command names distinct from built-in commands and {{args}} for the user input.
- panels: [{id,title,description?,sections,actions}]. Sections are turns, changed_files, verifications, recent_activity. Actions are [{label,command,args?}] and refer to this plugin's slashCommands.
- V2 projections: [{id,scope,events}]. Scope is "session" or "workspace". Events are "turn.completed", "turn.failed", "turn.cancelled".
- V2 dataPanels: [{id,title,description?,projection,columns,filters?,defaultEvent?,counts?,openTurn?,placements?,copySummary?}]. Projection is the ID of a projection in this plugin. Columns are [{field,label}]; fields are time, session, harness, status, changed_files, verifications. Filters are harness or status. defaultEvent requires a status filter and an event in the referenced projection. Counts and openTurn are booleans. Placements are sidebar_tool or composer_action. copySummary is {label,command?}, a clipboard action and optional local slash command.
Include only supported data. No JavaScript, MCP, native harnesses, arbitrary UI code, background execution, or shell commands. Use at least one command or panel.
For an installed plugin, keep its ID and choose a new version. When revising a pending draft, preserve its requested changes unless the new request changes them. Its new version can stay the same as the pending draft.`;

export class PluginAuthoring {
  private active?: AbortController;

  constructor(private readonly registry: HarnessRegistry) {}

  cancel(): void {
    this.active?.abort(new Error('插件生成已取消'));
  }

  async generate(req: GeneratePluginDraftRequest, cwd: string, requestSignal: AbortSignal, installed?: PluginManifest): Promise<PluginManifest> {
    if (this.active) throw new Error('已有插件正在生成');
    const adapter = this.registry.get(req.harnessId);
    if (!adapter) throw new Error('所选 Harness 不可用');
    const previous = req.previous ? GeneratedPluginManifestSchema.parse(req.previous) : undefined;
    const pluginId = installed?.id ?? previous?.id;
    if (installed && previous && previous.id !== installed.id) throw new Error('草稿必须使用已安装插件的 ID');
    const controller = new AbortController();
    this.active = controller;
    const signal = AbortSignal.any([controller.signal, requestSignal, AbortSignal.timeout(90_000)]);
    let handle: AdapterSessionHandle | undefined;
    let unsubscribe: (() => void) | undefined;
    let abort: (() => void) | undefined;
    try {
      handle = await adapter.createSession({ cwd, model: req.model, permissionMode: 'plan' });
      signal.throwIfAborted();
      const session = handle;
      const turnId = randomUUID();
      let streamed = '';
      let completed = '';
      const response = new Promise<string>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        unsubscribe = session.onEvent((event) => {
          if (!('turnId' in event) || event.turnId !== turnId) return;
          switch (event.type) {
            case 'approval.requested':
              void session.resolveApproval(event.nativeRequestId, 'deny').catch(() => {});
              reject(new Error('生成插件草稿需要纯文本回复，已拒绝工具审批'));
              break;
            case 'message.assistant.delta': streamed += event.text; break;
            case 'message.assistant.completed': completed = event.text || completed; break;
            case 'turn.completed': resolve(completed || streamed); break;
            case 'turn.failed': reject(new Error(event.message)); break;
            case 'turn.cancelled': reject(new Error('Harness 取消了插件生成')); break;
          }
          if (streamed.length + completed.length > 96_000) reject(new Error('生成的草稿过大'));
        });
      });
      const draft = await Promise.race([
        response,
        session.sendTurn({
          turnId, permissionMode: 'plan', model: req.model,
          text: `${schemaGuide}\n\nUser requirements:\n${req.description}` +
            (installed ? `\nInstalled baseline:\n${JSON.stringify(installed)}` : '') +
            (previous ? `\nCurrent draft:\n${JSON.stringify(previous)}` : ''),
        }).then(() => response),
      ]);
      const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(draft);
      let parsed: unknown;
      try { parsed = JSON.parse(fenced?.[1] ?? draft.trim()); }
      catch { throw new Error('模型未返回有效的 JSON 插件清单'); }
      const manifest = GeneratedPluginManifestSchema.parse(parsed);
      if (pluginId && manifest.id !== pluginId) throw new Error('更新草稿必须保留原插件 ID');
      if (installed && manifest.version === installed.version) throw new Error('新版本号必须与已安装版本不同');
      if (!manifest.contributes.slashCommands?.length && !manifest.contributes.panels?.length && !manifest.contributes.dataPanels?.length) {
        throw new Error('草稿至少需要一个指令或面板');
      }
      return manifest;
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      unsubscribe?.();
      try { await handle?.dispose(); } finally { this.active = undefined; }
    }
  }
}
