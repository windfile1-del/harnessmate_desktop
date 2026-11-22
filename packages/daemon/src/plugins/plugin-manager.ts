import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HarnessCommandNameSchema,
  PluginManifestSchema,
  type Attachment,
  type CanonicalEvent,
  type InstalledPluginInfo,
  type InstallPluginRequest,
  type PluginCatalogItem,
  type PluginManifest,
  type PluginMcpPreset,
  type PluginSlashCommand,
} from '@harnessmate/protocol';
import type { HarnessRegistry } from '../harnesses/registry.js';
import type { HarnessAdapter } from '../harnesses/types.js';
import { MANIFEST_FILE, readPluginPackage, readRevisionPointer, revisionDirectory, writeRevision,
  writeRevisionPointer, type PluginPackage } from './plugin-package.js';
import { PluginRuntime } from './plugin-runtime.js';

export interface PluginTurnHookContext {
  sessionId: string;
  harnessId: string;
  cwd: string;
  text: string;
  attachments?: Attachment[];
}

export interface PluginRuntimeModule {
  beforeTurn?: (
    ctx: PluginTurnHookContext,
  ) => Promise<{ text?: string } | void> | { text?: string } | void;
  onEvent?: (event: unknown) => Promise<void> | void;
}

const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    id: 'core.harness.codex',
    name: 'Codex CLI 引擎插件',
    version: '1.0.0',
    description: '接入本机 Codex CLI (app-server JSON-RPC 2.0)，支持动态模型、账号限额与交互审批。',
    author: 'HarnessMate Core',
    category: 'harness',
    contributes: { uiSlots: ['modal'] },
  },
  {
    id: 'core.harness.agy',
    name: 'Antigravity CLI (ACP) 引擎插件',
    version: '1.0.0',
    description: '接入本机 agy CLI 原生 ACP 协议，支持动态模型、思考档位校验与权限确认。',
    author: 'HarnessMate Core',
    category: 'harness',
    contributes: { uiSlots: ['modal'] },
  },
  {
    id: 'core.harness.claude',
    name: 'Claude Code CLI 引擎插件',
    version: '1.0.0',
    description: '接入本机 Claude Code (stream-json 双向控制流)，自动读取 settings.json 模型目录。',
    author: 'HarnessMate Core',
    category: 'harness',
    contributes: { uiSlots: ['modal'] },
  },
  {
    id: 'core.attachments',
    name: '图片与文件上下文插件',
    version: '1.0.0',
    description: '支持粘贴截图、拖拽图片与 @文件 引用，自动适配各 CLI 的多模态输入协议。',
    author: 'HarnessMate Core',
    category: 'tool',
    contributes: { uiSlots: ['composer_action'] },
  },
  {
    id: 'core.mcp-hub',
    name: '跨 CLI MCP 统一管理中心',
    version: '1.0.0',
    description: '统一查看、安装、启停与跨端同步 Codex / AGY / Claude 的 MCP 服务器。',
    author: 'HarnessMate Core',
    category: 'mcp',
    contributes: { uiSlots: ['sidebar_tool', 'modal'] },
  },
  {
    id: 'core.account-usage',
    name: '多账号与配额用量看板',
    version: '1.0.0',
    description: '实时聚合各 CLI 登录账号、5h/7d 速率限额、每日 Token 趋势与会话成本账本。',
    author: 'HarnessMate Core',
    category: 'telemetry',
    contributes: { uiSlots: ['sidebar_tool', 'modal'] },
  },
  {
    id: 'core.git-inspector',
    name: 'Git Diff 与 Worktree 隔离插件',
    version: '1.0.0',
    description: '实时监控仓库变更、查看彩色 Unified Diff，并支持为并行会话创建隔离 Git Worktree。',
    author: 'HarnessMate Core',
    category: 'ui',
    contributes: { uiSlots: ['inspector_tab'] },
  },
  {
    id: 'core.terminal-runner',
    name: '工作区终端与文件浏览器插件',
    version: '1.0.0',
    description: '在右侧检视抽屉提供工作区文件预览、一键 @引用 与快捷终端命令执行器。',
    author: 'HarnessMate Core',
    category: 'tool',
    contributes: { uiSlots: ['inspector_tab'] },
  },
  {
    id: 'core.harness-commands',
    name: '原生 Harness 命令',
    version: '1.0.0',
    description: '在对话中调用当前 CLI 的模型、额度、计划、上下文、目标、插件与技能命令。',
    author: 'HarnessMate Core',
    category: 'tool',
    contributes: { uiSlots: ['composer_action'] },
  },
  {
    id: 'core.slash-workflows',
    name: '内置工程 Slash 工作流插件',
    version: '1.0.0',
    description: '提供 /review、/test、/fix、/refactor、/explain 等结构化斜杠指令模板。',
    author: 'HarnessMate Core',
    category: 'workflow',
    contributes: {
      slashCommands: [
        {
          command: 'review',
          description: '审查当前工作区改动与潜在风险',
          argumentHint: '[关注范围或文件]',
          template:
            '请对当前工作区最新的代码改动执行严格的代码审查，重点关注正确性、边界条件、安全隐患与性能问题。给出按优先级排序的修改建议。\n\n补充说明：{{args}}',
        },
        {
          command: 'test',
          description: '运行测试套件并定位失败原因',
          argumentHint: '[测试命令或模块]',
          template:
            '请定位并运行当前项目相关的自动化测试，如遇失败请分析根因并给出最小化修复方案。\n\n目标范围：{{args}}',
        },
        {
          command: 'fix',
          description: '诊断并修复指定 Bug 或报错',
          argumentHint: '<报错信息或问题描述>',
          template:
            '请复现并排查以下问题，说明根因后执行干净的修复并验证回归：\n\n{{args}}',
        },
        {
          command: 'refactor',
          description: '重构模块结构以提升清晰度与可维护性',
          argumentHint: '<目标文件或模块>',
          template:
            '请先分析目标代码的职责边界与耦合点，提出重构方案并在保持行为不变的前提下完成重构与验证：\n\n{{args}}',
        },
        {
          command: 'explain',
          description: '梳理代码架构与调用链路',
          argumentHint: '<文件、符号或流程>',
          template:
            '请清晰拆解以下模块或流程的架构设计、核心数据结构与关键执行路径：\n\n{{args}}',
        },
      ],
      hooks: ['before_turn'],
    },
  },
  {
    id: 'core.remote-mobile',
    name: 'HM-Remote 移动端联动插件',
    version: '1.0.0',
    description: '为 Android 端 HarnessMate 提供扫码配对、局域网/Tailscale 远程会话与跨端审批。',
    author: 'HarnessMate Core',
    category: 'remote',
    contributes: { uiSlots: ['sidebar_tool', 'modal'] },
  },
  {
    id: 'core.context-bridge',
    name: '跨引擎上下文桥接插件',
    version: '1.0.0',
    description: '基于水位线增量同步与协议原生注入（Codex inject_items / AGY embeddedContext / Claude sysfile），实现单会话内多引擎无缝切换。',
    author: 'HarnessMate Core',
    category: 'workflow',
    contributes: { uiSlots: ['composer_action', 'inspector_tab'], hooks: ['before_turn'] },
  },
  {
    id: 'core.task-ledger',
    name: '结构化任务状态账本插件',
    version: '1.0.0',
    description: '自动沉淀任务目标、步骤清单、修改文件、验证结果与钉选铁律，并同步写入工作区 .harnessmate/task-ledger.md。',
    author: 'HarnessMate Core',
    category: 'workflow',
    contributes: { uiSlots: ['inspector_tab'], hooks: ['after_turn'] },
  },
  {
    id: 'core.auto-failover',
    name: '限额/异常一键接力插件',
    version: '1.0.0',
    description: '当当前引擎遇到限额耗尽、超时或异常中断时，支持在同一会话内一键切换至备用引擎无缝续跑。',
    author: 'HarnessMate Core',
    category: 'workflow',
    contributes: { uiSlots: ['composer_action'] },
  },
];

const CURATED_PLUGIN_CATALOG: Array<PluginManifest & { tags: string[] }> = [
  {
    id: 'user.project-acceptance',
    name: '项目验收台',
    description: '按工作区查看三个 Harness 的轮次、已记录的改动文件和验证结果，支持筛选和定位到原轮次。',
    version: '1.0.0',
    apiVersion: 2,
    category: 'ui',
    tags: ['验收', '工作区'],
    contributes: {
      projections: [{ id: 'turns', scope: 'workspace', events: ['turn.completed', 'turn.failed', 'turn.cancelled'] }],
      dataPanels: [{
        id: 'acceptance', title: '项目验收台', projection: 'turns', counts: true,
        filters: ['harness', 'status'], openTurn: true, placements: ['sidebar_tool', 'composer_action'],
        columns: [
          { field: 'time', label: '时间' }, { field: 'session', label: '会话' },
          { field: 'harness', label: 'Harness' }, { field: 'status', label: '轮次' },
          { field: 'changed_files', label: '改动文件' }, { field: 'verifications', label: '验证结果' },
        ],
        copySummary: { label: '复制验收摘要', command: 'acceptance' },
      }],
    },
  },
  {
    id: 'ext.git-pr-studio',
    name: 'Git 提交与 PR 写作套件',
    version: '1.0.0',
    description: '新增 /commit、/pr-desc、/changelog 三个工程斜杠指令，自动基于 git diff 生成规范说明。',
    author: 'HarnessMate Community',
    category: 'workflow',
    tags: ['Slash 指令', 'Git', '效率'],
    contributes: {
      slashCommands: [
        {
          command: 'commit',
          description: '根据当前 git diff 生成 Conventional Commit 提交信息',
          argumentHint: '[可选补充说明]',
          template:
            '请查看当前 git status 与 git diff，总结本次改动意图，并给出符合 Conventional Commits 规范的中英双语提交信息（不直接执行 git push）。\n\n补充：{{args}}',
        },
        {
          command: 'pr-desc',
          description: '生成结构化 Pull Request 评审说明',
          argumentHint: '[基线分支名]',
          template:
            '请基于当前分支相对主分支的改动，撰写清晰的 PR 描述：包含变更背景、核心改动清单、验证证据与潜在风险点。\n\n参考基线：{{args}}',
        },
        {
          command: 'changelog',
          description: '整理面向用户的版本更新日志',
          template:
            '请整理近期提交记录，按「新增特性 / 问题修复 / 体验优化」分类生成简洁的更新日志。\n\n范围：{{args}}',
        },
      ],
    },
  },
  {
    id: 'ext.security-auditor',
    name: '安全审计与凭据扫描套件',
    version: '1.0.0',
    description: '提供 /sec-audit 与 /deps-check 指令，快速排查硬编码密钥、注入风险与权限越界。',
    author: 'HarnessMate Community',
    category: 'workflow',
    tags: ['安全', '审计', 'Slash 指令'],
    contributes: {
      slashCommands: [
        {
          command: 'sec-audit',
          description: '扫描工作区安全漏洞与敏感密钥泄露风险',
          argumentHint: '[目录或模块]',
          template:
            '请以安全审计员视角检查工作区代码：重点排查硬编码凭据、命令/SQL 注入、路径遍历、未鉴权端点与不安全的反序列化，并按严重度给出修复建议。\n\n范围：{{args}}',
        },
        {
          command: 'deps-check',
          description: '检查依赖树风险与过时包',
          template:
            '请检查项目依赖清单，识别高危、废弃或存在明显冲突的依赖包并给出升级建议。\n\n补充：{{args}}',
        },
      ],
    },
  },
  {
    id: 'ext.mcp-devtools-pack',
    name: '常用开发 MCP 预设包',
    version: '1.0.0',
    description: '提供 Context7 文档查询、Filesystem、Playwright 浏览器与 Sequential Thinking 一键安装预设。',
    author: 'HarnessMate Community',
    category: 'mcp',
    tags: ['MCP', '一键安装', '工具链'],
    contributes: {
      mcpPresets: [
        {
          name: 'context7',
          description: '实时拉取最新开源库官方文档与 API 示例',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@upstash/context7-mcp'],
        },
        {
          name: 'sequential-thinking',
          description: '结构化多步推理与复杂问题拆解 MCP',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
        },
        {
          name: 'playwright',
          description: '自动化浏览器调试、页面截图与端到端测试 MCP',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest'],
        },
      ],
    },
  },
  {
    id: 'ext.acp-opencode',
    name: 'OpenCode CLI (ACP 适配器插件)',
    version: '1.0.0',
    description: '通过标准 ACP 协议将本机 OpenCode CLI 接入 HarnessMate 多端统一前端。',
    author: 'HarnessMate Community',
    category: 'harness',
    tags: ['ACP', 'Harness', 'OpenCode'],
    contributes: {
      harnesses: [
        {
          id: 'opencode',
          displayName: 'OpenCode CLI',
          description: 'OpenCode CLI via Agent Client Protocol',
          command: 'opencode',
          args: ['acp'],
        },
      ],
    },
  },
  {
    id: 'ext.acp-gemini',
    name: 'Gemini CLI (ACP 适配器插件)',
    version: '1.0.0',
    description: '通过标准 ACP 协议接入 Google Gemini CLI，与 Codex/AGY/Claude 同台协作。',
    author: 'HarnessMate Community',
    category: 'harness',
    tags: ['ACP', 'Harness', 'Gemini'],
    contributes: {
      harnesses: [
        {
          id: 'gemini-cli',
          displayName: 'Gemini CLI',
          description: 'Google Gemini CLI via ACP (--experimental-acp)',
          command: 'gemini',
          args: ['--experimental-acp'],
        },
      ],
    },
  },
];

interface LoadedPluginRecord {
  info: InstalledPluginInfo;
  runtime?: PluginRuntime;
  packageRoot?: string;
  digest?: string;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPluginRecord>();
  private readonly pluginHarnesses = new Map<string, { adapter: HarnessAdapter; config: string }>();
  private mutation = Promise.resolve();
  private registryChanged = false;

  constructor(
    private readonly pluginsDir: string,
    private readonly registry: HarnessRegistry,
    private readonly getDisabledIds: () => string[],
    private readonly setDisabledIds: (ids: string[]) => void,
  ) {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    this.pluginsDir = fs.realpathSync(this.pluginsDir);
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(action);
    this.mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  takeRegistryChanged(): boolean {
    const changed = this.registryChanged;
    this.registryChanged = false;
    return changed;
  }

  reloadAll(): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      await this.loadRegistry();
      return this.listInstalled();
    });
  }

  private async loadRegistry(): Promise<void> {
    const next = new Map<string, LoadedPluginRecord>();
    const disabledSet = new Set(this.getDisabledIds());

    for (const manifest of BUILTIN_PLUGINS) {
      const enabled = !disabledSet.has(manifest.id);
      next.set(manifest.id, {
        info: {
          ...manifest,
          builtin: true,
          enabled,
          sourcePath: null,
          hasRuntimeHook: Boolean(manifest.contributes.hooks?.length),
          loadError: null,
        },
      });
    }

    const directories = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
    for (const entry of directories) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const root = path.join(this.pluginsDir, entry.name);
      try {
        const pointer = readRevisionPointer(root);
        const directory = pointer ? revisionDirectory(root, pointer.current) : root;
        if (!pointer && !fs.existsSync(path.join(root, MANIFEST_FILE))) continue;
        const pack = readPluginPackage(directory);
        if (next.has(pack.manifest.id)) throw new Error('插件 ID 重复');
        this.validateManifest(pack.manifest, next);
        const enabled = !disabledSet.has(pack.manifest.id);
        const record = await this.prepare(pack, directory, root, enabled, Boolean(pointer?.previous));
        next.set(pack.manifest.id, record);
      } catch (error) {
        const previous = [...this.plugins.values()].find((record) => record.info.sourcePath === root);
        const message = error instanceof Error ? error.message : String(error);
        if (previous && !next.has(previous.info.id) && !previous.runtime?.failed) {
          previous.info.loadError = message;
          next.set(previous.info.id, previous);
        } else {
          const id = previous?.info.id ?? `broken.${entry.name}`;
          next.set(id, { info: {
            ...previous?.info,
            id, name: previous?.info.name ?? entry.name, version: previous?.info.version ?? '0.0.0',
            description: previous?.info.description ?? '插件加载失败', category: previous?.info.category ?? 'workflow',
            contributes: previous?.info.contributes ?? {}, builtin: false, enabled: false,
            sourcePath: root, hasRuntimeHook: false, loadError: message,
            canRollback: Boolean(this.tryPrevious(root)),
          } });
        }
      }
    }
    this.activate(next);
  }

  private tryPrevious(root: string): string | undefined {
    try { return readRevisionPointer(root)?.previous; } catch { return undefined; }
  }

  private activate(next: Map<string, LoadedPluginRecord>): void {
    const wanted = new Map<string, NonNullable<PluginManifest['contributes']['harnesses']>[number]>();
    for (const rec of next.values()) {
      if (!rec.info.enabled) continue;
      for (const config of rec.info.contributes.harnesses ?? []) wanted.set(config.id, config);
    }
    for (const [id, record] of this.pluginHarnesses) {
      if (!wanted.has(id)) {
        if (this.registry.get(id) === record.adapter) this.registry.unregister(id);
        this.pluginHarnesses.delete(id);
        this.registryChanged = true;
      }
    }
    for (const [id, config] of wanted) {
      const old = this.pluginHarnesses.get(id);
      const current = this.registry.get(id);
      if (current && current !== old?.adapter) continue;
      const signature = JSON.stringify(config);
      if (current && old?.config === signature) continue;
      this.registry.registerCustomAcp(config);
      this.pluginHarnesses.set(id, { adapter: this.registry.get(id)!, config: signature });
      this.registryChanged = true;
    }
    for (const [id, record] of this.plugins) {
      if (record.runtime !== next.get(id)?.runtime) record.runtime?.retire();
    }
    this.plugins = next;
  }

  private async prepare(pack: PluginPackage, directory: string, root: string, enabled: boolean, canRollback: boolean) {
    const record: LoadedPluginRecord = {
      info: { ...pack.manifest, builtin: false, enabled, sourcePath: root, canRollback, loadError: null },
      packageRoot: directory,
      digest: pack.digest,
    };
    if (enabled && pack.manifest.entry) {
      const old = this.plugins.get(pack.manifest.id);
      if (old?.packageRoot === directory && old.digest === pack.digest && old.runtime && !old.runtime.failed) {
        record.runtime = old.runtime;
      } else {
        const runtime = new PluginRuntime(path.join(directory, pack.manifest.entry.replace(/\\/g, '/')), (error) => {
          const active = this.plugins.get(pack.manifest.id);
          if (active?.runtime === runtime) active.info.loadError = error.message;
        });
        try {
          await runtime.initialize();
          if (!runtime.hooks.length) throw new Error('入口需导出 beforeTurn 或 onEvent');
          record.runtime = runtime;
        } catch (error) {
          runtime.retire();
          throw error;
        }
      }
      record.info.hasRuntimeHook = true;
    }
    return record;
  }

  validateManifest(manifest: PluginManifest, occupied = this.plugins): void {
    if (manifest.id.startsWith('core.') || manifest.id.startsWith('broken.')) throw new Error('插件 ID 使用了保留前缀');
    const other = [...occupied.values()].filter(({ info }) => info.id !== manifest.id);
    const commands = new Set<string>([...HarnessCommandNameSchema.options, 'quota', 'plugins']);
    const contributedHarnesses = new Set<string>();
    const commandNames = (plugin: PluginManifest) => [
      ...(plugin.contributes.slashCommands ?? []).map(({ command }) => command),
      ...(plugin.contributes.dataPanels ?? []).flatMap(({ copySummary }) => copySummary?.command ? [copySummary.command] : []),
    ];
    for (const { info } of other) {
      for (const name of commandNames(info)) commands.add(name);
      for (const config of info.contributes.harnesses ?? []) contributedHarnesses.add(config.id);
    }
    const owns = new Set((occupied.get(manifest.id)?.info.contributes.harnesses ?? []).map(({ id }) => id));
    for (const name of commandNames(manifest)) {
      if (commands.has(name)) throw new Error(`指令 /${name} 已被占用`);
      commands.add(name);
    }
    for (const config of manifest.contributes.harnesses ?? []) {
      const current = this.registry.get(config.id);
      const owned = (owns.has(config.id) || this.plugins.get(manifest.id)?.info.contributes.harnesses?.some(({ id }) => id === config.id))
        && this.pluginHarnesses.get(config.id)?.adapter === current;
      if (contributedHarnesses.has(config.id) || (current && !owned)) {
        throw new Error(`Harness ID ${config.id} 已被占用`);
      }
      contributedHarnesses.add(config.id);
    }
    const panelIds = new Set<string>();
    const ownCommands = new Set(manifest.contributes.slashCommands?.map(({ command }) => command));
    for (const panel of manifest.contributes.panels ?? []) {
      if (panelIds.has(panel.id)) throw new Error(`面板 ID ${panel.id} 重复`);
      panelIds.add(panel.id);
      for (const action of panel.actions) {
        if (!ownCommands.has(action.command)) throw new Error(`面板操作必须引用本插件的指令 /${action.command}`);
      }
    }
    const { projections, dataPanels, harnesses, mcpPresets, hooks, uiSlots } = manifest.contributes;
    if (manifest.apiVersion !== 2 && (projections || dataPanels)) {
      throw new Error('事件投影和数据面板需要 apiVersion: 2');
    }
    if (manifest.apiVersion === 2 && (manifest.entry || harnesses?.length || mcpPresets?.length || hooks?.length || uiSlots?.length)) {
      throw new Error('V2 插件使用声明式扩展接口');
    }
    const projectionIds = new Set<string>();
    for (const projection of projections ?? []) {
      if (projectionIds.has(projection.id)) throw new Error(`事件投影 ID ${projection.id} 重复`);
      if (new Set(projection.events).size !== projection.events.length) throw new Error(`事件投影 ${projection.id} 含有重复事件`);
      projectionIds.add(projection.id);
    }
    for (const panel of dataPanels ?? []) {
      if (panelIds.has(panel.id)) throw new Error(`面板 ID ${panel.id} 重复`);
      if (!projectionIds.has(panel.projection)) throw new Error(`面板 ${panel.id} 引用了不存在的事件投影 ${panel.projection}`);
      if (new Set(panel.columns.map(({ field }) => field)).size !== panel.columns.length) throw new Error(`面板 ${panel.id} 含有重复列`);
      panelIds.add(panel.id);
    }
  }

  getDataPanel(pluginId: string, panelId: string) {
    const plugin = this.plugins.get(pluginId)?.info;
    if (!plugin?.enabled) return undefined;
    const panel = plugin.contributes.dataPanels?.find(({ id }) => id === panelId);
    const projection = plugin.contributes.projections?.find(({ id }) => id === panel?.projection);
    return panel && projection ? { panel, projection } : undefined;
  }

  listInstalled(): InstalledPluginInfo[] {
    return Array.from(this.plugins.values()).map((r) => r.info);
  }

  listCatalog(): PluginCatalogItem[] {
    return CURATED_PLUGIN_CATALOG.map((item) => ({
      ...item,
      installed: this.plugins.has(item.id),
    }));
  }

  isPluginEnabled(id: string): boolean {
    const rec = this.plugins.get(id);
    return rec ? rec.info.enabled : true;
  }

  listActiveSlashCommands(): Array<PluginSlashCommand & { pluginId: string; pluginName: string }> {
    const cmds: Array<PluginSlashCommand & { pluginId: string; pluginName: string }> = [];
    for (const rec of this.plugins.values()) {
      if (!rec.info.enabled) continue;
      for (const cmd of rec.info.contributes.slashCommands ?? []) {
        cmds.push({
          ...cmd,
          pluginId: rec.info.id,
          pluginName: rec.info.name,
        });
      }
    }
    return cmds;
  }

  listActiveMcpPresets(): Array<PluginMcpPreset & { pluginId: string; pluginName: string }> {
    const presets: Array<PluginMcpPreset & { pluginId: string; pluginName: string }> = [];
    for (const rec of this.plugins.values()) {
      if (!rec.info.enabled) continue;
      for (const preset of rec.info.contributes.mcpPresets ?? []) {
        presets.push({
          ...preset,
          pluginId: rec.info.id,
          pluginName: rec.info.name,
        });
      }
    }
    return presets;
  }

  togglePlugin(id: string, enabled: boolean): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const record = this.plugins.get(id);
      if (!record) throw new Error(`Plugin not found: ${id}`);
      let candidate: LoadedPluginRecord = { ...record, info: { ...record.info, enabled }, runtime: undefined };
      if (enabled && !record.info.builtin) {
        if (!record.packageRoot) throw new Error('请先修复或回退损坏的插件');
        const pack = readPluginPackage(record.packageRoot);
        this.validateManifest(pack.manifest);
        candidate = await this.prepare(pack, record.packageRoot, record.info.sourcePath!, true, Boolean(record.info.canRollback));
      }
      const disabled = new Set(this.getDisabledIds());
      if (enabled) disabled.delete(id);
      else disabled.add(id);
      try {
        this.setDisabledIds([...disabled]);
      } catch (error) {
        if (candidate.runtime !== record.runtime) candidate.runtime?.retire();
        throw error;
      }
      this.activate(new Map(this.plugins).set(id, candidate));
      return this.listInstalled();
    });
  }

  inspectPackage(directory: string) {
    const { manifest, digest, files } = readPluginPackage(directory);
    this.validateManifest(manifest);
    return { manifest, digest, fileCount: files.size, installedVersion: this.plugins.get(manifest.id)?.info.version };
  }

  installPlugin(req: InstallPluginRequest): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      let pack: PluginPackage;
      if (req.mode === 'local_dir') {
        pack = readPluginPackage(req.dirPath);
        if (req.expectedDigest && req.expectedDigest !== pack.digest) throw new Error('插件文件已更改，请重新预览');
        if (pack.manifest.entry && (!req.trustCode || !req.expectedDigest)) {
          throw new Error('请预览本地插件并确认信任其中的 JavaScript');
        }
      } else {
        const source = req.mode === 'manifest' ? req.manifest : CURATED_PLUGIN_CATALOG.find((item) => item.id === req.catalogId);
        if (!source) throw new Error('找不到目录中的插件');
        const manifest = PluginManifestSchema.parse(source);
        if (manifest.entry) throw new Error('带 JavaScript 入口的插件必须通过本地目录导入');
        pack = { manifest, files: new Map([[MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 2))]]), digest: '' };
      }
      this.validateManifest(pack.manifest);
      const id = pack.manifest.id;
      const old = this.plugins.get(id);
      const root = old?.info.sourcePath ?? path.join(this.pluginsDir, id);
      this.checkPluginRoot(root);
      const pointer = readRevisionPointer(root);
      const previous = pointer?.current ?? (old?.packageRoot ? writeRevision(root, readPluginPackage(old.packageRoot).files) : undefined);
      const revision = writeRevision(root, pack.files);
      const directory = revisionDirectory(root, revision);
      const enabled = !this.getDisabledIds().includes(id);
      let candidate: LoadedPluginRecord | undefined;
      try {
        candidate = await this.prepare(readPluginPackage(directory), directory, root, true, Boolean(previous));
        if (!enabled) {
          candidate.runtime?.retire();
          candidate = { ...candidate, runtime: undefined, info: { ...candidate.info, enabled, hasRuntimeHook: false } };
        }
        writeRevisionPointer(root, { current: revision, previous });
      } catch (error) {
        candidate?.runtime?.retire();
        this.removeRevision(root, revision);
        if (!pointer && previous) this.removeRevision(root, previous);
        throw error;
      }
      this.activate(new Map(this.plugins).set(id, candidate));
      if (pointer?.previous) this.removeRevision(root, pointer.previous);
      return this.listInstalled();
    });
  }

  rollbackPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const root = this.plugins.get(id)?.info.sourcePath;
      const pointer = root ? readRevisionPointer(root) : undefined;
      if (!root || !pointer?.previous) throw new Error('没有可回退的版本');
      this.checkPluginRoot(root);
      const directory = revisionDirectory(root, pointer.previous);
      const pack = readPluginPackage(directory);
      this.validateManifest(pack.manifest);
      const candidate = await this.prepare(pack, directory, root, !this.getDisabledIds().includes(pack.manifest.id), true);
      try {
        writeRevisionPointer(root, { current: pointer.previous, previous: pointer.current });
      } catch (error) {
        candidate.runtime?.retire();
        throw error;
      }
      const next = new Map(this.plugins);
      next.delete(id);
      next.set(pack.manifest.id, candidate);
      this.activate(next);
      return this.listInstalled();
    });
  }

  uninstallPlugin(id: string): Promise<InstalledPluginInfo[]> {
    return this.serialize(async () => {
      const root = this.plugins.get(id)?.info.sourcePath;
      if (!root) throw new Error('只能卸载外部插件');
      this.checkPluginRoot(root);
      const removed = path.join(this.pluginsDir, `.uninstalled-${randomUUID()}`);
      fs.renameSync(root, removed);
      try {
        this.setDisabledIds(this.getDisabledIds().filter((disabled) => disabled !== id));
      } catch (error) {
        fs.renameSync(removed, root);
        throw error;
      }
      const next = new Map(this.plugins);
      next.delete(id);
      this.activate(next);
      try { fs.rmSync(removed, { recursive: true, force: true }); } catch { /* Loaded files may still be open. */ }
      return this.listInstalled();
    });
  }

  private checkPluginRoot(root: string): void {
    if (path.dirname(root) !== this.pluginsDir || (fs.existsSync(root) && fs.realpathSync(root) !== root)) {
      throw new Error('插件安装路径无效');
    }
  }

  private removeRevision(root: string, revision: string): void {
    try { fs.rmSync(revisionDirectory(root, revision), { recursive: true, force: true }); }
    catch { /* An inactive revision can be removed on the next maintenance pass. */ }
  }

  notifyEvent(event: CanonicalEvent): void {
    if (!['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) return;
    for (const record of this.plugins.values()) {
      if (!record.info.enabled || !record.runtime?.hooks.includes('onEvent') || record.runtime.failed) continue;
      const hooks = record.info.contributes.hooks ?? [];
      if (!hooks.includes('on_event') && !hooks.includes('after_turn')) continue;
      void record.runtime.request('onEvent', event).catch((error: Error) => {
        record.info.loadError = error.message;
      });
    }
  }

  async close(): Promise<void> {
    await this.mutation;
    for (const record of this.plugins.values()) record.runtime?.retire();
  }

  /**
   * Expands active plugin slash commands (/cmd args) and runs any enabled JS beforeTurn hooks.
   */
  async processBeforeTurn(ctx: PluginTurnHookContext): Promise<{
    text: string;
    expandedCommand?: string;
  }> {
    let text = ctx.text;
    let expandedCommand: string | undefined;

    const trimmed = text.trim();
    if (trimmed.startsWith('/')) {
      const match = trimmed.match(/^\/([a-z0-9][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i);
      if (match?.[1]) {
        const cmdName = match[1].toLowerCase();
        if ([...this.plugins.values()].some(({ info }) => info.enabled &&
          info.contributes.dataPanels?.some(({ copySummary }) => copySummary?.command === cmdName))) {
          throw new Error(`/${cmdName} 是桌面插件面板命令，请在桌面聊天中使用`);
        }
        const args = (match[2] ?? '').trim();
        const found = this.listActiveSlashCommands().find((c) => c.command === cmdName);
        if (found) {
          text = found.template.replace(/\{\{args\}\}/g, args || '（无额外参数）');
          expandedCommand = `/${cmdName}`;
        }
      }
    }

    const deadline = Date.now() + 1500;
    for (const rec of this.plugins.values()) {
      if (!rec.info.enabled || !rec.runtime?.hooks.includes('beforeTurn') || rec.runtime.failed) continue;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const res = await rec.runtime.request('beforeTurn', { ...ctx, text }, Math.min(800, remaining)) as { text?: string } | undefined;
        if (res && typeof res.text === 'string' && res.text.trim() && res.text.length <= Math.max(100_000, text.length)) {
          text = res.text;
        }
      } catch (error) {
        rec.info.loadError = error instanceof Error ? error.message : String(error);
      }
    }

    return { text, expandedCommand };
  }
}
