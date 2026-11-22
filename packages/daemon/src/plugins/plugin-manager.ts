import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  PluginManifestSchema,
  type Attachment,
  type InstalledPluginInfo,
  type InstallPluginRequest,
  type PluginCatalogItem,
  type PluginManifest,
  type PluginMcpPreset,
  type PluginSlashCommand,
} from '@harnessmate/protocol';
import type { HarnessRegistry } from '../harnesses/registry.js';

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
    name: '跨引擎无损上下文桥接插件',
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
  runtime?: PluginRuntimeModule;
}

export class PluginManager {
  private readonly plugins = new Map<string, LoadedPluginRecord>();
  private readonly pluginHarnessIds = new Set<string>();

  constructor(
    private readonly pluginsDir: string,
    private readonly registry: HarnessRegistry,
    private readonly getDisabledIds: () => string[],
    private readonly setDisabledIds: (ids: string[]) => void,
  ) {
    fs.mkdirSync(this.pluginsDir, { recursive: true });
  }

  async reloadAll(): Promise<InstalledPluginInfo[]> {
    // Unregister any harnesses previously contributed by plugins
    for (const hid of this.pluginHarnessIds) {
      this.registry.unregister(hid);
    }
    this.pluginHarnessIds.clear();
    this.plugins.clear();

    const disabledSet = new Set(this.getDisabledIds());

    // 1. Register built-in core plugins
    for (const manifest of BUILTIN_PLUGINS) {
      const enabled = !disabledSet.has(manifest.id);
      this.plugins.set(manifest.id, {
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

    // 2. Scan external user-installed plugins in pluginsDir/*/harnessmate-plugin.json
    if (fs.existsSync(this.pluginsDir)) {
      const dirs = fs.readdirSync(this.pluginsDir, { withFileTypes: true });
      for (const ent of dirs) {
        if (!ent.isDirectory()) continue;
        const pluginDir = path.join(this.pluginsDir, ent.name);
        const manifestPath = path.join(pluginDir, 'harnessmate-plugin.json');
        if (!fs.existsSync(manifestPath)) continue;

        try {
          const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          const parsed = PluginManifestSchema.parse(raw);
          const enabled = !disabledSet.has(parsed.id);
          let runtime: PluginRuntimeModule | undefined;
          let loadError: string | null = null;

          if (enabled && parsed.entry) {
            const entryFull = path.resolve(pluginDir, parsed.entry);
            if (entryFull.startsWith(pluginDir) && fs.existsSync(entryFull)) {
              try {
                const mod = (await import(
                  `${pathToFileURL(entryFull).href}?t=${Date.now()}`
                )) as PluginRuntimeModule & { default?: PluginRuntimeModule };
                runtime = mod.default ?? mod;
              } catch (err) {
                loadError = err instanceof Error ? err.message : String(err);
              }
            }
          }

          this.plugins.set(parsed.id, {
            info: {
              ...parsed,
              builtin: false,
              enabled,
              sourcePath: pluginDir,
              hasRuntimeHook: Boolean(runtime?.beforeTurn || runtime?.onEvent),
              loadError,
            },
            runtime,
          });
        } catch (err) {
          this.plugins.set(`broken.${ent.name}`, {
            info: {
              id: `broken.${ent.name}`,
              name: ent.name,
              version: '0.0.0',
              description: 'Failed to parse harnessmate-plugin.json',
              category: 'workflow',
              contributes: {},
              builtin: false,
              enabled: false,
              sourcePath: pluginDir,
              hasRuntimeHook: false,
              loadError: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }
    }

    // 3. Apply enabled plugin harness contributions to HarnessRegistry
    for (const rec of this.plugins.values()) {
      if (!rec.info.enabled) continue;
      for (const hCfg of rec.info.contributes.harnesses ?? []) {
        this.registry.registerCustomAcp(hCfg);
        this.pluginHarnessIds.add(hCfg.id);
      }
    }

    return this.listInstalled();
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

  async togglePlugin(id: string, enabled: boolean): Promise<InstalledPluginInfo[]> {
    const rec = this.plugins.get(id);
    if (!rec) throw new Error(`Plugin not found: ${id}`);

    const disabled = new Set(this.getDisabledIds());
    if (enabled) {
      disabled.delete(id);
    } else {
      disabled.add(id);
    }
    this.setDisabledIds(Array.from(disabled));
    return this.reloadAll();
  }

  async installPlugin(req: InstallPluginRequest): Promise<InstalledPluginInfo[]> {
    if (req.mode === 'catalog') {
      const item = CURATED_PLUGIN_CATALOG.find((c) => c.id === req.catalogId);
      if (!item) throw new Error(`Catalog plugin not found: ${req.catalogId}`);
      const { tags: _tags, ...manifest } = item;
      const targetDir = path.join(this.pluginsDir, manifest.id);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'harnessmate-plugin.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );
      return this.reloadAll();
    }

    if (req.mode === 'manifest') {
      const manifest = PluginManifestSchema.parse(req.manifest);
      const targetDir = path.join(this.pluginsDir, manifest.id);
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(
        path.join(targetDir, 'harnessmate-plugin.json'),
        JSON.stringify(manifest, null, 2),
        'utf8',
      );
      return this.reloadAll();
    }

    // mode === 'local_dir'
    const srcDir = path.resolve(req.dirPath);
    const manifestPath = path.join(srcDir, 'harnessmate-plugin.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`No harnessmate-plugin.json found in ${srcDir}`);
    }
    const manifest = PluginManifestSchema.parse(
      JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
    );
    const targetDir = path.join(this.pluginsDir, manifest.id);
    if (path.resolve(targetDir) !== srcDir) {
      fs.rmSync(targetDir, { recursive: true, force: true });
      fs.cpSync(srcDir, targetDir, { recursive: true });
    }
    return this.reloadAll();
  }

  async uninstallPlugin(id: string): Promise<InstalledPluginInfo[]> {
    const rec = this.plugins.get(id);
    if (!rec) throw new Error(`Plugin not found: ${id}`);
    if (rec.info.builtin) throw new Error('Built-in plugins cannot be uninstalled; disable them instead.');

    if (rec.info.sourcePath && fs.existsSync(rec.info.sourcePath)) {
      fs.rmSync(rec.info.sourcePath, { recursive: true, force: true });
    }
    const disabled = new Set(this.getDisabledIds());
    disabled.delete(id);
    this.setDisabledIds(Array.from(disabled));
    return this.reloadAll();
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
        const args = (match[2] ?? '').trim();
        const found = this.listActiveSlashCommands().find((c) => c.command === cmdName);
        if (found) {
          text = found.template.replace(/\{\{args\}\}/g, args || '（无额外参数）');
          expandedCommand = `/${cmdName}`;
        }
      }
    }

    for (const rec of this.plugins.values()) {
      if (!rec.info.enabled || !rec.runtime?.beforeTurn) continue;
      try {
        const res = await rec.runtime.beforeTurn({ ...ctx, text });
        if (res && typeof res.text === 'string' && res.text.trim()) {
          text = res.text;
        }
      } catch {
        // Isolate third-party plugin hook errors
      }
    }

    return { text, expandedCommand };
  }
}
