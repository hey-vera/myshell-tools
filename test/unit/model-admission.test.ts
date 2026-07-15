/**
 * test/unit/model-admission.test.ts — R1.4 progressive model admission.
 *
 * Covers:
 *  - state machine ladder + demotion
 *  - never promote from name/version alone
 *  - tier gates (manager refuses pure candidate/worker-floor quarantine)
 *  - resolve from registry facts + declarative floor
 *  - live inventory models remain spawnable (worker/IC/manager hard-gate)
 *  - selectExecutionLane manager refuses name-only / quarantine inventory
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  admitDiscovered,
  applyAdmissionEvent,
  admissionKey,
  filterAvailableModelsForTier,
  filterModelsForTier,
  hasObjectiveCapabilityFacts,
  isInventoryListedSpawnable,
  isModelAdmittedForTier,
  isRankAdmittedForTier,
  resolveModelAdmission,
  type ModelAdmissionRecord,
} from '../../src/core/model-admission.ts';
import { selectExecutionLane } from '../../src/core/execution-lane.ts';
import {
  DECLARATIVE_MODEL_CAPABILITIES,
  type CapabilityRegistry,
  type ModelCapability,
} from '../../src/core/model-capabilities.ts';
import { DEFAULT_POLICY } from '../../src/core/policy.ts';
import type { ProviderId } from '../../src/providers/port.js';

const nowMs = new Date('2026-06-15T00:00:00.000Z').getTime();

function detectOnly(provider: ProviderId, id: string): ModelCapability {
  return {
    provider,
    id,
    aliases: [],
    supportedReasoningEfforts: [],
    source: ['detect'],
  };
}

function withObjective(provider: ProviderId, id: string): ModelCapability {
  return {
    provider,
    id,
    aliases: [],
    supportedReasoningEfforts: ['low', 'medium', 'high'],
    contextWindow: 200_000,
    source: ['detect', 'codex-cache'],
  };
}

function registryWith(
  ...caps: ModelCapability[]
): CapabilityRegistry {
  const base: Record<ProviderId, ModelCapability[]> = {
    claude: [...DECLARATIVE_MODEL_CAPABILITIES.claude],
    codex: [...DECLARATIVE_MODEL_CAPABILITIES.codex],
    opencode: [...DECLARATIVE_MODEL_CAPABILITIES.opencode],
    grok: [...DECLARATIVE_MODEL_CAPABILITIES.grok],
  };
  for (const c of caps) {
    base[c.provider] = [...base[c.provider], c];
  }
  return base;
}

// ---------------------------------------------------------------------------
// Tier gates
// ---------------------------------------------------------------------------

describe('isRankAdmittedForTier', () => {
  it('candidate and invalidated admit no tiers', () => {
    for (const tier of ['worker', 'ic', 'manager'] as const) {
      assert.equal(isRankAdmittedForTier('candidate', tier), false);
      assert.equal(isRankAdmittedForTier('invalidated', tier), false);
    }
  });

  it('worker-floor admits worker only', () => {
    assert.equal(isRankAdmittedForTier('worker-floor', 'worker'), true);
    assert.equal(isRankAdmittedForTier('worker-floor', 'ic'), false);
    assert.equal(isRankAdmittedForTier('worker-floor', 'manager'), false);
  });

  it('provisional admits worker + ic, not manager (base ladder)', () => {
    assert.equal(isRankAdmittedForTier('provisional', 'worker'), true);
    assert.equal(isRankAdmittedForTier('provisional', 'ic'), true);
    assert.equal(isRankAdmittedForTier('provisional', 'manager'), false);
  });

  it('eligible admits all tiers at rank level', () => {
    assert.equal(isRankAdmittedForTier('eligible', 'worker'), true);
    assert.equal(isRankAdmittedForTier('eligible', 'ic'), true);
    assert.equal(isRankAdmittedForTier('eligible', 'manager'), true);
  });
});

// ---------------------------------------------------------------------------
// Resolve from registry
// ---------------------------------------------------------------------------

describe('resolveModelAdmission', () => {
  it('missing Claude/Codex/Grok registry entry without inventory → candidate (blocked)', () => {
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'claude-brand-new-99.9-ultra',
    );
    assert.equal(r.rank, 'candidate');
    assert.ok(r.reasons.includes('discovered'));
    assert.equal(isRankAdmittedForTier(r.rank, 'manager'), false);
    assert.equal(isRankAdmittedForTier(r.rank, 'worker'), false);
  });

  it('missing entry marked inLiveInventory → provisional inventory-listed (spawnable)', () => {
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'claude-brand-new-99.9-ultra',
      undefined,
      { inLiveInventory: true },
    );
    assert.equal(r.rank, 'provisional');
    assert.ok(r.reasons.includes('inventory-listed'));
    assert.equal(isModelAdmittedForTier(r, 'worker'), true);
    assert.equal(isModelAdmittedForTier(r, 'ic'), true);
    assert.equal(isModelAdmittedForTier(r, 'manager'), true);
    // Still not curated eligible
    assert.notEqual(r.rank, 'eligible');
  });

  it('missing OpenCode registry entry → eligible for inventory authority (not ranked by name)', () => {
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'opencode',
      'opencode-go/fixture-live-manager-abc',
    );
    assert.equal(r.rank, 'eligible');
    assert.ok(r.reasons.includes('discovered'));
  });

  it('detect-only row → provisional inventory-listed (not worker-floor quarantine)', () => {
    const reg = registryWith(detectOnly('codex', 'gpt-future-canary'));
    const r = resolveModelAdmission(reg, 'codex', 'gpt-future-canary');
    assert.equal(r.rank, 'provisional');
    assert.ok(r.reasons.includes('detect-only') || r.reasons.includes('inventory-listed'));
    assert.equal(isModelAdmittedForTier(r, 'ic'), true);
    assert.equal(isModelAdmittedForTier(r, 'manager'), true);
  });

  it('objective metadata without curated profile → provisional', () => {
    const reg = registryWith(withObjective('codex', 'gpt-measured-facts'));
    const r = resolveModelAdmission(reg, 'codex', 'gpt-measured-facts');
    assert.equal(r.rank, 'provisional');
    assert.ok(r.reasons.includes('objective-metadata'));
  });

  it('curated routingProfile → eligible', () => {
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'opus',
    );
    assert.equal(r.rank, 'eligible');
    assert.ok(r.reasons.includes('registry-curated'));
  });

  it('sparse registry without routingProfile still inherits declarative curated floor', () => {
    // Partial registries used for effort/search facts must not demote curated ids.
    const sparse: CapabilityRegistry = {
      claude: [],
      codex: [
        {
          provider: 'codex',
          id: 'gpt-5.5',
          aliases: [],
          tierHint: 'manager',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          source: ['codex-cache'],
        },
      ],
      opencode: [],
      grok: [],
    };
    const r = resolveModelAdmission(sparse, 'codex', 'gpt-5.5');
    assert.equal(r.rank, 'eligible');
    assert.ok(r.reasons.includes('registry-curated'));
    assert.equal(isModelAdmittedForTier(r, 'manager'), true);
  });

  it('override wins (invalidated)', () => {
    const overrides = new Map([
      [admissionKey('claude', 'opus'), 'invalidated' as const],
    ]);
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'opus',
      overrides,
    );
    assert.equal(r.rank, 'invalidated');
  });

  it('never treats a flashy model id as objective facts', () => {
    assert.equal(
      hasObjectiveCapabilityFacts(detectOnly('claude', 'claude-opus-9-max-ultra')),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

describe('applyAdmissionEvent', () => {
  const base: ModelAdmissionRecord = {
    provider: 'claude',
    model: 'claude-new-x',
    rank: 'candidate',
    reasons: ['discovered'],
  };

  it('admit-worker-floor promotes candidate → worker-floor', () => {
    const next = applyAdmissionEvent(base, { type: 'admit-worker-floor' });
    assert.equal(next.rank, 'worker-floor');
  });

  it('objective-metadata with facts → provisional', () => {
    const floor = applyAdmissionEvent(base, { type: 'admit-worker-floor' });
    const next = applyAdmissionEvent(floor, {
      type: 'objective-metadata',
      hasObjectiveFacts: true,
    });
    assert.equal(next.rank, 'provisional');
  });

  it('objective-metadata without facts does not promote', () => {
    const floor = applyAdmissionEvent(base, { type: 'admit-worker-floor' });
    const next = applyAdmissionEvent(floor, {
      type: 'objective-metadata',
      hasObjectiveFacts: false,
    });
    assert.equal(next.rank, 'worker-floor');
  });

  it('measured-rank only elevates from provisional, not from worker-floor', () => {
    const floor = applyAdmissionEvent(base, { type: 'admit-worker-floor' });
    const skip = applyAdmissionEvent(floor, {
      type: 'measured-rank',
      measured: true,
    });
    assert.equal(skip.rank, 'worker-floor');

    const prov = applyAdmissionEvent(floor, {
      type: 'objective-metadata',
      hasObjectiveFacts: true,
    });
    const eligible = applyAdmissionEvent(prov, {
      type: 'measured-rank',
      measured: true,
    });
    assert.equal(eligible.rank, 'eligible');
  });

  it('never promotes from name/version alone', () => {
    const next = applyAdmissionEvent(base, {
      type: 'promote-by-name-version',
      nameOrVersion: 'claude-opus-99.0',
    });
    assert.equal(next.rank, 'candidate');
    assert.ok(next.reasons.includes('name-version-rejected'));
  });

  it('model-not-found demotes to invalidated', () => {
    const eligible = applyAdmissionEvent(
      applyAdmissionEvent(
        applyAdmissionEvent(base, { type: 'admit-worker-floor' }),
        { type: 'objective-metadata', hasObjectiveFacts: true },
      ),
      { type: 'measured-rank', measured: true },
    );
    assert.equal(eligible.rank, 'eligible');
    const demoted = applyAdmissionEvent(eligible, { type: 'model-not-found' });
    assert.equal(demoted.rank, 'invalidated');
    assert.ok(demoted.reasons.includes('model-not-found'));
  });

  it('schema-drift demotes to invalidated', () => {
    const demoted = applyAdmissionEvent(
      { ...base, rank: 'provisional' },
      { type: 'schema-drift' },
    );
    assert.equal(demoted.rank, 'invalidated');
    assert.ok(demoted.reasons.includes('schema-drift'));
  });

  it('invalidated stays put on further promote events', () => {
    const inv = applyAdmissionEvent(base, { type: 'model-not-found' });
    const stuck = applyAdmissionEvent(inv, { type: 'registry-curated' });
    assert.equal(stuck.rank, 'invalidated');
  });

  it('admitDiscovered starts at candidate', () => {
    const d = admitDiscovered('grok', 'grok-new-1');
    assert.equal(d.rank, 'candidate');
    assert.ok(d.reasons.includes('discovered'));
  });
});

// ---------------------------------------------------------------------------
// Inventory filter
// ---------------------------------------------------------------------------

describe('filterModelsForTier / filterAvailableModelsForTier', () => {
  it('manager keeps inventory-listed models; drops explicit worker-floor overrides', () => {
    const reg = registryWith(
      detectOnly('claude', 'claude-unknown-new'),
      withObjective('claude', 'claude-prov-facts'),
    );
    const kept = filterModelsForTier(
      'claude',
      ['opus', 'claude-unknown-new', 'claude-prov-facts', 'sonnet'],
      'manager',
      reg,
    );
    // opus + sonnet curated; inventory-listed detect/objective also spawnable
    assert.ok(kept.includes('opus'));
    assert.ok(kept.includes('sonnet'));
    assert.ok(kept.includes('claude-unknown-new'));
    assert.ok(kept.includes('claude-prov-facts'));
  });

  it('worker keeps inventory models', () => {
    const reg = registryWith(detectOnly('codex', 'gpt-unknown-w'));
    const kept = filterModelsForTier(
      'codex',
      ['gpt-unknown-w'],
      'worker',
      reg,
    );
    assert.deepEqual(kept, ['gpt-unknown-w']);
  });

  it('unknown inventory Claude models are provisional spawnable (worker keeps, manager keeps)', () => {
    const workerKept = filterModelsForTier(
      'claude',
      ['totally-missing-id'],
      'worker',
      DECLARATIVE_MODEL_CAPABILITIES,
    );
    assert.deepEqual(workerKept, ['totally-missing-id']);
    const managerKept = filterModelsForTier(
      'claude',
      ['totally-missing-id'],
      'manager',
      DECLARATIVE_MODEL_CAPABILITIES,
    );
    assert.deepEqual(managerKept, ['totally-missing-id']);
  });

  it('explicit candidate rank is admitted to no tier', () => {
    const overrides = new Map([
      [admissionKey('claude', 'quarantined-id'), 'candidate' as const],
    ]);
    for (const tier of ['worker', 'ic', 'manager'] as const) {
      const kept = filterModelsForTier(
        'claude',
        ['quarantined-id'],
        tier,
        DECLARATIVE_MODEL_CAPABILITIES,
        overrides,
      );
      assert.deepEqual(kept, [], `tier ${tier}`);
    }
  });

  it('explicit worker-floor override is worker-only', () => {
    const overrides = new Map([
      [admissionKey('claude', 'floor-id'), 'worker-floor' as const],
    ]);
    assert.deepEqual(
      filterModelsForTier(
        'claude',
        ['floor-id'],
        'worker',
        DECLARATIVE_MODEL_CAPABILITIES,
        overrides,
      ),
      ['floor-id'],
    );
    assert.deepEqual(
      filterModelsForTier(
        'claude',
        ['floor-id'],
        'manager',
        DECLARATIVE_MODEL_CAPABILITIES,
        overrides,
      ),
      [],
    );
  });

  it('filters per-provider map — manager keeps inventory-listed, drops quarantine', () => {
    const reg = registryWith(detectOnly('grok', 'grok-future'));
    const overrides = new Map([
      [admissionKey('grok', 'grok-future'), 'worker-floor' as const],
    ]);
    const out = filterAvailableModelsForTier(
      {
        grok: ['grok-future'],
        claude: ['opus'],
      },
      'manager',
      reg,
      overrides,
    );
    assert.deepEqual(out.grok, []);
    assert.ok(out.claude?.includes('opus'));
  });
});

describe('isModelAdmittedForTier with curated profile', () => {
  it('eligible haiku still refuses manager via routingProfile', () => {
    const record = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'haiku',
    );
    assert.equal(record.rank, 'eligible');
    const cap = DECLARATIVE_MODEL_CAPABILITIES.claude.find((c) => c.id === 'haiku');
    assert.ok(cap);
    assert.equal(isModelAdmittedForTier(record, 'manager', cap), false);
    assert.equal(isModelAdmittedForTier(record, 'worker', cap), true);
  });

  it('inventory-listed provisional is spawnable on manager without becoming eligible', () => {
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'model-a',
      undefined,
      { inLiveInventory: true },
    );
    assert.equal(r.rank, 'provisional');
    assert.ok(isInventoryListedSpawnable(r));
    assert.equal(isModelAdmittedForTier(r, 'manager'), true);
  });
});

// ---------------------------------------------------------------------------
// Production path: selectExecutionLane
// ---------------------------------------------------------------------------

describe('selectExecutionLane progressive admission', () => {
  it('manager may select inventory-listed unknown models (CLI inventory authority)', () => {
    const result = selectExecutionLane({
      tier: 'manager',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        claude: ['claude-totally-new-99-ultra'],
      },
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
    // Inventory model or pricing fallback — must not no_eligible_lane
    assert.ok(result.lane.model.length > 0);
  });

  it('manager refuses inventory that is only explicit candidate overrides', () => {
    const overrides = new Map([
      [admissionKey('claude', 'opus'), 'candidate' as const],
      [admissionKey('claude', 'sonnet'), 'candidate' as const],
      [admissionKey('claude', 'haiku'), 'candidate' as const],
    ]);
    const result = selectExecutionLane({
      tier: 'manager',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        claude: ['opus', 'sonnet', 'haiku'],
      },
      admissionOverrides: overrides,
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'no_eligible_lane');
  });

  it('manager refuses pure worker-floor quarantine inventory', () => {
    const overrides = new Map([
      [admissionKey('claude', 'only-floor'), 'worker-floor' as const],
    ]);
    const result = selectExecutionLane({
      tier: 'manager',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        claude: ['only-floor'],
      },
      admissionOverrides: overrides,
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'no_eligible_lane');
  });

  it('worker may select inventory (detect-only) models', () => {
    const reg = registryWith(detectOnly('claude', 'claude-worker-floor-id'));
    const result = selectExecutionLane({
      tier: 'worker',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        claude: ['haiku', 'claude-worker-floor-id'],
      },
      capabilityContext: { registry: reg, mode: 'auto' },
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.tier, 'worker');
    assert.equal(result.lane.provider, 'claude');
    assert.ok(result.lane.model.length > 0);
  });

  it('ic may select inventory-listed models (chat/meta paths must not brick)', () => {
    const result = selectExecutionLane({
      tier: 'ic',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        claude: ['model-a'],
      },
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
  });

  it('manager can still select curated eligible models from inventory', () => {
    const result = selectExecutionLane({
      tier: 'manager',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        claude: ['opus', 'claude-mystery-unknown'],
      },
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.lane.provider, 'claude');
  });

  it('invalidated override blocks even curated models for manager', () => {
    const overrides = new Map([
      [admissionKey('claude', 'opus'), 'invalidated' as const],
      [admissionKey('claude', 'sonnet'), 'invalidated' as const],
      [admissionKey('claude', 'haiku'), 'invalidated' as const],
    ]);
    const result = selectExecutionLane({
      tier: 'manager',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        claude: ['opus', 'sonnet', 'haiku'],
      },
      admissionOverrides: overrides,
      nowMs,
      cooldownUntil: new Map(),
      sessionTokensByAccount: {},
    });
    assert.equal(result.ok, false);
  });

  it('name-only promotion never elevates candidate outside inventory', () => {
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'claude-opus-99-ultra-max',
    );
    assert.equal(r.rank, 'candidate');
    const promoted = applyAdmissionEvent(r, {
      type: 'promote-by-name-version',
      nameOrVersion: 'claude-opus-99-ultra-max',
    });
    assert.equal(promoted.rank, 'candidate');
    assert.ok(promoted.reasons.includes('name-version-rejected'));
  });
});
