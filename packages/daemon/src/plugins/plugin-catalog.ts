import type { PluginManifest } from '@harnessmate/plugin-api';

export const CURATED_PLUGIN_CATALOG: Array<PluginManifest & { tags: string[] }> = [
  {
    id: 'user.session-toolkit', name: '会话工具箱', version: '1.0.0', apiVersion: 3, category: 'tool',
    description: '整理文本行，并在当前 Harness 支持时运行额度、压缩或计划动作。',
    tags: ['会话动作', '模型工具'],
    contributes: {
      programs: [{ id: 'unique_lines', description: '去除重复文本行并排序', exposeToModel: true,
        steps: [{ op: 'trim' }, { op: 'lines', unique: true, order: 'asc' }] }],
      actions: [
        { kind: 'program', command: 'unique-lines', description: '去除重复文本行并排序', program: 'unique_lines' },
        { kind: 'harness', command: 'toolkit-usage', description: '查看当前 Harness 的用量', nativeCommand: 'usage', args: '' },
        { kind: 'harness', command: 'toolkit-compact', description: '压缩当前会话的原生上下文', nativeCommand: 'compact', args: '' },
        { kind: 'harness', command: 'toolkit-plan', description: '将当前会话切换到计划模式', nativeCommand: 'plan', args: '' },
      ],
    },
  },
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
