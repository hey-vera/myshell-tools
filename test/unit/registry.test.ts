/**
 * Unit tests for src/providers/registry.ts
 *
 * buildProviders now accepts a pre-detected EnvironmentStatus (no internal spawn).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { buildProviders, buildAuthenticatedProviders } from '../../src/providers/registry.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<{
  claudeInstalled: boolean;
  codexInstalled: boolean;
  opencodeInstalled: boolean;
  grokInstalled: boolean;
}>): EnvironmentStatus {
  const { claudeInstalled = false, codexInstalled = false, opencodeInstalled = false, grokInstalled = false } = overrides;
  const base = {
    installed: false,
    version: null,
    authenticated: false,
    plan: null,
    binaryPath: null,
    availableModels: [] as readonly string[],
  };
  return {
    claude: { ...base, id: 'claude', installed: claudeInstalled },
    codex: { ...base, id: 'codex', installed: codexInstalled },
    opencode: { ...base, id: 'opencode', installed: opencodeInstalled },
    grok: { ...base, id: 'grok', installed: grokInstalled },
    hasAnyProvider: claudeInstalled || codexInstalled || opencodeInstalled || grokInstalled,
    platform: process.platform,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildProviders — synchronous, accepts pre-detected env', () => {
  it('returns an empty map when no providers are installed', () => {
    const env = makeEnv({});
    const providers = buildProviders('/fake/cwd', env);
    assert.deepEqual(Object.keys(providers), []);
  });

  it('returns only claude when only claude is installed', () => {
    const env = makeEnv({ claudeInstalled: true });
    const providers = buildProviders('/fake/cwd', env);
    assert.ok('claude' in providers, 'Expected claude provider');
    assert.ok(!('codex' in providers), 'Expected no codex provider');
    assert.ok(!('opencode' in providers), 'Expected no opencode provider');
  });

  it('returns only codex when only codex is installed', () => {
    const env = makeEnv({ codexInstalled: true });
    const providers = buildProviders('/fake/cwd', env);
    assert.ok('codex' in providers, 'Expected codex provider');
    assert.ok(!('claude' in providers), 'Expected no claude provider');
  });

  it('returns both claude and codex when both are installed', () => {
    const env = makeEnv({ claudeInstalled: true, codexInstalled: true });
    const providers = buildProviders('/fake/cwd', env);
    assert.ok('claude' in providers, 'Expected claude provider');
    assert.ok('codex' in providers, 'Expected codex provider');
  });

  it('returns all three when all providers are installed', () => {
    const env = makeEnv({ claudeInstalled: true, codexInstalled: true, opencodeInstalled: true });
    const providers = buildProviders('/fake/cwd', env);
    assert.equal(Object.keys(providers).length, 3);
    assert.ok('claude' in providers);
    assert.ok('codex' in providers);
    assert.ok('opencode' in providers);
  });

  it('returns grok when grok is installed', () => {
    const env = makeEnv({ grokInstalled: true });
    const providers = buildProviders('/fake/cwd', env);
    assert.ok('grok' in providers);
    assert.ok(!('claude' in providers));
  });

  it('buildProviders is synchronous (returns plain object, not a Promise)', () => {
    const env = makeEnv({});
    const result = buildProviders('/fake/cwd', env);
    // Must not be a Promise
    assert.ok(
      typeof (result as unknown as Promise<unknown>).then !== 'function',
      'buildProviders must return synchronously',
    );
  });

  it('each returned provider has an id matching the key', () => {
    const env = makeEnv({ claudeInstalled: true, codexInstalled: true });
    const providers = buildProviders('/fake/cwd', env);
    for (const [key, provider] of Object.entries(providers)) {
      assert.equal(provider?.id, key, `Provider id should match key "${key}"`);
    }
  });
});

describe('buildAuthenticatedProviders — orchestration set is signed-in only', () => {
  it('excludes installed-but-signed-out providers (no unauthenticated spawn target)', () => {
    const base = makeEnv({ claudeInstalled: true, codexInstalled: true });
    // claude signed in; codex installed but signed out.
    const env: EnvironmentStatus = { ...base, claude: { ...base.claude, authenticated: true } };
    const providers = buildAuthenticatedProviders('/fake/cwd', env);
    assert.ok('claude' in providers, 'signed-in claude is included');
    assert.ok(!('codex' in providers), 'signed-out codex is excluded');
  });

  it('returns an empty map when nothing is signed in (orchestrate guards cleanly)', () => {
    const env = makeEnv({ claudeInstalled: true, opencodeInstalled: true, grokInstalled: true });
    assert.deepEqual(Object.keys(buildAuthenticatedProviders('/fake/cwd', env)), []);
  });

  it('includes every signed-in provider', () => {
    const base = makeEnv({ claudeInstalled: true, opencodeInstalled: true });
    const env: EnvironmentStatus = {
      ...base,
      claude: { ...base.claude, authenticated: true },
      opencode: { ...base.opencode, authenticated: true },
    };
    const providers = buildAuthenticatedProviders('/fake/cwd', env);
    assert.ok('claude' in providers && 'opencode' in providers);
    assert.equal(Object.keys(providers).length, 2);
  });
});
