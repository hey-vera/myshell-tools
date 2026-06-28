/**
 * test/unit/preflight-deps.test.ts — unit tests for src/interface/preflight-deps.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ProviderId, Provider, ProviderRequest, ProviderEvent } from '../../src/providers/port.ts';
import type { Policy } from '../../src/core/types.ts';
import type { AppConfig } from '../../src/infra/config.js';
import type { BuildPreflightDepsInput } from '../../src/interface/preflight-deps.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import { buildPreflightDeps } from '../../src/interface/preflight-deps.ts';

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
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });

  it('smartRoute: false omits only routeClassifier', () => {
    const result = buildPreflightDeps(baseInput({ config: { ...config, smartRoute: false } }));
    assert.ok(result.routeClassifier === undefined, 'routeClassifier should be undefined');
    assert.ok(result.intentExtractor !== undefined, 'intentExtractor should be defined');
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });

  it('intentEngine: false omits only intentExtractor', () => {
    const result = buildPreflightDeps(baseInput({ config: { ...config, intentEngine: false } }));
    assert.ok(result.routeClassifier !== undefined, 'routeClassifier should be defined');
    assert.ok(result.intentExtractor === undefined, 'intentExtractor should be undefined');
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });

  it('intentPass: false omits only intentExtractor', () => {
    const result = buildPreflightDeps(baseInput({ intentPass: false }));
    assert.ok(result.routeClassifier !== undefined, 'routeClassifier should be defined');
    assert.ok(result.intentExtractor === undefined, 'intentExtractor should be undefined');
    assert.ok(result.autoBrainRungTuple !== undefined, 'autoBrainRungTuple should be defined');
  });
});
