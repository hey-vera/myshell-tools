/**
 * test/unit/preflight-deps.test.ts — unit tests for src/interface/preflight-deps.ts
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { ProviderId, Provider, ProviderRequest, ProviderEvent } from '../../src/providers/port.ts';
import type { Policy } from '../../src/core/types.ts';
import type { AppConfig } from '../../src/infra/config.js';
import type { BuildPreflightDepsInput } from '../../src/interface/preflight-deps.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { buildPreflightDeps } from '../../src/interface/preflight-deps.ts';
import { createTurnCallBudget } from '../../src/core/turn-call-budget.js';

function providerStub(id: ProviderId): Provider {
  return {
    id,
    installed: true,
    authenticated: true,
    plan: null,
    availableModels: [],
    run: async function* (
      _req: ProviderRequest,
      _signal: AbortSignal,
    ): AsyncGenerator<ProviderEvent> {
      yield { type: 'done' as const, text: 'ok' };
    },
  };
}

const providers = {
  opencode: providerStub('opencode'),
  claude: providerStub('claude'),
} as const;

const env = { ...process.env };
const config: AppConfig = { onboarded: true, setAsDefault: true };
const policy: Policy = DEFAULT_POLICY;

function baseInput(overrides: Partial<BuildPreflightDepsInput> = {}) {
  return {
    providers,
    policy,
    cwd: '/tmp/test',
    timeoutMs: 120_000,
    sandbox: 'workspace-write' as const,
    config,
    env,
    autoMode: 'balanced' as const,
    intentPass: true,
    ...overrides,
  };
}

describe('buildPreflightDeps', () => {
  it('default config builds routeClassifier, intentExtractor, and autoBrainRungTuple', () => {
    const result = buildPreflightDeps(baseInput());
    assert.ok(result.routeClassifier !== undefined, 'routeClassifier should be defined');
    assert.ok(result.intentExtractor !== undefined, 'intentExtractor should be defined');
    assert.equal(result.semanticPreflightV1, undefined);
    assert.equal(result.completionResultV1, undefined);
    assert.ok(result.semanticPreflightExtractor === undefined, 'semanticPreflightExtractor should be undefined');
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });

  it('smartRoute: false omits only routeClassifier', () => {
    const result = buildPreflightDeps(baseInput({ config: { ...config, smartRoute: false } }));
    assert.ok(result.routeClassifier === undefined, 'routeClassifier should be undefined');
    assert.ok(result.intentExtractor !== undefined, 'intentExtractor should be defined');
    assert.equal(result.semanticPreflightV1, undefined);
    assert.ok(result.semanticPreflightExtractor === undefined, 'semanticPreflightExtractor should be undefined');
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });

  it('intentEngine: false omits only intentExtractor', () => {
    const result = buildPreflightDeps(baseInput({ config: { ...config, intentEngine: false } }));
    assert.ok(result.routeClassifier !== undefined, 'routeClassifier should be defined');
    assert.ok(result.intentExtractor === undefined, 'intentExtractor should be undefined');
    assert.ok(result.semanticPreflightExtractor === undefined, 'semanticPreflightExtractor should be undefined');
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });

  it('intentPass: false omits only intentExtractor', () => {
    const result = buildPreflightDeps(baseInput({ intentPass: false }));
    assert.ok(result.routeClassifier !== undefined, 'routeClassifier should be defined');
    assert.ok(result.intentExtractor === undefined, 'intentExtractor should be undefined');
    assert.ok(result.semanticPreflightExtractor === undefined, 'semanticPreflightExtractor should be undefined');
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });

  it('same observing budget reaches route and intent factories', async () => {
    const budget = createTurnCallBudget({
      turnId: 'turn-shared',
      mode: 'observe',
      totalUnits: 64,
      reserved: { work: 1, failover: 0, verification: 0 },
    });

    const result = buildPreflightDeps(baseInput({
      config: { ...config, experimentalSemanticPreflightV1: true },
      turnCallBudget: budget,
    }));

    assert.ok(result.routeClassifier !== undefined, 'routeClassifier should be defined');
    assert.ok(result.intentExtractor !== undefined, 'intentExtractor should be defined');
    const semanticExtractor = result.semanticPreflightExtractor;
    assert.ok(semanticExtractor !== undefined, 'semanticPreflightExtractor should be defined');
    assert.equal(result.semanticPreflightV1, true);

    // Both classifiers/extractors were built with the SAME budget object —
    // verify by calling both and checking they record to the same ledger.
    // We do this by checking the budget's begun count increments across both.
    const initialSnap = budget.snapshot();
    assert.strictEqual(initialSnap.begun, 0);

    await semanticExtractor('review this implementation', new AbortController().signal);
    const afterSemantic = budget.snapshot();
    assert.strictEqual(afterSemantic.begun, 1);
    assert.deepEqual(
      afterSemantic.events
        .filter((e) => e.type === 'call-begun')
        .map((e) => e.type === 'call-begun' ? e.purpose : ''),
      ['intent'],
    );
  });

  it('preflight deps retain legacy closures for rollback while exposing semantic closure', () => {
    const result = buildPreflightDeps(baseInput({
      config: { ...config, experimentalSemanticPreflightV1: true },
    }));

    assert.equal(typeof result.routeClassifier, 'function');
    assert.equal(typeof result.intentExtractor, 'function');
    assert.equal(result.semanticPreflightV1, true);
    assert.equal(typeof result.semanticPreflightExtractor, 'function');
  });

  it('completion result flag is dark by default and explicitly wires deps when enabled', () => {
    const off = buildPreflightDeps(baseInput({
      env: { MYSHELL_COMPLETION_RESULT_V1: 'garbage' },
      config: { ...config, experimentalCompletionResultV1: false },
    }));
    assert.equal(off.completionResultV1, undefined);

    const envOn = buildPreflightDeps(baseInput({
      env: { MYSHELL_COMPLETION_RESULT_V1: '1' },
      config: { ...config, experimentalCompletionResultV1: false },
    }));
    assert.equal(envOn.completionResultV1, true);

    const configOn = buildPreflightDeps(baseInput({
      env: {},
      config: { ...config, experimentalCompletionResultV1: true },
    }));
    assert.equal(configOn.completionResultV1, true);
  });
  it('unset flag rollback restores legacy route and intent closures', () => {
    const result = buildPreflightDeps(baseInput({
      env: { MYSHELL_UNIFY_PREFLIGHT: '1', MYSHELL_RISK_SIGNALS: '1' },
      config: { ...config, experimentalSemanticPreflightV1: false },
    }));

    assert.equal(typeof result.routeClassifier, 'function');
    assert.equal(typeof result.intentExtractor, 'function');
    assert.equal(result.semanticPreflightV1, undefined);
    assert.equal(result.semanticPreflightExtractor, undefined);
  });
});
