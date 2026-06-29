/**
 * test/unit/routing-registry-validation.test.ts — registry validation harness (§2).
 *
 * BUILD-FAILING invariants (violation → test fails, blocking the build):
 *  - Every curated Claude/Codex/Grok model has a routingProfile.
 *  - tierSuitability values are integers 0..100.
 *  - speedClass, quotaClass, searchMode are valid union members.
 *  - searchMode:'native' only when adapter support is verified.
 *  - Fact-monotonicity within each provider.
 *
 * The SELF-TEST at the bottom proves the harness catches a bad row.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { DECLARATIVE_MODEL_CAPABILITIES } from '../../src/core/model-capabilities.ts';
import type { ModelCapability } from '../../src/core/model-capabilities.ts';
import type { RoutingProfile } from '../../src/core/route-types.ts';

// ---------------------------------------------------------------------------
// Validation helpers (pure)
// ---------------------------------------------------------------------------

const VALID_SPEED = new Set(['fast', 'balanced', 'deep']);
const VALID_QUOTA = new Set(['subscription', 'metered', 'free', 'unknown']);
const VALID_SEARCH = new Set(['native', 'none', 'unknown']);
const VALID_SOURCE = new Set(['curated-table', 'opencode-live-rank', 'official-doc', 'cli-metadata']);

function validateRoutingProfile(
  rp: RoutingProfile,
  provider: string,
  modelId: string,
): string[] {
  const errors: string[] = [];
  const prefix = `${provider}/${modelId}`;

  // tierSuitability: integer 0..100
  for (const tier of ['worker', 'ic', 'manager'] as const) {
    const v = rp.tierSuitability[tier];
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      errors.push(`${prefix}: tierSuitability.${tier}=${v} (must be integer 0..100)`);
    }
  }

  // tierAdmission: boolean
  for (const tier of ['worker', 'ic', 'manager'] as const) {
    if (typeof rp.tierAdmission[tier] !== 'boolean') {
      errors.push(`${prefix}: tierAdmission.${tier} must be boolean`);
    }
  }

  if (!VALID_SPEED.has(rp.speedClass)) {
    errors.push(`${prefix}: invalid speedClass "${rp.speedClass}"`);
  }

  if (!VALID_QUOTA.has(rp.quotaClass)) {
    errors.push(`${prefix}: invalid quotaClass "${rp.quotaClass}"`);
  }

  if (!VALID_SEARCH.has(rp.searchMode)) {
    errors.push(`${prefix}: invalid searchMode "${rp.searchMode}"`);
  }

  if (rp.poolHint !== undefined) {
    // poolHint must be a QuotaPoolId (string) — type-safe at compile time,
    // but let's verify it's at least non-empty
    if (typeof rp.poolHint !== 'string' || rp.poolHint.length === 0) {
      errors.push(`${prefix}: empty poolHint`);
    }
  }

  if (!VALID_SOURCE.has(rp.validation.source)) {
    errors.push(`${prefix}: invalid validation.source "${rp.validation.source}"`);
  }

  if (typeof rp.validation.checkedAt !== 'string' || rp.validation.checkedAt.length === 0) {
    errors.push(`${prefix}: validation.checkedAt missing or empty`);
  }

  return errors;
}

function validateFactMonotonicity(
  models: readonly ModelCapability[],
  provider: string,
): string[] {
  const errors: string[] = [];
  const ranked = [...models]
    .filter((m) => m.routingProfile !== undefined)
    .map((m) => ({
      id: m.id,
      tierHint: m.tierHint,
      rp: m.routingProfile!,
    }));

  // Admission-fact consistency (per-model, runs even for single-model providers)
  for (const m of ranked) {
    // Manager admission requires overrideReason if no objective context facts
    if (m.rp.tierAdmission.manager && !m.rp.validation.overrideReason) {
      const cap = models.find((c) => c.id === m.id);
      const hasContextWindow = cap?.contextWindow !== undefined && cap.contextWindow >= 128_000;
      if (!hasContextWindow) {
        errors.push(
          `${provider}/${m.id}: tierAdmission.manager=true but no contextWindow >= 128k and no overrideReason`,
        );
      }
    }

    // IC admission requires overrideReason if no objective context/reasoning facts
    if (m.rp.tierAdmission.ic && !m.rp.validation.overrideReason) {
      const cap = models.find((c) => c.id === m.id);
      const hasContextWindow = cap?.contextWindow !== undefined && cap.contextWindow >= 64_000;
      const hasReasoning = cap?.supportedReasoningEfforts && cap.supportedReasoningEfforts.length > 0;
      if (!hasContextWindow && !hasReasoning) {
        errors.push(
          `${provider}/${m.id}: tierAdmission.ic=true but no contextWindow >= 64k, no reasoning efforts, and no overrideReason`,
        );
      }
    }
  }

  // Cross-model monotonicity (requires 2+ ranked models)
  if (ranked.length <= 1) return errors;

  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i]!;
      const b = ranked[j]!;

      // If tierHint implies a higher tier, suitability for that tier should not be lower
      if (a.tierHint === 'manager' && b.tierHint === 'ic') {
        if (a.rp.tierSuitability.manager < b.rp.tierSuitability.manager) {
          // Skip if b has an explicit overrideReason
          if (!b.rp.validation.overrideReason) {
            errors.push(
              `${provider}: ${a.id}(manager) manager suit=${a.rp.tierSuitability.manager} < ${b.id}(ic) manager suit=${b.rp.tierSuitability.manager} — violates manager-tier monotonicity, and ${b.id} has no overrideReason`,
            );
          }
        }
      }

      if (a.tierHint === 'ic' && b.tierHint === 'worker') {
        if (a.rp.tierSuitability.ic < b.rp.tierSuitability.ic) {
          if (!b.rp.validation.overrideReason) {
            errors.push(
              `${provider}: ${a.id}(ic) ic suit=${a.rp.tierSuitability.ic} < ${b.id}(worker) ic suit=${b.rp.tierSuitability.ic} — violates ic-tier monotonicity, and ${b.id} has no overrideReason`,
            );
          }
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Test: every curated model has a routable routingProfile (§2)
// ---------------------------------------------------------------------------

describe('Capability Registry — routingProfile coverage (§2)', () => {
  for (const [provider, models] of Object.entries(DECLARATIVE_MODEL_CAPABILITIES)) {
    if (provider === 'opencode') continue; // OpenCode is dynamic, no static rows

    for (const model of models) {
      it(`${provider}/${model.id} has a routingProfile`, () => {
        assert.ok(model.routingProfile !== undefined, `${provider}/${model.id}: missing routingProfile`);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Test: routingProfile field invariants
// ---------------------------------------------------------------------------

describe('Capability Registry — routingProfile invariants (§2)', () => {
  for (const [provider, models] of Object.entries(DECLARATIVE_MODEL_CAPABILITIES)) {
    if (provider === 'opencode') continue;

    for (const model of models) {
      it(`${provider}/${model.id} routingProfile fields are valid`, () => {
        const rp = model.routingProfile;
        assert.ok(rp !== undefined);
        const errors = validateRoutingProfile(rp, provider, model.id);
        if (errors.length > 0) {
          assert.fail(errors.join('\n'));
        }
      });
    }
  }
});

// ---------------------------------------------------------------------------
// Test: searchMode matches adapter support (§2)
// ---------------------------------------------------------------------------

describe('Capability Registry — searchMode matches adapter support (§2)', () => {
  it('all Claude models have searchMode:native (adapter: --allowedTools WebSearch WebFetch)', () => {
    for (const model of DECLARATIVE_MODEL_CAPABILITIES.claude) {
      assert.equal(
        model.routingProfile?.searchMode,
        'native',
        `Claude/${model.id}: searchMode must be "native" (adapter supports --allowedTools WebSearch WebFetch at claude.ts:171-181)`,
      );
    }
  });

  it('all Codex models have searchMode:native (adapter: tools.web_search)', () => {
    for (const model of DECLARATIVE_MODEL_CAPABILITIES.codex) {
      assert.equal(
        model.routingProfile?.searchMode,
        'native',
        `Codex/${model.id}: searchMode must be "native" (adapter supports tools.web_search at codex.ts:108-114)`,
      );
    }
  });

  it('all Grok models have searchMode:native (adapter: enables/disables native search)', () => {
    for (const model of DECLARATIVE_MODEL_CAPABILITIES.grok) {
      assert.equal(
        model.routingProfile?.searchMode,
        'native',
        `Grok/${model.id}: searchMode must be "native" (adapter supports native search at grok.ts:33-34,138-140)`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Test: fact-monotonicity (§2)
// ---------------------------------------------------------------------------

describe('Capability Registry — fact-monotonicity (§2)', () => {
  it('Claude rows satisfy fact-monotonicity', () => {
    const errors = validateFactMonotonicity(DECLARATIVE_MODEL_CAPABILITIES.claude, 'claude');
    if (errors.length > 0) assert.fail(errors.join('\n'));
  });

  it('Codex rows satisfy fact-monotonicity', () => {
    const errors = validateFactMonotonicity(DECLARATIVE_MODEL_CAPABILITIES.codex, 'codex');
    if (errors.length > 0) assert.fail(errors.join('\n'));
  });

  it('Grok rows satisfy fact-monotonicity', () => {
    const errors = validateFactMonotonicity(DECLARATIVE_MODEL_CAPABILITIES.grok, 'grok');
    if (errors.length > 0) assert.fail(errors.join('\n'));
  });
});

// ---------------------------------------------------------------------------
// Self-test: VALIDATION HARNESS detects bad curated rows (§2)
// ---------------------------------------------------------------------------

describe('Capability Registry — validation harness self-test (§2)', () => {
  it('detects tierSuitability out of range', () => {
    const bad: RoutingProfile = {
      tierSuitability: { worker: 101, ic: -5, manager: 50 },
      tierAdmission: { worker: true, ic: false, manager: false },
      speedClass: 'fast',
      quotaClass: 'subscription',
      searchMode: 'native',
      validation: { source: 'curated-table', checkedAt: '2026-01-01' },
    };
    const errors = validateRoutingProfile(bad, 'test', 'bad-model');
    assert.ok(errors.length >= 2, `expected at least 2 errors, got ${errors.length}: ${errors.join('; ')}`);
    assert.ok(errors.some((e) => e.includes('worker=101')));
    assert.ok(errors.some((e) => e.includes('ic=-5')));
  });

  it('detects invalid speedClass', () => {
    const bad: RoutingProfile = {
      tierSuitability: { worker: 50, ic: 30, manager: 0 },
      tierAdmission: { worker: true, ic: false, manager: false },
      speedClass: 'slow' as RoutingProfile['speedClass'],
      quotaClass: 'subscription',
      searchMode: 'native',
      validation: { source: 'curated-table', checkedAt: '2026-01-01' },
    };
    const errors = validateRoutingProfile(bad, 'test', 'bad-model');
    assert.ok(errors.some((e) => e.includes('speedClass')));
  });

  it('detects invalid searchMode', () => {
    const bad: RoutingProfile = {
      tierSuitability: { worker: 50, ic: 30, manager: 0 },
      tierAdmission: { worker: true, ic: false, manager: false },
      speedClass: 'balanced',
      quotaClass: 'subscription',
      searchMode: 'off' as RoutingProfile['searchMode'],
      validation: { source: 'curated-table', checkedAt: '2026-01-01' },
    };
    const errors = validateRoutingProfile(bad, 'test', 'bad-model');
    assert.ok(errors.some((e) => e.includes('searchMode')));
  });

  it('detects missing overrideReason on manager admission without context facts', () => {
    const badModel: ModelCapability = {
      provider: 'claude',
      id: 'bad-opus',
      aliases: [],
      supportedReasoningEfforts: [],
      source: ['declarative'],
      routingProfile: {
        tierSuitability: { worker: 50, ic: 70, manager: 90 },
        tierAdmission: { worker: true, ic: true, manager: true },
        speedClass: 'deep',
        quotaClass: 'subscription',
        searchMode: 'native',
        // NO overrideReason — should be flagged
        validation: { source: 'curated-table', checkedAt: '2026-01-15' },
      },
    };
    const errors = validateFactMonotonicity([badModel], 'claude');
    assert.ok(errors.length > 0, 'should detect missing overrideReason for manager admission without context');
  });

  it('detects missing overrideReason on IC admission without context/reasoning', () => {
    const badModel: ModelCapability = {
      provider: 'codex',
      id: 'bad-mini',
      aliases: [],
      supportedReasoningEfforts: [], // no reasoning
      source: ['declarative'],
      routingProfile: {
        tierSuitability: { worker: 50, ic: 60, manager: 0 },
        tierAdmission: { worker: true, ic: true, manager: false }, // IC admitted but no facts
        speedClass: 'fast',
        quotaClass: 'metered',
        searchMode: 'native',
        validation: { source: 'curated-table', checkedAt: '2026-01-15' },
      },
    };
    const errors = validateFactMonotonicity([badModel], 'codex');
    assert.ok(errors.length > 0, 'should detect missing overrideReason for IC admission without context/reasoning');
  });

  it('monotonicity violation: worker-tier model has higher ic suit than ic-tier model', () => {
    const icModel: ModelCapability = {
      provider: 'grok',
      id: 'grok-ic',
      aliases: [],
      tierHint: 'ic',
      supportedReasoningEfforts: ['high'],
      source: ['declarative'],
      routingProfile: {
        tierSuitability: { worker: 60, ic: 50, manager: 0 },
        tierAdmission: { worker: true, ic: true, manager: false },
        speedClass: 'balanced',
        quotaClass: 'subscription',
        searchMode: 'native',
        validation: { source: 'curated-table', checkedAt: '2026-01-15' },
      },
    };
    const workerModel: ModelCapability = {
      provider: 'grok',
      id: 'grok-fast',
      aliases: [],
      tierHint: 'worker',
      supportedReasoningEfforts: ['low'],
      source: ['declarative'],
      routingProfile: {
        tierSuitability: { worker: 80, ic: 70, manager: 0 }, // higher IC than the ic-tier model!
        tierAdmission: { worker: true, ic: true, manager: false },
        speedClass: 'fast',
        quotaClass: 'subscription',
        searchMode: 'native',
        validation: { source: 'curated-table', checkedAt: '2026-01-15' }, // no overrideReason
      },
    };
    const errors = validateFactMonotonicity([icModel, workerModel], 'grok');
    assert.ok(errors.length > 0, 'should detect monotonicity violation: worker-tier model has higher ic suitability than ic-tier model without overrideReason');
    assert.ok(errors.some((e) => e.includes('ic suit')), 'error should mention ic suit');
  });
});
