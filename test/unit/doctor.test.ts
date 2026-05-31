/**
 * Unit tests for src/commands/doctor.ts
 *
 * Exercises the pure buildDoctorReport() function with fake EnvironmentStatus
 * objects. No real spawning, no filesystem side-effects.
 *
 * Also tests runDoctor() with opts.fix=true using fully-injected seams so no
 * real npm/login/detect subprocesses are ever spawned.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EnvironmentStatus, ProviderStatus } from '../../src/providers/detect.ts';
import type { DoctorExtras } from '../../src/commands/doctor.ts';
import { buildDoctorReport, runDoctor } from '../../src/commands/doctor.ts';
import type { OutputSink } from '../../src/interface/render.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProviderStatus(
  id: 'claude' | 'codex' | 'opencode',
  overrides?: Partial<ProviderStatus>,
): ProviderStatus {
  return {
    id,
    installed: false,
    version: null,
    authenticated: false,
    plan: null,
    binaryPath: null,
    availableModels: [],
    ...overrides,
  };
}

function makeEnv(
  claudeOverrides?: Partial<ProviderStatus>,
  codexOverrides?: Partial<ProviderStatus>,
  opencodeOverrides?: Partial<ProviderStatus>,
): EnvironmentStatus {
  const claude = makeProviderStatus('claude', claudeOverrides);
  const codex = makeProviderStatus('codex', codexOverrides);
  const opencode = makeProviderStatus('opencode', opencodeOverrides);
  return {
    claude,
    codex,
    opencode,
    hasAnyProvider: claude.installed || codex.installed || opencode.installed,
    platform: 'linux',
  };
}

const defaultExtras: DoctorExtras = {
  nodeVersion: 'v24.0.0',
  stateWritable: true,
  pricingStale: false,
};

// ---------------------------------------------------------------------------
// Claude installed + authenticated with plan, codex not installed
// ---------------------------------------------------------------------------

describe('buildDoctorReport — claude installed signed in with plan, codex not installed', () => {
  const env = makeEnv(
    {
      installed: true,
      version: '1.2.3',
      authenticated: true,
      plan: 'pro',
      binaryPath: 'claude',
    },
    { installed: false },
  );

  const lines = buildDoctorReport(env, defaultExtras, false);
  const output = lines.join('\n');

  it('does not throw', () => {
    assert.doesNotThrow(() => buildDoctorReport(env, defaultExtras, false));
  });

  it('mentions the claude version', () => {
    assert.ok(
      output.includes('1.2.3'),
      `expected claude version "1.2.3" in output:\n${output}`,
    );
  });

  it('mentions claude as installed', () => {
    const claudeLine = lines.find((l) => l.includes('claude') && l.includes('installed'));
    assert.ok(claudeLine !== undefined, 'expected a line mentioning claude installed');
  });

  it('shows "signed in" for authenticated claude', () => {
    assert.ok(
      output.includes('signed in'),
      `expected "signed in" auth status in output:\n${output}`,
    );
  });

  it('shows the plan label', () => {
    assert.ok(
      output.includes('pro'),
      `expected plan label "pro" in output:\n${output}`,
    );
  });

  it('does not contain old "assumed" wording', () => {
    assert.ok(
      !output.includes('assumed'),
      `expected no "assumed" wording in output:\n${output}`,
    );
  });

  it('mentions codex as not installed', () => {
    assert.ok(
      output.includes('not installed'),
      `expected "not installed" for codex in output:\n${output}`,
    );
  });

  it('includes the codex install command', () => {
    assert.ok(
      output.includes('npm install -g @openai/codex'),
      `expected codex install command in output:\n${output}`,
    );
  });

  it('shows the node version', () => {
    assert.ok(
      output.includes('v24.0.0'),
      `expected node version in output:\n${output}`,
    );
  });

  it('shows the platform', () => {
    assert.ok(
      output.includes('linux'),
      `expected platform "linux" in output:\n${output}`,
    );
  });

  it('reports overall "Ready" because claude is available', () => {
    assert.ok(
      output.includes('Ready'),
      `expected "Ready" status in output:\n${output}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Claude installed + authenticated, no plan
// ---------------------------------------------------------------------------

describe('buildDoctorReport — claude installed signed in, plan null', () => {
  const env = makeEnv(
    {
      installed: true,
      version: '1.2.3',
      authenticated: true,
      plan: null,
      binaryPath: 'claude',
    },
  );

  const lines = buildDoctorReport(env, defaultExtras, false);
  const output = lines.join('\n');

  it('shows "signed in"', () => {
    assert.ok(output.includes('signed in'), `expected "signed in" in output:\n${output}`);
  });

  it('does not show a plan label when plan is null', () => {
    // Should not show parenthesised plan string
    assert.ok(
      !output.includes('(null)') && !output.includes('(undefined)'),
      `expected no spurious plan label in output:\n${output}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Claude installed but NOT authenticated
// ---------------------------------------------------------------------------

describe('buildDoctorReport — claude installed but not signed in', () => {
  const env = makeEnv(
    {
      installed: true,
      version: '1.2.3',
      authenticated: false,
      plan: null,
      binaryPath: 'claude',
    },
  );

  const lines = buildDoctorReport(env, defaultExtras, false);
  const output = lines.join('\n');

  it('shows "not signed in"', () => {
    assert.ok(
      output.includes('not signed in'),
      `expected "not signed in" in output:\n${output}`,
    );
  });

  it('suggests running myshell-tools login', () => {
    assert.ok(
      output.includes('myshell-tools login'),
      `expected login suggestion in output:\n${output}`,
    );
  });

  it('does not show "signed in" without "not"', () => {
    // Ensure we see "not signed in" and not just "signed in" (positive)
    const signedInIdx = output.indexOf('signed in');
    const notSignedInIdx = output.indexOf('not signed in');
    assert.ok(
      notSignedInIdx !== -1,
      `expected "not signed in" in output:\n${output}`,
    );
    assert.equal(
      signedInIdx,
      notSignedInIdx + 'not '.length,
      `"signed in" should only appear as part of "not signed in"`,
    );
  });

  it('does not contain old "assumed" wording', () => {
    assert.ok(!output.includes('assumed'), `expected no "assumed" wording`);
  });
});

// ---------------------------------------------------------------------------
// Neither provider installed
// ---------------------------------------------------------------------------

describe('buildDoctorReport — no providers installed', () => {
  const env = makeEnv({ installed: false }, { installed: false });
  const lines = buildDoctorReport(env, defaultExtras, false);
  const output = lines.join('\n');

  it('does not throw', () => {
    assert.doesNotThrow(() => buildDoctorReport(env, defaultExtras, false));
  });

  it('reports "No providers found"', () => {
    assert.ok(
      output.includes('No providers found'),
      `expected "No providers found" in output:\n${output}`,
    );
  });

  it('includes install command for claude', () => {
    assert.ok(
      output.includes('npm install -g @anthropic-ai/claude-code'),
      `expected claude install command in output:\n${output}`,
    );
  });

  it('includes install command for codex', () => {
    assert.ok(
      output.includes('npm install -g @openai/codex'),
      `expected codex install command in output:\n${output}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Both providers installed
// ---------------------------------------------------------------------------

describe('buildDoctorReport — both providers installed and signed in', () => {
  const env = makeEnv(
    {
      installed: true,
      version: '2.0.0',
      authenticated: true,
      plan: 'pro',
      binaryPath: 'claude',
    },
    {
      installed: true,
      version: '0.5.0',
      authenticated: true,
      plan: null,
      binaryPath: 'codex',
    },
  );
  const lines = buildDoctorReport(env, defaultExtras, false);
  const output = lines.join('\n');

  it('does not throw', () => {
    assert.doesNotThrow(() => buildDoctorReport(env, defaultExtras, false));
  });

  it('mentions both provider versions', () => {
    assert.ok(output.includes('2.0.0'), `expected claude version 2.0.0 in output`);
    assert.ok(output.includes('0.5.0'), `expected codex version 0.5.0 in output`);
  });

  it('reports "Ready"', () => {
    assert.ok(output.includes('Ready'), `expected "Ready" in output`);
  });

  it('shows "signed in" for both providers', () => {
    const signedInCount = (output.match(/signed in/g) ?? []).length;
    assert.ok(signedInCount >= 2, `expected at least 2 "signed in" occurrences, got ${signedInCount}`);
  });
});

// ---------------------------------------------------------------------------
// Extras: pricing stale, .myshell-tools not writable
// ---------------------------------------------------------------------------

describe('buildDoctorReport — stale pricing and non-writable .myshell-tools', () => {
  const env = makeEnv({
    installed: true,
    version: '1.0.0',
    authenticated: true,
    plan: null,
    binaryPath: 'claude',
  });
  const extras: DoctorExtras = {
    nodeVersion: 'v20.0.0',
    stateWritable: false,
    pricingStale: true,
  };

  const lines = buildDoctorReport(env, extras, false);
  const output = lines.join('\n');

  it('reports .myshell-tools as not writable', () => {
    assert.ok(
      output.includes('not writable'),
      `expected "not writable" in output:\n${output}`,
    );
  });

  it('reports pricing as stale', () => {
    assert.ok(
      output.includes('stale'),
      `expected "stale" in output:\n${output}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Color output: ANSI codes present when color=true
// ---------------------------------------------------------------------------

describe('buildDoctorReport — color=true produces ANSI codes', () => {
  const env = makeEnv({
    installed: true,
    version: '1.0.0',
    authenticated: true,
    plan: null,
    binaryPath: 'claude',
  });
  const lines = buildDoctorReport(env, defaultExtras, true);
  const output = lines.join('\n');

  it('output contains ANSI escape codes when color=true', () => {
    assert.ok(
      output.includes('\x1b['),
      'expected ANSI codes when color=true',
    );
  });
});

// ---------------------------------------------------------------------------
// Color output: no ANSI codes when color=false
// ---------------------------------------------------------------------------

describe('buildDoctorReport — color=false produces plain text', () => {
  const env = makeEnv({
    installed: true,
    version: '1.0.0',
    authenticated: true,
    plan: null,
    binaryPath: 'claude',
  });
  const lines = buildDoctorReport(env, defaultExtras, false);
  const output = lines.join('\n');

  it('output contains no ANSI escape codes when color=false', () => {
    assert.ok(
      !output.includes('\x1b['),
      'expected no ANSI codes when color=false',
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers shared by fix-mode tests
// ---------------------------------------------------------------------------

function makeFakeOut(): { out: OutputSink; lines: string[] } {
  const lines: string[] = [];
  const out: OutputSink = {
    write: (s: string) => { lines.push(s); },
    color: false,
    isTty: false,
  };
  return { out, lines };
}

function makeFullEnv(overrides: {
  claude?: Partial<ProviderStatus>;
  codex?: Partial<ProviderStatus>;
  opencode?: Partial<ProviderStatus>;
}): EnvironmentStatus {
  const claude = makeProviderStatus('claude', overrides.claude);
  const codex = makeProviderStatus('codex', overrides.codex);
  const opencode = makeProviderStatus('opencode', overrides.opencode);
  return {
    claude,
    codex,
    opencode,
    hasAnyProvider: claude.installed || codex.installed || opencode.installed,
    platform: 'linux',
  };
}

// ---------------------------------------------------------------------------
// --fix mode: missing provider → install offered; answering y calls install
// ---------------------------------------------------------------------------

describe('runDoctor --fix — missing provider answered y calls installProvider', () => {
  it('calls installProvider for claude when answered y', async () => {
    const installCalls: string[] = [];
    const loginCalls: string[] = [];

    // All providers not installed initially; after "install" claude appears installed+authed.
    const initialEnv = makeFullEnv({});
    const afterInstallEnv = makeFullEnv({
      claude: { installed: true, authenticated: true, version: '1.0.0', binaryPath: 'claude' },
    });

    // Sequence: y for claude install, n for codex, n for opencode, then no sign-in needed
    // (claude is authed after install, others not installed)
    const answers = ['y', 'n', 'n'];
    let answerIdx = 0;
    const readLine = async () => answers[answerIdx++] ?? 'n';

    let detectCallCount = 0;
    const detectFn = async () => {
      detectCallCount++;
      // After install step (call 2+), return env with claude installed+authed
      return detectCallCount > 1 ? afterInstallEnv : initialEnv;
    };

    const installFn = async (id: 'claude' | 'codex' | 'opencode', _out: OutputSink) => {
      installCalls.push(id);
      return true;
    };
    const loginFn = async (_out: OutputSink, id?: string) => {
      loginCalls.push(id ?? 'all');
      return 0;
    };

    const { out } = makeFakeOut();
    await runDoctor(out, {
      fix: true,
      readLine,
      installProvider: installFn,
      login: loginFn,
      detectEnvironment: detectFn,
    });

    assert.deepEqual(installCalls, ['claude'], 'should have called installProvider only for claude');
    assert.deepEqual(loginCalls, [], 'no login should have been called — claude is authed after install');
  });
});

// ---------------------------------------------------------------------------
// --fix mode: missing provider answered n → install NOT called
// ---------------------------------------------------------------------------

describe('runDoctor --fix — missing provider answered n does not call installProvider', () => {
  it('does not call installProvider when user answers n', async () => {
    const installCalls: string[] = [];

    const env = makeFullEnv({});
    const readLine = async () => 'n';

    const { out } = makeFakeOut();
    await runDoctor(out, {
      fix: true,
      readLine,
      installProvider: async (id, _out) => { installCalls.push(id); return false; },
      login: async () => 0,
      detectEnvironment: async () => env,
    });

    assert.deepEqual(installCalls, [], 'installProvider must not be called when user answers n');
  });
});

// ---------------------------------------------------------------------------
// --fix mode: installed-but-unauthenticated → login offered; answering y calls login
// ---------------------------------------------------------------------------

describe('runDoctor --fix — installed+unauthenticated provider answered y calls login', () => {
  it('calls login for claude when it is installed but not authenticated and user answers y', async () => {
    const loginCalls: string[] = [];

    // claude installed but NOT authenticated; codex/opencode not installed.
    // Prompts: "Install codex?" (n), "Install opencode?" (n), "Sign in to claude?" (y).
    const env = makeFullEnv({
      claude: { installed: true, authenticated: false, version: '1.0.0', binaryPath: 'claude' },
    });

    const answers = ['n', 'n', 'y'];
    let idx = 0;
    const readLine = async () => answers[idx++] ?? 'n';

    const { out } = makeFakeOut();
    await runDoctor(out, {
      fix: true,
      readLine,
      installProvider: async (_id, _out) => false,
      login: async (_out, id) => { loginCalls.push(id ?? 'all'); return 0; },
      detectEnvironment: async () => env,
    });

    assert.deepEqual(loginCalls, ['claude'], 'login must be called for claude');
  });
});

// ---------------------------------------------------------------------------
// --fix mode: installed-but-unauthenticated → login offered; answering n skips
// ---------------------------------------------------------------------------

describe('runDoctor --fix — installed+unauthenticated provider answered n skips login', () => {
  it('does not call login when user answers n for the sign-in prompt', async () => {
    const loginCalls: string[] = [];

    // claude installed+unauthenticated; codex/opencode not installed.
    // Prompts: "Install codex?" (n), "Install opencode?" (n), "Sign in to claude?" (n).
    const env = makeFullEnv({
      claude: { installed: true, authenticated: false, version: '1.0.0', binaryPath: 'claude' },
    });

    const readLine = async () => 'n';

    const { out } = makeFakeOut();
    await runDoctor(out, {
      fix: true,
      readLine,
      installProvider: async (_id, _out) => false,
      login: async (_out, id) => { loginCalls.push(id ?? 'all'); return 0; },
      detectEnvironment: async () => env,
    });

    assert.deepEqual(loginCalls, [], 'login must not be called when user answers n');
  });
});

// ---------------------------------------------------------------------------
// --fix mode: opencode not installed → install offered, but no sign-in prompt
// ---------------------------------------------------------------------------

describe('runDoctor --fix — opencode not installed: install offered, no sign-in prompted', () => {
  it('offers install for opencode but does not prompt sign-in (opencode authed when installed)', async () => {
    const installCalls: string[] = [];
    const loginCalls: string[] = [];

    const initialEnv = makeFullEnv({});
    // After install: opencode appears installed AND authenticated (free models, no creds needed)
    const afterInstallEnv = makeFullEnv({
      opencode: { installed: true, authenticated: true, version: '0.1.0', binaryPath: 'opencode' },
    });

    // Answers: n (claude), n (codex), y (opencode install)
    const answers = ['n', 'n', 'y'];
    let idx = 0;
    const readLine = async () => answers[idx++] ?? 'n';

    let detectCallCount = 0;
    const detectFn = async () => {
      detectCallCount++;
      return detectCallCount > 1 ? afterInstallEnv : initialEnv;
    };

    const { out } = makeFakeOut();
    await runDoctor(out, {
      fix: true,
      readLine,
      installProvider: async (id, _out) => { installCalls.push(id); return true; },
      login: async (_out, id) => { loginCalls.push(id ?? 'all'); return 0; },
      detectEnvironment: detectFn,
    });

    assert.deepEqual(installCalls, ['opencode'], 'install should have been offered and accepted for opencode');
    assert.deepEqual(loginCalls, [], 'no login should have been offered — opencode is authed when installed');
  });
});

// ---------------------------------------------------------------------------
// --fix mode: no opts.fix → behavior identical to today (no prompts)
// ---------------------------------------------------------------------------

describe('runDoctor without fix — identical to original behavior', () => {
  it('returns 1 and does not prompt when no providers are installed', async () => {
    const installCalls: string[] = [];
    const loginCalls: string[] = [];
    const env = makeFullEnv({});

    const readLine = async () => { throw new Error('readLine must not be called'); };

    const { out, lines } = makeFakeOut();
    const code = await runDoctor(out, {
      // fix is absent — default mode
      readLine,
      installProvider: async (id, _out) => { installCalls.push(id); return false; },
      login: async (_out, id) => { loginCalls.push(id ?? 'all'); return 0; },
      detectEnvironment: async () => env,
    });

    assert.equal(code, 1, 'should return 1 when no providers installed');
    assert.deepEqual(installCalls, [], 'installProvider must not be called without --fix');
    assert.deepEqual(loginCalls, [], 'login must not be called without --fix');
    const output = lines.join('');
    assert.ok(output.includes('No providers found'), 'should include normal report text');
  });
});

// ---------------------------------------------------------------------------
// --fix mode: final status summary is printed
// ---------------------------------------------------------------------------

describe('runDoctor --fix — prints a final status summary after fix pass', () => {
  it('prints installed+signed-in confirmation for a provider that was already ready', async () => {
    const env = makeFullEnv({
      claude: { installed: true, authenticated: true, version: '1.0.0', binaryPath: 'claude' },
    });

    // No missing providers to install → no install prompts, no auth prompts (claude already authed)
    const readLine = async () => 'n';

    const { out, lines } = makeFakeOut();
    await runDoctor(out, {
      fix: true,
      readLine,
      installProvider: async (_id, _out) => false,
      login: async () => 0,
      detectEnvironment: async () => env,
    });

    const output = lines.join('');
    assert.ok(
      output.includes('claude: installed, signed in'),
      `expected final status for claude in output:\n${output}`,
    );
  });
});
