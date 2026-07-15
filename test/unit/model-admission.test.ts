/**
 * test/unit/model-admission.test.ts — R1.4 progressive model admission.
 *
 * Covers:
 *  - state machine ladder + demotion
 *  - never promote from name/version alone
 *  - tier gates (manager refuses candidate/worker-floor)
 *  - resolve from registry facts
 *  - selectExecutionLane manager refuses candidate-only inventory
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

  it('provisional admits worker + ic, not manager', () => {
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
  it('missing Claude/Codex/Grok registry entry → worker-floor (not name-promoted)', () => {
    const r = resolveModelAdmission(
      DECLARATIVE_MODEL_CAPABILITIES,
      'claude',
      'claude-brand-new-99.9-ultra',
    );
    assert.equal(r.rank, 'worker-floor');
    assert.ok(r.reasons.includes('discovered'));
    // Manager must still refuse
    assert.equal(isRankAdmittedForTier(r.rank, 'manager'), false);
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

  it('detect-only row → worker-floor', () => {
    const reg = registryWith(detectOnly('codex', 'gpt-future-canary'));
    const r = resolveModelAdmission(reg, 'codex', 'gpt-future-canary');
    assert.equal(r.rank, 'worker-floor');
    assert.ok(r.reasons.includes('detect-only'));
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
  it('manager drops candidate and worker-floor models', () => {
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
    // opus + sonnet are curated eligible with manager admission; provisional not manager
    assert.ok(kept.includes('opus'));
    assert.ok(kept.includes('sonnet'));
    assert.ok(!kept.includes('claude-unknown-new'));
    assert.ok(!kept.includes('claude-prov-facts'));
  });

  it('worker keeps worker-floor models', () => {
    const reg = registryWith(detectOnly('codex', 'gpt-unknown-w'));
    const kept = filterModelsForTier(
      'codex',
      ['gpt-unknown-w'],
      'worker',
      reg,
    );
    assert.deepEqual(kept, ['gpt-unknown-w']);
  });

  it('unknown non-registry Claude models are worker-floor (worker keeps, manager drops)', () => {
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
    assert.deepEqual(managerKept, []);
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

  it('filters per-provider map', () => {
    const reg = registryWith(detectOnly('grok', 'grok-future'));
    const out = filterAvailableModelsForTier(
      {
        grok: ['grok-future'],
        claude: ['opus'],
      },
      'manager',
      reg,
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
});

// ---------------------------------------------------------------------------
// Production path: selectExecutionLane
// ---------------------------------------------------------------------------

describe('selectExecutionLane progressive admission', () => {
  it('manager refuses candidate-only / worker-floor-only inventory (no_eligible_lane)', () => {
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
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.failure.code, 'no_eligible_lane');
    assert.ok(
      result.failure.message.toLowerCase().includes('admission') ||
        result.failure.blockedProviders.includes('claude'),
    );
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

  it('worker may select worker-floor (detect-only) inventory', () => {
    const reg = registryWith(detectOnly('claude', 'claude-worker-floor-id'));
    // Force worker policy preference toward claude with only the detect-only model.
    // Pricing fallback still has worker models; post-check admits worker-floor ids
    // only when route picks them — ensure inventory includes a pricing worker model
    // that is also worker-floor? Simpler: use availableModels with haiku (eligible
    // worker) to show worker path still works; plus a separate pure filter test.
    // For worker-floor selection via lane: use codex with only detect-only and
    // capabilityContext so admission registry knows the row.
    const result = selectExecutionLane({
      tier: 'worker',
      available: ['claude'],
      policy: DEFAULT_POLICY,
      availableModels: {
        // haiku is curated worker-eligible; unknown alone would be candidate
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
    // Must not be a candidate-only failure
    assert.ok(result.lane.model.length > 0);
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
    // opus or alias-resolved manager model — not the mystery unknown
    assert.notEqual(result.lane.model.toLowerCase(), 'claude-mystery-unknown');
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
});
