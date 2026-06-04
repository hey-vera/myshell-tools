/**
 * Unit tests for src/core/route.ts
 * Run with: node --experimental-strip-types --test test/unit/route.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route } from '../../src/core/route.ts';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../../src/core/policy.ts';
import type { ProviderId } from '../../src/providers/port.ts';
import type { Tier, Policy } from '../../src/core/types.ts';

// quality-first opens the manager tier (maxTier 'manager'); use it to verify
// manager-tier model resolution now that DEFAULT_POLICY/balanced clamps to 'ic'.
const MANAGER_OK_POLICY: Policy = POLICY_PRESETS['quality-first'];
// A policy with NO tier ceiling — exercises the original (unclamped) routing.
const NO_CAP_POLICY: Policy = (() => {
  const { maxTier: _omit, ...rest } = DEFAULT_POLICY;
  return rest;
})();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLAUDE_ONLY: ProviderId[] = ['claude'];
const CODEX_ONLY: ProviderId[] = ['codex'];
const BOTH: ProviderId[] = ['claude', 'codex'];
const NEITHER: ProviderId[] = [];

// ---------------------------------------------------------------------------
// IC tier
// ---------------------------------------------------------------------------

describe('route — ic tier', () => {
  it('claude-only → claude ic model (claude-sonnet-4-6)', () => {
    const decision = route('ic', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-sonnet-4-6');
  });

  it('codex-only → a codex ic model', () => {
    const decision = route('ic', CODEX_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'codex');
    // Should be gpt-5.2-codex (cheapest codex ic model by inputPer1M: $1.75 vs gpt-5.4 $2.50)
    assert.equal(decision.model, 'gpt-5.2-codex');
  });

  it('both available → claude first (per policy order)', () => {
    const decision = route('ic', BOTH, DEFAULT_POLICY);
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-sonnet-4-6');
  });

  it('empty available → throws', () => {
    assert.throws(
      () => route('ic', NEITHER, DEFAULT_POLICY),
      /no providers available/i,
    );
  });

  it('returns a RouteDecision with tier set correctly', () => {
    const decision = route('ic', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
  });
});

// ---------------------------------------------------------------------------
// Worker tier
// ---------------------------------------------------------------------------

describe('route — worker tier', () => {
  it('claude-only → claude worker model (claude-haiku-4-5)', () => {
    const decision = route('worker', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'worker');
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-haiku-4-5');
  });

  it('codex-only → cheapest codex worker model', () => {
    const decision = route('worker', CODEX_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'worker');
    assert.equal(decision.provider, 'codex');
    // gpt-5.4-nano is cheapest codex worker ($0.20/1M input vs gpt-5.4-mini $0.75)
    assert.equal(decision.model, 'gpt-5.4-nano');
  });

  it('both available → claude first (per policy order)', () => {
    const decision = route('worker', BOTH, DEFAULT_POLICY);
    assert.equal(decision.provider, 'claude');
  });
});

// ---------------------------------------------------------------------------
// Manager tier
// ---------------------------------------------------------------------------

describe('route — manager tier', () => {
  // NOTE: these assert manager-tier MODEL RESOLUTION, so they now use
  // MANAGER_OK_POLICY (quality-first, maxTier 'manager'). Under DEFAULT_POLICY /
  // balanced (maxTier 'ic') a manager request is intentionally clamped to ic —
  // see the "route — maxTier clamp" suite below. Previously these passed
  // DEFAULT_POLICY and expected opus/gpt-5.5; that encoded the pre-clamp bug
  // where balanced auto-ran the most expensive model.
  it('claude-only → claude manager model (claude-opus-4-7) under a manager-allowed policy', () => {
    const decision = route('manager', CLAUDE_ONLY, MANAGER_OK_POLICY);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-opus-4-7');
  });

  it('codex-only → codex manager model (gpt-5.5) under a manager-allowed policy', () => {
    const decision = route('manager', CODEX_ONLY, MANAGER_OK_POLICY);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.provider, 'codex');
    assert.equal(decision.model, 'gpt-5.5');
  });

  it('both available → claude first (per policy order) under a manager-allowed policy', () => {
    const decision = route('manager', BOTH, MANAGER_OK_POLICY);
    assert.equal(decision.provider, 'claude');
  });

  it('empty available → throws with helpful message', () => {
    assert.throws(
      () => route('manager', NEITHER, DEFAULT_POLICY),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /no providers available/i);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Policy fallback: provider not in policy order but present in available
// ---------------------------------------------------------------------------

describe('route — fallback when preferred providers unavailable', () => {
  it('policy prefers [claude, codex] but only an unknown provider is available — falls back to cheapest', () => {
    // This tests the case where available contains a provider that is NOT in the
    // policy order.  We simulate by passing a custom policy that prefers nothing
    // the available set has.
    const customPolicy = {
      ...DEFAULT_POLICY,
      providerOrderByTier: {
        ...DEFAULT_POLICY.providerOrderByTier,
        // ic prefers codex first, then claude
        ic: ['codex', 'claude'] as readonly ProviderId[],
      },
    };
    // Only claude is available, but policy prefers codex first.
    // Falls through to claude (second in order).
    const decision = route('ic', ['claude'], customPolicy);
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// route — opencode-only (JOB-1 regression guard)
// ---------------------------------------------------------------------------

describe('route — opencode-only provider', () => {
  const OPENCODE_ONLY: ProviderId[] = ['opencode'];

  it('worker tier with opencode-only returns a valid opencode decision (does not throw)', () => {
    const decision = route('worker', OPENCODE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'worker');
    assert.equal(decision.provider, 'opencode');
    assert.ok(decision.model.length > 0, 'model should be non-empty');
  });

  it('ic tier with opencode-only returns a valid opencode decision (does not throw)', () => {
    const decision = route('ic', OPENCODE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'opencode');
    assert.ok(decision.model.length > 0, 'model should be non-empty');
  });

  it('manager tier with opencode-only returns a valid opencode decision (does not throw)', () => {
    // Use a manager-allowed policy: DEFAULT_POLICY now clamps manager → ic.
    const decision = route('manager', OPENCODE_ONLY, MANAGER_OK_POLICY);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.provider, 'opencode');
    assert.ok(decision.model.length > 0, 'model should be non-empty');
  });
});

// ---------------------------------------------------------------------------
// route — availableModels filter
// ---------------------------------------------------------------------------

describe('route — availableModels filter', () => {
  it('prefers a model in the advertised set for the preferred provider', () => {
    // gpt-5.4 is advertised for codex; with codex-only, route should prefer it
    const decision = route('ic', ['codex'], DEFAULT_POLICY, {
      codex: ['gpt-5.4', 'gpt-5.5'],
    });
    assert.equal(decision.provider, 'codex');
    // gpt-5.4 is a valid codex ic model and is in the advertised set
    assert.equal(decision.model, 'gpt-5.4');
  });

  it('graceful fallback: when advertised set matches no pricing entry, still returns a valid decision', () => {
    // 'phantom-model-xyz' is advertised but not in our pricing table; should
    // fall back gracefully to the cheapest codex ic model (not throw).
    const decision = route('ic', ['codex'], DEFAULT_POLICY, {
      codex: ['phantom-model-xyz'],
    });
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'codex');
    assert.ok(decision.model.length > 0, 'model should be non-empty');
  });

  it('when availableModels is omitted, behaviour is identical to pre-existing routing', () => {
    const withoutModels = route('ic', CLAUDE_ONLY, DEFAULT_POLICY);
    const withUndefined = route('ic', CLAUDE_ONLY, DEFAULT_POLICY, undefined);
    assert.equal(withoutModels.provider, withUndefined.provider);
    assert.equal(withoutModels.model, withUndefined.model);
    assert.equal(withoutModels.tier, withUndefined.tier);
  });

  it('when availableModels has an empty array for a provider, behaviour is identical to omitting it', () => {
    const withEmpty = route('ic', CLAUDE_ONLY, DEFAULT_POLICY, { claude: [] });
    const withOmitted = route('ic', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(withEmpty.model, withOmitted.model);
  });
});

// ---------------------------------------------------------------------------
// route — authenticatedProviders (auth-aware routing)
// ---------------------------------------------------------------------------

describe('route — authenticatedProviders (auth-aware routing)', () => {
  it('prefers an authenticated provider over a signed-out higher-preference one', () => {
    // Policy order: [claude, codex]. claude is NOT authenticated; codex IS.
    // Expected: route picks codex (authenticated) over claude (signed-out first-in-order).
    const decision = route(
      'ic',
      ['claude', 'codex'],
      DEFAULT_POLICY,
      undefined,
      ['codex'],
    );
    assert.equal(decision.provider, 'codex');
  });

  it('picks the authenticated provider even when it is last in preference order', () => {
    // Only opencode is authenticated; all three are available.
    // Policy ic order: [claude, codex, opencode] — opencode is last.
    const decision = route(
      'ic',
      ['claude', 'codex', 'opencode'],
      DEFAULT_POLICY,
      undefined,
      ['opencode'],
    );
    assert.equal(decision.provider, 'opencode');
  });

  it('falls back to first available when NONE are authenticated', () => {
    // authenticatedProviders is non-empty but no provider overlaps with available.
    // Falls back to first available in preference order (claude).
    const decision = route(
      'ic',
      ['claude', 'codex'],
      DEFAULT_POLICY,
      undefined,
      // Some unrelated authenticated provider that is not in the available set
      [] as const,
    );
    // Empty authenticatedProviders → identical to today: first in preference order
    assert.equal(decision.provider, 'claude');
  });

  it('falls back to first available (claude) when authenticatedProviders is empty', () => {
    const decision = route('ic', ['claude', 'codex'], DEFAULT_POLICY, undefined, []);
    assert.equal(decision.provider, 'claude');
  });

  it('when authenticatedProviders is undefined, behaviour is identical to existing routing', () => {
    const withoutAuth = route('ic', BOTH, DEFAULT_POLICY);
    const withUndefinedAuth = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined);
    assert.equal(withoutAuth.provider, withUndefinedAuth.provider);
    assert.equal(withoutAuth.model, withUndefinedAuth.model);
  });

  it('when both claude and codex are authenticated, still picks claude (first in preference order)', () => {
    const decision = route(
      'ic',
      ['claude', 'codex'],
      DEFAULT_POLICY,
      undefined,
      ['claude', 'codex'],
    );
    assert.equal(decision.provider, 'claude');
  });

  it('auth-aware routing respects availableModels filter for the chosen authenticated provider', () => {
    // codex is the only authenticated provider; gpt-5.4 is advertised.
    const decision = route(
      'ic',
      ['claude', 'codex'],
      DEFAULT_POLICY,
      { codex: ['gpt-5.4', 'gpt-5.5'] },
      ['codex'],
    );
    assert.equal(decision.provider, 'codex');
    assert.equal(decision.model, 'gpt-5.4');
  });
});

// ---------------------------------------------------------------------------
// route — maxTier clamp (cost ceiling on the routing chokepoint)
// ---------------------------------------------------------------------------

describe('route — maxTier clamp', () => {
  it('balanced clamps a manager request DOWN to ic (sonnet, NOT opus) for claude', () => {
    // This is the core user-facing fix: balanced must never auto-run opus.
    const decision = route('manager', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic', 'tier must be clamped to ic');
    assert.equal(decision.provider, 'claude');
    assert.equal(decision.model, 'claude-sonnet-4-6');
    assert.notEqual(decision.model, 'claude-opus-4-7', 'must NOT route to opus under balanced');
  });

  it('balanced clamps a manager request DOWN to ic for codex (not gpt-5.5)', () => {
    const decision = route('manager', CODEX_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'codex');
    // cheapest codex ic model
    assert.equal(decision.model, 'gpt-5.2-codex');
    assert.notEqual(decision.model, 'gpt-5.5');
  });

  it('cost-saver clamps a manager request DOWN to ic', () => {
    const decision = route('manager', CLAUDE_ONLY, POLICY_PRESETS['cost-saver']);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.model, 'claude-sonnet-4-6');
  });

  it('quality-first does NOT clamp manager (maxTier manager) → opus', () => {
    const decision = route('manager', CLAUDE_ONLY, POLICY_PRESETS['quality-first']);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.model, 'claude-opus-4-7');
  });

  it('clamp only LOWERS: a worker/ic request is unaffected by a higher ceiling', () => {
    // ic request under balanced (ceiling ic) stays ic.
    const ic = route('ic', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(ic.tier, 'ic');
    assert.equal(ic.model, 'claude-sonnet-4-6');
    // worker request under balanced (ceiling ic) stays worker (never raised to ic).
    const worker = route('worker', CLAUDE_ONLY, DEFAULT_POLICY);
    assert.equal(worker.tier, 'worker');
    assert.equal(worker.model, 'claude-haiku-4-5');
  });

  it('undefined maxTier → no clamp (manager request resolves manager model)', () => {
    const decision = route('manager', CLAUDE_ONLY, NO_CAP_POLICY);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.model, 'claude-opus-4-7');
  });

  it('clamp respects an arbitrary ceiling: manager request, worker ceiling → worker', () => {
    const workerCeiling: Policy = { ...NO_CAP_POLICY, maxTier: 'worker' as Tier };
    const decision = route('manager', CLAUDE_ONLY, workerCeiling);
    assert.equal(decision.tier, 'worker');
    assert.equal(decision.model, 'claude-haiku-4-5');
  });

  it('clamp applies to the escalation/review chokepoint too: route("manager", ...) under balanced never reaches opus regardless of caller', () => {
    // orchestrate() escalation and review both call route('manager', ...); this
    // single clamp covers them all.
    for (const pool of [CLAUDE_ONLY, CODEX_ONLY, BOTH]) {
      const decision = route('manager', pool, DEFAULT_POLICY);
      assert.notEqual(decision.model, 'claude-opus-4-7');
      assert.notEqual(decision.model, 'gpt-5.5');
      assert.equal(decision.tier, 'ic');
    }
  });
});

// ---------------------------------------------------------------------------
// Learned preferred order (Local Outcome Learner)
// ---------------------------------------------------------------------------

describe('route — learned preferredOrder', () => {
  it('honours the learned order first: codex preferred over the static claude-first order', () => {
    // Static policy order is claude-first; with BOTH available, route() normally
    // picks claude. A learned order [codex, claude] must flip it to codex.
    const decision = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, ['codex', 'claude']);
    assert.equal(decision.provider, 'codex');
  });

  it('prefers a learned provider that is available AND authenticated', () => {
    // Both authenticated; learned order prefers codex → codex wins (auth-aware).
    const decision = route(
      'ic',
      BOTH,
      DEFAULT_POLICY,
      undefined,
      ['claude', 'codex'], // authenticatedProviders
      ['codex', 'claude'], // learned order
    );
    assert.equal(decision.provider, 'codex');
  });

  it('falls back to the static order when the learned order has no eligible provider', () => {
    // Learned order names only opencode, which is NOT available → fall back to the
    // static order (claude first) among the available pool.
    const decision = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, ['opencode']);
    assert.equal(decision.provider, 'claude');
  });

  it('learned order never expands the candidate set (only available providers win)', () => {
    // Only codex available; learned order prefers claude (unreachable) → codex.
    const decision = route('ic', CODEX_ONLY, DEFAULT_POLICY, undefined, undefined, ['claude', 'codex']);
    assert.equal(decision.provider, 'codex');
  });

  it('a learned provider that is available but NOT authenticated is skipped for an authenticated one', () => {
    // Learned prefers codex, but only claude is authenticated → claude wins
    // (auth-aware: the learned order respects authentication).
    const decision = route(
      'ic',
      BOTH,
      DEFAULT_POLICY,
      undefined,
      ['claude'], // only claude authenticated
      ['codex', 'claude'], // learned prefers codex
    );
    assert.equal(decision.provider, 'claude');
  });

  it('absent preferredOrder → behaviour is UNCHANGED (static order wins)', () => {
    const withUndef = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, undefined);
    const baseline = route('ic', BOTH, DEFAULT_POLICY);
    assert.equal(withUndef.provider, baseline.provider);
    assert.equal(withUndef.provider, 'claude');
  });

  it('empty preferredOrder → behaviour is UNCHANGED (static order wins)', () => {
    const withEmpty = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, []);
    assert.equal(withEmpty.provider, 'claude');
  });
});
