import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgyProfileConfig } from '@harnessmate/protocol';

const RULE_COPIES_MANIFEST = '.hm-rule-copies.json';
const ACL_MARKER_FILE = '.hm-acl-applied';
const USER_CONFIG_FILES = [['AGENTS.md'], ['GEMINI.md'], ['config', 'skills.json']] as const;

export interface AgyProfileDirectories {
  readonly geminiDir: string;
  readonly runtimeTempDir: string;
}

export interface PreparedAgyProfile {
  readonly geminiDir: string;
  readonly appDataDirName: string;
  readonly appDataPath: string;
  readonly runtimeTempDir: string;
  readonly aclApplied: boolean;
  readonly warnings: string[];
}

export function resolveAgyProfileDirectories(
  profilesRootDir: string,
  instanceId: string,
): AgyProfileDirectories {
  const key = crypto.createHash('sha256').update(instanceId, 'utf8').digest('hex');
  return {
    geminiDir: path.join(path.resolve(profilesRootDir), key),
    // Keep runtime temp short for Windows 260-character path safety.
    runtimeTempDir: path.join(path.resolve(profilesRootDir), '_tmp', key.slice(0, 12)),
  };
}

function sameCanonicalPath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Resolves a path strictly beneath `profileRoot` without crossing any symlink or
 * Windows reparse point. Fails closed (`undefined`) if any segment is missing,
 * has the wrong type, or links outside `profileRoot`.
 */
export function resolveManagedProfilePathSync(
  profileRoot: string,
  segments: readonly string[],
  kind: 'file' | 'directory',
): { readonly path: string; readonly info: fs.Stats } | undefined {
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(profileRoot);
  } catch {
    return undefined;
  }

  let current = rootReal;
  let info: fs.Stats | undefined;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    if (!seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\\')) {
      return undefined;
    }
    current = path.join(current, seg);
    try {
      info = fs.lstatSync(current);
    } catch {
      return undefined;
    }
    const expectFile = kind === 'file' && i === segments.length - 1;
    if (info.isSymbolicLink() || (expectFile ? !info.isFile() : !info.isDirectory())) {
      return undefined;
    }
  }

  if (!info) return undefined;
  try {
    const resolved = fs.realpathSync(current);
    return sameCanonicalPath(resolved, current) ? { path: current, info } : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveManagedProfilePath(
  profileRoot: string,
  segments: readonly string[],
  kind: 'file' | 'directory',
): Promise<{ readonly path: string; readonly info: fs.Stats } | undefined> {
  return resolveManagedProfilePathSync(profileRoot, segments, kind);
}

/**
 * Creates a directory with owner-only permissions. On Windows, applies `icacls`
 * inheritance reset once (marked with `.hm-acl-applied`) on a best-effort basis.
 */
export function ensurePrivateProfileDirectory(
  dirPath: string,
  opts?: { platform?: NodeJS.Platform; applyWindowsAcl?: boolean },
): { aclApplied: boolean; warning?: string } {
  const platform = opts?.platform ?? process.platform;
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    fs.chmodSync(dirPath, 0o700);
    return { aclApplied: true };
  }

  if (opts?.applyWindowsAcl === false) {
    return { aclApplied: false };
  }

  const marker = path.join(dirPath, ACL_MARKER_FILE);
  if (fs.existsSync(marker)) {
    return { aclApplied: true };
  }

  try {
    const username = process.env.USERNAME || os.userInfo().username;
    if (!username) {
      return { aclApplied: false, warning: '无法确定当前 Windows 用户名以设置目录 ACL' };
    }
    const icaclsExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe');
    execFileSync(
      fs.existsSync(icaclsExe) ? icaclsExe : 'icacls',
      [dirPath, '/inheritance:r', '/grant:r', `${username}:(OI)(CI)F`],
      { windowsHide: true, timeout: 5000, stdio: 'ignore' },
    );
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`, 'utf8');
    return { aclApplied: true };
  } catch (err) {
    return {
      aclApplied: false,
      warning: `Windows 目录 ACL 加固失败（不影响功能）：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function writeProfileSettings(appDataPath: string, profile: AgyProfileConfig): void {
  const settingsPath = path.join(appDataPath, 'settings.json');
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      existing = {};
    }
  }

  const next: Record<string, unknown> = {
    ...existing,
    auth: {
      ...(existing.auth && typeof existing.auth === 'object' && !Array.isArray(existing.auth)
        ? (existing.auth as Record<string, unknown>)
        : {}),
      type: profile.authMethod,
    },
  };

  if (profile.gcpProject || profile.gcpLocation) {
    next.gcp = {
      ...(profile.gcpProject ? { project: profile.gcpProject } : {}),
      ...(profile.gcpLocation ? { location: profile.gcpLocation } : {}),
    };
  }

  const tmpPath = `${settingsPath}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, settingsPath);
}

function linkGlobalSkillsIntoProfile(
  geminiDir: string,
  userHome: string,
  platform: NodeJS.Platform,
  warnings: string[],
): void {
  const userGemini = path.join(userHome, '.gemini');
  const pairs: Array<[string, string]> = [
    [path.join(geminiDir, 'config', 'skills'), path.join(userGemini, 'config', 'skills')],
    [path.join(geminiDir, 'skills'), path.join(userGemini, 'skills')],
  ];
  const linkType = platform === 'win32' ? 'junction' : 'dir';

  for (const [linkPath, targetPath] of pairs) {
    try {
      if (!fs.existsSync(targetPath)) {
        try {
          if (fs.lstatSync(linkPath).isSymbolicLink()) {
            fs.unlinkSync(linkPath);
          }
        } catch {
          // ignore missing link
        }
        continue;
      }

      let existingStat: fs.Stats | undefined;
      try {
        existingStat = fs.lstatSync(linkPath);
      } catch {
        existingStat = undefined;
      }

      if (existingStat) {
        if (existingStat.isSymbolicLink()) {
          const currentTarget = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
          if (sameCanonicalPath(currentTarget, path.resolve(targetPath), platform)) {
            continue;
          }
          fs.rmSync(linkPath, { recursive: true, force: true });
        } else if (existingStat.isDirectory()) {
          // Only replace empty placeholder directories created by the harness.
          if (fs.readdirSync(linkPath).length === 0) {
            fs.rmdirSync(linkPath);
          } else {
            continue;
          }
        } else {
          continue;
        }
      }

      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(targetPath, linkPath, linkType);
    } catch (err) {
      warnings.push(
        `无法链接全局 Skills 目录 ${linkPath} -> ${targetPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function syncGlobalRulesIntoProfile(
  geminiDir: string,
  userHome: string,
  platform: NodeJS.Platform,
  warnings: string[],
): void {
  const userGemini = path.join(userHome, '.gemini');

  if (platform !== 'win32') {
    for (const segments of USER_CONFIG_FILES) {
      const linkPath = path.join(geminiDir, ...segments);
      const targetPath = path.join(userGemini, ...segments);
      try {
        if (!fs.existsSync(targetPath)) {
          try {
            if (fs.lstatSync(linkPath).isSymbolicLink()) fs.unlinkSync(linkPath);
          } catch {
            // ignore
          }
          continue;
        }
        try {
          const st = fs.lstatSync(linkPath);
          if (st.isSymbolicLink()) {
            const currentTarget = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
            if (sameCanonicalPath(currentTarget, path.resolve(targetPath), platform)) continue;
            fs.unlinkSync(linkPath);
          } else {
            continue; // Profile owns its own non-symlink copy
          }
        } catch {
          // does not exist
        }
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(targetPath, linkPath, 'file');
      } catch (err) {
        warnings.push(
          `无法链接规则文件 ${linkPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return;
  }

  // On Windows, copy files with a manifest so profile-edited rules are never overwritten.
  const manifestPath = path.join(geminiDir, RULE_COPIES_MANIFEST);
  let copies: Record<string, string> = {};
  if (fs.existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        copies = { ...(parsed as Record<string, string>) };
      }
    } catch {
      copies = {};
    }
  }

  for (const segments of USER_CONFIG_FILES) {
    const key = segments.join('/');
    const destPath = path.join(geminiDir, ...segments);
    const srcPath = path.join(userGemini, ...segments);
    try {
      const current = fs.existsSync(destPath) ? fs.readFileSync(destPath, 'utf8') : undefined;
      if (current !== undefined && current !== copies[key]) {
        // Profile-owned or user-edited file: preserve untouched.
        delete copies[key];
        continue;
      }
      const source = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, 'utf8') : undefined;
      if (source === undefined) {
        if (current !== undefined) fs.rmSync(destPath, { force: true });
        delete copies[key];
        continue;
      }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, source, 'utf8');
      copies[key] = source;
    } catch (err) {
      warnings.push(
        `无法同步规则文件 ${destPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    fs.writeFileSync(manifestPath, JSON.stringify(copies, null, 2), 'utf8');
  } catch (err) {
    warnings.push(`无法写入规则同步清单: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function prepareAgyProfile(
  profile: AgyProfileConfig,
  opts: {
    profilesRootDir: string;
    userHome?: string;
    platform?: NodeJS.Platform;
    applyWindowsAcl?: boolean;
  },
): PreparedAgyProfile {
  const platform = opts.platform ?? process.platform;
  const userHome = opts.userHome ?? os.homedir();
  const appDataDirName = profile.appDataDirName?.trim() || 'antigravity-cli';
  const warnings: string[] = [];

  if (profile.isolationMode === 'official_default') {
    const geminiDir = profile.geminiDir?.trim()
      ? path.resolve(profile.geminiDir.trim())
      : path.join(userHome, '.gemini');
    const appDataPath = path.join(geminiDir, appDataDirName);
    const dirs = resolveAgyProfileDirectories(opts.profilesRootDir, profile.instanceId);
    return {
      geminiDir,
      appDataDirName,
      appDataPath,
      runtimeTempDir: dirs.runtimeTempDir,
      aclApplied: false,
      warnings,
    };
  }

  const dirs = resolveAgyProfileDirectories(opts.profilesRootDir, profile.instanceId);
  const geminiDir = profile.geminiDir?.trim()
    ? path.resolve(profile.geminiDir.trim())
    : dirs.geminiDir;
  const appDataPath = path.join(geminiDir, appDataDirName);
  const runtimeTempDir = dirs.runtimeTempDir;

  const aclResults = [
    ensurePrivateProfileDirectory(geminiDir, { platform, applyWindowsAcl: opts.applyWindowsAcl }),
    ensurePrivateProfileDirectory(appDataPath, { platform, applyWindowsAcl: opts.applyWindowsAcl }),
    ensurePrivateProfileDirectory(runtimeTempDir, { platform, applyWindowsAcl: opts.applyWindowsAcl }),
  ];
  for (const res of aclResults) {
    if (res.warning) warnings.push(res.warning);
  }

  writeProfileSettings(appDataPath, profile);

  if (profile.defaults?.linkGlobalSkills !== false) {
    linkGlobalSkillsIntoProfile(geminiDir, userHome, platform, warnings);
  }
  if (profile.defaults?.syncGlobalRules !== false) {
    syncGlobalRulesIntoProfile(geminiDir, userHome, platform, warnings);
  }

  return {
    geminiDir,
    appDataDirName,
    appDataPath,
    runtimeTempDir,
    aclApplied: aclResults[0]!.aclApplied,
    warnings,
  };
}

export type AgyProfileSkillsRootKind =
  | 'profile_config_skills'
  | 'profile_skills'
  | 'profile_antigravity_skills'
  | 'global_gemini_config_skills'
  | 'global_gemini_skills'
  | 'global_agents_skills';

export interface AgyProfileSkillsRootStatus {
  readonly kind: AgyProfileSkillsRootKind;
  readonly precedenceRank: number;
  readonly path: string;
  readonly present: boolean;
  readonly isSymlink: boolean;
  readonly symlinkSafe: boolean;
  readonly reasonCode?: string;
}

export interface AgyProfileScopeInspection {
  readonly instanceId: string;
  readonly isolationMode: AgyProfileConfig['isolationMode'];
  readonly authMethod: AgyProfileConfig['authMethod'];
  readonly geminiDir: string;
  readonly appDataDirName: string;
  readonly appDataPath: string;
  readonly runtimeTempDir: string;
  readonly linkGlobalSkills: boolean;
  readonly syncGlobalRules: boolean;
  readonly enterpriseIssue1610Affected: boolean;
  readonly skillsRoots: readonly AgyProfileSkillsRootStatus[];
  readonly warnings: readonly string[];
}

function isCanonicalSubpath(candidate: string, root: string, platform: NodeJS.Platform): boolean {
  const normCandidate = platform === 'win32' ? candidate.toLowerCase() : candidate;
  const normRoot = platform === 'win32' ? root.toLowerCase() : root;
  if (normCandidate === normRoot) return true;
  const withSep = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`;
  return normCandidate.startsWith(withSep);
}

function inspectSkillsRootCandidate(opts: {
  kind: AgyProfileSkillsRootKind;
  precedenceRank: number;
  targetPath: string;
  allowedSymlinkRoots: readonly string[];
  platform: NodeJS.Platform;
  warnings: string[];
}): AgyProfileSkillsRootStatus {
  const { kind, precedenceRank, targetPath, allowedSymlinkRoots, platform, warnings } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(targetPath);
  } catch {
    return {
      kind,
      precedenceRank,
      path: targetPath,
      present: false,
      isSymlink: false,
      symlinkSafe: true,
      reasonCode: 'not_present',
    };
  }

  const isSymlink = stat.isSymbolicLink();
  if (!isSymlink && !stat.isDirectory()) {
    warnings.push(`Skills 路径不是目录：${targetPath}`);
    return {
      kind,
      precedenceRank,
      path: targetPath,
      present: false,
      isSymlink: false,
      symlinkSafe: false,
      reasonCode: 'not_directory',
    };
  }

  try {
    const resolved = fs.realpathSync(targetPath);
    const resolvedStat = fs.statSync(resolved);
    if (!resolvedStat.isDirectory()) {
      warnings.push(`Skills 链接目标不是目录：${targetPath}`);
      return {
        kind,
        precedenceRank,
        path: targetPath,
        present: false,
        isSymlink,
        symlinkSafe: false,
        reasonCode: 'target_not_directory',
      };
    }
    const allowed = allowedSymlinkRoots.some((root) => {
      try {
        const rootReal = fs.realpathSync(root);
        return isCanonicalSubpath(resolved, rootReal, platform);
      } catch {
        return false;
      }
    });
    if (isSymlink && !allowed) {
      warnings.push(`拒绝越界 Skills 符号链接/Junction：${targetPath}`);
      return {
        kind,
        precedenceRank,
        path: targetPath,
        present: true,
        isSymlink: true,
        symlinkSafe: false,
        reasonCode: 'symlink_escape_rejected',
      };
    }
    return {
      kind,
      precedenceRank,
      path: targetPath,
      present: true,
      isSymlink,
      symlinkSafe: true,
    };
  } catch {
    warnings.push(`Skills 路径无法解析：${targetPath}`);
    return {
      kind,
      precedenceRank,
      path: targetPath,
      present: false,
      isSymlink,
      symlinkSafe: false,
      reasonCode: 'unresolvable_link',
    };
  }
}

/**
 * Strictly non-mutating read-only inspection of an AGY profile's directory
 * boundaries, Windows/POSIX link safety, AGY 1.5.16 skills precedence roots,
 * and upstream `#1610` enterprise isolation constraint.
 */
export function inspectAgyProfileScopeBoundary(
  profile: AgyProfileConfig,
  opts: {
    profilesRootDir: string;
    userHome?: string;
    platform?: NodeJS.Platform;
  },
): AgyProfileScopeInspection {
  const platform = opts.platform ?? process.platform;
  const userHome = opts.userHome ?? os.homedir();
  const appDataDirName = profile.appDataDirName?.trim() || 'antigravity-cli';
  const dirs = resolveAgyProfileDirectories(opts.profilesRootDir, profile.instanceId);
  const geminiDir =
    profile.isolationMode === 'official_default'
      ? profile.geminiDir?.trim()
        ? path.resolve(profile.geminiDir.trim())
        : path.join(userHome, '.gemini')
      : profile.geminiDir?.trim()
        ? path.resolve(profile.geminiDir.trim())
        : dirs.geminiDir;
  const appDataPath = path.join(geminiDir, appDataDirName);
  const userGeminiDir = path.join(userHome, '.gemini');
  const userAgentsSkillsDir = path.join(userHome, '.agents', 'skills');

  const linkGlobalSkills = profile.defaults?.linkGlobalSkills !== false;
  const syncGlobalRules = profile.defaults?.syncGlobalRules !== false;
  const enterpriseIssue1610Affected =
    profile.authMethod === 'oauth-business' && profile.isolationMode === 'profile_isolated';

  const warnings: string[] = [];
  if (enterpriseIssue1610Affected) {
    warnings.push(
      '企业账号 oauth-business 受上游 CLI #1610 限制，不保证并发文件级隔离。',
    );
  }

  const allowedProfileSymlinkRoots = linkGlobalSkills ? [geminiDir, userGeminiDir] : [geminiDir];
  const skillsRoots: AgyProfileSkillsRootStatus[] = [
    inspectSkillsRootCandidate({
      kind: 'profile_config_skills',
      precedenceRank: 100,
      targetPath: path.join(geminiDir, 'config', 'skills'),
      allowedSymlinkRoots: allowedProfileSymlinkRoots,
      platform,
      warnings,
    }),
    inspectSkillsRootCandidate({
      kind: 'profile_skills',
      precedenceRank: 110,
      targetPath: path.join(geminiDir, 'skills'),
      allowedSymlinkRoots: allowedProfileSymlinkRoots,
      platform,
      warnings,
    }),
    inspectSkillsRootCandidate({
      kind: 'profile_antigravity_skills',
      precedenceRank: 120,
      targetPath: path.join(geminiDir, 'antigravity', 'skills'),
      allowedSymlinkRoots: allowedProfileSymlinkRoots,
      platform,
      warnings,
    }),
    inspectSkillsRootCandidate({
      kind: 'global_gemini_config_skills',
      precedenceRank: 130,
      targetPath: path.join(userGeminiDir, 'config', 'skills'),
      allowedSymlinkRoots: [userGeminiDir],
      platform,
      warnings,
    }),
    inspectSkillsRootCandidate({
      kind: 'global_gemini_skills',
      precedenceRank: 140,
      targetPath: path.join(userGeminiDir, 'skills'),
      allowedSymlinkRoots: [userGeminiDir],
      platform,
      warnings,
    }),
    inspectSkillsRootCandidate({
      kind: 'global_agents_skills',
      precedenceRank: 200,
      targetPath: userAgentsSkillsDir,
      allowedSymlinkRoots: [path.join(userHome, '.agents')],
      platform,
      warnings,
    }),
  ];

  return {
    instanceId: profile.instanceId,
    isolationMode: profile.isolationMode,
    authMethod: profile.authMethod,
    geminiDir,
    appDataDirName,
    appDataPath,
    runtimeTempDir: dirs.runtimeTempDir,
    linkGlobalSkills,
    syncGlobalRules,
    enterpriseIssue1610Affected,
    skillsRoots,
    warnings,
  };
}
