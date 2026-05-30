/**
 * Unit tests for parseClaudeAuth and parseCodexAuth in src/providers/detect.ts
 *
 * All tests are hermetic — no live CLI spawns. Input strings are representative
 * samples based on real captured output from `claude auth status` and
 * `codex login status`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaudeAuth,
  parseCodexAuth,
} from '../../src/providers/detect.ts';

// ---------------------------------------------------------------------------
// parseClaudeAuth
// ---------------------------------------------------------------------------

describe('parseClaudeAuth — logged in with pro plan', () => {
  // Real captured output from `claude auth status` (exit code 0):
  const stdout = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    apiProvider: 'firstParty',
    email: 'user@example.com',
    orgId: 'abc-123',
    orgName: "user@example.com's Organization",
    subscriptionType: 'pro',
  });

  const result = parseClaudeAuth(stdout, '', 0);

  it('does not throw', () => {
    assert.doesNotThrow(() => parseClaudeAuth(stdout, '', 0));
  });

  it('authenticated is true', () => {
    assert.equal(result.authenticated, true);
  });

  it('plan is "pro"', () => {
    assert.equal(result.plan, 'pro');
  });
});

describe('parseClaudeAuth — logged in with free plan', () => {
  const stdout = JSON.stringify({
    loggedIn: true,
    authMethod: 'claude.ai',
    subscriptionType: 'free',
  });

  const result = parseClaudeAuth(stdout, '', 0);

  it('authenticated is true', () => {
    assert.equal(result.authenticated, true);
  });

  it('plan is "free"', () => {
    assert.equal(result.plan, 'free');
  });
});

describe('parseClaudeAuth — logged in, no subscriptionType field', () => {
  const stdout = JSON.stringify({
    loggedIn: true,
    authMethod: 'apiKey',
  });

  const result = parseClaudeAuth(stdout, '', 0);

  it('authenticated is true', () => {
    assert.equal(result.authenticated, true);
  });

  it('plan is null when subscriptionType is absent', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseClaudeAuth — logged out (loggedIn: false)', () => {
  const stdout = JSON.stringify({ loggedIn: false });

  const result = parseClaudeAuth(stdout, '', 0);

  it('authenticated is false', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseClaudeAuth — non-zero exit code', () => {
  const result = parseClaudeAuth('', 'error: not authenticated', 1);

  it('authenticated is false', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseClaudeAuth — garbage / non-JSON stdout', () => {
  const result = parseClaudeAuth('not json at all %%%', '', 0);

  it('does not throw on garbage input', () => {
    assert.doesNotThrow(() => parseClaudeAuth('not json at all %%%', '', 0));
  });

  it('authenticated is false', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseClaudeAuth — empty stdout', () => {
  const result = parseClaudeAuth('', '', 0);

  it('does not throw on empty stdout', () => {
    assert.doesNotThrow(() => parseClaudeAuth('', '', 0));
  });

  it('authenticated is false', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

// ---------------------------------------------------------------------------
// parseCodexAuth
// ---------------------------------------------------------------------------

describe('parseCodexAuth — logged in (stderr only, real codex behaviour)', () => {
  // Real captured output from `codex login status` (exit code 0):
  // stdout is EMPTY; the "Logged in using ChatGPT" message goes to stderr.
  // Verified by running: codex login status > /tmp/out.txt 2>/tmp/err.txt
  const stderr = 'Logged in using ChatGPT';

  const result = parseCodexAuth('', stderr, 0);

  it('does not throw', () => {
    assert.doesNotThrow(() => parseCodexAuth('', stderr, 0));
  });

  it('authenticated is true when message is in stderr', () => {
    assert.equal(result.authenticated, true);
  });

  it('plan is null (codex login status does not expose plan)', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseCodexAuth — logged in (stdout only, fallback)', () => {
  // If future codex versions write to stdout, that should also work.
  const result = parseCodexAuth('Logged in using ChatGPT', '', 0);

  it('authenticated is true when message is in stdout', () => {
    assert.equal(result.authenticated, true);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseCodexAuth — logged in variant casing (stderr)', () => {
  const result = parseCodexAuth('', 'logged in using API key', 0);

  it('authenticated is true (case-insensitive match in stderr)', () => {
    assert.equal(result.authenticated, true);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseCodexAuth — unauthenticated with non-zero exit code', () => {
  // Codex exits non-zero when not logged in — the exit code is the primary guard.
  const result = parseCodexAuth('Not logged in.', '', 2);

  it('authenticated is false when exit code is non-zero', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseCodexAuth — non-zero exit code', () => {
  const result = parseCodexAuth('', 'not authenticated', 1);

  it('authenticated is false when exit code is non-zero', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseCodexAuth — garbage input', () => {
  const result = parseCodexAuth('some random garbage output %%%', '', 0);

  it('does not throw on garbage input', () => {
    assert.doesNotThrow(() => parseCodexAuth('some random garbage output %%%', '', 0));
  });

  it('authenticated is false (no "logged in" substring)', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});

describe('parseCodexAuth — empty stdout with exit code 0', () => {
  const result = parseCodexAuth('', '', 0);

  it('does not throw on empty stdout', () => {
    assert.doesNotThrow(() => parseCodexAuth('', '', 0));
  });

  it('authenticated is false', () => {
    assert.equal(result.authenticated, false);
  });

  it('plan is null', () => {
    assert.equal(result.plan, null);
  });
});
