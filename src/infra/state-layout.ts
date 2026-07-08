/**
 * src/infra/state-layout.ts — cross-platform persistence layout authority.
 *
 * Replaces the ad-hoc `defaultStateHome()` / Replit-only logic with a fully
 * resolved AppStateLayout that handles POSIX (legacy + XDG), Windows (known
 * folders), and cloud IDEs (Replit / Codespaces / Gitpod / generic) in one
 * pure resolver. Also exports compatibility shims for existing callers.
 *
 * Design rules:
 *  - resolveStateLayout is pure and never throws.
 *  - Only defaultStateContext() reads process.env / cwd / platform / homedir.
 *  - XDG variables must be absolute; relative values are ignored.
 *  - Windows uses APPDATA/LOCALAPPDATA; NEVER HOME.
 *  - Cloud IDEs anchor everything to the persistent workspace.
 */

import { posix } from 'node:path';
import { homedir } from 'node:os';

// ── Types ──────────────────────────────────────────────────────────────────


export type StateLocationKind =
  | 'cloud-workspace'
  | 'windows-known-folder'
  | 'xdg'
  | 'legacy-posix';

export interface StateContext {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly cwd: string;
  readonly homeDir: string;
}

export interface ProjectStateDirs {
  readonly projectKey: string;
  readonly root: string;
  readonly ledgerFile: string;
  readonly sessionFile: string;
  readonly sessionsDir: string;
  readonly intentVersionsFile: string;
  readonly evalResultsFile: string;
  readonly commandAuditFile: string;
  readonly evidenceDir: string;
}

export interface AppStateLayout {
  readonly kind: StateLocationKind;
  readonly appName: 'myshell-tools';
  readonly configRoot: string;
  readonly stateRoot: string;
  readonly cacheRoot: string;
  readonly legacyRoot: string;
  readonly cloud: null | {
    readonly provider: 'replit' | 'codespaces' | 'gitpod' | 'generic';
    readonly workspaceRoot: string;
  };
  readonly paths: {
    readonly configFile: string;
    readonly credentialsFile: string;
    readonly conversationsDir: string;
    readonly durableContextDir: string;
    readonly conversationArchiveDir: string;
    readonly goalsDir: string;
    readonly memoryDir: string;
    readonly rulesDir: string;
    readonly subscriptionsFile: string;
    readonly providerHomesDir: string;
    readonly updateCacheFile: string;
    readonly migrationDir: string;
    readonly activeConversationFile: string;
    readonly relaunchRecoveryFile: string;
  };
}

// ── Platform-aware path helpers ────────────────────────────────────────────

function toPlatform(p: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return p.replace(/\//g, '\\');
  return p;
}

function toPosix(p: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return p.replace(/\\/g, '/');
  return p;
}

function isAbsolute(p: string, platform: NodeJS.Platform): boolean {
  const pp = toPosix(p, platform);
  if (platform === 'win32') return /^[A-Za-z]:\//.test(pp) || /^\/\//.test(pp);
  return pp.startsWith('/');
}

function deriveProjectKey(cwd: string, platform: NodeJS.Platform): string {
  let key = toPosix(cwd, platform).replace(/^[A-Za-z]:/, '');
  key = key.replace(/\//g, '--');
  key = key.replace(/^--+|--+$/g, '');
  return key || 'root';
}

// ── Cloud detection ────────────────────────────────────────────────────────

export function isReplit(env: NodeJS.ProcessEnv): boolean {
  return env['REPL_ID'] !== undefined || env['REPLIT_DEV_DOMAIN'] !== undefined;
}

export function isCloudIde(env: NodeJS.ProcessEnv): boolean {
  if (isReplit(env)) return true;
  if (env['CODESPACES'] === 'true' || env['CODESPACE_NAME'] !== undefined) return true;
  if (env['GITPOD_WORKSPACE_ID'] !== undefined || env['GITPOD_WORKSPACE_URL'] !== undefined)
    return true;
  if (env['MYSHELL_CLOUD_WORKSPACE'] !== undefined) return true;
  return false;
}

function findCodespacesWorkspace(cwd: string, platform: NodeJS.Platform): string {
  let dir = toPosix(cwd, platform);
  for (;;) {
    const parts = dir.split('/');
    if (
      parts.length === 3 &&
      parts[0] === '' &&
      parts[1] === 'workspaces' &&
      parts[2] !== ''
    ) {
      return dir;
    }
    const idx = dir.lastIndexOf('/');
    if (idx <= 0) break;
    dir = dir.slice(0, idx);
  }
  return toPosix(cwd, platform);
}

function resolveCloudInfo(
  env: NodeJS.ProcessEnv,
  cwd: string,
  platform: NodeJS.Platform,
): AppStateLayout['cloud'] {
  if (isReplit(env)) {
    return { provider: 'replit', workspaceRoot: toPosix(cwd, platform) };
  }

  if (env['CODESPACES'] === 'true' || env['CODESPACE_NAME'] !== undefined) {
    const gh = env['GITHUB_WORKSPACE'];
    const root =
      gh && isAbsolute(gh, platform)
        ? toPosix(gh, platform)
        : findCodespacesWorkspace(cwd, platform);
    return { provider: 'codespaces', workspaceRoot: root };
  }

  if (env['GITPOD_WORKSPACE_ID'] !== undefined || env['GITPOD_WORKSPACE_URL'] !== undefined) {
    const root = env['GITPOD_REPO_ROOT'];
    if (root && isAbsolute(root, platform)) {
      return { provider: 'gitpod', workspaceRoot: toPosix(root, platform) };
    }
    return { provider: 'gitpod', workspaceRoot: toPosix(cwd, platform) };
  }

  const ws = env['MYSHELL_CLOUD_WORKSPACE'];
  if (ws && isAbsolute(ws, platform)) {
    return { provider: 'generic', workspaceRoot: toPosix(ws, platform) };
  }

  return null;
}

// ── Path assembly ──────────────────────────────────────────────────────────

function buildPaths(
  configRoot: string,
  stateRoot: string,
  cacheRoot: string,
): AppStateLayout['paths'] {
  return {
    configFile: posix.join(configRoot, 'config.json'),
    credentialsFile: posix.join(stateRoot, 'credentials.json'),
    conversationsDir: posix.join(stateRoot, 'conversations'),
    durableContextDir: posix.join(stateRoot, 'durable-context'),
    conversationArchiveDir: posix.join(stateRoot, '.session-archive'),
    goalsDir: posix.join(stateRoot, 'goals'),
    memoryDir: posix.join(stateRoot, 'memory'),
    rulesDir: posix.join(stateRoot, 'rules'),
    subscriptionsFile: posix.join(stateRoot, 'subscriptions.json'),
    providerHomesDir: posix.join(stateRoot, 'provider-homes'),
    updateCacheFile: posix.join(cacheRoot, 'update-check.json'),
    migrationDir: posix.join(stateRoot, 'migration'),
    activeConversationFile: posix.join(stateRoot, 'active-conversation.json'),
    relaunchRecoveryFile: posix.join(stateRoot, 'relaunch-recovery.json'),
  };
}

function finalizePaths(
  raw: AppStateLayout['paths'],
  platform: NodeJS.Platform,
): AppStateLayout['paths'] {
  return {
    configFile: toPlatform(raw.configFile, platform),
    credentialsFile: toPlatform(raw.credentialsFile, platform),
    conversationsDir: toPlatform(raw.conversationsDir, platform),
    durableContextDir: toPlatform(raw.durableContextDir, platform),
    conversationArchiveDir: toPlatform(raw.conversationArchiveDir, platform),
    goalsDir: toPlatform(raw.goalsDir, platform),
    memoryDir: toPlatform(raw.memoryDir, platform),
    rulesDir: toPlatform(raw.rulesDir, platform),
    subscriptionsFile: toPlatform(raw.subscriptionsFile, platform),
    providerHomesDir: toPlatform(raw.providerHomesDir, platform),
    updateCacheFile: toPlatform(raw.updateCacheFile, platform),
    migrationDir: toPlatform(raw.migrationDir, platform),
    activeConversationFile: toPlatform(raw.activeConversationFile, platform),
    relaunchRecoveryFile: toPlatform(raw.relaunchRecoveryFile, platform),
  };
}

// ── Windows layout ─────────────────────────────────────────────────────────

function resolveWindowsLayout(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): AppStateLayout {
  const userProfile = env['USERPROFILE'];
  const homePosix = toPosix(homeDir, platform);

  // Config root: APPDATA > USERPROFILE\AppData\Roaming > homeDir\AppData\Roaming
  let configRoot: string;
  const appdata = env['APPDATA'];
  if (appdata && isAbsolute(appdata, platform)) {
    configRoot = posix.join(toPosix(appdata, platform), 'myshell-tools');
  } else if (userProfile) {
    configRoot = posix.join(
      toPosix(userProfile, platform),
      'AppData',
      'Roaming',
      'myshell-tools',
    );
  } else {
    configRoot = posix.join(homePosix, 'AppData', 'Roaming', 'myshell-tools');
  }

  // State root: LOCALAPPDATA > USERPROFILE\AppData\Local > homeDir\AppData\Local
  let stateRoot: string;
  const localAppData = env['LOCALAPPDATA'];
  if (localAppData && isAbsolute(localAppData, platform)) {
    stateRoot = posix.join(toPosix(localAppData, platform), 'myshell-tools');
  } else if (userProfile) {
    stateRoot = posix.join(
      toPosix(userProfile, platform),
      'AppData',
      'Local',
      'myshell-tools',
    );
  } else {
    stateRoot = posix.join(homePosix, 'AppData', 'Local', 'myshell-tools');
  }

  const legacyRoot = posix.join(homePosix, '.myshell-tools');

  return {
    kind: 'windows-known-folder',
    appName: 'myshell-tools',
    configRoot: toPlatform(configRoot, platform),
    stateRoot: toPlatform(stateRoot, platform),
    cacheRoot: toPlatform(stateRoot, platform),
    legacyRoot: toPlatform(legacyRoot, platform),
    cloud: null,
    paths: finalizePaths(buildPaths(configRoot, stateRoot, stateRoot), platform),
  };
}

// ── POSIX layout ───────────────────────────────────────────────────────────

function resolvePosixLayout(
  env: NodeJS.ProcessEnv,
  homeDir: string,
  platform: NodeJS.Platform,
): AppStateLayout {
  const homePosix = toPosix(homeDir, platform);
  const legacyRoot = posix.join(homePosix, '.myshell-tools');

  const xdgConfigHome = env['XDG_CONFIG_HOME'];
  const xdgStateHome = env['XDG_STATE_HOME'];
  const xdgCacheHome = env['XDG_CACHE_HOME'];

  let configRoot = legacyRoot;
  let stateRoot = legacyRoot;
  let cacheRoot = legacyRoot;
  let hasXdg = false;

  if (xdgConfigHome && isAbsolute(xdgConfigHome, platform)) {
    configRoot = posix.join(toPosix(xdgConfigHome, platform), 'myshell-tools');
    hasXdg = true;
  }
  if (xdgStateHome && isAbsolute(xdgStateHome, platform)) {
    stateRoot = posix.join(toPosix(xdgStateHome, platform), 'myshell-tools');
    hasXdg = true;
  }
  if (xdgCacheHome && isAbsolute(xdgCacheHome, platform)) {
    cacheRoot = posix.join(toPosix(xdgCacheHome, platform), 'myshell-tools');
    hasXdg = true;
  }

  return {
    kind: hasXdg ? 'xdg' : 'legacy-posix',
    appName: 'myshell-tools',
    configRoot: toPlatform(configRoot, platform),
    stateRoot: toPlatform(stateRoot, platform),
    cacheRoot: toPlatform(cacheRoot, platform),
    legacyRoot: toPlatform(legacyRoot, platform),
    cloud: null,
    paths: finalizePaths(buildPaths(configRoot, stateRoot, cacheRoot), platform),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve the full application state layout from an injected context.
 * Pure — never throws, never touches process.* or fs.
 */
export function resolveStateLayout(ctx: StateContext): AppStateLayout {
  const { env, platform, cwd, homeDir } = ctx;

  if (isCloudIde(env)) {
    const cloud = resolveCloudInfo(env, cwd, platform);
    if (cloud) {
      const root = posix.join(cloud.workspaceRoot, '.myshell-tools');
      return {
        kind: 'cloud-workspace',
        appName: 'myshell-tools',
        configRoot: toPlatform(root, platform),
        stateRoot: toPlatform(root, platform),
        cacheRoot: toPlatform(root, platform),
        legacyRoot: toPlatform(root, platform),
        cloud,
        paths: finalizePaths(buildPaths(root, root, root), platform),
      };
    }
    // Cloud detection was a false positive — fall through to platform defaults.
  }

  if (platform === 'win32') {
    return resolveWindowsLayout(env, homeDir, platform);
  }

  return resolvePosixLayout(env, homeDir, platform);
}

/**
 * Gather the ambient process context. This is the ONLY function in this module
 * allowed to read process.env / process.cwd() / process.platform / os.homedir().
 * Never throws.
 */
export function defaultStateContext(): StateContext {
  return {
    env: process.env,
    platform: process.platform,
    cwd: process.cwd(),
    homeDir: homedir(),
  };
}

/**
 * Convenience: resolve the state layout from the ambient process context.
 */
export function defaultStateLayout(): AppStateLayout {
  return resolveStateLayout(defaultStateContext());
}

/**
 * Derive per-project state directories from a layout and a working directory.
 * The project key is a sanitised version of the absolute cwd path.
 */
export function projectStateDirs(layout: AppStateLayout, cwd: string): ProjectStateDirs {
  const platform: NodeJS.Platform = layout.paths.configFile.includes('\\')
    ? 'win32'
    : 'linux';
  const projectKey = deriveProjectKey(cwd, platform);
  const statePosix = toPosix(layout.stateRoot, platform);
  const root = posix.join(statePosix, 'projects', projectKey);
  return {
    projectKey,
    root: toPlatform(root, platform),
    ledgerFile: toPlatform(posix.join(root, 'ledger.jsonl'), platform),
    sessionFile: toPlatform(posix.join(root, 'sessions', 'current.jsonl'), platform),
    sessionsDir: toPlatform(posix.join(root, 'sessions'), platform),
    intentVersionsFile: toPlatform(posix.join(root, 'intent-versions.jsonl'), platform),
    evalResultsFile: toPlatform(posix.join(root, 'eval-results.jsonl'), platform),
    commandAuditFile: toPlatform(posix.join(root, 'command-audit.jsonl'), platform),
    evidenceDir: toPlatform(posix.join(root, 'evidence'), platform),
  };
}

// ── Compatibility shims (byte-identical to src/infra/state-dir.ts) ─────────

/**
 * @deprecated Use resolveStateLayout(ctx).stateRoot instead.
 * Returns the parent directory under which .myshell-tools lives in the legacy
 * scheme: the workspace (cwd) on Replit, otherwise the home directory.
 */
export function resolveStateHome(
  env: NodeJS.ProcessEnv,
  cwd: string,
  home: string = homedir(),
): string {
  return isReplit(env) ? cwd : home;
}

/**
 * @deprecated Use defaultStateLayout().stateRoot instead.
 */
export function defaultStateHome(): string {
  try {
    return resolveStateHome(process.env, process.cwd(), homedir());
  } catch {
    return homedir();
  }
}
