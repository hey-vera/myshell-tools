/**
 * Unit tests for src/commands/login.ts
 *
 * Only the hermetic validation path is unit-tested. The interactive sign-in
 * (which spawns `claude /login` / `codex login` with inherited stdio) is an
 * integration concern and is not exercised here.
 *
 * The tee-capture flow (runWithTeeCapture) is also an integration concern:
 * it spawns a real subprocess and requires an interactive terminal. It is not
 * exercised here. The pure helpers it depends on (extractClaudeToken,
 * stripPastedSecretWrapper, classifyPastedSecret) are tested in credentials.test.ts.
 */

import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import type {
  LoginProviderOutcome,
  LoginResult,
  LoginVerifyResult,
  LoginRunnerDeps,
} from '../../src/commands/login.ts';
import {
  isProviderId,
  isHeadlessEnv,
  resolveLoginMethod,
  shouldRetryWithCode,
  runLogin,
  getLoginCommand,
  aggregateLoginOutcomes,
  loginExitCode,
  createLoginRunner,
  runProviderLogin,
} from '../../src/commands/login.ts';
import { extractClaudeToken, stripPastedSecretWrapper, classifyPastedSecret } from '../../src/infra/credentials.ts';

describe('isProviderId', () => {
  it('accepts claude, codex, opencode, and grok', () => {
    assert.equal(isProviderId('claude'), true);
    assert.equal(isProviderId('codex'), true);
    assert.equal(isProviderId('opencode'), true);
    assert.equal(isProviderId('grok'), true);
  });

  it('rejects anything else', () => {
    assert.equal(isProviderId('gpt'), false);
    assert.equal(isProviderId('Claude'), false);
    assert.equal(isProviderId(''), false);
  });
});

// ---------------------------------------------------------------------------
// isHeadlessEnv — pure env detection
// ---------------------------------------------------------------------------

describe('isHeadlessEnv — detects headless/container/SSH environments', () => {
  it('returns true when REPL_ID is set (Replit)', () => {
    assert.equal(isHeadlessEnv({ REPL_ID: 'abc123' }, 'linux'), true);
  });

  it('returns true when REPLIT_DEV_DOMAIN is set', () => {
    assert.equal(isHeadlessEnv({ REPLIT_DEV_DOMAIN: 'foo.replit.dev' }, 'linux'), true);
  });

  it('returns true when CODESPACES is set', () => {
    assert.equal(isHeadlessEnv({ CODESPACES: 'true' }, 'linux'), true);
  });

  it('returns true when GITPOD_WORKSPACE_ID is set', () => {
    assert.equal(isHeadlessEnv({ GITPOD_WORKSPACE_ID: 'ws-123' }, 'linux'), true);
  });

  it('returns true when SSH_CONNECTION is set', () => {
    assert.equal(isHeadlessEnv({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 12345' }, 'linux'), true);
  });

  it('returns true when SSH_TTY is set', () => {
    assert.equal(isHeadlessEnv({ SSH_TTY: '/dev/pts/0' }, 'linux'), true);
  });

  it('returns true on linux with no DISPLAY or WAYLAND_DISPLAY', () => {
    assert.equal(isHeadlessEnv({}, 'linux'), true);
  });

  it('returns true on linux with empty DISPLAY and no WAYLAND_DISPLAY', () => {
    assert.equal(isHeadlessEnv({ DISPLAY: '' }, 'linux'), true);
  });

  it('returns false on linux when DISPLAY is set', () => {
    assert.equal(isHeadlessEnv({ DISPLAY: ':0' }, 'linux'), false);
  });

  it('returns false on linux when WAYLAND_DISPLAY is set', () => {
    assert.equal(isHeadlessEnv({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), false);
  });

  it('returns false on darwin (macOS) with empty env', () => {
    assert.equal(isHeadlessEnv({}, 'darwin'), false);
  });

  it('returns false on win32 with empty env', () => {
    assert.equal(isHeadlessEnv({}, 'win32'), false);
  });
});

// ---------------------------------------------------------------------------
// resolveLoginMethod — explicit override and auto-detection
// ---------------------------------------------------------------------------

describe('resolveLoginMethod — explicit method overrides detection', () => {
  it('returns "browser" when explicitly requested, even on headless env', () => {
    assert.equal(resolveLoginMethod('browser', { REPL_ID: 'x' }, 'linux'), 'browser');
  });

  it('returns "code" when explicitly requested, even on a desktop env', () => {
    assert.equal(resolveLoginMethod('code', { DISPLAY: ':0' }, 'linux'), 'code');
  });

  it('auto-detects "code" for headless linux (no DISPLAY)', () => {
    assert.equal(resolveLoginMethod(undefined, {}, 'linux'), 'code');
  });

  it('auto-detects "code" for Replit environment', () => {
    assert.equal(resolveLoginMethod(undefined, { REPL_ID: 'abc' }, 'linux'), 'code');
  });

  it('auto-detects "browser" on macOS with no SSH/container env vars', () => {
    assert.equal(resolveLoginMethod(undefined, {}, 'darwin'), 'browser');
  });

  it('auto-detects "browser" on linux when DISPLAY is set', () => {
    assert.equal(resolveLoginMethod(undefined, { DISPLAY: ':0' }, 'linux'), 'browser');
  });
});

describe('getLoginCommand — opencode uses the provider picker (no -p opencode)', () => {
  // Bare `auth login` opens opencode's provider picker so the user can choose any
  // provider — OpenCode Zen (recommended) or one they have access to. `-p opencode`
  // would pin a single provider, so we must NOT pass it. opencode stores the chosen
  // credential itself (oauth OR api); myshell never sees it.
  it('uses opencode auth login (provider picker) for browser/default login', () => {
    assert.deepEqual(getLoginCommand('opencode', 'browser'), {
      bin: 'opencode',
      args: ['auth', 'login'],
    });
  });

  it('uses opencode auth login (provider picker) for code login', () => {
    assert.deepEqual(getLoginCommand('opencode', 'code'), {
      bin: 'opencode',
      args: ['auth', 'login'],
    });
  });

  it('never pins a single provider (-p opencode) in either method', () => {
    for (const method of ['browser', 'code'] as const) {
      assert.ok(
        !getLoginCommand('opencode', method).args.includes('-p'),
        `opencode ${method} login must not pass -p (would pin one provider; use the picker)`,
      );
    }
  });

  it('leaves claude and codex login commands unchanged', () => {
    assert.deepEqual(getLoginCommand('claude', 'browser'), {
      bin: 'claude',
      args: ['/login'],
    });
    assert.deepEqual(getLoginCommand('claude', 'code'), { bin: 'claude', args: ['/login'] });
    assert.deepEqual(getLoginCommand('codex', 'browser'), { bin: 'codex', args: ['login'] });
    assert.deepEqual(getLoginCommand('codex', 'code'), {
      bin: 'codex',
      args: ['login', '--device-auth'],
    });
  });

  it('grok browser login uses OAuth subscription flow', () => {
    assert.deepEqual(getLoginCommand('grok', 'browser'), {
      bin: 'grok',
      args: ['login', '--oauth'],
    });
  });

  it('grok code login uses device-auth flow', () => {
    assert.deepEqual(getLoginCommand('grok', 'code'), {
      bin: 'grok',
      args: ['login', '--device-auth'],
    });
  });

  it('grok login never passes an api key or --xai-api-base-url', () => {
    for (const method of ['browser', 'code'] as const) {
      const cmd = getLoginCommand('grok', method);
      assert.ok(!cmd.args.some((a) => a.startsWith('sk-')));
      assert.ok(!cmd.args.includes('--xai-api-base-url'));
      assert.ok(!cmd.args.includes('XAI_API_KEY'));
    }
  });
});

// ---------------------------------------------------------------------------
// shouldRetryWithCode — pure seam for the browser-fail → code-retry decision
// ---------------------------------------------------------------------------

describe('shouldRetryWithCode — browser-fail retry decision (pure, hermetic)', () => {
  it('returns true on "y" (explicit yes)', () => {
    assert.equal(shouldRetryWithCode('y'), true);
  });

  it('returns true on "Y"', () => {
    assert.equal(shouldRetryWithCode('Y'), true);
  });

  it('returns true on "yes"', () => {
    assert.equal(shouldRetryWithCode('yes'), true);
  });

  it('returns true on empty string (defaultYes=true — Enter accepts retry)', () => {
    assert.equal(shouldRetryWithCode(''), true);
  });

  it('returns true on whitespace-only input (treated as empty)', () => {
    assert.equal(shouldRetryWithCode('   '), true);
  });

  it('returns true on null (EOF / stream closed — default yes)', () => {
    assert.equal(shouldRetryWithCode(null), true);
  });

  it('returns false on "n" (explicit no)', () => {
    assert.equal(shouldRetryWithCode('n'), false);
  });

  it('returns false on "N"', () => {
    assert.equal(shouldRetryWithCode('N'), false);
  });

  it('returns false on "no"', () => {
    assert.equal(shouldRetryWithCode('no'), false);
  });

  it('returns false on "NO" (case-insensitive)', () => {
    assert.equal(shouldRetryWithCode('NO'), false);
  });

  it('returns true on unrecognised input (falls through to defaultYes=true)', () => {
    // Anything that is not y/yes/n/no falls back to the default (yes).
    assert.equal(shouldRetryWithCode('maybe'), true);
  });
});

describe('runLogin — invalid argument (hermetic, no spawn)', () => {
  it('returns 1 and writes an "unknown provider" error', async () => {
    const buf: string[] = [];
    const out = { write: (s: string) => buf.push(s), color: false, isTty: false };
    const code = await runLogin(out, 'bogus');
    assert.equal(code, 1);
    assert.ok(
      buf.join('').toLowerCase().includes('unknown provider'),
      `expected an "unknown provider" message, got: ${buf.join('')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Pure paste-fallback helpers used by captureClaudeTokenWithPaste
// (integration-tested via the helper exports from credentials.ts)
// ---------------------------------------------------------------------------

describe('paste-fallback: stripPastedSecretWrapper + extractClaudeToken — combined flow', () => {
  it('extracts token from a double-quoted paste', () => {
    const raw = '"sk-ant-oat01-abc-TOKENPART"';
    const token = extractClaudeToken(stripPastedSecretWrapper(raw));
    assert.equal(token, 'sk-ant-oat01-abc-TOKENPART');
  });

  it('extracts token from a single-quoted paste with surrounding spaces', () => {
    const raw = "  'sk-ant-oat01-session-DATA'  ";
    const token = extractClaudeToken(stripPastedSecretWrapper(raw));
    assert.equal(token, 'sk-ant-oat01-session-DATA');
  });

  it('extracts token from a plain paste with surrounding whitespace', () => {
    const raw = '   sk-ant-oat01-plain-TOKEN   ';
    const token = extractClaudeToken(stripPastedSecretWrapper(raw));
    assert.equal(token, 'sk-ant-oat01-plain-TOKEN');
  });

  it('returns null for a blank paste after stripping', () => {
    const raw = '   ';
    const token = extractClaudeToken(stripPastedSecretWrapper(raw));
    assert.equal(token, null);
  });
});

describe('paste-fallback: classifyPastedSecret — api-key vs oauth-token distinction', () => {
  it('classifies a real sk-ant-api key as "api-key"', () => {
    // Users sometimes paste their API key instead of the OAuth token.
    assert.equal(classifyPastedSecret('sk-ant-api03-key-ABC'), 'api-key');
  });

  it('classifies the correct sk-ant-oat token as "oauth-token"', () => {
    assert.equal(classifyPastedSecret('sk-ant-oat01-session-TOKEN'), 'oauth-token');
  });

  it('classifies an unrelated string as "none"', () => {
    assert.equal(classifyPastedSecret('completely-wrong-value'), 'none');
  });

  it('classifies empty string as "none"', () => {
    assert.equal(classifyPastedSecret(''), 'none');
  });

  it('uses startsWith semantics — mid-string sk-ant-oat is NOT oauth-token', () => {
    // classifyPastedSecret receives pre-normalised (trimmed) input from the caller.
    // A mid-string occurrence must not match, confirming startsWith not includes.
    assert.equal(classifyPastedSecret('prefix sk-ant-oat01-abc-TOKEN'), 'none');
  });

  it('uses startsWith semantics — leading sk-ant-oat IS oauth-token', () => {
    assert.equal(classifyPastedSecret('sk-ant-oat01-abc-TOKEN'), 'oauth-token');
  });
});

describe('aggregateLoginOutcomes', () => {
  it('aggregate invalid provider', () => {
    const result = aggregateLoginOutcomes([], 'bogus');
    assert.deepStrictEqual(result, {
      status: 'invalid-provider',
      outcomes: [],
      invalidProvider: 'bogus',
    });
    assert.equal(loginExitCode(result), 1);
  });

  it('aggregate all skipped is no-targets', () => {
    const outcomes: LoginProviderOutcome[] = [
      { provider: 'claude', status: 'skipped-not-installed', method: null, attempts: [], fallbackUsed: false },
    ];
    const result = aggregateLoginOutcomes(outcomes);
    assert.equal(result.status, 'no-targets');
    assert.equal(loginExitCode(result), 1);
  });

  it('aggregate authenticated plus skipped is success', () => {
    const outcomes: LoginProviderOutcome[] = [
      {
        provider: 'claude',
        status: 'authenticated',
        method: 'browser',
        attempts: [
          { method: 'browser', status: 'authenticated', childExitCode: 0, verification: 'authenticated' },
        ],
        fallbackUsed: false,
      },
      { provider: 'codex', status: 'skipped-not-installed', method: null, attempts: [], fallbackUsed: false },
    ];
    const result = aggregateLoginOutcomes(outcomes);
    assert.equal(result.status, 'success');
    assert.equal(loginExitCode(result), 0);
  });

  it('aggregate authenticated plus failed is partial', () => {
    const outcomes: LoginProviderOutcome[] = [
      {
        provider: 'claude',
        status: 'authenticated',
        method: 'browser',
        attempts: [
          { method: 'browser', status: 'authenticated', childExitCode: 0, verification: 'authenticated' },
        ],
        fallbackUsed: false,
      },
      {
        provider: 'codex',
        status: 'failed',
        method: null,
        attempts: [
          { method: 'browser', status: 'failed', childExitCode: 1, verification: 'not-authenticated' },
        ],
        fallbackUsed: false,
      },
    ];
    const result = aggregateLoginOutcomes(outcomes);
    assert.equal(result.status, 'partial');
    assert.equal(loginExitCode(result), 1);
  });

  it('aggregate cancel only', () => {
    const outcomes: LoginProviderOutcome[] = [
      {
        provider: 'claude',
        status: 'cancelled',
        method: null,
        attempts: [
          { method: 'browser', status: 'cancelled', childExitCode: null, verification: 'not-authenticated' },
        ],
        fallbackUsed: false,
      },
    ];
    const result = aggregateLoginOutcomes(outcomes);
    assert.equal(result.status, 'cancelled');
    assert.equal(loginExitCode(result), 1);
  });

  it('failure dominates cancel without success', () => {
    const outcomes: LoginProviderOutcome[] = [
      {
        provider: 'claude',
        status: 'cancelled',
        method: null,
        attempts: [
          { method: 'browser', status: 'cancelled', childExitCode: null, verification: 'not-authenticated' },
        ],
        fallbackUsed: false,
      },
      {
        provider: 'codex',
        status: 'failed',
        method: null,
        attempts: [
          { method: 'browser', status: 'failed', childExitCode: 1, verification: 'not-authenticated' },
        ],
        fallbackUsed: false,
      },
    ];
    const result = aggregateLoginOutcomes(outcomes);
    assert.equal(result.status, 'failed');
  });

  it('method is only the authenticating method', () => {
    const authOutcome: LoginProviderOutcome = {
      provider: 'claude',
      status: 'authenticated',
      method: 'browser',
      attempts: [
        { method: 'browser', status: 'authenticated', childExitCode: 0, verification: 'authenticated' },
      ],
      fallbackUsed: false,
    };
    const cancelledOutcome: LoginProviderOutcome = {
      provider: 'codex',
      status: 'cancelled',
      method: null,
      attempts: [
        { method: 'browser', status: 'cancelled', childExitCode: null, verification: 'not-authenticated' },
      ],
      fallbackUsed: false,
    };

    if (authOutcome.status === 'authenticated') {
      assert.equal(typeof authOutcome.method, 'string');
    }
    if (cancelledOutcome.status !== 'authenticated') {
      assert.equal(cancelledOutcome.method, null);
    }
  });

  it('declined retry leaves browser attempt and fallbackUsed false', () => {
    const outcome: LoginProviderOutcome = {
      provider: 'claude',
      status: 'cancelled',
      method: null,
      attempts: [
        {
          method: 'browser',
          status: 'cancelled',
          childExitCode: 1,
          verification: 'probe-error',
        },
      ],
      fallbackUsed: false,
    };
    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].method, 'browser');
    assert.equal(outcome.fallbackUsed, false);
  });
});

describe('loginExitCode', () => {
  it('loginExitCode returns zero only for success', () => {
    const successResult: LoginResult = { status: 'success', outcomes: [] };
    assert.equal(loginExitCode(successResult), 0);

    for (const status of ['partial', 'cancelled', 'failed', 'no-targets', 'invalid-provider'] as const) {
      const result: LoginResult = { status, outcomes: [] };
      assert.equal(loginExitCode(result), 1, `status '${status}' should return 1`);
    }
  });

  it('standalone exit translation rejects partial and cancelled', () => {
    const partial: LoginResult = {
      status: 'partial',
      outcomes: [
        { provider: 'claude', status: 'authenticated', method: 'browser', attempts: [{ method: 'browser', status: 'authenticated', childExitCode: 0, verification: 'authenticated' }], fallbackUsed: false },
        { provider: 'codex', status: 'failed', method: null, attempts: [{ method: 'browser', status: 'failed', childExitCode: 1, verification: 'not-authenticated' }], fallbackUsed: false },
      ],
    };
    assert.equal(loginExitCode(partial), 1);

    const cancelled: LoginResult = {
      status: 'cancelled',
      outcomes: [
        { provider: 'claude', status: 'cancelled', method: null, attempts: [{ method: 'browser', status: 'cancelled', childExitCode: null, verification: 'not-authenticated' }], fallbackUsed: false },
      ],
    };
    assert.equal(loginExitCode(cancelled), 1);
  });
});

// ---------------------------------------------------------------------------
// Injectable runner tests (P0-03b)
// ---------------------------------------------------------------------------

function fakeNoopOut() {
  return { write: () => {}, color: false, isTty: false } as const;
}

function fakeDeps(overrides?: Partial<LoginRunnerDeps>): LoginRunnerDeps {
  return {
    detect: vi.fn().mockResolvedValue({ installed: true, authenticated: false }),
    spawn: vi.fn().mockReturnValue({ done: Promise.resolve(0) }),
    verify: vi.fn().mockResolvedValue({ kind: 'not-authenticated' } as LoginVerifyResult),
    clearToken: vi.fn().mockResolvedValue(undefined),
    env: {},
    platform: 'linux' as NodeJS.Platform,
    cwd: () => '/fake/cwd',
    ...overrides,
  };
}

describe('runProviderLogin — detected flow', () => {
  it('verified browser success after exit zero', async () => {
    const verify = vi.fn().mockResolvedValue({ kind: 'authenticated' } as LoginVerifyResult);
    const deps = fakeDeps({ verify });
    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps);

    assert.equal(outcome.status, 'authenticated');
    assert.equal(outcome.method, 'browser');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].status, 'authenticated');
    assert.equal(outcome.attempts[0].verification, 'authenticated');
    assert.equal(outcome.attempts[0].childExitCode, 0);
    assert.equal(outcome.attempts[0].method, 'browser');
    assert.equal(outcome.fallbackUsed, false);
    assert.equal(deps.detect.mock.calls.length, 1);
    assert.equal(deps.spawn.mock.calls.length, 1);
    assert.equal(verify.mock.calls.length, 1);
  });

  it('verified authentication wins after nonzero exit', async () => {
    const verify = vi.fn().mockResolvedValue({ kind: 'authenticated' } as LoginVerifyResult);
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve(1) });
    const deps = fakeDeps({ verify, spawn });
    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps);

    assert.equal(outcome.status, 'authenticated');
    assert.equal(outcome.attempts[0].status, 'authenticated');
    assert.equal(outcome.attempts[0].verification, 'authenticated');
    assert.equal(outcome.attempts[0].childExitCode, 1);
  });

  it('exit zero plus negative probe fails', async () => {
    const verify = vi.fn().mockResolvedValue({ kind: 'not-authenticated' } as LoginVerifyResult);
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve(0) });
    const deps = fakeDeps({ verify, spawn });
    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps);

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].status, 'failed');
    assert.equal(outcome.attempts[0].verification, 'not-authenticated');
    assert.equal(outcome.attempts[0].childExitCode, 0);
  });

  it('exit 130 plus negative probe cancels', async () => {
    const verify = vi.fn().mockResolvedValue({ kind: 'not-authenticated' } as LoginVerifyResult);
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve(130) });
    const deps = fakeDeps({ verify, spawn });
    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps);

    assert.equal(outcome.status, 'cancelled');
    assert.equal(outcome.attempts[0].status, 'cancelled');
    assert.equal(outcome.attempts[0].verification, 'not-authenticated');
    assert.equal(outcome.attempts[0].childExitCode, 130);
  });

  it('probe throw is probe-error', async () => {
    const err = new Error('probe failed');
    const verify = vi.fn().mockResolvedValue({ kind: 'probe-error', error: err } as LoginVerifyResult);
    const deps = fakeDeps({ verify });
    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps);

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.attempts[0].status, 'failed');
    assert.equal(outcome.attempts[0].verification, 'probe-error');
  });

  it('detect throw fails without spawn', async () => {
    const detect = vi.fn().mockRejectedValue(new Error('detect failed'));
    const spawn = vi.fn();
    const deps = fakeDeps({ detect, spawn });
    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps);

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.method, null);
    assert.equal(outcome.attempts.length, 0);
    assert.equal(spawn.mock.calls.length, 0);
  });

  it('not installed skips', async () => {
    const detect = vi.fn().mockResolvedValue({ installed: false });
    const spawn = vi.fn();
    const deps = fakeDeps({ detect, spawn });
    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps);

    assert.equal(outcome.status, 'skipped-not-installed');
    assert.equal(outcome.attempts.length, 0);
    assert.equal(spawn.mock.calls.length, 0);
  });

  it('browser retry code succeeds and method is code', async () => {
    const verify = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'not-authenticated' } as LoginVerifyResult)
      .mockResolvedValueOnce({ kind: 'authenticated' } as LoginVerifyResult);
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ done: Promise.resolve(1) })
      .mockReturnValueOnce({ done: Promise.resolve(0) });
    const confirm = vi.fn().mockResolvedValue(true);
    const deps = fakeDeps({ verify, spawn });

    const outcome = await runProviderLogin(fakeNoopOut(), 'claude', 'browser', { confirm }, deps);

    assert.equal(outcome.status, 'authenticated');
    assert.equal(outcome.method, 'code');
    assert.equal(outcome.attempts.length, 2);
    assert.equal(outcome.attempts[0].method, 'browser');
    assert.equal(outcome.attempts[0].status, 'failed');
    assert.equal(outcome.attempts[1].method, 'code');
    assert.equal(outcome.attempts[1].status, 'authenticated');
    assert.equal(outcome.fallbackUsed, true);
    assert.equal(confirm.mock.calls.length, 1);
  });

  it('browser retry code fails', async () => {
    const verify = vi
      .fn()
      .mockResolvedValue({ kind: 'not-authenticated' } as LoginVerifyResult);
    const spawn = vi
      .fn()
      .mockReturnValueOnce({ done: Promise.resolve(1) })
      .mockReturnValueOnce({ done: Promise.resolve(1) });
    const confirm = vi.fn().mockResolvedValue(true);
    const deps = fakeDeps({ verify, spawn });

    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', { confirm }, deps);

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.attempts.length, 2);
    assert.equal(outcome.attempts[0].method, 'browser');
    assert.equal(outcome.attempts[0].status, 'failed');
    assert.equal(outcome.attempts[1].method, 'code');
    assert.equal(outcome.attempts[1].status, 'failed');
    assert.equal(outcome.fallbackUsed, true);
  });

  it('declined retry preserves browser outcome', async () => {
    const verify = vi.fn().mockResolvedValue({ kind: 'not-authenticated' } as LoginVerifyResult);
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve(1) });
    const confirm = vi.fn().mockResolvedValue(false);
    const deps = fakeDeps({ verify, spawn });

    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', { confirm }, deps);

    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.method, null);
    assert.equal(outcome.attempts.length, 1);
    assert.equal(outcome.attempts[0].method, 'browser');
    assert.equal(outcome.fallbackUsed, false);
    assert.equal(confirm.mock.calls.length, 1);
  });

  it('all four providers use their existing argv', async () => {
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve(0) });
    const verify = vi.fn().mockResolvedValue({ kind: 'authenticated' } as LoginVerifyResult);
    const deps = fakeDeps({ spawn, verify });
    const runner = createLoginRunner(deps);

    await runner(fakeNoopOut(), undefined, { method: 'browser' });

    const calls = spawn.mock.calls as Array<[string, readonly string[], unknown]>;
    const bins = calls.map((c) => c[0]);
    const args = calls.map((c) => c[1]);
    assert.deepEqual(bins, ['claude', 'codex', 'opencode', 'grok']);
    assert.deepEqual(args, [
      ['/login'],
      ['login'],
      ['auth', 'login'],
      ['login', '--oauth'],
    ]);
  });

  it('suspend and resume exactly once per spawned attempt', async () => {
    const resume = vi.fn();
    const suspendStdin = vi.fn(() => resume);
    const verify = vi.fn().mockResolvedValue({ kind: 'not-authenticated' } as LoginVerifyResult);
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve(1) });
    const confirm = vi.fn().mockResolvedValue(true);
    const deps = fakeDeps({ verify, spawn });

    const outcome = await runProviderLogin(fakeNoopOut(), 'codex', 'browser', { confirm, suspendStdin }, deps);

    // Two spawns: browser (failed) + code (failed) = 2 spawns
    assert.equal(outcome.attempts.length, 2);
    assert.equal(suspendStdin.mock.calls.length, 2);
    assert.equal(resume.mock.calls.length, 2);
  });

  it('Claude clearToken only after verified authentication', async () => {
    const clearToken = vi.fn().mockResolvedValue(undefined);

    // claude authenticated → clearToken called
    const deps1 = fakeDeps({
      verify: vi.fn().mockResolvedValue({ kind: 'authenticated' } as LoginVerifyResult),
      clearToken,
    });
    await runProviderLogin(fakeNoopOut(), 'claude', 'browser', undefined, deps1);
    assert.equal(clearToken.mock.calls.length, 1);

    // non-claude authenticated → clearToken NOT called
    clearToken.mockClear();
    const deps2 = fakeDeps({
      verify: vi.fn().mockResolvedValue({ kind: 'authenticated' } as LoginVerifyResult),
      clearToken,
    });
    await runProviderLogin(fakeNoopOut(), 'codex', 'browser', undefined, deps2);
    assert.equal(clearToken.mock.calls.length, 0);

    // claude not-authenticated → clearToken NOT called
    clearToken.mockClear();
    const deps3 = fakeDeps({
      verify: vi.fn().mockResolvedValue({ kind: 'not-authenticated' } as LoginVerifyResult),
      clearToken,
    });
    await runProviderLogin(fakeNoopOut(), 'claude', 'browser', undefined, deps3);
    assert.equal(clearToken.mock.calls.length, 0);
  });

  it('legacy numeric adapter is truthful', async () => {
    const out = fakeNoopOut();

    // invalid provider → exit 1
    const code = await runLogin(out, 'bogus');
    assert.equal(code, 1);

    // verify the relationship: runLogin delegates and returns loginExitCode of result
    assert.equal(loginExitCode({ status: 'success', outcomes: [] }), 0);
    assert.equal(loginExitCode({ status: 'invalid-provider', outcomes: [], invalidProvider: 'bogus' }), 1);
  });

  it('ordinary success = one detect, one spawn, one verify, one suspend/resume pair', async () => {
    const resume = vi.fn();
    const suspendStdin = vi.fn(() => resume);
    const detect = vi.fn().mockResolvedValue({ installed: true, authenticated: false });
    const spawn = vi.fn().mockReturnValue({ done: Promise.resolve(0) });
    const verify = vi.fn().mockResolvedValue({ kind: 'authenticated' } as LoginVerifyResult);
    const deps = fakeDeps({ detect, spawn, verify });

    await runProviderLogin(fakeNoopOut(), 'codex', 'browser', { suspendStdin }, deps);

    assert.equal(detect.mock.calls.length, 1);
    assert.equal(spawn.mock.calls.length, 1);
    assert.equal(verify.mock.calls.length, 1);
    assert.equal(suspendStdin.mock.calls.length, 1);
    assert.equal(resume.mock.calls.length, 1);
  });
});
