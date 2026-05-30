/**
 * Unit tests for src/commands/doctor.ts
 *
 * Exercises the pure buildDoctorReport() function with fake EnvironmentStatus
 * objects. No real spawning, no filesystem side-effects.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EnvironmentStatus, ProviderStatus } from '../../src/providers/detect.ts';
import type { DoctorExtras } from '../../src/commands/doctor.ts';
import { buildDoctorReport } from '../../src/commands/doctor.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProviderStatus(
  id: 'claude' | 'codex',
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
): EnvironmentStatus {
  const claude = makeProviderStatus('claude', claudeOverrides);
  const codex = makeProviderStatus('codex', codexOverrides);
  return {
    claude,
    codex,
    hasAnyProvider: claude.installed || codex.installed,
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
