import { afterEach, beforeEach, describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { loadClaudeToken, saveClaudeToken } from '../../src/infra/credentials.ts';
import {
  claudeEnvWithStoredFallback,
  resolveStoredCredentialInjection,
} from '../../src/providers/detect.ts';

describe('resolveStoredCredentialInjection', () => {
  it('defaults off without env opt-in', () => {
    assert.equal(resolveStoredCredentialInjection({}), false);
  });

  it('opts in via MYSHELL_LEGACY_CLAUDE_TOKEN=1', () => {
    assert.equal(
      resolveStoredCredentialInjection({ MYSHELL_LEGACY_CLAUDE_TOKEN: '1' }),
      true,
    );
  });

  it('explicit false wins over env opt-in (account-scoped runs)', () => {
    assert.equal(
      resolveStoredCredentialInjection({ MYSHELL_LEGACY_CLAUDE_TOKEN: '1' }, false),
      false,
    );
  });

  it('explicit true enables injection without env', () => {
    assert.equal(resolveStoredCredentialInjection({}, true), true);
  });
});

describe('claudeEnvWithStoredFallback', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), `claude-precedence-${randomUUID()}-`));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('prefers a valid Claude credentials file and clears the legacy token', async () => {
    const configDir = join(dir, 'claude-config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'current-account-token',
          expiresAt: Date.now() + 60_000,
        },
      }),
      'utf8',
    );
    await saveClaudeToken('old-account-token', dir);

    const env = await claudeEnvWithStoredFallback(
      { CLAUDE_CONFIG_DIR: configDir },
      dir,
      true,
      dir,
    );

    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], undefined);
    assert.equal(await loadClaudeToken(dir), null);
  });

  it('does NOT inject legacy token by default when Claude has no credentials (R4.1 off)', async () => {
    await saveClaudeToken('only-available-token', dir);

    const env = await claudeEnvWithStoredFallback({}, dir, undefined, dir);

    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], undefined);
    // Sole working credential is preserved on disk (no clear without dual-proof)
    assert.equal(await loadClaudeToken(dir), 'only-available-token');
  });

  it('falls back to the legacy token when injection is explicitly on', async () => {
    await saveClaudeToken('only-available-token', dir);

    const env = await claudeEnvWithStoredFallback({}, dir, true, dir);

    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'only-available-token');
    assert.equal(await loadClaudeToken(dir), 'only-available-token');
  });

  it('falls back to the legacy token when MYSHELL_LEGACY_CLAUDE_TOKEN=1', async () => {
    await saveClaudeToken('env-opt-in-token', dir);

    const env = await claudeEnvWithStoredFallback(
      { MYSHELL_LEGACY_CLAUDE_TOKEN: '1' },
      dir,
      undefined,
      dir,
    );

    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'env-opt-in-token');
    assert.equal(await loadClaudeToken(dir), 'env-opt-in-token');
  });

  it('does not prefer a metered API-key credential over subscription OAuth', async () => {
    const configDir = join(dir, 'claude-config');
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, '.credentials.json'),
      JSON.stringify({ primaryApiKey: 'not-used-by-myshell' }),
      'utf8',
    );
    await saveClaudeToken('subscription-fallback-token', dir);

    const env = await claudeEnvWithStoredFallback(
      { CLAUDE_CONFIG_DIR: configDir },
      dir,
      true,
      dir,
    );

    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], 'subscription-fallback-token');
    assert.equal(await loadClaudeToken(dir), 'subscription-fallback-token');
  });

  it('preserves and prefers the Replit-persistent Claude login', async () => {
    const persistentDir = join(dir, '.replit-tools', '.claude-persistent');
    await mkdir(persistentDir, { recursive: true });
    await writeFile(
      join(persistentDir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: 'persistent-current-token',
          expiresAt: Date.now() + 60_000,
        },
      }),
      'utf8',
    );
    await saveClaudeToken('old-account-token', dir);

    const env = await claudeEnvWithStoredFallback({}, dir, true, dir);

    assert.equal(env['CLAUDE_CONFIG_DIR'], persistentDir);
    assert.equal(env['CLAUDE_CODE_OAUTH_TOKEN'], undefined);
    assert.equal(await loadClaudeToken(dir), null);
  });
});
