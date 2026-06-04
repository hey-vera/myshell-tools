/**
 * test/unit/credentials.test.ts — unit tests for src/infra/credentials.ts
 *
 * All tests are hermetic: they use temporary directories and never spawn real
 * subprocesses. The `extractClaudeToken` helper is pure (no I/O) and is tested
 * extensively for correctness and never-throw guarantees.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  loadCredentials,
  loadClaudeToken,
  claudeEnv,
  saveClaudeToken,
  clearClaudeToken,
  applyStoredCredentials,
  extractClaudeToken,
  stripPastedSecretWrapper,
  sanitizePastedToken,
  classifyPastedSecret,
  claudeTokenStatus,
  loadClaudeTokenCapturedAt,
  replitPersistentEnv,
  loginPersistentEnv,
} from '../../src/infra/credentials.ts';

// ---------------------------------------------------------------------------
// replitPersistentEnv — point claude/codex at the Replit-persistent login
// ---------------------------------------------------------------------------

describe('replitPersistentEnv', () => {
  let dir = '';

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), `myshell-replit-${randomUUID()}-`));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('returns {} when no .replit-tools persistent dirs exist', () => {
    const add = replitPersistentEnv({}, dir);
    assert.deepEqual(add, {});
  });

  it('sets CLAUDE_CONFIG_DIR when the persistent dir holds .credentials.json', async () => {
    const claudeDir = join(dir, '.replit-tools', '.claude-persistent');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(join(claudeDir, '.credentials.json'), '{}', 'utf8');
    const add = replitPersistentEnv({}, dir);
    assert.equal(add['CLAUDE_CONFIG_DIR'], claudeDir);
  });

  it('sets CODEX_HOME when the persistent dir holds auth.json', async () => {
    const codexDir = join(dir, '.replit-tools', '.codex-persistent');
    await mkdir(codexDir, { recursive: true });
    await writeFile(join(codexDir, 'auth.json'), '{}', 'utf8');
    const add = replitPersistentEnv({}, dir);
    assert.equal(add['CODEX_HOME'], codexDir);
  });

  it('sets XDG_CONFIG_HOME / XDG_DATA_HOME when opencode config dirs exist', async () => {
    await mkdir(join(dir, '.config', 'opencode'), { recursive: true });
    await mkdir(join(dir, '.local', 'share', 'opencode'), { recursive: true });
    const add = replitPersistentEnv({}, dir);
    assert.equal(add['XDG_CONFIG_HOME'], join(dir, '.config'));
    assert.equal(add['XDG_DATA_HOME'], join(dir, '.local', 'share'));
  });

  it('never overrides an already-set CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_*', () => {
    const add = replitPersistentEnv(
      {
        CLAUDE_CONFIG_DIR: '/already/set',
        CODEX_HOME: '/also/set',
        XDG_CONFIG_HOME: '/xdg/cfg',
        XDG_DATA_HOME: '/xdg/data',
      },
      dir,
    );
    assert.equal(add['CLAUDE_CONFIG_DIR'], undefined);
    assert.equal(add['CODEX_HOME'], undefined);
    assert.equal(add['XDG_CONFIG_HOME'], undefined);
    assert.equal(add['XDG_DATA_HOME'], undefined);
  });

  it('does NOT set XDG dirs when .config exists but has no opencode subdir', async () => {
    const bareDir = await mkdtemp(join(tmpdir(), `myshell-bare-${randomUUID()}-`));
    await mkdir(join(bareDir, '.config'), { recursive: true });
    const add = replitPersistentEnv({}, bareDir);
    assert.equal(add['XDG_CONFIG_HOME'], undefined);
    await rm(bareDir, { recursive: true, force: true });
  });

  it('does NOT redirect to an empty persistent dir (no creds → no-op, never breaks ephemeral login)', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), `myshell-empty-${randomUUID()}-`));
    await mkdir(join(emptyDir, '.replit-tools', '.claude-persistent'), { recursive: true });
    const add = replitPersistentEnv({}, emptyDir);
    assert.equal(add['CLAUDE_CONFIG_DIR'], undefined);
    await rm(emptyDir, { recursive: true, force: true });
  });

  it('never throws on a nonexistent cwd', () => {
    assert.doesNotThrow(() => replitPersistentEnv({}, '/no/such/path/at/all'));
  });
});

// ---------------------------------------------------------------------------
// loginPersistentEnv — prepare Replit-persistent dirs before first login
// ---------------------------------------------------------------------------

describe('loginPersistentEnv', () => {
  it('on Replit returns Claude/Codex/opencode env vars and creates their dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), `myshell-login-replit-${randomUUID()}-`));
    try {
      const add = loginPersistentEnv({ REPL_ID: 'abc123' }, dir, ['claude', 'codex', 'opencode']);

      const claudeDir = join(dir, '.replit-tools', '.claude-persistent');
      const codexDir = join(dir, '.replit-tools', '.codex-persistent');
      const opencodeCfg = join(dir, '.config');
      const opencodeData = join(dir, '.local', 'share');

      assert.equal(add['CLAUDE_CONFIG_DIR'], claudeDir);
      assert.equal(add['CODEX_HOME'], codexDir);
      assert.equal(add['XDG_CONFIG_HOME'], opencodeCfg);
      assert.equal(add['XDG_DATA_HOME'], opencodeData);
      assert.equal(existsSync(claudeDir), true);
      assert.equal(existsSync(codexDir), true);
      assert.equal(existsSync(opencodeCfg), true);
      assert.equal(existsSync(opencodeData), true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('creates only the targeted provider dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), `myshell-login-minimal-${randomUUID()}-`));
    try {
      const add = loginPersistentEnv({ REPL_ID: 'abc123' }, dir, ['claude']);

      assert.equal(add['CLAUDE_CONFIG_DIR'], join(dir, '.replit-tools', '.claude-persistent'));
      assert.equal(add['CODEX_HOME'], undefined);
      assert.equal(add['XDG_CONFIG_HOME'], undefined);
      assert.equal(add['XDG_DATA_HOME'], undefined);
      assert.equal(existsSync(join(dir, '.replit-tools', '.claude-persistent')), true);
      assert.equal(existsSync(join(dir, '.replit-tools', '.codex-persistent')), false);
      assert.equal(existsSync(join(dir, '.config')), false);
      assert.equal(existsSync(join(dir, '.local', 'share')), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('off Replit returns no overrides and creates no persistent dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), `myshell-login-local-${randomUUID()}-`));
    try {
      const add = loginPersistentEnv({}, dir, ['claude', 'codex', 'opencode']);

      assert.deepEqual(add, {});
      assert.equal(existsSync(join(dir, '.replit-tools')), false);
      assert.equal(existsSync(join(dir, '.config')), false);
      assert.equal(existsSync(join(dir, '.local', 'share')), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('preserves already-set env vars and does not create default dirs for them', async () => {
    const dir = await mkdtemp(join(tmpdir(), `myshell-login-preserve-${randomUUID()}-`));
    try {
      const add = loginPersistentEnv(
        {
          REPLIT_DEV_DOMAIN: 'example.replit.dev',
          CLAUDE_CONFIG_DIR: '/custom/claude',
          CODEX_HOME: '/custom/codex',
          XDG_CONFIG_HOME: '/custom/config',
          XDG_DATA_HOME: '/custom/data',
        },
        dir,
        ['claude', 'codex', 'opencode'],
      );

      assert.deepEqual(add, {});
      assert.equal(existsSync(join(dir, '.replit-tools')), false);
      assert.equal(existsSync(join(dir, '.config')), false);
      assert.equal(existsSync(join(dir, '.local', 'share')), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// claudeEnv — pure helper (no I/O)
// ---------------------------------------------------------------------------

describe('claudeEnv — returns baseEnv unchanged when token is null', () => {
  it('returns the exact same object reference when token is null', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const result = claudeEnv(base, null);
    assert.strictEqual(result, base);
  });

  it('does not add CLAUDE_CODE_OAUTH_TOKEN when token is null', () => {
    const base: NodeJS.ProcessEnv = {};
    const result = claudeEnv(base, null);
    assert.equal(result['CLAUDE_CODE_OAUTH_TOKEN'], undefined);
  });
});

describe('claudeEnv — returns baseEnv unchanged when token already set in env', () => {
  it('returns the exact same object reference when CLAUDE_CODE_OAUTH_TOKEN is set', () => {
    const base: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'existing-value' };
    const result = claudeEnv(base, 'new-token');
    assert.strictEqual(result, base);
  });

  it('does NOT overwrite the user-exported env value', () => {
    const base: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'user-value' };
    const result = claudeEnv(base, 'stored-token');
    assert.equal(result['CLAUDE_CODE_OAUTH_TOKEN'], 'user-value');
  });
});

describe('claudeEnv — injects token when token is non-null and env has no existing value', () => {
  it('returns a new object (not the same reference)', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const result = claudeEnv(base, 'sk-ant-oat01-test-TOKEN');
    assert.notStrictEqual(result, base);
  });

  it('injects CLAUDE_CODE_OAUTH_TOKEN into the returned env', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const result = claudeEnv(base, 'sk-ant-oat01-test-TOKEN');
    assert.equal(result['CLAUDE_CODE_OAUTH_TOKEN'], 'sk-ant-oat01-test-TOKEN');
  });

  it('preserves all other keys from baseEnv', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', HOME: '/home/user', FOO: 'bar' };
    const result = claudeEnv(base, 'sk-ant-oat01-test-TOKEN');
    assert.equal(result['PATH'], '/usr/bin');
    assert.equal(result['HOME'], '/home/user');
    assert.equal(result['FOO'], 'bar');
  });

  it('does not mutate the original baseEnv', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    claudeEnv(base, 'sk-ant-oat01-test-TOKEN');
    assert.equal(base['CLAUDE_CODE_OAUTH_TOKEN'], undefined);
  });

  it('works with an empty baseEnv', () => {
    const result = claudeEnv({}, 'sk-ant-oat01-empty-base-TOKEN');
    assert.equal(result['CLAUDE_CODE_OAUTH_TOKEN'], 'sk-ant-oat01-empty-base-TOKEN');
  });
});

describe('claudeEnv — pure (never throws)', () => {
  it('does not throw when token is null', () => {
    assert.doesNotThrow(() => claudeEnv({}, null));
  });

  it('does not throw when token is non-null and env is empty', () => {
    assert.doesNotThrow(() => claudeEnv({}, 'sk-ant-oat01-test-TOKEN'));
  });

  it('does not throw when CLAUDE_CODE_OAUTH_TOKEN is already set', () => {
    assert.doesNotThrow(() =>
      claudeEnv({ CLAUDE_CODE_OAUTH_TOKEN: 'existing' }, 'sk-ant-oat01-new-TOKEN'),
    );
  });
});

// ---------------------------------------------------------------------------
// loadClaudeToken — async wrapper around loadCredentials
// ---------------------------------------------------------------------------

describe('loadClaudeToken — returns null when no token is stored', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-lct-missing-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns null when credentials file does not exist', async () => {
    const token = await loadClaudeToken(homeDir);
    assert.equal(token, null);
  });

  it('does not throw when credentials file is missing', async () => {
    await assert.doesNotReject(() => loadClaudeToken(homeDir));
  });
});

describe('loadClaudeToken — returns stored token', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-lct-saved-${randomUUID()}-`));
    await saveClaudeToken('sk-ant-oat01-load-TOKEN', homeDir);
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns the stored token string', async () => {
    const token = await loadClaudeToken(homeDir);
    assert.equal(token, 'sk-ant-oat01-load-TOKEN');
  });
});

describe('loadClaudeToken — returns null after clearClaudeToken', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-lct-clear-${randomUUID()}-`));
    await saveClaudeToken('sk-ant-oat01-to-clear-TOKEN', homeDir);
    await clearClaudeToken(homeDir);
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns null after token is cleared', async () => {
    const token = await loadClaudeToken(homeDir);
    assert.equal(token, null);
  });
});

// ---------------------------------------------------------------------------
// extractClaudeToken — pure helper (no I/O)
// ---------------------------------------------------------------------------

describe('extractClaudeToken — pure token extraction', () => {
  it('extracts a valid token from a plain string', () => {
    const token = extractClaudeToken('sk-ant-oat01-abcdef-XYZ123_abc-def');
    assert.equal(token, 'sk-ant-oat01-abcdef-XYZ123_abc-def');
  });

  it('extracts a token embedded in multi-line setup-token output', () => {
    const output = [
      'Authenticating with claude.ai...',
      'Your token is:',
      '  sk-ant-oat01-LONG_TOKEN_VALUE_HERE-MORE-CHARS',
      'Copy and keep it safe.',
    ].join('\n');
    const token = extractClaudeToken(output);
    assert.equal(token, 'sk-ant-oat01-LONG_TOKEN_VALUE_HERE-MORE-CHARS');
  });

  it('extracts a token with surrounding whitespace', () => {
    const token = extractClaudeToken('   sk-ant-oat02-abc-XYZ   \n');
    assert.equal(token, 'sk-ant-oat02-abc-XYZ');
  });

  it('returns the FIRST token when multiple appear', () => {
    const text = 'sk-ant-oat01-first-AAA some text sk-ant-oat01-second-BBB';
    const token = extractClaudeToken(text);
    assert.equal(token, 'sk-ant-oat01-first-AAA');
  });

  it('returns null when no token is present', () => {
    assert.equal(extractClaudeToken('no token here'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(extractClaudeToken(''), null);
  });

  it('returns null for blank/whitespace-only input', () => {
    assert.equal(extractClaudeToken('   \n\t  '), null);
  });

  it('does NOT match an API key (sk-ant-api…)', () => {
    // API keys start with sk-ant-api, not sk-ant-oat — must not be captured
    assert.equal(extractClaudeToken('sk-ant-api01-SomeKey-abc123'), null);
  });

  it('does NOT match a partial prefix without the dash-segment', () => {
    // Must have the dash followed by at least one Base64url char
    assert.equal(extractClaudeToken('sk-ant-oat01'), null);
  });

  it('matches token format with version 01', () => {
    const token = extractClaudeToken('sk-ant-oat01-sessionpart-TOKENPART');
    assert.equal(token, 'sk-ant-oat01-sessionpart-TOKENPART');
  });

  it('matches token format with no version digits (sk-ant-oat-…)', () => {
    // Some tokens may omit the version digits entirely
    const token = extractClaudeToken('sk-ant-oat-session-TOKEN_DATA');
    assert.equal(token, 'sk-ant-oat-session-TOKEN_DATA');
  });

  it('never throws on null-ish inputs', () => {
    // Passing unusual values should never throw
    assert.doesNotThrow(() => extractClaudeToken(''));
    assert.doesNotThrow(() => extractClaudeToken('garbage input !!@#$%'));
    assert.doesNotThrow(() => extractClaudeToken('\x00\x01\x02'));
  });

  it('handles very long input without throwing', () => {
    const longText = 'a'.repeat(100_000) + ' sk-ant-oat01-mid-TOKEN ' + 'b'.repeat(100_000);
    const token = extractClaudeToken(longText);
    assert.equal(token, 'sk-ant-oat01-mid-TOKEN');
  });
});

// ---------------------------------------------------------------------------
// loadCredentials — missing / corrupt / valid files
// ---------------------------------------------------------------------------

describe('loadCredentials — missing file returns {}', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-missing-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns {} when credentials.json does not exist', async () => {
    const creds = await loadCredentials(homeDir);
    assert.deepEqual(creds, {});
  });

  it('does not throw when file is missing', async () => {
    await assert.doesNotReject(() => loadCredentials(homeDir));
  });
});

describe('loadCredentials — corrupt file returns {}', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-corrupt-${randomUUID()}-`));
    const dir = join(homeDir, '.myshell-tools');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'credentials.json'), 'THIS IS NOT JSON', 'utf8');
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns {} on corrupt JSON', async () => {
    const creds = await loadCredentials(homeDir);
    assert.deepEqual(creds, {});
  });

  it('does not throw on corrupt JSON', async () => {
    await assert.doesNotReject(() => loadCredentials(homeDir));
  });
});

describe('loadCredentials — non-object JSON returns {}', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-nonobj-${randomUUID()}-`));
    const dir = join(homeDir, '.myshell-tools');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'credentials.json'), '"just a string"', 'utf8');
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns {} when file contains a non-object JSON value', async () => {
    const creds = await loadCredentials(homeDir);
    assert.deepEqual(creds, {});
  });
});

// ---------------------------------------------------------------------------
// saveClaudeToken + loadCredentials — round-trip
// ---------------------------------------------------------------------------

describe('saveClaudeToken + loadCredentials — round-trip', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-save-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('saves a token and loadCredentials returns it', async () => {
    await saveClaudeToken('sk-ant-oat01-test-TOKENVALUE', homeDir);
    const creds = await loadCredentials(homeDir);
    assert.equal(creds.claudeOauthToken, 'sk-ant-oat01-test-TOKENVALUE');
  });

  it('overwrites an existing token on second save', async () => {
    await saveClaudeToken('sk-ant-oat01-first-AAA', homeDir);
    await saveClaudeToken('sk-ant-oat01-second-BBB', homeDir);
    const creds = await loadCredentials(homeDir);
    assert.equal(creds.claudeOauthToken, 'sk-ant-oat01-second-BBB');
  });

  it('creates the .myshell-tools directory if it does not exist', async () => {
    const freshHome = await mkdtemp(join(tmpdir(), `creds-newdir-${randomUUID()}-`));
    try {
      // No .myshell-tools dir yet — saveClaudeToken must create it
      await saveClaudeToken('sk-ant-oat01-new-TOKEN', freshHome);
      const creds = await loadCredentials(freshHome);
      assert.equal(creds.claudeOauthToken, 'sk-ant-oat01-new-TOKEN');
    } finally {
      await rm(freshHome, { recursive: true, force: true });
    }
  });

  it('does not throw', async () => {
    await assert.doesNotReject(() =>
      saveClaudeToken('sk-ant-oat01-nodethrow-TOKEN', homeDir),
    );
  });
});

// ---------------------------------------------------------------------------
// saveClaudeToken — file mode (0o600, POSIX only)
// ---------------------------------------------------------------------------

// Guard with process.platform so this suite is a no-op on Windows (where
// POSIX mode bits are not enforced by the OS).
if (process.platform !== 'win32') {
  describe('saveClaudeToken — credentials file mode', () => {
    let homeDir: string;

    before(async () => {
      homeDir = await mkdtemp(join(tmpdir(), `creds-mode-${randomUUID()}-`));
    });

    after(async () => {
      await rm(homeDir, { recursive: true, force: true });
    });

    it('saved credentials.json has mode 0o600 (owner-read-only)', async () => {
      await saveClaudeToken('sk-ant-oat01-modetest-TOKEN', homeDir);
      const credPath = join(homeDir, '.myshell-tools', 'credentials.json');
      const st = await stat(credPath);
      const actualMode = st.mode & 0o777;
      assert.equal(
        actualMode,
        0o600,
        `expected credentials file mode 0o600, got 0o${actualMode.toString(8)}`,
      );
    });
  });
}

// ---------------------------------------------------------------------------
// clearClaudeToken
// ---------------------------------------------------------------------------

describe('clearClaudeToken', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-clear-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('removes a previously saved token', async () => {
    await saveClaudeToken('sk-ant-oat01-todelete-TOKEN', homeDir);
    await clearClaudeToken(homeDir);
    const creds = await loadCredentials(homeDir);
    assert.equal(creds.claudeOauthToken, undefined);
  });

  it('does not throw when no token is stored', async () => {
    const freshHome = await mkdtemp(join(tmpdir(), `creds-clearempty-${randomUUID()}-`));
    try {
      await assert.doesNotReject(() => clearClaudeToken(freshHome));
    } finally {
      await rm(freshHome, { recursive: true, force: true });
    }
  });

  it('does not throw when credentials file does not exist', async () => {
    const freshHome = await mkdtemp(join(tmpdir(), `creds-clearmissing-${randomUUID()}-`));
    try {
      await assert.doesNotReject(() => clearClaudeToken(freshHome));
    } finally {
      await rm(freshHome, { recursive: true, force: true });
    }
  });

  it('claudeOauthToken is undefined after clearClaudeToken', async () => {
    await saveClaudeToken('sk-ant-oat01-clear-VERIFY', homeDir);
    await clearClaudeToken(homeDir);
    const creds = await loadCredentials(homeDir);
    assert.equal(creds.claudeOauthToken, undefined);
  });
});

// ---------------------------------------------------------------------------
// applyStoredCredentials
// ---------------------------------------------------------------------------

describe('applyStoredCredentials — injects token when not already in env', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-apply-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('sets CLAUDE_CODE_OAUTH_TOKEN when a token is stored and env is empty', async () => {
    await saveClaudeToken('sk-ant-oat01-inject-TOKEN', homeDir);
    const env: NodeJS.ProcessEnv = {};
    await applyStoredCredentials(env, homeDir);
    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'sk-ant-oat01-inject-TOKEN');
  });

  it('does NOT overwrite when CLAUDE_CODE_OAUTH_TOKEN is already set', async () => {
    await saveClaudeToken('sk-ant-oat01-stored-TOKEN', homeDir);
    const env: NodeJS.ProcessEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'existing-value' };
    await applyStoredCredentials(env, homeDir);
    // Must keep the original value — user's explicit env wins
    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'existing-value');
  });

  it('is a no-op when no token is stored and env is empty', async () => {
    const freshHome = await mkdtemp(join(tmpdir(), `creds-applynoop-${randomUUID()}-`));
    try {
      const env: NodeJS.ProcessEnv = {};
      await applyStoredCredentials(env, freshHome);
      assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], undefined);
    } finally {
      await rm(freshHome, { recursive: true, force: true });
    }
  });

  it('does not throw when credentials file is missing', async () => {
    const freshHome = await mkdtemp(join(tmpdir(), `creds-applythrow-${randomUUID()}-`));
    try {
      const env: NodeJS.ProcessEnv = {};
      await assert.doesNotReject(() => applyStoredCredentials(env, freshHome));
    } finally {
      await rm(freshHome, { recursive: true, force: true });
    }
  });

  it('does not throw when credentials file is corrupt', async () => {
    const corruptHome = await mkdtemp(join(tmpdir(), `creds-applycorrupt-${randomUUID()}-`));
    try {
      const dir = join(corruptHome, '.myshell-tools');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'credentials.json'), '<<<CORRUPT>>>', 'utf8');
      const env: NodeJS.ProcessEnv = {};
      await assert.doesNotReject(() => applyStoredCredentials(env, corruptHome));
      // Corrupt → no token set
      assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], undefined);
    } finally {
      await rm(corruptHome, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// stripPastedSecretWrapper — pure helper
// ---------------------------------------------------------------------------

describe('stripPastedSecretWrapper — strips whitespace and surrounding quotes', () => {
  it('trims plain leading/trailing whitespace', () => {
    assert.equal(stripPastedSecretWrapper('  hello  '), 'hello');
  });

  it('strips double quotes and trims inner whitespace', () => {
    assert.equal(stripPastedSecretWrapper('"  sk-ant-oat01-abc  "'), 'sk-ant-oat01-abc');
  });

  it('strips single quotes', () => {
    assert.equal(stripPastedSecretWrapper("'token'"), 'token');
  });

  it('returns the string unchanged when no quotes or extra whitespace', () => {
    assert.equal(stripPastedSecretWrapper('sk-ant-oat01-abc-XYZ'), 'sk-ant-oat01-abc-XYZ');
  });

  it('returns empty string when input is whitespace only', () => {
    assert.equal(stripPastedSecretWrapper('   '), '');
  });

  it('returns empty string for empty input', () => {
    assert.equal(stripPastedSecretWrapper(''), '');
  });

  it('does NOT strip mismatched quotes (only outer pair counts)', () => {
    // Opening " but no closing " — treat as plain string, just trim
    assert.equal(stripPastedSecretWrapper('"no-closing-quote'), '"no-closing-quote');
  });

  it('does NOT strip when opening and closing quotes differ', () => {
    assert.equal(stripPastedSecretWrapper(`"mixed'`), `"mixed'`);
  });

  it('handles a real token with surrounding double quotes', () => {
    const raw = '"sk-ant-oat01-LONG_TOKEN_VALUE_HERE-MORE-CHARS"';
    assert.equal(
      stripPastedSecretWrapper(raw),
      'sk-ant-oat01-LONG_TOKEN_VALUE_HERE-MORE-CHARS',
    );
  });

  it('never throws on empty string', () => {
    assert.doesNotThrow(() => stripPastedSecretWrapper(''));
  });

  it('never throws on unusual characters', () => {
    assert.doesNotThrow(() => stripPastedSecretWrapper('\x00\x01\x02'));
  });
});

// ---------------------------------------------------------------------------
// sanitizePastedToken — pure helper (whitespace/escape-proof token paste)
// ---------------------------------------------------------------------------

describe('sanitizePastedToken — reassembles a mangled token paste', () => {
  it('leaves a clean token untouched', () => {
    assert.equal(
      sanitizePastedToken('sk-ant-oat01-abc-XYZ'),
      'sk-ant-oat01-abc-XYZ',
    );
  });

  it('trims surrounding whitespace and newlines', () => {
    assert.equal(
      sanitizePastedToken('  sk-ant-oat01-abc-XYZ\n'),
      'sk-ant-oat01-abc-XYZ',
    );
  });

  it('collapses an internal space (stray paste artifact)', () => {
    assert.equal(
      sanitizePastedToken('sk-ant-oat01-abc def-XYZ'),
      'sk-ant-oat01-abcdef-XYZ',
    );
  });

  it('rejoins a token that a soft-wrap split across two lines', () => {
    // A terminal can break a long token with a newline mid-value; removing all
    // whitespace stitches it back into the single contiguous secret.
    assert.equal(
      sanitizePastedToken('sk-ant-oat01-firsthalf\nsecondhalf-XYZ'),
      'sk-ant-oat01-firsthalfsecondhalf-XYZ',
    );
  });

  it('strips bracketed-paste escape markers some terminals wrap around a paste', () => {
    assert.equal(
      sanitizePastedToken('\x1b[200~sk-ant-oat01-abc-XYZ\x1b[201~'),
      'sk-ant-oat01-abc-XYZ',
    );
  });

  it('strips surrounding quotes as well', () => {
    assert.equal(
      sanitizePastedToken('"sk-ant-oat01-abc-XYZ"'),
      'sk-ant-oat01-abc-XYZ',
    );
  });

  it('a sanitized split paste extracts to the full token', () => {
    // The end-to-end guarantee: sanitize → extract recovers the whole value
    // even when the raw paste arrived broken.
    const recovered = extractClaudeToken(
      sanitizePastedToken('sk-ant-oat01-LONG\nVALUE_HERE-MORECHARS'),
    );
    assert.equal(recovered, 'sk-ant-oat01-LONGVALUE_HERE-MORECHARS');
  });

  it('returns empty string for whitespace-only input', () => {
    assert.equal(sanitizePastedToken('   \n\t '), '');
  });

  it('never throws on unusual characters', () => {
    assert.doesNotThrow(() => sanitizePastedToken('\x00\x01\x02'));
  });
});

// ---------------------------------------------------------------------------
// classifyPastedSecret — pure helper
// ---------------------------------------------------------------------------

describe('classifyPastedSecret — classifies OAuth tokens, API keys, and other strings', () => {
  it('returns "oauth-token" for a string starting with sk-ant-oat', () => {
    assert.equal(classifyPastedSecret('sk-ant-oat01-abc-XYZ'), 'oauth-token');
  });

  it('returns "none" for sk-ant-oat embedded mid-string (startsWith semantics)', () => {
    // Mid-string occurrence must NOT classify as oauth-token.
    assert.equal(
      classifyPastedSecret('Your token: sk-ant-oat01-session-TOKENPART here'),
      'none',
    );
  });

  it('returns "api-key" for a string starting with sk-ant-api', () => {
    assert.equal(classifyPastedSecret('sk-ant-api03-abc-XYZ'), 'api-key');
  });

  it('returns "none" for sk-ant-api embedded mid-string (startsWith semantics)', () => {
    // Mid-string occurrence must NOT classify as api-key.
    assert.equal(classifyPastedSecret('API key: sk-ant-api01-somekey-ABC'), 'none');
  });

  it('returns "none" for an unrelated string', () => {
    assert.equal(classifyPastedSecret('not-a-token'), 'none');
  });

  it('returns "none" for an empty string', () => {
    assert.equal(classifyPastedSecret(''), 'none');
  });

  it('returns "none" for whitespace only', () => {
    assert.equal(classifyPastedSecret('   '), 'none');
  });

  it('returns "none" for a partial prefix without the discriminating segment', () => {
    // 'sk-ant-' alone — neither oat nor api
    assert.equal(classifyPastedSecret('sk-ant-something-else'), 'none');
  });

  it('returns "oauth-token" when string starts with oat and also contains api later', () => {
    // Extremely unlikely in practice, but the oat check wins because it is first.
    const s = 'sk-ant-oat01-x sk-ant-api01-y';
    assert.equal(classifyPastedSecret(s), 'oauth-token');
  });

  it('returns "none" for leading-prefix mismatch even if oat appears later', () => {
    // startsWith means leading prefix ONLY — mid-string oat should not match.
    assert.equal(classifyPastedSecret('prefix sk-ant-oat01-x'), 'none');
  });

  it('never throws on empty string', () => {
    assert.doesNotThrow(() => classifyPastedSecret(''));
  });

  it('never throws on unusual characters', () => {
    assert.doesNotThrow(() => classifyPastedSecret('\x00\x01\x02'));
  });
});

// ---------------------------------------------------------------------------
// claudeTokenStatus — pure helper
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe('claudeTokenStatus — returns null for missing/invalid capturedAt', () => {
  it('returns null for undefined', () => {
    assert.equal(claudeTokenStatus(undefined, Date.now()), null);
  });

  it('returns null for empty string', () => {
    assert.equal(claudeTokenStatus('', Date.now()), null);
  });

  it('returns null for a non-date string', () => {
    assert.equal(claudeTokenStatus('not-a-date', Date.now()), null);
  });

  it('never throws on invalid input', () => {
    assert.doesNotThrow(() => claudeTokenStatus(undefined, Date.now()));
    assert.doesNotThrow(() => claudeTokenStatus('garbage!@#', Date.now()));
  });
});

describe('claudeTokenStatus — fresh token (~365 days left)', () => {
  // Token was saved "now"; nowMs is also "now" → 365 days left
  it('daysLeft is 364 when savedAtMs === nowMs (floor of 365.0 - epsilon)', () => {
    const nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(nowMs).toISOString();
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.notEqual(status, null);
    // At exactly nowMs, daysLeft = floor((capturedAt+365d - nowMs)/msPerDay) = floor(365) = 365
    // but floating point means it is exactly 365.
    assert.ok(status!.daysLeft >= 364 && status!.daysLeft <= 365, `daysLeft should be near 365, got ${status!.daysLeft}`);
  });

  it('expired is false for a fresh token', () => {
    const nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(nowMs).toISOString();
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.expired, false);
  });

  it('nearExpiry is false for a fresh token', () => {
    const nowMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(nowMs).toISOString();
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.nearExpiry, false);
  });

  it('capturedAt round-trips', () => {
    const nowMs = new Date('2026-06-15T12:00:00.000Z').getTime();
    const capturedAt = new Date(nowMs).toISOString();
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.equal(status!.capturedAt, capturedAt);
  });

  it('expiresAt is capturedAt + lifetimeDays', () => {
    const capturedMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    const nowMs = capturedMs; // same moment
    const status = claudeTokenStatus(capturedAt, nowMs, 365);
    const expectedExpiry = new Date(capturedMs + 365 * MS_PER_DAY).toISOString();
    assert.equal(status!.expiresAt, expectedExpiry);
  });
});

describe('claudeTokenStatus — 10 days left → nearExpiry true', () => {
  it('nearExpiry is true when 10 days remain (within default warnWithinDays=14)', () => {
    const capturedMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    // Now is 355 days after capture → 10 days remain
    const nowMs = capturedMs + 355 * MS_PER_DAY;
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.nearExpiry, true);
    assert.strictEqual(status!.expired, false);
    assert.equal(status!.daysLeft, 10);
  });

  it('nearExpiry is false for exactly 15 days left (outside default warnWithinDays=14)', () => {
    const capturedMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    const nowMs = capturedMs + 350 * MS_PER_DAY; // 365 - 350 = 15 days left
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.nearExpiry, false);
    assert.equal(status!.daysLeft, 15);
  });

  it('nearExpiry is true for exactly 14 days left (boundary = warnWithinDays)', () => {
    const capturedMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    const nowMs = capturedMs + 351 * MS_PER_DAY; // 365 - 351 = 14 days left
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.nearExpiry, true);
    assert.equal(status!.daysLeft, 14);
  });
});

describe('claudeTokenStatus — 0 or negative days left → expired true', () => {
  it('expired is true when daysLeft is 0 (same day as expiry)', () => {
    const capturedMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    // now = capturedAt + 365 days → 0 days left (floor(0) = 0, expired = true)
    const nowMs = capturedMs + 365 * MS_PER_DAY;
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.expired, true);
    assert.strictEqual(status!.nearExpiry, false);
    assert.ok(status!.daysLeft <= 0);
  });

  it('expired is true when token is 1 year past expiry', () => {
    const capturedMs = new Date('2024-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    const nowMs = capturedMs + 730 * MS_PER_DAY; // 2 years later
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.expired, true);
    assert.ok(status!.daysLeft < 0);
  });

  it('nearExpiry is false when expired', () => {
    const capturedMs = new Date('2025-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    const nowMs = capturedMs + 400 * MS_PER_DAY;
    const status = claudeTokenStatus(capturedAt, nowMs);
    assert.strictEqual(status!.expired, true);
    assert.strictEqual(status!.nearExpiry, false);
  });
});

describe('claudeTokenStatus — custom lifetimeDays and warnWithinDays', () => {
  it('respects custom lifetimeDays', () => {
    const capturedMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    // Custom 30-day lifetime; now is 29 days later → 1 day left
    const nowMs = capturedMs + 29 * MS_PER_DAY;
    const status = claudeTokenStatus(capturedAt, nowMs, 30, 7);
    assert.equal(status!.daysLeft, 1);
    assert.strictEqual(status!.nearExpiry, true); // within 7-day warn window
  });

  it('respects custom warnWithinDays', () => {
    const capturedMs = new Date('2026-01-01T00:00:00.000Z').getTime();
    const capturedAt = new Date(capturedMs).toISOString();
    // 30 days lifetime, now is 10 days later → 20 days left
    const nowMs = capturedMs + 10 * MS_PER_DAY;
    // warnWithinDays=25 → 20 days left < 25 → nearExpiry = true
    const status = claudeTokenStatus(capturedAt, nowMs, 30, 25);
    assert.strictEqual(status!.nearExpiry, true);
    // warnWithinDays=5 → 20 days left > 5 → nearExpiry = false
    const status2 = claudeTokenStatus(capturedAt, nowMs, 30, 5);
    assert.strictEqual(status2!.nearExpiry, false);
  });
});

// ---------------------------------------------------------------------------
// saveClaudeToken + loadClaudeTokenCapturedAt — round-trip
// ---------------------------------------------------------------------------

describe('saveClaudeToken — records claudeTokenCapturedAt', () => {
  let homeDir: string;
  let beforeSaveMs: number;
  let afterSaveMs: number;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-capturedat-${randomUUID()}-`));
    beforeSaveMs = Date.now();
    await saveClaudeToken('sk-ant-oat01-capturedat-TOKEN', homeDir);
    afterSaveMs = Date.now();
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('claudeTokenCapturedAt is present in stored credentials', async () => {
    const creds = await loadCredentials(homeDir);
    assert.ok(
      typeof creds.claudeTokenCapturedAt === 'string' && creds.claudeTokenCapturedAt.length > 0,
      'expected claudeTokenCapturedAt to be a non-empty string',
    );
  });

  it('claudeTokenCapturedAt is a valid ISO date string', async () => {
    const creds = await loadCredentials(homeDir);
    const ms = new Date(creds.claudeTokenCapturedAt!).getTime();
    assert.ok(Number.isFinite(ms), `expected valid ISO date, got "${creds.claudeTokenCapturedAt}"`);
  });

  it('claudeTokenCapturedAt timestamp falls within the save window', async () => {
    const creds = await loadCredentials(homeDir);
    const ms = new Date(creds.claudeTokenCapturedAt!).getTime();
    assert.ok(
      ms >= beforeSaveMs && ms <= afterSaveMs,
      `capturedAt ${ms} should be between ${beforeSaveMs} and ${afterSaveMs}`,
    );
  });
});

describe('loadClaudeTokenCapturedAt — round-trip after saveClaudeToken', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-lctat-${randomUUID()}-`));
    await saveClaudeToken('sk-ant-oat01-lctat-TOKEN', homeDir);
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns a string after save', async () => {
    const val = await loadClaudeTokenCapturedAt(homeDir);
    assert.ok(typeof val === 'string' && val.length > 0, 'expected a non-empty string');
  });

  it('returned string is a valid ISO date', async () => {
    const val = await loadClaudeTokenCapturedAt(homeDir);
    const ms = new Date(val!).getTime();
    assert.ok(Number.isFinite(ms), `expected valid ISO date, got "${val}"`);
  });

  it('does not throw', async () => {
    await assert.doesNotReject(() => loadClaudeTokenCapturedAt(homeDir));
  });
});

describe('loadClaudeTokenCapturedAt — missing file returns undefined', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-lctat-missing-${randomUUID()}-`));
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns undefined when credentials file does not exist', async () => {
    const val = await loadClaudeTokenCapturedAt(homeDir);
    assert.equal(val, undefined);
  });

  it('does not throw when file is missing', async () => {
    await assert.doesNotReject(() => loadClaudeTokenCapturedAt(homeDir));
  });
});

describe('loadClaudeTokenCapturedAt — backward compat: old file without field', () => {
  let homeDir: string;

  before(async () => {
    homeDir = await mkdtemp(join(tmpdir(), `creds-lctat-compat-${randomUUID()}-`));
    // Write an old-style credentials file without claudeTokenCapturedAt
    const dir = join(homeDir, '.myshell-tools');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'credentials.json'),
      JSON.stringify({ claudeOauthToken: 'sk-ant-oat01-old-file-TOKEN' }),
      'utf8',
    );
  });

  after(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('returns undefined for old file without claudeTokenCapturedAt field', async () => {
    const val = await loadClaudeTokenCapturedAt(homeDir);
    assert.equal(val, undefined);
  });

  it('old token is still loadable (backward compat)', async () => {
    const token = await loadClaudeToken(homeDir);
    assert.equal(token, 'sk-ant-oat01-old-file-TOKEN');
  });
});
