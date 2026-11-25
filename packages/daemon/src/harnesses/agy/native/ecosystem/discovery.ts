import fs from 'node:fs';
import path from 'node:path';
import {
  hashNormalizedPath,
  isPathWithinRoot,
  isSensitiveFileName,
  readSafeBoundedFile,
  redactPathForDto,
  resolveSafeChildPath,
  validateAuthorizedDirectory,
} from './path-guard.js';
import type {
  AdminPolicySnapshot,
  AgyPluginMetadataEntry,
  BoundarySurfaceStatus,
  CustomAgentEntry,
  HookMetadataEntry,
  McpServerMetadataEntry,
  RuleDiscoveryEntry,
  SkillDiscoveryEntry,
  SkillDuplicateConflict,
  ValidatedProjectRoot,
} from './types.js';

export interface ParsedMarkdownFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly model?: string;
  readonly trigger?: string;
  readonly tools?: readonly string[];
  readonly subagents?: boolean;
}

/**
 * Parses bounded YAML frontmatter strictly for display metadata.
 * Markdown body / system instructions are intentionally discarded.
 */
export function parseBoundedMarkdownFrontmatter(content: string): ParsedMarkdownFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {};
  }
  const endIdx = normalized.indexOf('\n---', 4);
  if (endIdx < 0) return {};

  const block = normalized.slice(4, endIdx);
  const lines = block.split('\n');
  let name: string | undefined;
  let description: string | undefined;
  let model: string | undefined;
  let trigger: string | undefined;
  let subagents: boolean | undefined;
  let tools: string[] | undefined;
  let inToolsList = false;

  const stripQuotes = (raw: string): string => {
    const t = raw.trim();
    if (
      (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
      (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
    ) {
      return t.slice(1, -1);
    }
    return t;
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (inToolsList) {
      if (trimmed.startsWith('- ')) {
        tools ??= [];
        tools.push(stripQuotes(trimmed.slice(2)));
        continue;
      }
      inToolsList = false;
    }

    const colonIdx = rawLine.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = rawLine.slice(0, colonIdx).trim();
    const val = rawLine.slice(colonIdx + 1).trim();

    switch (key) {
      case 'name':
        if (val) name = stripQuotes(val).slice(0, 120);
        break;
      case 'description':
        if (val && val !== '>-' && val !== '|') description = stripQuotes(val).slice(0, 240);
        break;
      case 'model':
        if (val) model = stripQuotes(val).slice(0, 120);
        break;
      case 'trigger':
        if (val) trigger = stripQuotes(val).slice(0, 64);
        break;
      case 'subagents':
        if (val === 'true') subagents = true;
        else if (val === 'false') subagents = false;
        break;
      case 'tools':
        if (!val) {
          inToolsList = true;
        } else if (val.startsWith('[') && val.endsWith(']')) {
          tools = val
            .slice(1, -1)
            .split(',')
            .map((s) => stripQuotes(s))
            .filter(Boolean);
        }
        break;
      default:
        break;
    }
  }

  return {
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(model ? { model } : {}),
    ...(trigger ? { trigger } : {}),
    ...(tools && tools.length > 0 ? { tools } : {}),
    ...(subagents !== undefined ? { subagents } : {}),
  };
}

function listDirSafe(dirPath: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkAncestorsToRepoRoot(startDir: string, stopBoundary: string, maxLevels = 12): string[] {
  const dirs: string[] = [];
  let current = path.resolve(startDir);
  const boundary = path.resolve(stopBoundary);

  for (let i = 0; i < maxLevels; i++) {
    dirs.push(current);
    const hasGit = fs.existsSync(path.join(current, '.git'));
    if (hasGit || current.toLowerCase() === boundary.toLowerCase()) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

export function discoverCustomAgents(opts: {
  readonly workspaceRoot: string;
  readonly geminiDir: string;
  readonly userHome: string;
  readonly platform?: NodeJS.Platform;
}): readonly CustomAgentEntry[] {
  const platform = opts.platform ?? process.platform;
  const roots: Array<{
    readonly baseDir: string;
    readonly subSegments: readonly string[];
    readonly scope: CustomAgentEntry['scope'];
    readonly sourceKind: CustomAgentEntry['sourceKind'];
    readonly precedenceRank: number;
  }> = [
    {
      baseDir: opts.workspaceRoot,
      subSegments: ['.agents', 'agents'],
      scope: 'project_workspace',
      sourceKind: 'workspace_agents',
      precedenceRank: 10,
    },
    {
      baseDir: opts.workspaceRoot,
      subSegments: ['.agent', 'agents'],
      scope: 'project_workspace',
      sourceKind: 'workspace_legacy_agent',
      precedenceRank: 20,
    },
    {
      baseDir: opts.geminiDir,
      subSegments: ['config', 'agents'],
      scope: 'account_profile',
      sourceKind: 'profile_gemini_config',
      precedenceRank: 30,
    },
    {
      baseDir: opts.geminiDir,
      subSegments: ['agents'],
      scope: 'account_profile',
      sourceKind: 'profile_gemini',
      precedenceRank: 40,
    },
  ];

  const discovered: Array<Omit<CustomAgentEntry, 'shadowedBy'>> = [];
  const seenPathHashes = new Set<string>();

  for (const root of roots) {
    const resolvedDir = resolveSafeChildPath(root.baseDir, root.subSegments, 'directory', { platform });
    if (!resolvedDir.ok) continue;

    for (const entry of listDirSafe(resolvedDir.canonicalPath)) {
      if (entry.name.startsWith('.') || isSensitiveFileName(entry.name)) continue;

      let fileSegments: string[] | null = null;
      let fallbackName = entry.name;
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        fileSegments = [...root.subSegments, entry.name];
        fallbackName = entry.name.slice(0, -3);
      } else if (entry.isDirectory()) {
        fileSegments = [...root.subSegments, entry.name, 'agent.md'];
      }
      if (!fileSegments) continue;

      const fileRes = readSafeBoundedFile(root.baseDir, fileSegments, { platform });
      if (!fileRes.ok) continue;

      const pathHash = hashNormalizedPath(fileRes.canonicalPath, platform);
      if (seenPathHashes.has(pathHash)) continue;
      seenPathHashes.add(pathHash);

      const fm = parseBoundedMarkdownFrontmatter(fileRes.content);
      const name = fm.name || fallbackName;
      discovered.push({
        id: `${root.sourceKind}:${name}:${pathHash.slice(0, 6)}`,
        name,
        ...(fm.description ? { description: fm.description } : {}),
        ...(fm.model ? { modelHint: fm.model } : {}),
        ...(fm.tools ? { toolsCount: fm.tools.length, toolNames: fm.tools } : {}),
        ...(fm.subagents !== undefined ? { subagentsEnabled: fm.subagents } : {}),
        scope: root.scope,
        sourceKind: root.sourceKind,
        precedenceRank: root.precedenceRank,
        redactedPath: redactPathForDto(fileRes.canonicalPath, {
          workspaceRoot: opts.workspaceRoot,
          geminiDir: opts.geminiDir,
          userHome: opts.userHome,
          platform,
        }),
        switchSemantics: 'new_session_or_fork_required',
        launchFlag: '--agent',
        officialEntry: 'agy agents · /agents',
        namespace: 'agy_native',
        readOnly: true,
      });
    }
  }

  discovered.sort((a, b) => a.precedenceRank - b.precedenceRank || a.name.localeCompare(b.name));
  const winnerByName = new Map<string, string>();
  return discovered.map((item) => {
    const key = item.name.toLowerCase();
    const existingWinner = winnerByName.get(key);
    if (!existingWinner) {
      winnerByName.set(key, item.sourceKind);
      return item;
    }
    return {
      ...item,
      shadowedBy: existingWinner,
    };
  });
}

export function discoverSkillsWith1516Precedence(opts: {
  readonly workspaceRoot: string;
  readonly cwd?: string;
  readonly geminiDir: string;
  readonly userHome: string;
  readonly isolationMode: 'official_default' | 'profile_isolated';
  readonly linkGlobalSkills: boolean;
  readonly platform?: NodeJS.Platform;
}): {
  readonly items: readonly SkillDiscoveryEntry[];
  readonly duplicates: readonly SkillDuplicateConflict[];
  readonly rejectedRootsCount: number;
} {
  const platform = opts.platform ?? process.platform;
  const userGeminiDir = path.join(opts.userHome, '.gemini');
  const userAgentsDir = path.join(opts.userHome, '.agents');
  const allowProfileLinks = opts.linkGlobalSkills ? [opts.geminiDir, userGeminiDir] : [opts.geminiDir];

  const ancestorDirs = walkAncestorsToRepoRoot(opts.cwd ?? opts.workspaceRoot, opts.workspaceRoot);

  const roots: Array<{
    readonly baseDir: string;
    readonly subSegments: readonly string[];
    readonly scope: SkillDiscoveryEntry['scope'];
    readonly sourceKind: SkillDiscoveryEntry['sourceKind'];
    readonly precedenceRank: number;
    readonly allowSymlinkWithinRoots?: readonly string[];
    readonly versionNote?: string;
  }> = [];

  ancestorDirs.forEach((dir, idx) => {
    roots.push({
      baseDir: dir,
      subSegments: ['.agents', 'skills'],
      scope: 'project_workspace',
      sourceKind: 'workspace_agents',
      precedenceRank: 10 + idx * 2,
    });
    roots.push({
      baseDir: dir,
      subSegments: ['.agent', 'skills'],
      scope: 'project_workspace',
      sourceKind: 'workspace_legacy_agent',
      precedenceRank: 11 + idx * 2,
    });
  });

  roots.push(
    {
      baseDir: opts.geminiDir,
      subSegments: ['config', 'skills'],
      scope: 'account_profile',
      sourceKind: 'profile_gemini_config',
      precedenceRank: 100,
      allowSymlinkWithinRoots: allowProfileLinks,
    },
    {
      baseDir: opts.geminiDir,
      subSegments: ['skills'],
      scope: 'account_profile',
      sourceKind: 'profile_gemini',
      precedenceRank: 110,
      allowSymlinkWithinRoots: allowProfileLinks,
    },
    {
      baseDir: opts.geminiDir,
      subSegments: ['antigravity', 'skills'],
      scope: 'account_profile',
      sourceKind: 'profile_antigravity',
      precedenceRank: 120,
      allowSymlinkWithinRoots: allowProfileLinks,
    },
  );

  if (opts.isolationMode === 'official_default' || opts.linkGlobalSkills) {
    roots.push(
      {
        baseDir: userGeminiDir,
        subSegments: ['config', 'skills'],
        scope: 'machine_global',
        sourceKind: 'global_gemini_config',
        precedenceRank: 130,
        allowSymlinkWithinRoots: [userGeminiDir],
      },
      {
        baseDir: userGeminiDir,
        subSegments: ['skills'],
        scope: 'machine_global',
        sourceKind: 'global_gemini',
        precedenceRank: 140,
        allowSymlinkWithinRoots: [userGeminiDir],
      },
    );
  }

  // AGY 1.5.16 introduced `~/.agents/skills`, strictly lower precedence than `~/.gemini`.
  if (opts.isolationMode === 'official_default' || opts.linkGlobalSkills) {
    roots.push({
      baseDir: userAgentsDir,
      subSegments: ['skills'],
      scope: 'machine_global',
      sourceKind: 'global_agents_1_5_16',
      precedenceRank: 200,
      allowSymlinkWithinRoots: [userAgentsDir],
      versionNote: 'AGY 1.5.16 全局 .agents/skills（优先级低于 .gemini）',
    });
  }

  const rawEntries: Array<Omit<SkillDiscoveryEntry, 'shadowedBy'>> = [];
  const seenPathHashes = new Set<string>();
  let rejectedRootsCount = 0;

  for (const root of roots) {
    const dirRes = resolveSafeChildPath(root.baseDir, root.subSegments, 'directory', {
      allowSymlinkWithinRoots: root.allowSymlinkWithinRoots,
      platform,
    });
    if (!dirRes.ok) {
      if (dirRes.reasonCode === 'symlink_escape_rejected') {
        rejectedRootsCount += 1;
      }
      continue;
    }

    for (const entry of listDirSafe(dirRes.canonicalPath)) {
      if (entry.name.startsWith('.') || isSensitiveFileName(entry.name)) continue;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

      const skillFile = readSafeBoundedFile(dirRes.canonicalPath, [entry.name, 'SKILL.md'], {
        allowSymlinkWithinRoots: root.allowSymlinkWithinRoots,
        platform,
      });
      if (!skillFile.ok) {
        if (skillFile.reasonCode === 'symlink_escape_rejected') {
          rejectedRootsCount += 1;
        }
        continue;
      }

      const pathHash = hashNormalizedPath(skillFile.canonicalPath, platform);
      if (seenPathHashes.has(pathHash)) continue;
      seenPathHashes.add(pathHash);

      const fm = parseBoundedMarkdownFrontmatter(skillFile.content);
      rawEntries.push({
        name: fm.name || entry.name,
        ...(fm.description ? { description: fm.description } : {}),
        scope: root.scope,
        sourceKind: root.sourceKind,
        precedenceRank: root.precedenceRank,
        redactedPath: redactPathForDto(skillFile.canonicalPath, {
          workspaceRoot: opts.workspaceRoot,
          geminiDir: opts.geminiDir,
          userHome: opts.userHome,
          platform,
        }),
        namespace: 'agy_native',
        ...(root.versionNote ? { versionNote: root.versionNote } : {}),
      });
    }
  }

  rawEntries.sort((a, b) => a.precedenceRank - b.precedenceRank || a.name.localeCompare(b.name));
  const winners = new Map<string, SkillDiscoveryEntry['sourceKind']>();
  const shadowedMap = new Map<string, SkillDiscoveryEntry['sourceKind'][]>();

  const items: SkillDiscoveryEntry[] = rawEntries.map((entry) => {
    const key = entry.name.toLowerCase();
    const winner = winners.get(key);
    if (!winner) {
      winners.set(key, entry.sourceKind);
      return entry;
    }
    const list = shadowedMap.get(key) ?? [];
    list.push(entry.sourceKind);
    shadowedMap.set(key, list);
    return {
      ...entry,
      shadowedBy: winner,
    };
  });

  const duplicates: SkillDuplicateConflict[] = [];
  for (const [key, shadowedSources] of shadowedMap.entries()) {
    const winnerEntry = items.find((i) => i.name.toLowerCase() === key && !i.shadowedBy);
    if (winnerEntry) {
      duplicates.push({
        name: winnerEntry.name,
        winnerSourceKind: winnerEntry.sourceKind,
        shadowedSources,
      });
    }
  }

  return { items, duplicates, rejectedRootsCount };
}

export function discoverRulesReadOnly(opts: {
  readonly workspaceRoot: string;
  readonly geminiDir: string;
  readonly userHome: string;
  readonly rulesVerifiedLive?: boolean;
  readonly platform?: NodeJS.Platform;
}): readonly RuleDiscoveryEntry[] {
  const platform = opts.platform ?? process.platform;
  const acpVerification: RuleDiscoveryEntry['acpRuntimeVerification'] = opts.rulesVerifiedLive
    ? 'verified_live'
    : 'unverified_upstream_1540';
  const note = opts.rulesVerifiedLive
    ? '已通过当前会话验证 Rules 读取；不修改或注入 System Prompt。'
    : '仅只读发现本地规则文件；受上游 ACP #1540 影响未假定运行时生效，严禁注入 System Prompt。';

  const items: RuleDiscoveryEntry[] = [];
  const seenHashes = new Set<string>();

  const addFileCandidate = (
    baseDir: string,
    segments: readonly string[],
    kind: RuleDiscoveryEntry['kind'],
    scope: RuleDiscoveryEntry['scope'],
    sourceKind: RuleDiscoveryEntry['sourceKind'],
    allowSymlinkWithinRoots?: readonly string[],
  ): void => {
    const res = readSafeBoundedFile(baseDir, segments, { allowSymlinkWithinRoots, platform });
    if (!res.ok) return;
    const hash = hashNormalizedPath(res.canonicalPath, platform);
    if (seenHashes.has(hash)) return;
    seenHashes.add(hash);

    const fm = kind === 'modular_rule' ? parseBoundedMarkdownFrontmatter(res.content) : {};
    const triggerMode: RuleDiscoveryEntry['triggerMode'] =
      fm.trigger === 'model_decision'
        ? 'model_decision'
        : kind === 'agents_md' || kind === 'gemini_md' || fm.trigger === 'always_on'
          ? 'always_on'
          : 'unknown';

    items.push({
      id: `rule:${hash}`,
      name: segments[segments.length - 1]!,
      kind,
      scope,
      sourceKind,
      triggerMode,
      canonicalHash: hash,
      redactedPath: redactPathForDto(res.canonicalPath, {
        workspaceRoot: opts.workspaceRoot,
        geminiDir: opts.geminiDir,
        userHome: opts.userHome,
        platform,
      }),
      acpRuntimeVerification: acpVerification,
      note,
      namespace: 'agy_native',
    });
  };

  addFileCandidate(opts.workspaceRoot, ['AGENTS.md'], 'agents_md', 'project_workspace', 'workspace_root');
  addFileCandidate(opts.workspaceRoot, ['GEMINI.md'], 'gemini_md', 'project_workspace', 'workspace_root');
  addFileCandidate(opts.workspaceRoot, ['.agents', 'AGENTS.md'], 'agents_md', 'project_workspace', 'workspace_agents');
  addFileCandidate(opts.workspaceRoot, ['.agents', 'GEMINI.md'], 'gemini_md', 'project_workspace', 'workspace_agents');
  addFileCandidate(opts.workspaceRoot, ['.agents', 'rules.json'], 'rules_json', 'project_workspace', 'workspace_agents');

  for (const [subSeg, sourceKind] of [
    [['.agents', 'rules'], 'workspace_agents'],
    [['.agent', 'rules'], 'workspace_legacy_agent'],
  ] as const) {
    const dirRes = resolveSafeChildPath(opts.workspaceRoot, subSeg, 'directory', { platform });
    if (dirRes.ok) {
      for (const entry of listDirSafe(dirRes.canonicalPath)) {
        if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
          addFileCandidate(
            opts.workspaceRoot,
            [...subSeg, entry.name],
            'modular_rule',
            'project_workspace',
            sourceKind,
          );
        }
      }
    }
  }

  const profileRoots = [opts.geminiDir, path.join(opts.userHome, '.gemini')];
  addFileCandidate(opts.geminiDir, ['AGENTS.md'], 'agents_md', 'account_profile', 'profile_gemini', profileRoots);
  addFileCandidate(opts.geminiDir, ['GEMINI.md'], 'gemini_md', 'account_profile', 'profile_gemini', profileRoots);
  addFileCandidate(opts.geminiDir, ['config', 'AGENTS.md'], 'agents_md', 'account_profile', 'profile_gemini_config', profileRoots);
  addFileCandidate(opts.geminiDir, ['config', 'GEMINI.md'], 'gemini_md', 'account_profile', 'profile_gemini_config', profileRoots);

  const profileModular = resolveSafeChildPath(opts.geminiDir, ['config', 'rules'], 'directory', {
    allowSymlinkWithinRoots: profileRoots,
    platform,
  });
  if (profileModular.ok) {
    for (const entry of listDirSafe(profileModular.canonicalPath)) {
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        addFileCandidate(
          opts.geminiDir,
          ['config', 'rules', entry.name],
          'modular_rule',
          'account_profile',
          'profile_gemini_config',
          profileRoots,
        );
      }
    }
  }

  return items;
}

export function discoverHooksMetadata(opts: {
  readonly workspaceRoot: string;
  readonly geminiDir: string;
  readonly userHome: string;
  readonly isolationMode: 'official_default' | 'profile_isolated';
  readonly adminPolicy: AdminPolicySnapshot;
  readonly platform?: NodeJS.Platform;
}): readonly HookMetadataEntry[] {
  const platform = opts.platform ?? process.platform;
  const userGeminiDir = path.join(opts.userHome, '.gemini');
  const candidates: Array<{
    readonly baseDir: string;
    readonly segments: readonly string[];
    readonly scope: HookMetadataEntry['scope'];
    readonly sourceKind: HookMetadataEntry['sourceKind'];
  }> = [
    {
      baseDir: opts.workspaceRoot,
      segments: ['.agents', 'hooks.json'],
      scope: 'project_workspace',
      sourceKind: 'workspace_agents_hooks',
    },
    {
      baseDir: opts.geminiDir,
      segments: ['config', 'hooks.json'],
      scope: 'account_profile',
      sourceKind: 'profile_gemini_config_hooks',
    },
    {
      baseDir: opts.geminiDir,
      segments: ['hooks.json'],
      scope: 'account_profile',
      sourceKind: 'profile_gemini_hooks',
    },
  ];
  if (opts.isolationMode === 'official_default') {
    candidates.push({
      baseDir: userGeminiDir,
      segments: ['hooks.json'],
      scope: 'machine_global',
      sourceKind: 'global_gemini_hooks',
    });
  }

  const results: HookMetadataEntry[] = [];
  const seenHashes = new Set<string>();

  for (const cand of candidates) {
    const fileRes = readSafeBoundedFile(cand.baseDir, cand.segments, { platform });
    if (!fileRes.ok) continue;
    const hash = hashNormalizedPath(fileRes.canonicalPath, platform);
    if (seenHashes.has(hash)) continue;
    seenHashes.add(hash);

    let parsed: unknown;
    try {
      parsed = JSON.parse(fileRes.content);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;

    const record = parsed as Record<string, unknown>;
    const hooksObj =
      record.hooks && typeof record.hooks === 'object' && !Array.isArray(record.hooks)
        ? (record.hooks as Record<string, unknown>)
        : record;
    const redactedPath = redactPathForDto(fileRes.canonicalPath, {
      workspaceRoot: opts.workspaceRoot,
      geminiDir: opts.geminiDir,
      userHome: opts.userHome,
      platform,
    });

    for (const [eventName, handlerDef] of Object.entries(hooksObj)) {
      if (!eventName || eventName.startsWith('$')) continue;
      const handlerCount = Array.isArray(handlerDef) ? handlerDef.length : handlerDef ? 1 : 0;
      if (handlerCount === 0) continue;
      results.push({
        eventName,
        scope: cand.scope,
        sourceKind: cand.sourceKind,
        handlerCount,
        redactedPath,
        organizationDisabled: opts.adminPolicy.hooksDisabled,
        namespace: 'agy_native',
        neverAutoExecutedByHm: true,
      });
    }
  }

  return results;
}

export function discoverAgyPluginsMetadata(opts: {
  readonly workspaceRoot: string;
  readonly geminiDir: string;
  readonly userHome: string;
  readonly adminPolicy: AdminPolicySnapshot;
  readonly platform?: NodeJS.Platform;
}): readonly AgyPluginMetadataEntry[] {
  const platform = opts.platform ?? process.platform;
  const disabledSet = new Set(opts.adminPolicy.disabledPlugins.map((s) => s.toLowerCase()));
  const items: AgyPluginMetadataEntry[] = [];
  const seenKeys = new Set<string>();

  const pushPlugin = (
    name: string,
    enabled: boolean | null,
    scope: AgyPluginMetadataEntry['scope'],
    sourceKind: AgyPluginMetadataEntry['sourceKind'],
    canonicalPath: string,
  ): void => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const dedupeKey = `${sourceKind}:${trimmed.toLowerCase()}`;
    if (seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);

    const disabledByPolicy = disabledSet.has(trimmed.toLowerCase());
    items.push({
      name: trimmed,
      scope,
      sourceKind,
      enabled: disabledByPolicy ? false : enabled,
      disabledByPolicy,
      managedByOrgPolicy: disabledByPolicy,
      redactedPath: redactPathForDto(canonicalPath, {
        workspaceRoot: opts.workspaceRoot,
        geminiDir: opts.geminiDir,
        userHome: opts.userHome,
        platform,
      }),
      namespace: 'agy_native',
      officialEntry: 'agy plugin · /plugin',
    });
  };

  const jsonLists: Array<{
    readonly baseDir: string;
    readonly segments: readonly string[];
    readonly scope: AgyPluginMetadataEntry['scope'];
    readonly sourceKind: AgyPluginMetadataEntry['sourceKind'];
  }> = [
    {
      baseDir: opts.workspaceRoot,
      segments: ['.agents', 'plugins.json'],
      scope: 'project_workspace',
      sourceKind: 'workspace_agents_plugins',
    },
    {
      baseDir: opts.geminiDir,
      segments: ['config', 'plugins.json'],
      scope: 'account_profile',
      sourceKind: 'profile_gemini_config_plugins',
    },
  ];

  for (const cfg of jsonLists) {
    const fileRes = readSafeBoundedFile(cfg.baseDir, cfg.segments, { platform });
    if (!fileRes.ok) continue;
    try {
      const parsed = JSON.parse(fileRes.content) as unknown;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (typeof entry === 'string') {
            pushPlugin(entry, null, cfg.scope, cfg.sourceKind, fileRes.canonicalPath);
          } else if (entry && typeof entry === 'object') {
            const obj = entry as Record<string, unknown>;
            if (typeof obj.name === 'string') {
              pushPlugin(
                obj.name,
                typeof obj.enabled === 'boolean' ? obj.enabled : null,
                cfg.scope,
                cfg.sourceKind,
                fileRes.canonicalPath,
              );
            }
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        const record = parsed as Record<string, unknown>;
        const list = Array.isArray(record.plugins) ? record.plugins : null;
        if (list) {
          for (const entry of list) {
            if (typeof entry === 'string') {
              pushPlugin(entry, null, cfg.scope, cfg.sourceKind, fileRes.canonicalPath);
            } else if (entry && typeof entry === 'object') {
              const obj = entry as Record<string, unknown>;
              if (typeof obj.name === 'string') {
                pushPlugin(
                  obj.name,
                  typeof obj.enabled === 'boolean' ? obj.enabled : null,
                  cfg.scope,
                  cfg.sourceKind,
                  fileRes.canonicalPath,
                );
              }
            }
          }
        } else {
          for (const [k, v] of Object.entries(record)) {
            if (k.startsWith('$') || k === 'disabled') continue;
            if (typeof v === 'boolean') {
              pushPlugin(k, v, cfg.scope, cfg.sourceKind, fileRes.canonicalPath);
            } else if (v && typeof v === 'object') {
              const obj = v as Record<string, unknown>;
              pushPlugin(
                k,
                typeof obj.enabled === 'boolean' ? obj.enabled : null,
                cfg.scope,
                cfg.sourceKind,
                fileRes.canonicalPath,
              );
            }
          }
        }
      }
    } catch {
      // ignore malformed plugins.json
    }
  }

  for (const dirSpec of [
    {
      baseDir: opts.workspaceRoot,
      subSeg: ['.agents', 'plugins'],
      scope: 'project_workspace' as const,
      sourceKind: 'workspace_agents_plugins' as const,
    },
    {
      baseDir: opts.geminiDir,
      subSeg: ['config', 'plugins'],
      scope: 'account_profile' as const,
      sourceKind: 'profile_gemini_config_plugins' as const,
    },
    {
      baseDir: opts.geminiDir,
      subSeg: ['plugins'],
      scope: 'account_profile' as const,
      sourceKind: 'profile_gemini_plugins' as const,
    },
  ]) {
    const dirRes = resolveSafeChildPath(dirSpec.baseDir, dirSpec.subSeg, 'directory', { platform });
    if (!dirRes.ok) continue;
    for (const entry of listDirSafe(dirRes.canonicalPath)) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const manifestRes = readSafeBoundedFile(dirRes.canonicalPath, [entry.name, 'plugin.json'], {
        platform,
      });
      if (!manifestRes.ok) continue;
      try {
        const parsed = JSON.parse(manifestRes.content) as Record<string, unknown>;
        const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : entry.name;
        const enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : null;
        pushPlugin(name, enabled, dirSpec.scope, dirSpec.sourceKind, manifestRes.canonicalPath);
      } catch {
        // ignore invalid plugin manifest
      }
    }
  }

  return items;
}

export function discoverMcpMetadata(opts: {
  readonly workspaceRoot: string;
  readonly geminiDir: string;
  readonly userHome: string;
  readonly adminPolicy: AdminPolicySnapshot;
  readonly harnessMateSessionMcpServers?: ReadonlyArray<{
    readonly name: string;
    readonly transportKind?: 'stdio' | 'http' | 'sse' | 'unknown';
  }>;
  readonly platform?: NodeJS.Platform;
}): {
  readonly servers: readonly McpServerMetadataEntry[];
  readonly nativeGlobalConfigPresent: boolean;
} {
  const platform = opts.platform ?? process.platform;
  const blockedSet = new Set(opts.adminPolicy.blockedMcpServers.map((s) => s.toLowerCase()));
  const servers: McpServerMetadataEntry[] = [];
  let nativeGlobalConfigPresent = false;

  const inspectMcpFile = (
    baseDir: string,
    segments: readonly string[],
    scope: 'global_shared' | 'project_local',
  ): void => {
    const fileRes = readSafeBoundedFile(baseDir, segments, { platform });
    if (!fileRes.ok) return;
    if (scope === 'global_shared') nativeGlobalConfigPresent = true;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fileRes.content);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

    const record = parsed as Record<string, unknown>;
    const rawServers =
      record.mcpServers && typeof record.mcpServers === 'object' && !Array.isArray(record.mcpServers)
        ? (record.mcpServers as Record<string, unknown>)
        : {};

    const redactedSourcePath = redactPathForDto(fileRes.canonicalPath, {
      workspaceRoot: opts.workspaceRoot,
      geminiDir: opts.geminiDir,
      userHome: opts.userHome,
      platform,
    });

    for (const [serverName, def] of Object.entries(rawServers)) {
      if (!serverName) continue;
      const obj = def && typeof def === 'object' && !Array.isArray(def) ? (def as Record<string, unknown>) : {};
      const transportKind: McpServerMetadataEntry['transportKind'] =
        typeof obj.serverUrl === 'string' || typeof obj.url === 'string'
          ? obj.type === 'sse'
            ? 'sse'
            : 'http'
          : typeof obj.command === 'string'
            ? 'stdio'
            : 'unknown';
      const hasSecretEnvRedacted = Boolean(
        obj.env && typeof obj.env === 'object' && Object.keys(obj.env as object).length > 0,
      );
      const hasAuthHeadersRedacted = Boolean(
        obj.headers && typeof obj.headers === 'object' && Object.keys(obj.headers as object).length > 0,
      );
      servers.push({
        name: serverName,
        transportKind,
        scope,
        namespace: 'agy_native',
        hasSecretEnvRedacted,
        hasAuthHeadersRedacted,
        blockedByPolicy: blockedSet.has(serverName.toLowerCase()),
        redactedSourcePath,
      });
    }
  };

  inspectMcpFile(path.join(opts.userHome, '.gemini'), ['config', 'mcp_config.json'], 'global_shared');
  inspectMcpFile(opts.workspaceRoot, ['.agents', 'mcp_config.json'], 'project_local');

  for (const hmServer of opts.harnessMateSessionMcpServers ?? []) {
    servers.push({
      name: hmServer.name,
      transportKind: hmServer.transportKind ?? 'unknown',
      scope: 'session_isolated',
      namespace: 'harnessmate',
      hasSecretEnvRedacted: false,
      hasAuthHeadersRedacted: false,
      blockedByPolicy: false,
    });
  }

  return { servers, nativeGlobalConfigPresent };
}

export function validateProjectRoots(opts: {
  readonly workspaceRoot: string;
  readonly additionalDirectories: readonly string[];
  readonly geminiDir: string;
  readonly userHome: string;
  readonly allowAdditionalSymlinksWithinRoots?: readonly string[];
  readonly platform?: NodeJS.Platform;
}): {
  readonly workspaceRoot: ValidatedProjectRoot;
  readonly additionalDirectories: readonly ValidatedProjectRoot[];
} {
  const platform = opts.platform ?? process.platform;
  const seenHashes = new Set<string>();

  const wsCheck = validateAuthorizedDirectory(opts.workspaceRoot, {
    platform,
    allowSymlinkWithinRoots: opts.allowAdditionalSymlinksWithinRoots,
  });
  const wsHash = wsCheck.canonicalPath
    ? hashNormalizedPath(wsCheck.canonicalPath, platform)
    : hashNormalizedPath(opts.workspaceRoot || 'invalid', platform);
  seenHashes.add(wsHash);

  const workspaceRoot: ValidatedProjectRoot = {
    kind: 'workspace_root',
    sourceScope: 'session_runtime',
    redactedPath: wsCheck.canonicalPath
      ? redactPathForDto(wsCheck.canonicalPath, {
          workspaceRoot: opts.workspaceRoot,
          geminiDir: opts.geminiDir,
          userHome: opts.userHome,
          platform,
        })
      : '<workspace>',
    normalizedHash: wsHash,
    allowed: wsCheck.allowed,
    reasonCode: wsCheck.reasonCode,
  };

  const additionalDirectories: ValidatedProjectRoot[] = [];
  for (const rawDir of opts.additionalDirectories) {
    const check = validateAuthorizedDirectory(rawDir, {
      platform,
      allowSymlinkWithinRoots: [
        ...(wsCheck.canonicalPath ? [wsCheck.canonicalPath] : []),
        ...(opts.allowAdditionalSymlinksWithinRoots ?? []),
      ],
    });
    const dirHash = check.canonicalPath
      ? hashNormalizedPath(check.canonicalPath, platform)
      : hashNormalizedPath(rawDir || 'invalid', platform);

    const isDup = check.allowed && seenHashes.has(dirHash);
    if (check.allowed) seenHashes.add(dirHash);

    const isInsideWorkspace = Boolean(
      check.canonicalPath &&
        wsCheck.canonicalPath &&
        isPathWithinRoot(check.canonicalPath, wsCheck.canonicalPath, platform),
    );

    additionalDirectories.push({
      kind: 'additional_directory',
      sourceScope: 'account_profile',
      redactedPath: check.canonicalPath
        ? isInsideWorkspace
          ? redactPathForDto(check.canonicalPath, {
              workspaceRoot: opts.workspaceRoot,
              geminiDir: opts.geminiDir,
              userHome: opts.userHome,
              platform,
            })
          : `<additional-dir:${dirHash.slice(0, 8)}>`
        : `<rejected-dir:${dirHash.slice(0, 8)}>`,
      normalizedHash: dirHash,
      allowed: check.allowed && !isDup,
      reasonCode: isDup ? 'duplicate_root' : check.reasonCode,
    });
  }

  return { workspaceRoot, additionalDirectories };
}

export function buildBoundarySurfaces(): readonly BoundarySurfaceStatus[] {
  return [
    {
      capabilityId: 'AGY-S16',
      key: 'billing_credits',
      title: 'Credits、账单与付费计划',
      namespace: 'agy_native',
      gate: 'upstream_limited',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'ACP 未提供账单或购买控制接口；仅展示只读计划摘要与官方 /credits 入口。',
      officialEntry: '官方 CLI /credits · 官方账户设置',
      officialDocUrl: 'https://antigravity.google/docs/plans/',
    },
    {
      capabilityId: 'AGY-X01',
      key: 'remote_control',
      title: 'AGY Remote Control',
      namespace: 'agy_native',
      gate: 'upstream_limited',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'AGY 原生 Remote Control 与 HarnessMate HM-Remote 体系完全独立；HM 不代为开启原生远控。',
      officialEntry: '官方 CLI /remote-control · agy remote-control',
      officialDocUrl: 'https://antigravity.google/docs/remote-control/',
    },
    {
      capabilityId: 'AGY-X02',
      key: 'remote_agents',
      title: 'AGY Remote Agents',
      namespace: 'agy_native',
      gate: 'upstream_limited',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'Google 托管远端环境当前未验证 ACP 作用域接口，不得按本地路径推断远端状态。',
      officialEntry: '官方 CLI --remote-agent · App Remote Project',
      officialDocUrl: 'https://antigravity.google/docs/remote-agents/',
    },
    {
      capabilityId: 'AGY-X03',
      key: 'ssh_workspace',
      title: 'AGY SSH Workspace',
      namespace: 'agy_native',
      gate: 'upstream_limited',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'App SSH 远端工作区与认证作用域独立；HM 不跨边界复用凭据或接管 SSH 连接管理。',
      officialEntry: 'Antigravity App SSH 新建项目',
      officialDocUrl: 'https://antigravity.google/docs/ssh/',
    },
    {
      capabilityId: 'AGY-E08',
      key: 'sidecars',
      title: 'App Sidecars 与 agentapi',
      namespace: 'agy_native',
      gate: 'unsupported',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'Sidecars 属 Antigravity App 生命周期管理的后台进程；HM 严禁启动或探测未授权 Sidecar。',
      officialEntry: 'Antigravity App Automations / Sidecar Manifest',
      officialDocUrl: 'https://antigravity.google/docs/sidecars/',
    },
    {
      capabilityId: 'AGY-E09',
      key: 'ide_sdk',
      title: 'Antigravity SDK / IDE 扩展能力',
      namespace: 'agy_native',
      gate: 'unsupported',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'Antigravity SDK / Personas 与 agy acp 运行时分离，HM 不引入第二套非官方运行时。',
      officialEntry: 'Antigravity SDK & IDE Extensions 文档',
      officialDocUrl: 'https://antigravity.google/docs/sdk/overview/',
    },
    {
      capabilityId: 'AGY-E06',
      key: 'mcp_apps',
      title: 'AGY MCP Apps 原生界面',
      namespace: 'agy_native',
      gate: 'unsupported',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'ACP v1 暂未暴露 AGY App MCP iframe view schema，与 HarnessMate 自有沙箱视图相互独立。',
      officialEntry: 'Antigravity App MCP Apps',
      officialDocUrl: 'https://antigravity.google/docs/mcp-apps/',
    },
    {
      capabilityId: 'AGY-E10',
      key: 'marketplace',
      title: 'AGY Marketplace 与 Build with Google',
      namespace: 'agy_native',
      gate: 'upstream_limited',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: '原生插件市场无 ACP 列表接口，与 HarnessMate Plugin Catalog 严格分轨展示。',
      officialEntry: 'Antigravity App Marketplace · agy plugin',
      officialDocUrl: 'https://antigravity.google/docs/marketplace/',
    },
    {
      capabilityId: 'AGY-E07',
      key: 'learn_customizations',
      title: 'Learn 与配置发现 (/learn · agy-customizations)',
      namespace: 'agy_native',
      gate: 'not_tested',
      nativeFeedAvailable: false,
      hmManaged: false,
      reason: 'Rules/Skills 提案应由官方工作流与明确用户确认执行，HM 不自动修改用户私有规则文件。',
      officialEntry: '官方 CLI /learn · /agy-customizations',
      officialDocUrl: 'https://antigravity.google/docs/customization-discovery/',
    },
  ];
}
