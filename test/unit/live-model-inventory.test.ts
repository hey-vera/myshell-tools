/**
 * test/unit/live-model-inventory.test.ts — live model auto-adapt pure helpers.
 *
 * Pins: interval re-detect timing, model-id union, routing inventory expansion
 * from detect + registry live sources, and fail-soft env patching.
 * NO I/O, NO model call.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_REDETECT_INTERVAL_MS,
  shouldRedetectModels,
  unionModelIds,
  routingInventoryFromDetectAndRegistry,
  withUpdatedAvailableModels,
  buildAvailableModelsByAccount,
} from '../../src/core/live-model-inventory.ts';
import type { CapabilityRegistry, ModelCapability } from '../../src/core/model-capabilities.ts';
import type { EnvironmentStatus, ProviderStatus } from '../../src/providers/detect.ts';

function cap(
  provider: ModelCapability['provider'],
  id: string,
  source: ModelCapability['source'],
): ModelCapability {
  return {
    provider,
    id,
    aliases: [],
    supportedReasoningEfforts: [],
    source,
  };
}

function provider(
  id: ProviderStatus['id'],
  overrides: Partial<ProviderStatus> = {},
): ProviderStatus {
  return {
    id,
    installed: true,
    version: '1',
    authenticated: true,
    plan: null,
    binaryPath: id,
    availableModels: [],
    ...overrides,
  };
}

describe('shouldRedetectModels', () => {
  it('returns true when never redetected', () => {
    assert.equal(shouldRedetectModels(undefined, 1_000), true);
  });

  it('returns false inside the default interval', () => {
    const last = 10_000;
    assert.equal(
      shouldRedetectModels(last, last + DEFAULT_MODEL_REDETECT_INTERVAL_MS - 1),
      false,
    );
  });

  it('returns true when interval has elapsed', () => {
    const last = 10_000;
    assert.equal(
      shouldRedetectModels(last, last + DEFAULT_MODEL_REDETECT_INTERVAL_MS),
      true,
    );
  });
});

describe('unionModelIds', () => {
  it('de-dupes case-insensitively and preserves first-seen casing', () => {
    assert.deepEqual(unionModelIds(['gpt-5.5', 'GPT-5.5'], ['gpt-future'], undefined, ['']), [
      'gpt-5.5',
      'gpt-future',
    ]);
  });
});

describe('routingInventoryFromDetectAndRegistry', () => {
  it('merges an unknown detect/codex-cache id into routing inventory (no invented tier)', () => {
    const registry: CapabilityRegistry = {
      claude: [],
      codex: [
        cap('codex', 'gpt-5.5', ['declarative']),
        cap('codex', 'gpt-future-x', ['detect']),
        cap('codex', 'gpt-from-cache', ['codex-cache']),
      ],
      opencode: [cap('opencode', 'opencode/new-model', ['detect'])],
      grok: [],
    };
    const inv = routingInventoryFromDetectAndRegistry(
      { codex: ['gpt-5.5'] },
      registry,
    );
    assert.deepEqual(inv.codex, ['gpt-5.5', 'gpt-future-x', 'gpt-from-cache']);
    assert.deepEqual(inv.opencode, ['opencode/new-model']);
    // declarative-only without detect list entry still not required beyond merge sources
    assert.equal(inv.claude, undefined);
  });

  it('returns detect inventory unchanged when registry is absent', () => {
    const inv = routingInventoryFromDetectAndRegistry(
      { claude: ['opus', 'sonnet'] },
      undefined,
    );
    assert.deepEqual(inv, { claude: ['opus', 'sonnet'] });
  });

  it('does not re-emit canonical ids for declarative entries only tagged detect via alias', () => {
    // Layer 2 tags declarative `sonnet` with `detect` when detect advertises the
    // alias `claude-sonnet-4-6`. Expansion must keep the advertised alias only —
    // not invent a second candidate (`sonnet`) that flips VN session-hash ties.
    const registry: CapabilityRegistry = {
      claude: [
        {
          provider: 'claude',
          id: 'sonnet',
          aliases: ['claude-sonnet-4-6'],
          supportedReasoningEfforts: [],
          source: ['declarative', 'detect'],
        },
        cap('claude', 'haiku', ['declarative']),
      ],
      codex: [
        {
          provider: 'codex',
          id: 'gpt-5.4',
          aliases: [],
          supportedReasoningEfforts: [],
          source: ['declarative', 'detect'],
        },
      ],
      opencode: [],
      grok: [],
    };
    const inv = routingInventoryFromDetectAndRegistry(
      { claude: ['claude-sonnet-4-6'], codex: ['gpt-5.4'] },
      registry,
    );
    assert.deepEqual(inv.claude, ['claude-sonnet-4-6']);
    assert.deepEqual(inv.codex, ['gpt-5.4']);
  });
});

describe('withUpdatedAvailableModels', () => {
  it('patches only supplied providers and preserves auth facts', () => {
    const env: EnvironmentStatus = {
      claude: provider('claude', { availableModels: ['opus'], plan: 'max' }),
      codex: provider('codex', { availableModels: ['gpt-5.5'] }),
      opencode: provider('opencode', { availableModels: ['opencode/a'] }),
      grok: provider('grok', { installed: false, authenticated: false }),
      hasAnyProvider: true,
      platform: 'linux',
    };
    const next = withUpdatedAvailableModels(env, {
      codex: ['gpt-5.5', 'gpt-future-x'],
    });
    assert.deepEqual(next.codex.availableModels, ['gpt-5.5', 'gpt-future-x']);
    assert.equal(next.claude.plan, 'max');
    assert.deepEqual(next.claude.availableModels, ['opus']);
  });
});

describe('buildAvailableModelsByAccount (R1.5)', () => {
  it('shapes per-account inventory and unions duplicate account rows', () => {
    const map = buildAvailableModelsByAccount([
      { provider: 'claude', accountId: 'acc-a', models: ['model-a', 'MODEL-A'] },
      { provider: 'claude', accountId: 'acc-a', models: ['model-a2'] },
      { provider: 'claude', accountId: 'acc-b', models: ['model-b'] },
      { provider: 'codex', accountId: 'cx-1', models: ['gpt-future'] },
    ]);
    assert.deepEqual(map.claude?.['acc-a'], ['model-a', 'model-a2']);
    assert.deepEqual(map.claude?.['acc-b'], ['model-b']);
    assert.deepEqual(map.codex?.['cx-1'], ['gpt-future']);
  });
});
