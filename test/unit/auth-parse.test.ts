/**
 * Unit tests for parseClaudeAuth, parseCodexAuth, and the opencode detection
 * helpers in src/providers/detect.ts.
 *
 * All tests are hermetic — no live CLI spawns. Input strings are representative
 * samples based on real captured output from `claude auth status`,
 * `codex login status`, and `opencode --version`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClaudeAuth,
  parseCodexAuth,
  parseOpencodeAuth,
  opencodeCredentialCount,
  resolveOpencodeAuthPath,
  parseOpencodeModels,
  getInstallCommand,
  credentialFileIndicatesAuth,
  foldRateLimitTier,
  rateLimitTierFromCreds,
  decodeJwtClaims,
  codexPlanFromAuthJson,
  resolveCodexAuthPath,
  opencodePlanFromAuthJson,
} from '../../src/providers/detect.ts';

// ---------------------------------------------------------------------------
// JWT fixture builder — make an UNSIGNED test JWT carrying the given claims.
// header.payload.signature, payload base64url-encoded. The signature segment is
// a placeholder (we never verify it — see decodeJwtClaims). This mirrors the
// real codex/opencode token shape (chatgpt_plan_type lives under the
// `https://api.openai.com/auth` claim) WITHOUT embedding any real token.
// ---------------------------------------------------------------------------

function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function makeJwt(claims: Record<string, unknown>): string {
  const header = b64url({ alg: 'RS256', typ: 'JWT' });
  const payload = b64url(claims);
  return `${header}.${payload}.fake-signature-not-verified`;
}

/** A codex auth.json with a ChatGPT OAuth login carrying a given plan_type. */
function codexAuthJson(planType: string | null): string {
  const authClaim: Record<string, unknown> = { chatgpt_account_id: 'acc-123' };
  if (planType !== null) authClaim['chatgpt_plan_type'] = planType;
  return JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: makeJwt({ 'https://api.openai.com/auth': authClaim, sub: 'x' }),
      access_token: makeJwt({ 'https://api.openai.com/auth': authClaim }),
      refresh_token: 'rt',
      account_id: 'acc-123',
    },
    last_refresh: '2026-06-02T17:13:29Z',
  });
}

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

// ---------------------------------------------------------------------------
// opencode detection helpers — pure / hermetic
// ---------------------------------------------------------------------------

/**
 * opencode authentication is probed for real via `opencode auth list` (see
 * parseOpencodeAuth above): installed → authenticated only when ≥1 provider
 * credential is configured. Here we test the supporting install-command helper.
 */

describe('opencode — getInstallCommand returns the opencode-ai npm package', () => {
  it('does not throw', () => {
    assert.doesNotThrow(() => getInstallCommand('opencode'));
  });

  it('returns the npm install -g opencode-ai command', () => {
    assert.equal(getInstallCommand('opencode'), 'npm install -g opencode-ai');
  });

  it('starts with "npm install -g "', () => {
    assert.ok(
      getInstallCommand('opencode').startsWith('npm install -g '),
      'opencode install command must start with "npm install -g "',
    );
  });

  it('contains the opencode-ai package name', () => {
    assert.ok(
      getInstallCommand('opencode').includes('opencode-ai'),
      'opencode install command must include the "opencode-ai" package name',
    );
  });

  it('is different from the claude install command', () => {
    assert.notEqual(
      getInstallCommand('opencode'),
      getInstallCommand('claude'),
      'opencode and claude install commands must differ',
    );
  });

  it('is different from the codex install command', () => {
    assert.notEqual(
      getInstallCommand('opencode'),
      getInstallCommand('codex'),
      'opencode and codex install commands must differ',
    );
  });

  it('is a pure function — same input always returns same output', () => {
    assert.equal(getInstallCommand('opencode'), getInstallCommand('opencode'));
  });

  it('does not contain digit-% literals (Honesty Contract)', () => {
    assert.ok(
      !/\d+%/.test(getInstallCommand('opencode')),
      'opencode install command must not contain digit-% literals',
    );
  });
});

describe('opencode — detection rationale: installed implies authenticated (free models)', () => {
  /**
   * opencode ships free models (e.g. opencode/deepseek-v4-flash-free) that
   * require no credentials. The detection contract documented here:
   *  - When `opencode --version` exits 0, installed=true AND authenticated=true.
   *  - This is honest: any installed opencode binary is immediately usable.
   *  - plan is always null (opencode --version does not expose subscription).
   *
   * Because detectProvider('opencode') spawns a real binary, we cannot test it
   * hermetically here. Instead, we document the contract via assertions about
   * the getInstallCommand output and by verifying the ProviderId union includes
   * 'opencode'. The real spawn is exercised by the integration suite.
   */

  it('opencode is a valid ProviderId (compile-time verified by typecheck)', () => {
    // If 'opencode' were not in the ProviderId union, getInstallCommand('opencode')
    // would be a TypeScript error. The fact that this test compiles at all is the
    // assertion. We add a runtime check for belt-and-suspenders.
    const cmd = getInstallCommand('opencode');
    assert.ok(typeof cmd === 'string' && cmd.length > 0, 'opencode is a valid ProviderId');
  });

  it('all three install commands are distinct (claude, codex, opencode)', () => {
    const commands = [
      getInstallCommand('claude'),
      getInstallCommand('codex'),
      getInstallCommand('opencode'),
    ];
    const uniqueCommands = new Set(commands);
    assert.equal(uniqueCommands.size, 3, 'all three install commands must be distinct');
  });
});

// ---------------------------------------------------------------------------
// parseOpencodeAuth / opencodeCredentialCount — opencode-broker recognition.
// myshell itself never stores or sees the secret; it DELEGATES sign-in to opencode,
// which stores the credential in its own secure auth.json. So opencode is
// authenticated whenever it holds ≥1 recognized credential of EITHER `type:"oauth"`
// OR `type:"api"` (e.g. an OpenCode Zen gateway key). From that one credential
// opencode brokers many models (e.g. Kimi via opencode-go).
// ---------------------------------------------------------------------------

describe('parseOpencodeAuth — opencode holds the secret (oauth OR api counts)', () => {
  it('authenticated when an oauth credential is present', () => {
    const raw = JSON.stringify({
      anthropic: { type: 'oauth', access: 'a', refresh: 'r', expires: 123 },
    });
    const r = parseOpencodeAuth(raw);
    assert.equal(r.authenticated, true);
    assert.equal(r.credentialCount, 1);
  });

  it('authenticated when only an api-key credential is present (opencode stores it, e.g. OpenCode Zen)', () => {
    const raw = JSON.stringify({
      opencode: { type: 'api', key: 'sk-xxx' },
      openai: { type: 'api', key: 'sk-yyy' },
    });
    const r = parseOpencodeAuth(raw);
    assert.equal(r.authenticated, true);
    assert.equal(r.credentialCount, 2);
  });

  it('counts both oauth and api credentials in a mixed file', () => {
    const raw = JSON.stringify({
      anthropic: { type: 'oauth', access: 'a' },
      openai: { type: 'api', key: 'sk-yyy' },
    });
    const r = parseOpencodeAuth(raw);
    assert.equal(r.authenticated, true);
    assert.equal(r.credentialCount, 2);
  });

  it('counts every recognized (oauth/api) credential, ignoring unrecognized types', () => {
    const raw = JSON.stringify({
      anthropic: { type: 'oauth' },
      'github-copilot': { type: 'oauth' },
      openai: { type: 'api' },
      bogus: { type: 'something-else' },
      alsoBogus: { notAType: true },
    });
    assert.equal(opencodeCredentialCount(raw), 3);
  });

  it('NOT authenticated for empty / garbage / non-object input (fail-soft)', () => {
    assert.equal(parseOpencodeAuth('').authenticated, false);
    assert.equal(parseOpencodeAuth('not json at all').authenticated, false);
    assert.equal(parseOpencodeAuth('{}').authenticated, false);
    assert.equal(parseOpencodeAuth('[]').authenticated, false);
    assert.equal(parseOpencodeAuth('null').authenticated, false);
    assert.equal(opencodeCredentialCount(''), 0);
    assert.equal(opencodeCredentialCount('garbage'), 0);
    // An object with no recognized credential type is still not authenticated.
    assert.equal(parseOpencodeAuth('{"x":{"type":"weird"}}').authenticated, false);
  });
});

describe('resolveOpencodeAuthPath', () => {
  it('uses $XDG_DATA_HOME/opencode/auth.json when XDG_DATA_HOME is set', () => {
    const p = resolveOpencodeAuthPath({ XDG_DATA_HOME: '/persist/data' }, '/home/u');
    assert.equal(p, '/persist/data/opencode/auth.json');
  });

  it('falls back to $HOME/.local/share/opencode/auth.json when XDG is unset', () => {
    const p = resolveOpencodeAuthPath({}, '/home/u');
    assert.equal(p, '/home/u/.local/share/opencode/auth.json');
  });
});

// ---------------------------------------------------------------------------
// parseOpencodeModels — the user's real available `provider/model` list
// ---------------------------------------------------------------------------

describe('parseOpencodeModels', () => {
  it('parses one provider/model id per line (live free roster shape)', () => {
    const stdout =
      'opencode/big-pickle\nopencode/deepseek-v4-flash-free\nopencode/mimo-v2.5-free\n';
    assert.deepEqual(parseOpencodeModels(stdout), [
      'opencode/big-pickle',
      'opencode/deepseek-v4-flash-free',
      'opencode/mimo-v2.5-free',
    ]);
  });

  it('keeps opencode-go/* ids and ignores blank/banner lines', () => {
    const stdout = '\n  Models\n\nopencode-go/kimi-k2.6\nopencode-go/glm-5.1\n';
    assert.deepEqual(parseOpencodeModels(stdout), [
      'opencode-go/kimi-k2.6',
      'opencode-go/glm-5.1',
    ]);
  });

  it('returns [] for empty / non-model output (never throws)', () => {
    assert.deepEqual(parseOpencodeModels(''), []);
    assert.deepEqual(parseOpencodeModels('no models configured'), []);
  });
});

// ---------------------------------------------------------------------------
// credentialFileIndicatesAuth — on-disk credential fallback
// ---------------------------------------------------------------------------

describe('credentialFileIndicatesAuth', () => {
  // Fixed reference point used across all tests in this suite.
  const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
  const ONE_HOUR_MS = 60 * 60 * 1000;

  it('non-expired oauth token (expiresAt = nowMs + 1 hour) → true', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok_valid',
        refreshToken: 'ref_tok',
        expiresAt: NOW_MS + ONE_HOUR_MS,
      },
    });
    assert.equal(credentialFileIndicatesAuth(raw, NOW_MS), true);
  });

  it('expired oauth token (expiresAt = nowMs - 1 hour) → false', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok_expired',
        refreshToken: 'ref_tok',
        expiresAt: NOW_MS - ONE_HOUR_MS,
      },
    });
    assert.equal(credentialFileIndicatesAuth(raw, NOW_MS), false);
  });

  it('expiresAt null but accessToken present → true', () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'tok_no_expiry',
        refreshToken: null,
        expiresAt: null,
      },
    });
    assert.equal(credentialFileIndicatesAuth(raw, NOW_MS), true);
  });

  it('primaryApiKey present → true', () => {
    const raw = JSON.stringify({
      primaryApiKey: 'sk-ant-api03-somekey',
    });
    assert.equal(credentialFileIndicatesAuth(raw, NOW_MS), true);
  });

  it('empty string → false', () => {
    assert.equal(credentialFileIndicatesAuth('', NOW_MS), false);
  });

  it('garbage / non-JSON input → false (never throws)', () => {
    assert.doesNotThrow(() => credentialFileIndicatesAuth('not json %%%', NOW_MS));
    assert.equal(credentialFileIndicatesAuth('not json %%%', NOW_MS), false);
  });

  it('empty object {} → false', () => {
    assert.equal(credentialFileIndicatesAuth('{}', NOW_MS), false);
  });
});

// ---------------------------------------------------------------------------
// Max sub-tier: foldRateLimitTier + rateLimitTierFromCreds + parseClaudeAuth
// enrichment. Verifies 5x / 20x / missing → the right plan string.
// ---------------------------------------------------------------------------

describe('foldRateLimitTier — folds the Max sub-tier into the plan string', () => {
  it('max + a 5x rateLimitTier → "max_5x"', () => {
    assert.equal(foldRateLimitTier('max', 'default_claude_max_5x'), 'max_5x');
  });

  it('max + a 20x rateLimitTier → "max_20x"', () => {
    assert.equal(foldRateLimitTier('max', 'default_claude_max_20x'), 'max_20x');
  });

  it('20x is matched before 5x (no mis-match)', () => {
    assert.equal(foldRateLimitTier('max', 'something_max_20x'), 'max_20x');
  });

  it('matches the substring robustly, not an exact string', () => {
    assert.equal(foldRateLimitTier('max', 'totally_renamed_prefix_5x'), 'max_5x');
  });

  it('missing rateLimitTier → unchanged generic "max"', () => {
    assert.equal(foldRateLimitTier('max', null), 'max');
    assert.equal(foldRateLimitTier('max', undefined), 'max');
    assert.equal(foldRateLimitTier('max', ''), 'max');
  });

  it('garbage rateLimitTier with no marker → unchanged generic "max"', () => {
    assert.equal(foldRateLimitTier('max', 'default_claude_pro'), 'max');
  });

  it('non-Max plan is never enriched', () => {
    assert.equal(foldRateLimitTier('pro', 'default_claude_max_20x'), 'pro');
    assert.equal(foldRateLimitTier('free', 'whatever_5x'), 'free');
  });

  it('null plan stays null', () => {
    assert.equal(foldRateLimitTier(null, 'default_claude_max_5x'), null);
  });

  it('does not double-fold a plan that already carries a sub-tier marker', () => {
    assert.equal(foldRateLimitTier('max_20x', 'default_claude_max_5x'), 'max_20x');
  });
});

describe('rateLimitTierFromCreds — reads claudeAiOauth.rateLimitTier', () => {
  it('reads the tier string when present', () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'x', rateLimitTier: 'default_claude_max_5x' },
    });
    assert.equal(rateLimitTierFromCreds(raw), 'default_claude_max_5x');
  });

  it('missing field → null', () => {
    const raw = JSON.stringify({ claudeAiOauth: { accessToken: 'x' } });
    assert.equal(rateLimitTierFromCreds(raw), null);
  });

  it('missing claudeAiOauth → null', () => {
    assert.equal(rateLimitTierFromCreds('{}'), null);
  });

  it('garbage / non-JSON → null (never throws)', () => {
    assert.doesNotThrow(() => rateLimitTierFromCreds('not json %%%'));
    assert.equal(rateLimitTierFromCreds('not json %%%'), null);
  });
});

describe('parseClaudeAuth — enriches the Max plan from status-JSON rateLimitTier', () => {
  it('subscriptionType max + rateLimitTier 5x → plan "max_5x"', () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_5x',
    });
    assert.equal(parseClaudeAuth(stdout, '', 0).plan, 'max_5x');
  });

  it('subscriptionType max + rateLimitTier 20x → plan "max_20x"', () => {
    const stdout = JSON.stringify({
      loggedIn: true,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
    assert.equal(parseClaudeAuth(stdout, '', 0).plan, 'max_20x');
  });

  it('subscriptionType max, no rateLimitTier → plain "max" (fail-soft)', () => {
    const stdout = JSON.stringify({ loggedIn: true, subscriptionType: 'max' });
    assert.equal(parseClaudeAuth(stdout, '', 0).plan, 'max');
  });
});

// ---------------------------------------------------------------------------
// decodeJwtClaims — defensive, no-signature-trust claim decode
// ---------------------------------------------------------------------------

describe('decodeJwtClaims — reads the payload, never trusts the signature', () => {
  it('decodes a well-formed JWT payload to its claims object', () => {
    const tok = makeJwt({ plan: 'pro', n: 1, nested: { a: true } });
    const claims = decodeJwtClaims(tok);
    assert.deepEqual(claims, { plan: 'pro', n: 1, nested: { a: true } });
  });

  it('decodes base64url-encoded payloads needing padding', () => {
    // A claim set whose base64 length is not a multiple of 4 before padding.
    const tok = makeJwt({ a: 'abc' });
    assert.deepEqual(decodeJwtClaims(tok), { a: 'abc' });
  });

  it('returns null for non-JWT / malformed input (fail-soft, never throws)', () => {
    assert.doesNotThrow(() => decodeJwtClaims('not-a-jwt'));
    assert.equal(decodeJwtClaims('not-a-jwt'), null);
    assert.equal(decodeJwtClaims(''), null);
    // 'two' is not base64-decodable JSON → null (a single segment, no payload).
    assert.equal(decodeJwtClaims('only.two'), null);
    assert.equal(decodeJwtClaims('header.@@@not-base64@@@.sig'), null);
  });

  it('returns null when the payload is valid base64 but not a JSON object', () => {
    const tok = `h.${Buffer.from('"a string"', 'utf8').toString('base64url')}.s`;
    assert.equal(decodeJwtClaims(tok), null);
  });
});

// ---------------------------------------------------------------------------
// codexPlanFromAuthJson — surfaces the REAL ChatGPT plan from codex auth.json
// (chatgpt_plan_type in the OAuth token claim). No fabrication.
// ---------------------------------------------------------------------------

describe('codexPlanFromAuthJson — reads chatgpt_plan_type from the token claim', () => {
  it('surfaces the plan as a friendly label when the id_token carries chatgpt_plan_type', () => {
    assert.equal(codexPlanFromAuthJson(codexAuthJson('pro')), 'Pro');
  });

  it('normalizes + trims the plan label to a friendly name', () => {
    const raw = codexAuthJson('  PLUS  ');
    assert.equal(codexPlanFromAuthJson(raw), 'Plus');
  });

  it('maps the owner account slug "prolite" to its friendly label "Pro"', () => {
    assert.equal(codexPlanFromAuthJson(codexAuthJson('prolite')), 'Pro');
  });

  it('title-cases an unknown slug instead of showing the raw token', () => {
    assert.equal(codexPlanFromAuthJson(codexAuthJson('pro_max')), 'Pro Max');
  });

  it('falls back to access_token when id_token lacks the claim', () => {
    const authClaim = { chatgpt_plan_type: 'free' };
    const raw = JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: makeJwt({ sub: 'x' }), // no auth claim
        access_token: makeJwt({ 'https://api.openai.com/auth': authClaim }),
      },
    });
    assert.equal(codexPlanFromAuthJson(raw), 'Free');
  });

  it('returns null when no token carries a plan claim (API-key login)', () => {
    const raw = JSON.stringify({
      auth_mode: 'apikey',
      OPENAI_API_KEY: 'sk-xxx',
      tokens: { id_token: '', access_token: '' },
    });
    assert.equal(codexPlanFromAuthJson(raw), null);
  });

  it('returns null when the plan claim is present but empty', () => {
    assert.equal(codexPlanFromAuthJson(codexAuthJson('')), null);
    assert.equal(codexPlanFromAuthJson(codexAuthJson('   ')), null);
  });

  it('returns null on missing tokens / garbage / non-object (fail-soft, never throws)', () => {
    assert.doesNotThrow(() => codexPlanFromAuthJson('not json %%%'));
    assert.equal(codexPlanFromAuthJson('not json %%%'), null);
    assert.equal(codexPlanFromAuthJson('{}'), null);
    assert.equal(codexPlanFromAuthJson('null'), null);
    assert.equal(codexPlanFromAuthJson('[]'), null);
    assert.equal(codexPlanFromAuthJson(JSON.stringify({ tokens: null })), null);
  });
});

// ---------------------------------------------------------------------------
// resolveCodexAuthPath — honours CODEX_HOME, then persistent dir, then ~/.codex
// ---------------------------------------------------------------------------

describe('resolveCodexAuthPath', () => {
  it('uses $CODEX_HOME/auth.json when CODEX_HOME is set', () => {
    const p = resolveCodexAuthPath({ CODEX_HOME: '/persist/codex' }, '/work', '/home/u');
    assert.equal(p, '/persist/codex/auth.json');
  });

  it('falls back to ~/.codex/auth.json when CODEX_HOME is unset and no persistent dir', () => {
    // cwd points somewhere with no .replit-tools/.codex-persistent/auth.json.
    const p = resolveCodexAuthPath({}, '/nonexistent-cwd-xyz', '/home/u');
    assert.equal(p, '/home/u/.codex/auth.json');
  });
});

// ---------------------------------------------------------------------------
// opencodePlanFromAuthJson — TRUTHFUL: surfaces a ChatGPT plan ONLY when an
// oauth credential's token genuinely carries one; otherwise null (no fabrication
// for api/gateway keys like OpenCode Zen).
// ---------------------------------------------------------------------------

describe('opencodePlanFromAuthJson — only a genuinely-present oauth plan claim', () => {
  it('surfaces "provider: plan" when an oauth credential token carries a plan claim', () => {
    const raw = JSON.stringify({
      openai: {
        type: 'oauth',
        access: makeJwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } }),
        refresh: 'r',
        expires: 123,
      },
    });
    assert.equal(opencodePlanFromAuthJson(raw), 'openai: pro');
  });

  it('returns null for an api/gateway key (e.g. OpenCode Zen) — no plan is stored', () => {
    const raw = JSON.stringify({
      opencode: { type: 'api', key: 'sk-zen-xxx' },
    });
    assert.equal(opencodePlanFromAuthJson(raw), null);
  });

  it('returns null for an oauth credential whose token has no plan claim', () => {
    const raw = JSON.stringify({
      anthropic: { type: 'oauth', access: makeJwt({ sub: 'x' }), refresh: 'r', expires: 1 },
    });
    assert.equal(opencodePlanFromAuthJson(raw), null);
  });

  it('returns null for an oauth credential with a non-JWT access value', () => {
    const raw = JSON.stringify({
      anthropic: { type: 'oauth', access: 'opaque-token', refresh: 'r', expires: 1 },
    });
    assert.equal(opencodePlanFromAuthJson(raw), null);
  });

  it('returns null on empty / garbage / non-object input (fail-soft, never throws)', () => {
    assert.doesNotThrow(() => opencodePlanFromAuthJson('not json %%%'));
    assert.equal(opencodePlanFromAuthJson('not json %%%'), null);
    assert.equal(opencodePlanFromAuthJson('{}'), null);
    assert.equal(opencodePlanFromAuthJson('null'), null);
    assert.equal(opencodePlanFromAuthJson('[]'), null);
  });
});
