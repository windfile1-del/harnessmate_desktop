import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgyLaunchContext } from './agy-launch-context.js';

export interface AgyEcosystemSnapshot {
  instanceId: string;
  isolationMode: 'official_default' | 'profile_isolated';
  geminiDir: string;
  projects: {
    workspaceRoot: string;
    additionalDirectories: string[];
  };
  rules: {
    profileFiles: string[];
    workspaceRulesDirPresent: boolean;
  };
  skills: {
    profileSkillsLinked: boolean;
    workspaceSkillsCount: number;
  };
  mcp: {
    nativeGlobalConfigPresent: boolean;
    nativeGlobalConfigPath: string;
    nativeScope: 'global_shared';
    harnessMateSessionMcpScope: 'session_isolated';
    note: string;
  };
  hooks: {
    agyInternalHooksPresent: boolean;
    agyInternalHooksScope: 'agy_internal';
    harnessMateV5HooksCount: number;
  };
  plugins: {
    agyPluginCliNote: string;
    harnessMateActivePluginsCount: number;
  };
}

function countDirEntries(dirPath: string): number {
  try {
    if (!fs.existsSync(dirPath)) return 0;
    return fs.readdirSync(dirPath).filter((n) => !n.startsWith('.')).length;
  } catch {
    return 0;
  }
}

/**
 * Collects a strictly non-invasive read-only snapshot of the 6-domain boundary
 * between Google Antigravity native ecosystem files and HarnessMate Desktop.
 */
export function collectAgyEcosystemSnapshot(opts: {
  launchContext: AgyLaunchContext;
  workspaceRoot: string;
  additionalDirectories?: string[];
  harnessMateActivePluginsCount: number;
  userHome?: string;
}): AgyEcosystemSnapshot {
  const userHome = opts.userHome ?? os.homedir();
  const { launchContext, workspaceRoot } = opts;

  const profileFiles: string[] = [];
  for (const name of ['AGENTS.md', 'GEMINI.md']) {
    if (fs.existsSync(path.join(launchContext.geminiDir, name))) {
      profileFiles.push(name);
    }
  }
  const workspaceRulesDirPresent = fs.existsSync(path.join(workspaceRoot, '.agents', 'rules'));

  const profileSkillsLinked =
    fs.existsSync(path.join(launchContext.geminiDir, 'skills')) ||
    fs.existsSync(path.join(launchContext.geminiDir, 'config', 'skills'));
  const workspaceSkillsCount = countDirEntries(path.join(workspaceRoot, '.agents', 'skills'));

  const nativeGlobalConfigPath = path.join(userHome, '.gemini', 'config', 'mcp_config.json');
  const nativeGlobalConfigPresent = fs.existsSync(nativeGlobalConfigPath);

  const agyInternalHooksPresent =
    fs.existsSync(path.join(launchContext.geminiDir, 'hooks.json')) ||
    fs.existsSync(path.join(userHome, '.gemini', 'hooks.json'));

  return {
    instanceId: launchContext.instanceId,
    isolationMode: launchContext.isolationMode,
    geminiDir: launchContext.geminiDir,
    projects: {
      workspaceRoot,
      additionalDirectories: opts.additionalDirectories ?? [],
    },
    rules: {
      profileFiles,
      workspaceRulesDirPresent,
    },
    skills: {
      profileSkillsLinked,
      workspaceSkillsCount,
    },
    mcp: {
      nativeGlobalConfigPresent,
      nativeGlobalConfigPath,
      nativeScope: 'global_shared',
      harnessMateSessionMcpScope: 'session_isolated',
      note: '实测 agy mcp 读取本机全局 mcp_config.json（跨 Profile 共享）；HarnessMate 插件工具通过会话级 ACP mcpServers 隔离注入。',
    },
    hooks: {
      agyInternalHooksPresent,
      agyInternalHooksScope: 'agy_internal',
      harnessMateV5HooksCount: opts.harnessMateActivePluginsCount,
    },
    plugins: {
      agyPluginCliNote: 'agy plugin 与 HarnessMate V5 插件系统双轨独立、互不共享权限与沙箱。',
      harnessMateActivePluginsCount: opts.harnessMateActivePluginsCount,
    },
  };
}
