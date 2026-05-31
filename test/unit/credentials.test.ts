/**
 * test/unit/credentials.test.ts — unit tests for src/infra/credentials.ts
 *
 * All tests are hermetic: they use temporary directories and never spawn real
 * subprocesses. The `extractClaudeToken` helper is pure (no I/O) and is tested
 * extensively for correctness and never-throw guarantees.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import {
  loadCredentials,
  saveClaudeToken,
  clearClaudeToken,
  applyStoredCredentials,
  extractClaudeToken,
} from '../../src/infra/credentials.ts';

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

  it('loadCredentials returns {} after clearClaudeToken', async () => {
    await saveClaudeToken('sk-ant-oat01-clear-VERIFY', homeDir);
    await clearClaudeToken(homeDir);
    const creds = await loadCredentials(homeDir);
    assert.deepEqual(creds, {});
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
