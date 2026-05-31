/**
 * Unit tests for src/providers/registry.ts
 *
 * buildProviders now accepts a pre-detected EnvironmentStatus (no internal spawn).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildProviders } from '../../src/providers/registry.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(overrides: Partial<{
  claudeInstalled: boolean;
  codexInstalled: boolean;
  opencodeInstalled: boolean;
}>): EnvironmentStatus {
  const { claudeInstalled = false, codexInstalled = false, opencodeInstalled = false } = overrides;
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
    hasAnyProvider: claudeInstalled || codexInstalled || opencodeInstalled,
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
