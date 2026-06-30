/**
 * test/unit/state-layout.test.ts — full layout matrix for the cross-platform
 * persistence feature (Phase A).
 *
 * Every test injects a synthetic StateContext — never touches the real user
 * profile, filesystem, or process globals.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';

import {
  isReplit,
  isCloudIde,
  resolveStateLayout,
  defaultStateLayout,
  projectStateDirs,
  resolveStateHome,
  defaultStateHome,
} from '../../src/infra/state-layout.ts';
import type {
  StateContext,
  AppStateLayout,
} from '../../src/infra/state-layout.ts';

// ─── helpers ───────────────────────────────────────────────────────────────

function ctx(overrides: Partial<StateContext> = {}): StateContext {
  return {
    env: {},
    platform: 'linux',
    cwd: '/home/user/project',
    homeDir: '/home/user',
    ...overrides,
  };
}


/** Quick sanity check on layout shape. */
function assertLayoutShape(layout: AppStateLayout): void {
  assert.equal(layout.appName, 'myshell-tools');
  assert.ok(['cloud-workspace', 'windows-known-folder', 'xdg', 'legacy-posix'].includes(layout.kind));
  assert.equal(typeof layout.configRoot, 'string');
  assert.equal(typeof layout.stateRoot, 'string');
  assert.equal(typeof layout.cacheRoot, 'string');
  assert.equal(typeof layout.legacyRoot, 'string');

  const p = layout.paths;
  assert.equal(typeof p.configFile, 'string');
  assert.equal(typeof p.credentialsFile, 'string');
  assert.equal(typeof p.conversationsDir, 'string');
  assert.equal(typeof p.conversationArchiveDir, 'string');
  assert.equal(typeof p.goalsDir, 'string');
  assert.equal(typeof p.memoryDir, 'string');
  assert.equal(typeof p.rulesDir, 'string');
  assert.equal(typeof p.subscriptionsFile, 'string');
  assert.equal(typeof p.providerHomesDir, 'string');
  assert.equal(typeof p.updateCacheFile, 'string');
  assert.equal(typeof p.migrationDir, 'string');
}

// ─── isReplit / isCloudIde ─────────────────────────────────────────────────

describe('isReplit', () => {
  it('true when REPL_ID is set', () => {
    assert.equal(isReplit({ REPL_ID: 'abc' }), true);
  });
  it('true when REPLIT_DEV_DOMAIN is set', () => {
    assert.equal(isReplit({ REPLIT_DEV_DOMAIN: 'x.repl.co' }), true);
  });
  it('false in a plain environment', () => {
    assert.equal(isReplit({}), false);
    assert.equal(isReplit({ HOME: '/home/me' }), false);
  });
});

describe('isCloudIde', () => {
  it('true for Replit', () => {
    assert.equal(isCloudIde({ REPL_ID: 'abc' }), true);
  });
  it('true for Codespaces (CODESPACES=true)', () => {
    assert.equal(isCloudIde({ CODESPACES: 'true' }), true);
  });
  it('true for Codespaces (CODESPACE_NAME)', () => {
    assert.equal(isCloudIde({ CODESPACE_NAME: 'my-cs' }), true);
  });
  it('true for Gitpod (GITPOD_WORKSPACE_ID)', () => {
    assert.equal(isCloudIde({ GITPOD_WORKSPACE_ID: 'abc' }), true);
  });
  it('true for Gitpod (GITPOD_WORKSPACE_URL)', () => {
    assert.equal(isCloudIde({ GITPOD_WORKSPACE_URL: 'https://x.gitpod.io' }), true);
  });
  it('true for generic MYSHELL_CLOUD_WORKSPACE', () => {
    assert.equal(isCloudIde({ MYSHELL_CLOUD_WORKSPACE: '/data/ws' }), true);
  });
  it('false for empty env', () => {
    assert.equal(isCloudIde({}), false);
  });
  it('false for ordinary env', () => {
    assert.equal(isCloudIde({ HOME: '/home/me', PATH: '/usr/bin' }), false);
  });
});

// ─── Linux no XDG ──────────────────────────────────────────────────────────

describe('resolveStateLayout — Linux legacy (no XDG)', () => {
  const layout = resolveStateLayout(
    ctx({ platform: 'linux', homeDir: '/home/user', cwd: '/home/user/project' }),
  );

  it('kind is legacy-posix', () => {
    assert.equal(layout.kind, 'legacy-posix');
  });
  it('all roots point to ~/.myshell-tools', () => {
    assert.equal(layout.configRoot, '/home/user/.myshell-tools');
    assert.equal(layout.stateRoot, '/home/user/.myshell-tools');
    assert.equal(layout.cacheRoot, '/home/user/.myshell-tools');
    assert.equal(layout.legacyRoot, '/home/user/.myshell-tools');
  });
  it('cloud is null', () => {
    assert.equal(layout.cloud, null);
  });
  it('paths are rooted under legacy dir', () => {
    assert.equal(layout.paths.configFile, '/home/user/.myshell-tools/config.json');
    assert.equal(layout.paths.credentialsFile, '/home/user/.myshell-tools/credentials.json');
    assert.equal(layout.paths.conversationsDir, '/home/user/.myshell-tools/conversations');
    assert.equal(layout.paths.goalsDir, '/home/user/.myshell-tools/goals');
    assert.equal(layout.paths.updateCacheFile, '/home/user/.myshell-tools/update-check.json');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Linux absolute XDG (each category independently) ──────────────────────

describe('resolveStateLayout — Linux XDG (all set, absolute)', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/user',
      env: {
        XDG_CONFIG_HOME: '/etc/xdg',
        XDG_STATE_HOME: '/var/lib',
        XDG_CACHE_HOME: '/var/cache',
      },
    }),
  );

  it('kind is xdg', () => assert.equal(layout.kind, 'xdg'));
  it('configRoot uses XDG_CONFIG_HOME', () => {
    assert.equal(layout.configRoot, '/etc/xdg/myshell-tools');
  });
  it('stateRoot uses XDG_STATE_HOME', () => {
    assert.equal(layout.stateRoot, '/var/lib/myshell-tools');
  });
  it('cacheRoot uses XDG_CACHE_HOME', () => {
    assert.equal(layout.cacheRoot, '/var/cache/myshell-tools');
  });
  it('legacyRoot is still ~/.myshell-tools', () => {
    assert.equal(layout.legacyRoot, '/home/user/.myshell-tools');
  });
  it('configFile resides under XDG_CONFIG_HOME', () => {
    assert.equal(layout.paths.configFile, '/etc/xdg/myshell-tools/config.json');
  });
  it('credentialsFile resides under XDG_STATE_HOME', () => {
    assert.equal(layout.paths.credentialsFile, '/var/lib/myshell-tools/credentials.json');
  });
  it('updateCacheFile resides under XDG_CACHE_HOME', () => {
    assert.equal(layout.paths.updateCacheFile, '/var/cache/myshell-tools/update-check.json');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Linux XDG (config only)', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/user',
      env: { XDG_CONFIG_HOME: '/custom/config' },
    }),
  );

  it('kind is xdg', () => assert.equal(layout.kind, 'xdg'));
  it('only config root moves', () => {
    assert.equal(layout.configRoot, '/custom/config/myshell-tools');
    assert.equal(layout.stateRoot, '/home/user/.myshell-tools');
    assert.equal(layout.cacheRoot, '/home/user/.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Linux XDG (state only)', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/user',
      env: { XDG_STATE_HOME: '/custom/state' },
    }),
  );

  it('kind is xdg', () => assert.equal(layout.kind, 'xdg'));
  it('only state root moves', () => {
    assert.equal(layout.configRoot, '/home/user/.myshell-tools');
    assert.equal(layout.stateRoot, '/custom/state/myshell-tools');
    assert.equal(layout.cacheRoot, '/home/user/.myshell-tools');
  });
  it('credentials are under XDG state', () => {
    assert.equal(layout.paths.credentialsFile, '/custom/state/myshell-tools/credentials.json');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Linux XDG (cache only)', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/user',
      env: { XDG_CACHE_HOME: '/custom/cache' },
    }),
  );

  it('kind is xdg', () => assert.equal(layout.kind, 'xdg'));
  it('only cache root moves', () => {
    assert.equal(layout.configRoot, '/home/user/.myshell-tools');
    assert.equal(layout.stateRoot, '/home/user/.myshell-tools');
    assert.equal(layout.cacheRoot, '/custom/cache/myshell-tools');
  });
  it('update cache is under XDG cache', () => {
    assert.equal(layout.paths.updateCacheFile, '/custom/cache/myshell-tools/update-check.json');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Linux relative XDG ignored ────────────────────────────────────────────

describe('resolveStateLayout — Linux relative XDG ignored', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/user',
      env: {
        XDG_CONFIG_HOME: '.config',
        XDG_STATE_HOME: '.local/state',
        XDG_CACHE_HOME: '.cache',
      },
    }),
  );

  it('kind falls back to legacy-posix', () => {
    assert.equal(layout.kind, 'legacy-posix');
  });
  it('all roots are ~/.myshell-tools', () => {
    assert.equal(layout.configRoot, '/home/user/.myshell-tools');
    assert.equal(layout.stateRoot, '/home/user/.myshell-tools');
    assert.equal(layout.cacheRoot, '/home/user/.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Linux mixed absolute/relative XDG', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/user',
      env: {
        XDG_CONFIG_HOME: '/etc/absolute',
        XDG_CACHE_HOME: '.relative',
      },
    }),
  );

  it('kind is xdg (because at least one absolute)', () => {
    assert.equal(layout.kind, 'xdg');
  });
  it('config uses absolute value', () => {
    assert.equal(layout.configRoot, '/etc/absolute/myshell-tools');
  });
  it('cache falls back to legacy (relative ignored)', () => {
    assert.equal(layout.cacheRoot, '/home/user/.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── macOS same as POSIX ───────────────────────────────────────────────────

describe('resolveStateLayout — macOS (darwin)', () => {
  const layout = resolveStateLayout(
    ctx({ platform: 'darwin', homeDir: '/Users/alice' }),
  );

  it('kind is legacy-posix', () => {
    assert.equal(layout.kind, 'legacy-posix');
  });
  it('all roots are ~/.myshell-tools', () => {
    assert.equal(layout.configRoot, '/Users/alice/.myshell-tools');
    assert.equal(layout.stateRoot, '/Users/alice/.myshell-tools');
    assert.equal(layout.cacheRoot, '/Users/alice/.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — macOS with XDG', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'darwin',
      homeDir: '/Users/alice',
      env: { XDG_CONFIG_HOME: '/opt/config' },
    }),
  );

  it('kind is xdg', () => assert.equal(layout.kind, 'xdg'));
  it('config is under XDG', () => {
    assert.equal(layout.configRoot, '/opt/config/myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Windows APPDATA / LOCALAPPDATA ────────────────────────────────────────

describe('resolveStateLayout — Windows with APPDATA and LOCALAPPDATA', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'win32',
      homeDir: 'C:\\Users\\josh',
      cwd: 'C:\\Users\\josh\\project',
      env: {
        USERPROFILE: 'C:\\Users\\josh',
        APPDATA: 'C:\\Users\\josh\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\josh\\AppData\\Local',
      },
    }),
  );

  it('kind is windows-known-folder', () => {
    assert.equal(layout.kind, 'windows-known-folder');
  });
  it('configRoot uses APPDATA', () => {
    assert.equal(layout.configRoot, 'C:\\Users\\josh\\AppData\\Roaming\\myshell-tools');
  });
  it('stateRoot uses LOCALAPPDATA', () => {
    assert.equal(layout.stateRoot, 'C:\\Users\\josh\\AppData\\Local\\myshell-tools');
  });
  it('cacheRoot equals stateRoot', () => {
    assert.equal(layout.cacheRoot, layout.stateRoot);
  });
  it('legacyRoot is homeDir\\.myshell-tools', () => {
    assert.equal(layout.legacyRoot, 'C:\\Users\\josh\\.myshell-tools');
  });
  it('configFile is under APPDATA', () => {
    assert.equal(layout.paths.configFile, 'C:\\Users\\josh\\AppData\\Roaming\\myshell-tools\\config.json');
  });
  it('credentialsFile is under LOCALAPPDATA', () => {
    assert.equal(layout.paths.credentialsFile, 'C:\\Users\\josh\\AppData\\Local\\myshell-tools\\credentials.json');
  });
  it('updateCacheFile is under LOCALAPPDATA', () => {
    assert.equal(layout.paths.updateCacheFile, 'C:\\Users\\josh\\AppData\\Local\\myshell-tools\\update-check.json');
  });
  it('cloud is null', () => assert.equal(layout.cloud, null));
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Windows only-USERPROFILE fallback ─────────────────────────────────────

describe('resolveStateLayout — Windows with only USERPROFILE', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'win32',
      homeDir: 'C:\\Users\\josh',
      env: { USERPROFILE: 'C:\\Users\\josh' },
    }),
  );

  it('kind is windows-known-folder', () => {
    assert.equal(layout.kind, 'windows-known-folder');
  });
  it('configRoot falls back to USERPROFILE\\AppData\\Roaming', () => {
    assert.equal(layout.configRoot, 'C:\\Users\\josh\\AppData\\Roaming\\myshell-tools');
  });
  it('stateRoot falls back to USERPROFILE\\AppData\\Local', () => {
    assert.equal(layout.stateRoot, 'C:\\Users\\josh\\AppData\\Local\\myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Windows with only homeDir (no USERPROFILE)', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'win32',
      homeDir: 'C:\\Users\\josh',
      env: {},
    }),
  );

  it('configRoot falls back to homeDir\\AppData\\Roaming', () => {
    assert.equal(layout.configRoot, 'C:\\Users\\josh\\AppData\\Roaming\\myshell-tools');
  });
  it('stateRoot falls back to homeDir\\AppData\\Local', () => {
    assert.equal(layout.stateRoot, 'C:\\Users\\josh\\AppData\\Local\\myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Windows HOME set differently (MUST BE IGNORED) ────────────────────────

describe('resolveStateLayout — Windows with HOME set differently', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'win32',
      homeDir: 'C:\\Users\\josh',
      env: {
        USERPROFILE: 'C:\\Users\\josh',
        HOME: 'D:\\different-home',
        APPDATA: 'C:\\Users\\josh\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\josh\\AppData\\Local',
      },
    }),
  );

  it('HOME is ignored — uses USERPROFILE-based paths', () => {
    assert.equal(layout.configRoot, 'C:\\Users\\josh\\AppData\\Roaming\\myshell-tools');
    assert.equal(layout.stateRoot, 'C:\\Users\\josh\\AppData\\Local\\myshell-tools');
  });
  it('legacyRoot uses homeDir, not HOME', () => {
    assert.equal(layout.legacyRoot, 'C:\\Users\\josh\\.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Windows HOME only, no USERPROFILE', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'win32',
      homeDir: 'C:\\Users\\josh',
      env: {
        HOME: 'D:\\different-home',
        APPDATA: 'C:\\Users\\josh\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\josh\\AppData\\Local',
      },
    }),
  );

  it('HOME is ignored — homeDir fallback is not HOME', () => {
    assert.equal(layout.legacyRoot, 'C:\\Users\\josh\\.myshell-tools');
  });
  // APPDATA is used directly, not derived from HOME
  it('configRoot uses APPDATA directly', () => {
    assert.equal(layout.configRoot, 'C:\\Users\\josh\\AppData\\Roaming\\myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Replit ────────────────────────────────────────────────────────────────

describe('resolveStateLayout — Replit', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/runner',
      cwd: '/home/runner/workspace',
      env: { REPL_ID: 'abc123' },
    }),
  );

  it('kind is cloud-workspace', () => {
    assert.equal(layout.kind, 'cloud-workspace');
  });
  it('cloud provider is replit', () => {
    assert.equal(layout.cloud?.provider, 'replit');
  });
  it('workspace root is cwd', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/home/runner/workspace');
  });
  it('all roots are <workspace>/.myshell-tools', () => {
    assert.equal(layout.configRoot, '/home/runner/workspace/.myshell-tools');
    assert.equal(layout.stateRoot, '/home/runner/workspace/.myshell-tools');
    assert.equal(layout.cacheRoot, '/home/runner/workspace/.myshell-tools');
    assert.equal(layout.legacyRoot, '/home/runner/workspace/.myshell-tools');
  });
  it('paths are under workspace', () => {
    assert.equal(layout.paths.configFile, '/home/runner/workspace/.myshell-tools/config.json');
    assert.equal(layout.paths.credentialsFile, '/home/runner/workspace/.myshell-tools/credentials.json');
    assert.equal(layout.paths.conversationsDir, '/home/runner/workspace/.myshell-tools/conversations');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Replit with REPLIT_DEV_DOMAIN', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/runner',
      cwd: '/home/runner/workspace',
      env: { REPLIT_DEV_DOMAIN: 'x.repl.co' },
    }),
  );

  it('kind is cloud-workspace', () => assert.equal(layout.kind, 'cloud-workspace'));
  it('cloud provider is replit', () => assert.equal(layout.cloud?.provider, 'replit'));
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Codespaces with GITHUB_WORKSPACE ──────────────────────────────────────

describe('resolveStateLayout — Codespaces with GITHUB_WORKSPACE', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/codespace',
      cwd: '/workspaces/myrepo',
      env: {
        CODESPACES: 'true',
        GITHUB_WORKSPACE: '/workspaces/myrepo',
      },
    }),
  );

  it('kind is cloud-workspace', () => assert.equal(layout.kind, 'cloud-workspace'));
  it('cloud provider is codespaces', () => {
    assert.equal(layout.cloud?.provider, 'codespaces');
  });
  it('workspace root is GITHUB_WORKSPACE', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/workspaces/myrepo');
  });
  it('all roots anchored to GITHUB_WORKSPACE', () => {
    assert.equal(layout.configRoot, '/workspaces/myrepo/.myshell-tools');
    assert.equal(layout.stateRoot, '/workspaces/myrepo/.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Codespaces with CODESPACE_NAME', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/codespace',
      cwd: '/workspaces/myrepo',
      env: {
        CODESPACE_NAME: 'my-cs',
        GITHUB_WORKSPACE: '/workspaces/myrepo',
      },
    }),
  );

  it('kind is cloud-workspace', () => assert.equal(layout.kind, 'cloud-workspace'));
  it('cloud provider is codespaces', () => assert.equal(layout.cloud?.provider, 'codespaces'));
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Codespaces /workspaces/<repo> fallback ────────────────────────────────

describe('resolveStateLayout — Codespaces /workspaces/<repo> fallback', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/codespace',
      cwd: '/workspaces/myrepo/subdir/deep',
      env: { CODESPACES: 'true' },
    }),
  );

  it('walked up from cwd to /workspaces/myrepo', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/workspaces/myrepo');
  });
  it('provider is codespaces', () => {
    assert.equal(layout.cloud?.provider, 'codespaces');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Codespaces cwd outside /workspaces falls back to cwd', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/codespace',
      cwd: '/home/codespace/stuff',
      env: { CODESPACES: 'true' },
    }),
  );

  it('no /workspaces ancestor found — falls back to cwd', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/home/codespace/stuff');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Codespaces with GITHUB_WORKSPACE relative (ignored)', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/codespace',
      cwd: '/workspaces/myrepo/sub',
      env: {
        CODESPACES: 'true',
        GITHUB_WORKSPACE: './workspaces/myrepo',
      },
    }),
  );

  it('relative GITHUB_WORKSPACE ignored — falls back to /workspaces ancestor', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/workspaces/myrepo');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Gitpod ────────────────────────────────────────────────────────────────

describe('resolveStateLayout — Gitpod with GITPOD_REPO_ROOT', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/gitpod',
      cwd: '/workspace/project',
      env: {
        GITPOD_WORKSPACE_ID: 'ws-123',
        GITPOD_REPO_ROOT: '/workspace/project',
      },
    }),
  );

  it('kind is cloud-workspace', () => assert.equal(layout.kind, 'cloud-workspace'));
  it('cloud provider is gitpod', () => {
    assert.equal(layout.cloud?.provider, 'gitpod');
  });
  it('workspace root is GITPOD_REPO_ROOT', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/workspace/project');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Gitpod with GITPOD_WORKSPACE_URL', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/gitpod',
      cwd: '/workspace/project',
      env: {
        GITPOD_WORKSPACE_URL: 'https://x.gitpod.io',
        GITPOD_REPO_ROOT: '/workspace/project',
      },
    }),
  );

  it('provider is gitpod', () => assert.equal(layout.cloud?.provider, 'gitpod'));
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Gitpod without GITPOD_REPO_ROOT falls back to cwd', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/gitpod',
      cwd: '/workspace/project',
      env: { GITPOD_WORKSPACE_ID: 'ws-123' },
    }),
  );

  it('falls back to cwd', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/workspace/project');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — Gitpod with relative GITPOD_REPO_ROOT ignored', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/gitpod',
      cwd: '/workspace/project',
      env: {
        GITPOD_WORKSPACE_ID: 'ws-123',
        GITPOD_REPO_ROOT: '../elsewhere',
      },
    }),
  );

  it('relative GITPOD_REPO_ROOT ignored — falls back to cwd', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/workspace/project');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Generic MYSHELL_CLOUD_WORKSPACE ───────────────────────────────────────

describe('resolveStateLayout — generic MYSHELL_CLOUD_WORKSPACE', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/root',
      cwd: '/app',
      env: { MYSHELL_CLOUD_WORKSPACE: '/data/workspace' },
    }),
  );

  it('kind is cloud-workspace', () => assert.equal(layout.kind, 'cloud-workspace'));
  it('cloud provider is generic', () => {
    assert.equal(layout.cloud?.provider, 'generic');
  });
  it('workspace root is MYSHELL_CLOUD_WORKSPACE', () => {
    assert.equal(layout.cloud?.workspaceRoot, '/data/workspace');
  });
  it('all roots anchored to MYSHELL_CLOUD_WORKSPACE', () => {
    assert.equal(layout.configRoot, '/data/workspace/.myshell-tools');
    assert.equal(layout.stateRoot, '/data/workspace/.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

describe('resolveStateLayout — MYSHELL_CLOUD_WORKSPACE relative ignored', () => {
  const layout = resolveStateLayout(
    ctx({
      platform: 'linux',
      homeDir: '/home/user',
      cwd: '/home/user/project',
      env: { MYSHELL_CLOUD_WORKSPACE: './data' },
    }),
  );

  it('relative is ignored — falls through to legacy-posix', () => {
    assert.equal(layout.kind, 'legacy-posix');
    assert.equal(layout.cloud, null);
    assert.equal(layout.configRoot, '/home/user/.myshell-tools');
  });
  it('shape is valid', () => assertLayoutShape(layout));
});

// ─── Never throws ──────────────────────────────────────────────────────────

describe('resolveStateLayout — never throws', () => {
  it('empty context', () => {
    const layout = resolveStateLayout({ env: {}, platform: 'linux', cwd: '', homeDir: '' });
    assert.equal(layout.kind, 'legacy-posix');
    assertLayoutShape(layout);
  });

  it('empty context on Windows', () => {
    const layout = resolveStateLayout({ env: {}, platform: 'win32', cwd: '', homeDir: '' });
    assert.equal(layout.kind, 'windows-known-folder');
    // homeDir empty, no USERPROFILE → falls back to homeDir\AppData\...
    assert.ok(layout.configRoot.includes('AppData'));
  });

  it('undefined env vars do not throw', () => {
    const layout = resolveStateLayout(
      ctx({ platform: 'linux', env: { XDG_CONFIG_HOME: undefined } }),
    );
    assert.equal(layout.kind, 'legacy-posix');
  });

  it('empty-string XDG var (treated as set but relative, ignored)', () => {
    const layout = resolveStateLayout(
      ctx({ platform: 'linux', env: { XDG_CONFIG_HOME: '' } }),
    );
    // empty string is falsy, so skipped as if not set
    assert.equal(layout.kind, 'legacy-posix');
  });
});

// ─── projectStateDirs ──────────────────────────────────────────────────────

describe('projectStateDirs', () => {
  const layout = resolveStateLayout(
    ctx({ platform: 'linux', homeDir: '/home/user' }),
  );

  it('derives project key from cwd', () => {
    const dirs = projectStateDirs(layout, '/home/user/my-project');
    assert.ok(dirs.projectKey.length > 0);
    assert.ok(!dirs.projectKey.includes('/'));
    assert.ok(!dirs.projectKey.includes('\\'));
  });

  it('roots under stateRoot/projects/<key>', () => {
    const dirs = projectStateDirs(layout, '/home/user/my-project');
    assert.ok(dirs.root.startsWith('/home/user/.myshell-tools/projects/'));
  });

  it('provides all expected file and dir paths', () => {
    const dirs = projectStateDirs(layout, '/home/user/my-project');
    assert.equal(typeof dirs.ledgerFile, 'string');
    assert.equal(typeof dirs.sessionFile, 'string');
    assert.equal(typeof dirs.sessionsDir, 'string');
    assert.equal(typeof dirs.intentVersionsFile, 'string');
    assert.equal(typeof dirs.evalResultsFile, 'string');
    assert.equal(typeof dirs.commandAuditFile, 'string');
    assert.equal(typeof dirs.evidenceDir, 'string');

    assert.ok(dirs.ledgerFile.endsWith('ledger.jsonl'));
    assert.ok(dirs.sessionFile.endsWith('current.jsonl'));
    assert.ok(dirs.sessionsDir.endsWith('sessions'));
    assert.ok(dirs.intentVersionsFile.endsWith('intent-versions.jsonl'));
    assert.ok(dirs.evalResultsFile.endsWith('eval-results.jsonl'));
    assert.ok(dirs.commandAuditFile.endsWith('command-audit.jsonl'));
    assert.ok(dirs.evidenceDir.endsWith('evidence'));
  });

  it('same cwd produces same project key (deterministic)', () => {
    const a = projectStateDirs(layout, '/home/user/project');
    const b = projectStateDirs(layout, '/home/user/project');
    assert.equal(a.projectKey, b.projectKey);
    assert.equal(a.root, b.root);
  });

  it('different cwd produces different project key', () => {
    const a = projectStateDirs(layout, '/home/user/project-a');
    const b = projectStateDirs(layout, '/home/user/project-b');
    assert.notEqual(a.projectKey, b.projectKey);
  });
});

// ─── Compatibility shims ───────────────────────────────────────────────────

describe('resolveStateHome (compatibility shim)', () => {
  it('returns cwd on Replit', () => {
    assert.equal(
      resolveStateHome({ REPL_ID: 'abc' }, '/home/runner/workspace', '/home/runner'),
      '/home/runner/workspace',
    );
  });

  it('returns home off Replit', () => {
    assert.equal(
      resolveStateHome({}, '/some/project', '/home/me'),
      '/home/me',
    );
  });

  it('returns cwd on Replit with REPLIT_DEV_DOMAIN', () => {
    assert.equal(
      resolveStateHome({ REPLIT_DEV_DOMAIN: 'x.repl.co' }, '/ws', '/home'),
      '/ws',
    );
  });
});

describe('defaultStateHome (compatibility shim)', () => {
  it('returns a string', () => {
    assert.equal(typeof defaultStateHome(), 'string');
    assert.ok(defaultStateHome().length > 0);
  });

  it('resolves to cwd when REPL_ID is set', () => {
    const prev = process.env['REPL_ID'];
    try {
      process.env['REPL_ID'] = 'test-repl';
      assert.equal(defaultStateHome(), process.cwd());
    } finally {
      if (prev === undefined) delete process.env['REPL_ID'];
      else process.env['REPL_ID'] = prev;
    }
  });

  it('resolves to home dir when no Replit env is present', () => {
    const prevId = process.env['REPL_ID'];
    const prevDomain = process.env['REPLIT_DEV_DOMAIN'];
    try {
      delete process.env['REPL_ID'];
      delete process.env['REPLIT_DEV_DOMAIN'];
      assert.equal(defaultStateHome(), homedir());
    } finally {
      if (prevId !== undefined) process.env['REPL_ID'] = prevId;
      if (prevDomain !== undefined) process.env['REPLIT_DEV_DOMAIN'] = prevDomain;
    }
  });
});

// ─── defaultStateLayout (uses ambient context) ─────────────────────────────

describe('defaultStateLayout (ambient)', () => {
  it('produces a valid layout without throwing', () => {
    const layout = defaultStateLayout();
    assertLayoutShape(layout);
    assert.equal(typeof layout.kind, 'string');
  });
});
