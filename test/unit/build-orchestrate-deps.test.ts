/**
 * test/unit/build-orchestrate-deps.test.ts — shared OrchestrateDeps core (P2.4 slice 1).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { EnvironmentStatus, ProviderStatus } from '../../src/providers/detect.ts';
import {
  collectEnvRoutingFacts,
  buildEnvRoutingDepsSlice,
  buildAvailableModelsByAccountDepsSlice,
  buildShippedCoreOrchestrateFlags,
  buildOptionalSharedContextDeps,
  buildSharedOrchestrateCore,
  SHARED_ORCHESTRATE_CORE_KEYS,
} from '../../src/interface/build-orchestrate-deps.ts';

function provider(
  id: ProviderStatus['id'],
  overrides: Partial<ProviderStatus> = {},
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

function env(overrides: Partial<Record<'claude' | 'codex' | 'opencode' | 'grok', Partial<ProviderStatus>>> = {}): EnvironmentStatus {
  return {
    claude: provider('claude', overrides.claude),
    codex: provider('codex', overrides.codex),
    opencode: provider('opencode', overrides.opencode),
    grok: provider('grok', overrides.grok),
    hasAnyProvider: true,
    platform: 'linux',
  };
}

describe('collectEnvRoutingFacts', () => {
  it('returns empty collections when nothing is installed or authed', () => {
    const facts = collectEnvRoutingFacts(env());
    assert.deepEqual(facts.availableModels, {});
    assert.deepEqual(facts.authenticatedProviders, []);
    assert.deepEqual(facts.planInfos, {});
  });

  it('includes availableModels only for installed providers with non-empty lists', () => {
    const facts = collectEnvRoutingFacts(
      env({
        claude: {
          installed: true,
          availableModels: ['claude-sonnet'],
        },
        codex: {
          installed: true,
          availableModels: [],
        },
        opencode: {
          installed: false,
          availableModels: ['should-omit'],
        },
      }),
    );
    assert.deepEqual(facts.availableModels, { claude: ['claude-sonnet'] });
  });

  it('classifies planInfos only for authenticated providers', () => {
    const facts = collectEnvRoutingFacts(
      env({
        claude: { authenticated: true, plan: 'pro' },
        codex: { authenticated: true, plan: null },
        grok: { authenticated: false, plan: 'max' },
      }),
    );
    assert.deepEqual(facts.authenticatedProviders, ['claude', 'codex']);
    assert.equal(facts.planInfos.claude?.tier, 'pro');
    assert.equal(facts.planInfos.claude?.confidence, 'observed');
    assert.equal(facts.planInfos.codex?.confidence, 'none');
    assert.equal(facts.planInfos.grok, undefined);
  });
});

describe('buildEnvRoutingDepsSlice', () => {
  it('omits empty keys for exactOptionalPropertyTypes / OFF paths', () => {
    const slice = buildEnvRoutingDepsSlice(env());
    assert.deepEqual(Object.keys(slice), []);
  });

  it('includes only non-empty routing keys', () => {
    const slice = buildEnvRoutingDepsSlice(
      env({
        claude: {
          installed: true,
          authenticated: true,
          plan: 'max',
          availableModels: ['m1'],
        },
      }),
    );
    assert.deepEqual(Object.keys(slice).sort(), [
      'authenticatedProviders',
      'availableModels',
      'planInfos',
    ]);
    assert.deepEqual(slice.availableModels, { claude: ['m1'] });
    assert.deepEqual(slice.authenticatedProviders, ['claude']);
    assert.equal(slice.planInfos?.claude?.tier, 'max');
  });

  it('allows authenticatedProviders override (menu cooldown filter)', () => {
    const slice = buildEnvRoutingDepsSlice(
      env({
        claude: { authenticated: true, plan: 'pro' },
        codex: { authenticated: true, plan: 'pro' },
      }),
      { authenticatedProviders: ['codex'] },
    );
    assert.deepEqual(slice.authenticatedProviders, ['codex']);
    // planInfos still cover all authed providers from env
    assert.ok(slice.planInfos?.claude !== undefined);
    assert.ok(slice.planInfos?.codex !== undefined);
  });
});

describe('buildShippedCoreOrchestrateFlags', () => {
  it('returns the five shipped-on flags both CLI and menu already set', () => {
    const flags = buildShippedCoreOrchestrateFlags();
    assert.deepEqual(flags, {
      cacheAccountingV2: true,
      accountAux: true,
      evidenceReceiptV2: true,
      blockedStateV1: true,
      nativeSessionsPromote: true,
    });
  });
});

describe('buildOptionalSharedContextDeps', () => {
  it('omits empty strings and absent fields', () => {
    assert.deepEqual(buildOptionalSharedContextDeps({}), {});
    assert.deepEqual(buildOptionalSharedContextDeps({ memoryContext: '' }), {});
    assert.deepEqual(
      buildOptionalSharedContextDeps({ memoryContext: 'MEM', environmentContext: '' }),
      { memoryContext: 'MEM' },
    );
  });

  it('includes sleep and capabilityRegistry when provided', () => {
    const sleep = async (_ms: number): Promise<void> => {};
    const registry = { version: 1 } as unknown as NonNullable<
      Parameters<typeof buildOptionalSharedContextDeps>[0]['capabilityRegistry']
    >;
    const slice = buildOptionalSharedContextDeps({ sleep, capabilityRegistry: registry });
    assert.equal(slice.sleep, sleep);
    assert.equal(slice.capabilityRegistry, registry);
  });
});

describe('buildSharedOrchestrateCore', () => {
  it('produces expected shared keys and never invents vendorNeutral / experimental flags', () => {
    const core = buildSharedOrchestrateCore(
      env({
        claude: {
          installed: true,
          authenticated: true,
          plan: 'pro',
          availableModels: ['claude-sonnet'],
        },
      }),
      { context: { memoryContext: 'USER MEMORY', toolStateContext: 'ABOUT' } },
    );

    const keys = Object.keys(core).sort();
    for (const k of keys) {
      assert.ok(
        (SHARED_ORCHESTRATE_CORE_KEYS as readonly string[]).includes(k),
        `unexpected key outside shared core surface: ${k}`,
      );
    }

    assert.equal(core.cacheAccountingV2, true);
    assert.equal(core.accountAux, true);
    assert.equal(core.evidenceReceiptV2, true);
    assert.equal(core.blockedStateV1, true);
    assert.equal(core.nativeSessionsPromote, true);
    assert.equal(core.memoryContext, 'USER MEMORY');
    assert.equal(core.toolStateContext, 'ABOUT');
    assert.deepEqual(core.authenticatedProviders, ['claude']);
    assert.deepEqual(core.availableModels, { claude: ['claude-sonnet'] });

    // Explicit non-goals for slice 1
    assert.equal(
      (core as { vendorNeutralEnabled?: boolean }).vendorNeutralEnabled,
      undefined,
    );
    assert.equal((core as { tribunalEnabled?: boolean }).tribunalEnabled, undefined);
    assert.equal((core as { unifyPreflight?: boolean }).unifyPreflight, undefined);
    assert.equal((core as { riskSignals?: boolean }).riskSignals, undefined);
  });

  it('SHARED_ORCHESTRATE_CORE_KEYS documents the full pure-surface set', () => {
    assert.ok(SHARED_ORCHESTRATE_CORE_KEYS.includes('availableModels'));
    assert.ok(SHARED_ORCHESTRATE_CORE_KEYS.includes('planInfos'));
    assert.ok(SHARED_ORCHESTRATE_CORE_KEYS.includes('cacheAccountingV2'));
    assert.ok(SHARED_ORCHESTRATE_CORE_KEYS.includes('blockedStateV1'));
    assert.equal(SHARED_ORCHESTRATE_CORE_KEYS.length, 13);
  });

  it('expands availableModels with live registry ids (detect/codex-cache)', () => {
    const registry = {
      claude: [],
      codex: [
        {
          provider: 'codex' as const,
          id: 'gpt-5.5',
          aliases: [],
          supportedReasoningEfforts: [],
          source: ['declarative'] as const,
        },
        {
          provider: 'codex' as const,
          id: 'gpt-brand-new-ship',
          aliases: [],
          supportedReasoningEfforts: [],
          source: ['detect'] as const,
        },
      ],
      opencode: [],
      grok: [],
    };
    const core = buildSharedOrchestrateCore(
      env({
        codex: {
          installed: true,
          authenticated: true,
          availableModels: ['gpt-5.5'],
        },
      }),
      { context: { capabilityRegistry: registry } },
    );
    assert.deepEqual(core.availableModels, {
      codex: ['gpt-5.5', 'gpt-brand-new-ship'],
    });
  });
});

describe('buildAvailableModelsByAccountDepsSlice (P1 wire)', () => {
  it('omits key when no accounts or no models', () => {
    assert.deepEqual(buildAvailableModelsByAccountDepsSlice({ claude: ['m'] }, []), {});
    assert.deepEqual(
      buildAvailableModelsByAccountDepsSlice(undefined, [{ provider: 'claude', id: 'a' }]),
      {},
    );
  });

  it('spreads provisional per-account inventory for managed accounts', () => {
    const slice = buildAvailableModelsByAccountDepsSlice(
      { claude: ['sonnet'], opencode: ['kimi'] },
      [
        { provider: 'claude', id: 'c1' },
        { provider: 'claude', id: 'c2' },
        { provider: 'opencode', id: 'oc1' },
      ],
    );
    assert.deepEqual(slice.availableModelsByAccount, {
      claude: { c1: ['sonnet'], c2: ['sonnet'] },
      opencode: { oc1: ['kimi'] },
    });
  });
});
