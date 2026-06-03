import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseClaudeOauth,
  oauthRefreshDecision,
  applyRefreshToCreds,
  resolveClaudeCredsPath,
  refreshClaudeOauthIfNeeded,
  type ClaudeOauth,
  type RefreshResponse,
} from '../../src/infra/claude-oauth-refresh.ts';

const NOW = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

const creds = (oauth: Partial<ClaudeOauth> & Record<string, unknown>, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'acc', refreshToken: 'ref', expiresAt: NOW + 10 * HOUR, ...oauth }, ...extra });

// ---------------------------------------------------------------------------
// parseClaudeOauth
// ---------------------------------------------------------------------------

describe('parseClaudeOauth', () => {
  it('extracts accessToken / refreshToken / expiresAt', () => {
    const o = parseClaudeOauth(creds({}));
    assert.deepEqual(o, { accessToken: 'acc', refreshToken: 'ref', expiresAt: NOW + 10 * HOUR });
  });

  it('returns null when there is no oauth block', () => {
    assert.equal(parseClaudeOauth('{}'), null);
    assert.equal(parseClaudeOauth('{"other":1}'), null);
  });

  it('returns null on missing access token', () => {
    assert.equal(parseClaudeOauth(JSON.stringify({ claudeAiOauth: { refreshToken: 'r' } })), null);
  });

  it('refreshToken null when absent/empty; expiresAt null when non-numeric', () => {
    const o = parseClaudeOauth(JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: '', expiresAt: 'x' } }));
    assert.deepEqual(o, { accessToken: 'a', refreshToken: null, expiresAt: null });
  });

  it('never throws on garbage', () => {
    assert.equal(parseClaudeOauth('not json'), null);
    assert.equal(parseClaudeOauth(''), null);
  });
});

// ---------------------------------------------------------------------------
// oauthRefreshDecision
// ---------------------------------------------------------------------------

describe('oauthRefreshDecision', () => {
  const base: ClaudeOauth = { accessToken: 'a', refreshToken: 'r', expiresAt: NOW };

  it('valid when well beyond the threshold', () => {
    assert.equal(oauthRefreshDecision({ ...base, expiresAt: NOW + 10 * HOUR }, NOW), 'valid');
  });

  it('refresh when within the 2h threshold', () => {
    assert.equal(oauthRefreshDecision({ ...base, expiresAt: NOW + 1 * HOUR }, NOW), 'refresh');
  });

  it('refresh when already expired (and a refresh token exists)', () => {
    assert.equal(oauthRefreshDecision({ ...base, expiresAt: NOW - 1 * HOUR }, NOW), 'refresh');
  });

  it('expired-no-refresh when due but no refresh token', () => {
    assert.equal(
      oauthRefreshDecision({ accessToken: 'a', refreshToken: null, expiresAt: NOW - HOUR }, NOW),
      'expired-no-refresh',
    );
  });

  it('no-expiry when expiresAt is null', () => {
    assert.equal(oauthRefreshDecision({ accessToken: 'a', refreshToken: 'r', expiresAt: null }, NOW), 'no-expiry');
  });
});

// ---------------------------------------------------------------------------
// applyRefreshToCreds
// ---------------------------------------------------------------------------

describe('applyRefreshToCreds', () => {
  it('updates access/expiry and preserves other keys', () => {
    const before = { claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt: 1, scopes: ['x'] }, primaryApiKey: 'keep' };
    const resp: RefreshResponse = { accessToken: 'new', expiresInSec: 3600 };
    const after = applyRefreshToCreds(before, resp, NOW) as Record<string, unknown>;
    const oauth = after['claudeAiOauth'] as Record<string, unknown>;
    assert.equal(oauth['accessToken'], 'new');
    assert.equal(oauth['expiresAt'], NOW + 3600 * 1000);
    assert.equal(oauth['refreshToken'], 'r', 'old refresh token kept when response omits one');
    assert.deepEqual(oauth['scopes'], ['x'], 'unrelated oauth fields preserved');
    assert.equal(after['primaryApiKey'], 'keep', 'unrelated top-level keys preserved');
  });

  it('uses the rotated refresh token when the response includes one', () => {
    const after = applyRefreshToCreds(
      { claudeAiOauth: { accessToken: 'old', refreshToken: 'r1' } },
      { accessToken: 'new', refreshToken: 'r2', expiresInSec: 60 },
      NOW,
    ) as Record<string, unknown>;
    assert.equal((after['claudeAiOauth'] as Record<string, unknown>)['refreshToken'], 'r2');
  });
});

// ---------------------------------------------------------------------------
// resolveClaudeCredsPath
// ---------------------------------------------------------------------------

describe('resolveClaudeCredsPath', () => {
  it('honours CLAUDE_CONFIG_DIR', () => {
    assert.equal(
      resolveClaudeCredsPath({ CLAUDE_CONFIG_DIR: '/cfg' }, '/cwd', '/home'),
      '/cfg/.credentials.json',
    );
  });

  it('falls back to ~/.claude when no config dir and no replit dir', () => {
    assert.equal(
      resolveClaudeCredsPath({}, '/nonexistent-cwd', '/home/me'),
      '/home/me/.claude/.credentials.json',
    );
  });
});

// ---------------------------------------------------------------------------
// refreshClaudeOauthIfNeeded — orchestrator (injected fetcher + temp files)
// ---------------------------------------------------------------------------

describe('refreshClaudeOauthIfNeeded', () => {
  const setup = async (raw: string | null): Promise<{ home: string; credsPath: string }> => {
    const home = await mkdtemp(join(tmpdir(), 'oauth-ref-'));
    const credsPath = join(home, '.credentials.json');
    if (raw !== null) await writeFile(credsPath, raw, 'utf8');
    return { home, credsPath };
  };

  it('no-creds when the file is missing', async () => {
    const { home, credsPath } = await setup(null);
    const r = await refreshClaudeOauthIfNeeded({ home, credsPath, nowMs: NOW, fetcher: async () => null });
    assert.equal(r.action, 'no-creds');
  });

  it('valid when the token is well within lifetime (no fetch)', async () => {
    const { home, credsPath } = await setup(creds({ expiresAt: NOW + 10 * HOUR }));
    let called = false;
    const r = await refreshClaudeOauthIfNeeded({
      home, credsPath, nowMs: NOW,
      fetcher: async () => { called = true; return null; },
    });
    assert.equal(r.action, 'valid');
    assert.equal(called, false, 'must not hit the endpoint when the token is valid');
  });

  it('refreshes and writes the new token back when near expiry', async () => {
    const { home, credsPath } = await setup(creds({ expiresAt: NOW + 30 * 60 * 1000, refreshToken: 'r1' }, { primaryApiKey: 'keep' }));
    const r = await refreshClaudeOauthIfNeeded({
      home, credsPath, nowMs: NOW,
      fetcher: async (rt) => { assert.equal(rt, 'r1'); return { accessToken: 'fresh', refreshToken: 'r2', expiresInSec: 8 * 3600 }; },
    });
    assert.equal(r.action, 'refreshed');
    assert.equal(r.hoursLeft, 8);
    const written = JSON.parse(await readFile(credsPath, 'utf8')) as Record<string, unknown>;
    const oauth = written['claudeAiOauth'] as Record<string, unknown>;
    assert.equal(oauth['accessToken'], 'fresh');
    assert.equal(oauth['refreshToken'], 'r2');
    assert.equal(oauth['expiresAt'], NOW + 8 * HOUR);
    assert.equal(written['primaryApiKey'], 'keep', 'unrelated keys survive the rewrite');
    assert.ok(!existsSync(`${credsPath}.myshell-bak`), 'backup removed on success');
  });

  it('expired-no-refresh when due but no refresh token', async () => {
    const { home, credsPath } = await setup(JSON.stringify({ claudeAiOauth: { accessToken: 'a', expiresAt: NOW - HOUR } }));
    const r = await refreshClaudeOauthIfNeeded({ home, credsPath, nowMs: NOW, fetcher: async () => ({ accessToken: 'x', expiresInSec: 1 }) });
    assert.equal(r.action, 'expired-no-refresh');
  });

  it('on fetch failure: leaves creds untouched, drops a cooldown marker, then skips', async () => {
    const original = creds({ expiresAt: NOW - HOUR });
    const { home, credsPath } = await setup(original);
    const r1 = await refreshClaudeOauthIfNeeded({ home, credsPath, nowMs: NOW, fetcher: async () => null });
    assert.equal(r1.action, 'failed');
    assert.equal(await readFile(credsPath, 'utf8'), original, 'creds file is unchanged on failure');
    assert.ok(existsSync(join(home, '.myshell-tools', '.claude-refresh-failed')), 'cooldown marker dropped');

    // A second attempt within the cooldown window skips the endpoint entirely.
    let called = false;
    const r2 = await refreshClaudeOauthIfNeeded({
      home, credsPath, nowMs: NOW + 60_000,
      fetcher: async () => { called = true; return null; },
    });
    assert.equal(r2.action, 'cooldown');
    assert.equal(called, false);
  });

  it('cooldown expires after 1h so refresh is retried', async () => {
    const { home, credsPath } = await setup(creds({ expiresAt: NOW - HOUR }));
    await refreshClaudeOauthIfNeeded({ home, credsPath, nowMs: NOW, fetcher: async () => null }); // sets marker
    const r = await refreshClaudeOauthIfNeeded({
      home, credsPath, nowMs: NOW + 2 * HOUR, // past the 1h cooldown
      fetcher: async () => ({ accessToken: 'fresh', expiresInSec: 3600 }),
    });
    assert.equal(r.action, 'refreshed');
    // marker cleared on success
    let markerAge = -1;
    try { markerAge = (await stat(join(home, '.myshell-tools', '.claude-refresh-failed'))).mtimeMs; } catch { markerAge = -1; }
    assert.equal(markerAge, -1, 'cooldown marker cleared after a successful refresh');
  });
});
