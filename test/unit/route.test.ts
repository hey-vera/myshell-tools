/**
 * Unit tests for src/core/route.ts
 * Run with: node --experimental-strip-types --test test/unit/route.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { route, selectReasoningEffort } from '../../src/core/route.ts';
import type { CapabilityRouteContext } from '../../src/core/route.ts';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../../src/core/policy.ts';
import type { ProviderId } from '../../src/providers/port.ts';
import type { Tier, Policy } from '../../src/core/types.ts';
import type { CapabilityRegistry } from '../../src/core/model-capabilities.ts';

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
const GROK_ONLY: ProviderId[] = ['grok'];
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
    // gpt-5.4 is the codex ic model ($2.50/1M input)
    assert.equal(decision.model, 'gpt-5.4');
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

  it('grok-only → grok ic model (grok-build) under default policy', () => {
    const decision = route('ic', GROK_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'ic');
    assert.equal(decision.provider, 'grok');
    assert.equal(decision.model, 'grok-build');
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
    // gpt-5.4-mini is cheapest codex worker ($0.75/1M input)
    assert.equal(decision.model, 'gpt-5.4-mini');
  });

  it('both available → claude first (per policy order)', () => {
    const decision = route('worker', BOTH, DEFAULT_POLICY);
    assert.equal(decision.provider, 'claude');
  });

  it('grok-only → grok worker model (grok-composer-2.5-fast)', () => {
    const decision = route('worker', GROK_ONLY, DEFAULT_POLICY);
    assert.equal(decision.tier, 'worker');
    assert.equal(decision.provider, 'grok');
    assert.equal(decision.model, 'grok-composer-2.5-fast');
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

  it('grok-only → grok manager model (grok-build) under a manager-allowed policy', () => {
    const decision = route('manager', GROK_ONLY, MANAGER_OK_POLICY);
    assert.equal(decision.tier, 'manager');
    assert.equal(decision.provider, 'grok');
    assert.equal(decision.model, 'grok-build');
  });

  it('both available → claude first (per policy order) under a manager-allowed policy', () => {
    const decision = route('manager', BOTH, MANAGER_OK_POLICY);
    assert.equal(decision.provider, 'claude');
  });

  it('all providers available → grok is ordered LAST in policy', () => {
    const decision = route('manager', ['claude', 'codex', 'opencode', 'grok'], MANAGER_OK_POLICY);
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

  it('fallback for a non-preferred provider still honours its advertised models', () => {
    const customPolicy: Policy = {
      ...DEFAULT_POLICY,
      providerOrderByTier: {
        ...DEFAULT_POLICY.providerOrderByTier,
        ic: ['claude'] as readonly ProviderId[],
      },
    };
    const decision = route('ic', ['codex'], customPolicy, {
      codex: ['gpt-5.4'],
    });
    assert.equal(decision.provider, 'codex');
    assert.equal(decision.model, 'gpt-5.4');
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
    assert.equal(decision.model, 'gpt-5.4');
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

describe('route — dynamic preferredOrder', () => {
  it('honours the dynamic order first: codex preferred over the static claude-first order', () => {
    // Static policy order is claude-first; with BOTH available, route() normally
    // picks claude. A learned order [codex, claude] must flip it to codex.
    const decision = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, ['codex', 'claude']);
    assert.equal(decision.provider, 'codex');
  });

  it('prefers a dynamic provider that is available AND authenticated', () => {
    // Both authenticated; dynamic order prefers codex → codex wins (auth-aware).
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

  it('falls back to the static order when the dynamic order has no eligible provider', () => {
    // Dynamic order names only opencode, which is NOT available → fall back to the
    // static order (claude first) among the available pool.
    const decision = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, ['opencode']);
    assert.equal(decision.provider, 'claude');
  });

  it('dynamic order never expands the candidate set (only available providers win)', () => {
    // Only codex available; dynamic order prefers claude (unreachable) → codex.
    const decision = route('ic', CODEX_ONLY, DEFAULT_POLICY, undefined, undefined, ['claude', 'codex']);
    assert.equal(decision.provider, 'codex');
  });

  it('a dynamic provider that is available but NOT authenticated is skipped for an authenticated one', () => {
    // Dynamic prefers codex, but only claude is authenticated → claude wins
    // (auth-aware: the dynamic order respects authentication).
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

// ---------------------------------------------------------------------------
// Stage 2 — capability-fit ranking (bounded re-rank within the candidate set)
// ---------------------------------------------------------------------------

describe('route — capability-fit (Stage 2)', () => {
  // A fake registry where, for codex IC, gpt-5.4 has a SMALL known context
  // window and gpt-5.5 a large one (tierHint: 'ic' for the fixture).
  // claude/opencode left empty (unknown = neutral).
  const REG: CapabilityRegistry = {
    claude: [],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: [],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        contextWindow: 128_000,
        source: ['codex-cache'],
      },
      {
        provider: 'codex',
        id: 'gpt-5.5',
        aliases: [],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        contextWindow: 400_000,
        source: ['codex-cache'],
      },
    ],
  };

  function ctx(over: Partial<CapabilityRouteContext> = {}): CapabilityRouteContext {
    return { mode: 'balanced', registry: REG, ...over };
  }

  it('NO capabilityContext → output is byte-for-byte identical (no capabilityReasons field)', () => {
    // Exhaustively compare the with-undefined-context decision to the baseline
    // across every existing call shape; the new optional arg must change nothing.
    const cases: Array<[Tier, ProviderId[], Policy, Parameters<typeof route>[3]?]> = [
      ['ic', CLAUDE_ONLY, DEFAULT_POLICY],
      ['ic', CODEX_ONLY, DEFAULT_POLICY],
      ['worker', BOTH, DEFAULT_POLICY],
      ['manager', CLAUDE_ONLY, MANAGER_OK_POLICY],
      ['ic', ['codex'], DEFAULT_POLICY, { codex: ['gpt-5.4', 'gpt-5.5'] }],
      ['ic', ['opencode'], DEFAULT_POLICY],
    ];
    for (const [tier, pool, policy, models] of cases) {
      const base = route(tier, pool, policy, models);
      const withUndef = route(tier, pool, policy, models, undefined, undefined, undefined);
      assert.deepEqual(withUndef, base);
      // The field must be genuinely ABSENT, not present-and-undefined.
      assert.ok(!('capabilityReasons' in withUndef), 'capabilityReasons must be absent');
      assert.ok(!('reasoningEffort' in withUndef), 'reasoningEffort must be absent');
    }
  });

  it('large-context task picks the larger-window model WITHIN the bounded set', () => {
    // Baseline (cheapest codex ic among advertised) is gpt-5.4 ($2.50).
    // Since only one codex IC model exists (gpt-5.4), capability-fit has no
    // alternative to re-rank against; the baseline is returned unchanged.
    const baseline = route('ic', ['codex'], DEFAULT_POLICY, {
      codex: ['gpt-5.4'],
    });
    assert.equal(baseline.model, 'gpt-5.4');

    const fit = route(
      'ic',
      ['codex'],
      DEFAULT_POLICY,
      { codex: ['gpt-5.4'] },
      undefined,
      undefined,
      ctx({
        taskSignals: {
          risk: 'high',
          routePlan: false,
          estimatedInputTokens: 300_000,
          taskKind: 'large-context',
        },
      }),
    );
    // Only gpt-5.4 is a valid codex IC candidate; fit returns it unchanged.
    assert.equal(fit.provider, 'codex');
    assert.equal(fit.model, 'gpt-5.4');
    assert.ok(
      Array.isArray(fit.capabilityReasons),
      'capabilityReasons should be present',
    );
  });

  it('small-context task leaves the baseline pick unchanged (fit moves only on a known win)', () => {
    const fit = route(
      'ic',
      ['codex'],
      DEFAULT_POLICY,
      { codex: ['gpt-5.4'] },
      undefined,
      undefined,
      ctx({
        taskSignals: { risk: 'low', routePlan: false, estimatedInputTokens: 2_000, taskKind: 'trivial' },
      }),
    );
    assert.equal(fit.model, 'gpt-5.4');
  });

  it('capability-fit CANNOT open manager: balanced still clamps a manager request to ic', () => {
    // Even with a registry that would "prefer" the manager model, the clampTier /
    // authorizeTier ceiling is upstream of fit — fit only re-ranks within the
    // already-clamped IC candidate set, so opus/gpt-5.5 can never be selected.
    const fit = route(
      'manager',
      CLAUDE_ONLY,
      DEFAULT_POLICY, // balanced: maxTier 'ic'
      undefined,
      undefined,
      undefined,
      ctx({
        taskSignals: {
          risk: 'critical',
          routePlan: true,
          estimatedInputTokens: 900_000,
          taskKind: 'architecture',
        },
      }),
    );
    assert.equal(fit.tier, 'ic', 'must stay clamped to ic');
    assert.equal(fit.model, 'claude-sonnet-4-6');
    assert.notEqual(fit.model, 'claude-opus-4-7');
  });

  it('capability-fit CANNOT pick a signed-out provider ahead of a signed-in one', () => {
    // codex is the only authenticated provider; the registry knows nothing helpful
    // about claude. Fit must not override auth to choose claude.
    const fit = route(
      'ic',
      ['claude', 'codex'],
      DEFAULT_POLICY,
      undefined,
      ['codex'], // only codex authenticated
      undefined,
      ctx({
        taskSignals: {
          risk: 'high',
          routePlan: false,
          estimatedInputTokens: 300_000,
          taskKind: 'large-context',
        },
      }),
    );
    assert.equal(fit.provider, 'codex', 'authenticated provider must still win');
  });

  it('capability-fit CANNOT pick a model not in availableModels', () => {
    // Only gpt-5.4 is advertised; the registry knows gpt-5.5 (tierHint: 'ic')
    // has a huge window, but it is NOT advertised, so it must never be selected.
    const fit = route(
      'ic',
      ['codex'],
      DEFAULT_POLICY,
      { codex: ['gpt-5.4'] },
      undefined,
      undefined,
      ctx({
        taskSignals: {
          risk: 'high',
          routePlan: false,
          estimatedInputTokens: 300_000,
          taskKind: 'large-context',
        },
      }),
    );
    assert.equal(fit.provider, 'codex');
    assert.equal(fit.model, 'gpt-5.4', 'must stay within advertised models');
  });

  it('capabilityReasons present when context supplied, absent when not', () => {
    const without = route('ic', ['codex'], DEFAULT_POLICY, { codex: ['gpt-5.4'] });
    assert.equal(without.capabilityReasons, undefined);

    const withCtx = route(
      'ic',
      ['codex'],
      DEFAULT_POLICY,
      { codex: ['gpt-5.4'] },
      undefined,
      undefined,
      ctx({
        taskSignals: {
          risk: 'high',
          routePlan: false,
          estimatedInputTokens: 300_000,
          taskKind: 'large-context',
        },
      }),
    );
    assert.ok(Array.isArray(withCtx.capabilityReasons), 'capabilityReasons present with context');
  });

  it('vision: requires supportsVision only when the task has image input', () => {
    const visionReg: CapabilityRegistry = {
      claude: [],
      opencode: [],
      codex: [
        {
          provider: 'codex',
          id: 'gpt-5.4',
          aliases: [],
          tierHint: 'ic',
          supportedReasoningEfforts: [],
          supportsVision: true,
          source: ['codex-cache'],
        },
        {
          provider: 'codex',
          id: 'gpt-5.5',
          aliases: [],
          tierHint: 'ic',
          supportedReasoningEfforts: [],
          source: ['codex-cache'], // vision unknown
        },
      ],
    };
    const fit = route(
      'ic',
      ['codex'],
      DEFAULT_POLICY,
      { codex: ['gpt-5.4', 'gpt-5.5'] },
      undefined,
      undefined,
      {
        mode: 'balanced',
        registry: visionReg,
        taskSignals: { risk: 'medium', routePlan: false, needsVision: true, taskKind: 'implementation' },
      },
    );
    assert.equal(fit.model, 'gpt-5.4', 'image task picks the vision-capable model');
  });
});

// ===========================================================================
// Stage 4 — modelOutcomeOrder is a WEAK tie-break, AFTER hard fit.
// ===========================================================================
describe('route — modelOutcomeOrder (weak tie-break)', () => {
  // Two IC models from different providers that are EQUAL on every hard
  // capability signal (both have a known 200k window, no vision, equal native
  // session) — a provider-level tie where preferredOrder tips the balance.
  const TIE_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        contextWindow: 200_000,
        source: ['declarative'],
      },
    ],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: [],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        contextWindow: 200_000,
        source: ['codex-cache'],
      },
    ],
  };
  // A registry where codex IC has a LARGE window and claude IC a small one — a
  // HARD large-context fit that must out-weigh any learned preference.
  const HARD_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        contextWindow: 128_000,
        source: ['declarative'],
      },
    ],
    opencode: [],
    codex: [
      { provider: 'codex', id: 'gpt-5.4', aliases: [], tierHint: 'ic', supportedReasoningEfforts: [], contextWindow: 400_000, source: ['codex-cache'] },
    ],
  };
  const MODELS = { codex: ['gpt-5.4'] } as const;
  const SMALL = { risk: 'low' as const, routePlan: false, estimatedInputTokens: 2_000, taskKind: 'implementation' as const };

  it('breaks a tie between providers with equal-capability IC models in favour of the dynamic preferred order', () => {
    // claude is policy-first; without preferredOrder, claude wins.
    const baseline = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced', registry: TIE_REG, taskSignals: SMALL,
    });
    assert.equal(baseline.provider, 'claude');

    // With dynamic preferredOrder preferring codex, the tie tips to codex.
    const tipped = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], ['codex', 'claude'], {
      mode: 'balanced',
      registry: TIE_REG,
      taskSignals: SMALL,
    });
    assert.equal(tipped.provider, 'codex', 'dynamic provider order broke the tie');
    assert.equal(tipped.model, 'gpt-5.4');
  });

  it('NEVER overrides a hard capability fit: large-context requirement picks the satisfying provider over a preferred but non-satisfying one', () => {
    // claude (128k) is preferred by dynamic order but cannot hold 300k;
    // codex (400k) satisfies the large-context need and is selected.
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], ['claude', 'codex'], {
      mode: 'balanced',
      registry: HARD_REG,
      taskSignals: { risk: 'high', routePlan: false, estimatedInputTokens: 300_000, taskKind: 'large-context' },
    });
    assert.equal(fit.provider, 'codex', 'hard large-context requirement overrides the dynamic provider preference');
    assert.equal(fit.model, 'gpt-5.4');
  });

  it('NEVER changes provider: a preference for a signed-out provider does not win over an authed one', () => {
    // codex authenticated; claude signed out. A dynamic order ranking claude first
    // must not override auth (route() picks the authed provider; modelOutcomeOrder
    // only ever re-ranks WITHIN the chosen provider's models).
    const fit = route('ic', ['codex', 'claude'], DEFAULT_POLICY, MODELS, ['codex'], undefined, {
      mode: 'balanced',
      registry: TIE_REG,
      taskSignals: SMALL,
      modelOutcomeOrder: [{ provider: 'codex', model: 'gpt-5.4' }],
    });
    assert.equal(fit.provider, 'codex', 'authed provider chosen; modelOutcomeOrder cannot switch provider');
  });
});

// ===========================================================================
// Stage 5 — provider-native feature facts are NON-ROUTABLE.
// A model that differs ONLY in supportsProviderSkills / supportsProviderSubagents /
// providerFeatureSource must produce the SAME route decision. These facts are pure
// self-awareness inventory; route()/scoreModel must never read them.
// ===========================================================================
describe('route — provider-native feature facts are non-routable (Stage 5)', () => {
  // Two codex IC candidates with the SAME (neutral) capability facts. One variant of
  // the registry adds the Stage-5 provider-feature flags; the routing-relevant fields
  // (tier, window, vision, native session, efforts) are byte-for-byte identical.
  function reg(withFeatures: boolean): CapabilityRegistry {
    const feat = withFeatures
      ? {
          supportsProviderSkills: true,
          supportsProviderSubagents: true,
          providerFeatureSource: 'claude-code-docs',
        }
      : {};
    return {
      claude: [
        {
          provider: 'claude',
          id: 'sonnet',
          aliases: ['claude-sonnet-4-6'],
          tierHint: 'ic',
          supportedReasoningEfforts: [],
          supportsNativeSession: true,
          source: ['declarative'],
          ...feat,
        },
      ],
      opencode: [],
      codex: [
        {
          provider: 'codex',
          id: 'gpt-5.4',
          aliases: [],
          tierHint: 'ic',
          supportedReasoningEfforts: [],
          contextWindow: 400_000,
          source: ['codex-cache'],
          ...feat,
        },
        {
          provider: 'codex',
          id: 'gpt-5.5',
          aliases: [],
          tierHint: 'ic',
          supportedReasoningEfforts: [],
          contextWindow: 128_000,
          source: ['codex-cache'],
          ...feat,
        },
      ],
    };
  }

  const SCENARIOS: ReadonlyArray<{
    readonly name: string;
    readonly tier: Tier;
    readonly pool: ProviderId[];
    readonly models?: Partial<Record<ProviderId, readonly string[]>>;
    readonly signals: CapabilityRouteContext['taskSignals'];
  }> = [
    {
      name: 'small implementation task (baseline pick)',
      tier: 'ic',
      pool: ['codex'],
      models: { codex: ['gpt-5.4', 'gpt-5.5'] },
      signals: { risk: 'low', routePlan: false, estimatedInputTokens: 2_000, taskKind: 'implementation' },
    },
    {
      name: 'large-context task (window fit fires)',
      tier: 'ic',
      pool: ['codex'],
      models: { codex: ['gpt-5.4', 'gpt-5.5'] },
      signals: { risk: 'high', routePlan: false, estimatedInputTokens: 300_000, taskKind: 'large-context' },
    },
    {
      name: 'claude IC architecture turn',
      tier: 'ic',
      pool: ['claude'],
      signals: { risk: 'high', routePlan: true, taskKind: 'architecture' },
    },
  ];

  for (const s of SCENARIOS) {
    it(`adding skills/sub-agent facts does NOT change the route decision — ${s.name}`, () => {
      const without = route(s.tier, s.pool, DEFAULT_POLICY, s.models, undefined, undefined, {
        mode: 'balanced',
        registry: reg(false),
        taskSignals: s.signals,
      });
      const withFeat = route(s.tier, s.pool, DEFAULT_POLICY, s.models, undefined, undefined, {
        mode: 'balanced',
        registry: reg(true),
        taskSignals: s.signals,
      });
      // Identical provider, model, tier, AND capabilityReasons — the flags are
      // invisible to scoring, so nothing about the decision moves.
      assert.deepEqual(withFeat, without);
    });
  }

  it('selectReasoningEffort ignores the provider-feature facts entirely', () => {
    const base = {
      provider: 'codex' as const,
      id: 'gpt-5.5',
      aliases: [],
      tierHint: 'manager' as const,
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'] as const,
      source: ['codex-cache'] as const,
    };
    const input = {
      mode: 'quality-first' as const,
      tier: 'manager' as const,
      risk: 'critical' as const,
      taskKind: 'architecture' as const,
      routePlan: true,
    };
    const plain = selectReasoningEffort({ model: base, ...input });
    const withFeat = selectReasoningEffort({
      model: {
        ...base,
        supportsProviderSkills: true,
        supportsProviderSubagents: true,
        providerFeatureSource: 'claude-code-docs',
      },
      ...input,
    });
    assert.equal(withFeat, plain, 'effort selection must not read provider-feature facts');
  });
});

// ===========================================================================
// Cross-provider capability-aware PRE-PASS (combined-utilization lever, #7/#6).
//
// route() chooses the PROVIDER capability-aware ONLY for a genuine HARD
// requirement (true image input, or a large-context need only some providers can
// hold), and ONLY among available+authenticated providers whose in-tier model
// KNOWN-satisfies it. Otherwise it is byte-for-byte today. These tests pin both
// the activation and — most importantly — the non-regression + bounds.
// ===========================================================================
describe('route — cross-provider capability pre-pass (hard requirements)', () => {
  // Registry where, at IC tier, ONLY codex's gpt-5.4 supports vision; claude has a
  // known sonnet WITHOUT vision (known-false, not just unknown). Policy order is
  // claude-first, so without the pre-pass claude would win.
  const VISION_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        supportsVision: false, // KNOWN no vision
        source: ['declarative'],
      },
    ],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: ['codex'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        supportsVision: true, // the only vision-capable in-tier model
        source: ['codex-cache'],
      },
    ],
  };

  // Registry where BOTH claude and codex have a vision-capable IC model.
  const BOTH_VISION_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        supportsVision: true,
        source: ['declarative'],
      },
    ],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: ['codex'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        supportsVision: true,
        source: ['codex-cache'],
      },
    ],
  };

  // Registry where claude IC has a SMALL window and codex IC a LARGE one.
  const CONTEXT_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        contextWindow: 128_000, // too small for 300k
        source: ['declarative'],
      },
    ],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: ['codex'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        contextWindow: 400_000, // holds 300k + margin
        source: ['codex-cache'],
      },
    ],
  };

  // Registry where NO IC model has a KNOWN window (vision/context all unknown).
  const UNKNOWN_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        source: ['declarative'], // window + vision unknown
      },
    ],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: ['codex'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        source: ['codex-cache'], // window + vision unknown
      },
    ],
  };

  const VISION_SIGNALS = {
    risk: 'medium' as const,
    routePlan: false,
    needsVision: true,
    taskKind: 'implementation' as const,
  };
  const LARGE_SIGNALS = {
    risk: 'high' as const,
    routePlan: false,
    estimatedInputTokens: 300_000,
    taskKind: 'large-context' as const,
  };
  const SMALL_SIGNALS = {
    risk: 'low' as const,
    routePlan: false,
    estimatedInputTokens: 2_000,
    taskKind: 'implementation' as const,
  };

  // --- Non-regression: no hard requirement → deep-equals today --------------
  it('no hard requirement → route() deep-equals today across every call shape (with registry present)', () => {
    const cases: Array<[Tier, ProviderId[], Policy, Parameters<typeof route>[3]?, readonly ProviderId[]?, readonly ProviderId[]?]> = [
      ['ic', CLAUDE_ONLY, DEFAULT_POLICY],
      ['ic', CODEX_ONLY, DEFAULT_POLICY],
      ['worker', BOTH, DEFAULT_POLICY],
      ['manager', CLAUDE_ONLY, MANAGER_OK_POLICY],
      ['ic', ['codex'], DEFAULT_POLICY, { codex: ['gpt-5.4', 'gpt-5.5'] }],
      ['ic', BOTH, DEFAULT_POLICY, undefined, ['codex']],
      ['ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], ['codex', 'claude']],
    ];
    for (const [tier, pool, policy, models, authed, learned] of cases) {
      // Baseline: NO capability context at all (today's exact behaviour).
      const base = route(tier, pool, policy, models, authed, learned);
      // With a registry present but only a SMALL-context / non-vision signal — the
      // pre-pass must NOT fire, so the decision (incl. capabilityReasons from the
      // within-provider fit) must equal the no-pre-pass path. We compare provider,
      // model and tier (the routing decision the pre-pass governs) byte-for-byte.
      const withReg = route(tier, pool, policy, models, authed, learned, {
        mode: 'balanced',
        registry: CONTEXT_REG,
        taskSignals: SMALL_SIGNALS,
      });
      assert.equal(withReg.provider, base.provider, `provider must match for ${tier}/${pool}`);
      assert.equal(withReg.model, base.model, `model must match for ${tier}/${pool}`);
      assert.equal(withReg.tier, base.tier, `tier must match for ${tier}/${pool}`);
    }
  });

  it('capabilityContext absent → byte-for-byte identical even on a vision-shaped pool', () => {
    const base = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex']);
    const same = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, undefined);
    assert.deepEqual(same, base);
    assert.ok(!('capabilityReasons' in same));
  });

  // --- needsVision routes to the only vision-capable authed provider --------
  it('needsVision → routes to the ONLY vision-capable authed provider even though it is later in policy order', () => {
    // Policy order is claude-first; both authed; only codex has a vision model.
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: VISION_REG,
      taskSignals: VISION_SIGNALS,
    });
    assert.equal(fit.provider, 'codex', 'must route to the vision-capable provider');
  });

  it('needsVision with BOTH vision-capable → existing order wins (claude first)', () => {
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: BOTH_VISION_REG,
      taskSignals: VISION_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'when both satisfy, the existing claude-first order wins');
  });

  // --- Vision-capable provider signed out → falls through, no stranding -----
  it('needsVision but the only vision-capable provider is SIGNED OUT → falls through to today (no stranding, no signed-out pick)', () => {
    // codex has the vision model but is NOT authenticated; claude IS authed (no vision).
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude'], undefined, {
      mode: 'balanced',
      registry: VISION_REG,
      taskSignals: VISION_SIGNALS,
    });
    const base = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude']);
    assert.equal(fit.provider, 'claude', 'must not strand on the signed-out vision provider');
    assert.equal(fit.provider, base.provider, 'falls through to today’s authed selection');
  });

  it('needsVision but the only vision-capable provider is UNAVAILABLE → falls through', () => {
    // Only claude available (no vision); codex (vision) not in the available pool.
    const fit = route('ic', CLAUDE_ONLY, DEFAULT_POLICY, undefined, undefined, undefined, {
      mode: 'balanced',
      registry: VISION_REG,
      taskSignals: VISION_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'never selects an unavailable provider');
  });

  // --- Large context prefers the bigger-window authed provider --------------
  it('large-context → prefers the bigger-window authed provider over the policy-first small-window one', () => {
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: CONTEXT_REG,
      taskSignals: LARGE_SIGNALS,
    });
    assert.equal(fit.provider, 'codex', 'big-window provider satisfies the large-context requirement');
  });

  it('large-context but the big-window provider is SIGNED OUT → falls through to the authed (small-window) provider', () => {
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude'], undefined, {
      mode: 'balanced',
      registry: CONTEXT_REG,
      taskSignals: LARGE_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'no stranding on the signed-out big-window provider');
  });

  // --- Unknown caps → no reorder --------------------------------------------
  it('unknown capability for all providers → NO reorder (falls through to today)', () => {
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: UNKNOWN_REG,
      taskSignals: LARGE_SIGNALS,
    });
    const base = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex']);
    assert.equal(fit.provider, base.provider, 'unknown windows must not move the provider');
    assert.equal(fit.provider, 'claude');
  });

  it('unknown vision for all providers → NO reorder', () => {
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: UNKNOWN_REG,
      taskSignals: VISION_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'unknown vision is not a satisfier — no reorder');
  });

  // --- Bounds: never changes tier / never picks unauthed ahead of authed ----
  it('pre-pass never changes tier: a manager request under balanced stays clamped to ic', () => {
    const fit = route('manager', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: CONTEXT_REG,
      taskSignals: { risk: 'critical', routePlan: true, estimatedInputTokens: 300_000, taskKind: 'large-context' },
    });
    assert.equal(fit.tier, 'ic', 'tier must remain clamped — the pre-pass never opens manager');
  });

  it('pre-pass never picks an unauthed satisfier ahead of an authed non-satisfier', () => {
    // codex satisfies (big window) but is SIGNED OUT; claude is authed but small window.
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude'], undefined, {
      mode: 'balanced',
      registry: CONTEXT_REG,
      taskSignals: LARGE_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'authed provider wins over a signed-out satisfier');
  });

  it('pre-pass never selects a provider not in available', () => {
    // codex is the only satisfier in the registry but is NOT available.
    const fit = route('ic', CLAUDE_ONLY, DEFAULT_POLICY, undefined, ['claude'], undefined, {
      mode: 'balanced',
      registry: CONTEXT_REG,
      taskSignals: LARGE_SIGNALS,
    });
    assert.equal(fit.provider, 'claude');
  });

  it('no auth info supplied: large-context still prefers the satisfying available provider (policy order within satisfiers)', () => {
    // No authenticatedProviders. claude (small) is policy-first but does NOT satisfy;
    // codex (big) satisfies → first-available phase over the satisfying set picks codex.
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, undefined, {
      mode: 'balanced',
      registry: CONTEXT_REG,
      taskSignals: LARGE_SIGNALS,
    });
    assert.equal(fit.provider, 'codex');
  });
});

describe('route — SOFT web-search preference pre-pass', () => {
  // Registry where, at IC tier, ONLY codex's model declares a native search tool;
  // claude has NO search tool. Policy order is claude-first, so WITHOUT the search
  // pre-pass claude wins. With a genuine search need + codex authed, codex wins so
  // its native web search actually runs.
  const SEARCH_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        // no supportsSearchTool → claude cannot run native search here
        source: ['declarative'],
      },
    ],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: ['codex'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        supportsSearchTool: true, // the only native-search-capable in-tier model
        source: ['codex-cache'],
      },
    ],
  };

  // A registry where a HIGHER-priority HARD requirement (vision) and search both
  // point at codex would be ambiguous, so for the "hard wins" test we use a
  // registry where claude (policy-first) is the ONLY vision-capable provider and
  // codex is the only search-capable one — proving vision (hard) overrides search
  // (soft) and keeps claude.
  const VISION_CLAUDE_SEARCH_CODEX_REG: CapabilityRegistry = {
    claude: [
      {
        provider: 'claude',
        id: 'sonnet',
        aliases: ['claude-sonnet-4-6'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        supportsVision: true, // claude satisfies the HARD vision requirement
        source: ['declarative'],
      },
    ],
    opencode: [],
    codex: [
      {
        provider: 'codex',
        id: 'gpt-5.4',
        aliases: ['codex'],
        tierHint: 'ic',
        supportedReasoningEfforts: [],
        supportsVision: false, // codex cannot do vision here
        supportsSearchTool: true, // but it is the search-capable one
        source: ['codex-cache'],
      },
    ],
  };

  const SEARCH_SIGNALS = {
    risk: 'medium' as const,
    routePlan: false,
    needsWebSearch: true,
    taskKind: 'implementation' as const,
  };
  const NO_SEARCH_SIGNALS = {
    risk: 'medium' as const,
    routePlan: false,
    needsWebSearch: false,
    taskKind: 'implementation' as const,
  };

  // (a) search + Codex authed → PREFERS Codex even though claude is policy-first.
  it('search need + Codex authenticated → PREFERS Codex (so native web search runs)', () => {
    const base = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex']);
    assert.equal(base.provider, 'claude', 'precondition: claude is policy-first without the pre-pass');
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: SEARCH_REG,
      taskSignals: SEARCH_SIGNALS,
    });
    assert.equal(fit.provider, 'codex', 'search need prefers the native-search-capable provider');
  });

  // (b) search + Codex NOT authed → falls back UNCHANGED (fail-soft, never fails).
  it('search need but Codex SIGNED OUT → falls back to today’s order unchanged (fail-soft, no stranding)', () => {
    const base = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude']);
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude'], undefined, {
      mode: 'balanced',
      registry: SEARCH_REG,
      taskSignals: SEARCH_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'must not strand on the signed-out search provider');
    assert.equal(fit.provider, base.provider, 'falls through to today’s authed selection');
  });

  it('search need but Codex UNAVAILABLE → falls through unchanged', () => {
    const fit = route('ic', CLAUDE_ONLY, DEFAULT_POLICY, undefined, ['claude'], undefined, {
      mode: 'balanced',
      registry: SEARCH_REG,
      taskSignals: SEARCH_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'never selects an unavailable provider for search');
  });

  it('search need but NO auth info supplied → no soft promotion (fall through unchanged)', () => {
    // Without auth info we must not promote a possibly-signed-out provider on a
    // soft preference, so claude (policy-first) stays.
    const base = route('ic', BOTH, DEFAULT_POLICY);
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, undefined, undefined, {
      mode: 'balanced',
      registry: SEARCH_REG,
      taskSignals: SEARCH_SIGNALS,
    });
    assert.equal(fit.provider, base.provider, 'no auth info → no soft search promotion');
    assert.equal(fit.provider, 'claude');
  });

  // (c) non-search turns → byte-for-byte unchanged.
  it('NON-search turn (needsWebSearch false) → provider/model/tier identical to today', () => {
    const base = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex']);
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: SEARCH_REG,
      taskSignals: NO_SEARCH_SIGNALS,
    });
    assert.equal(fit.provider, base.provider, 'non-search turn must not move the provider');
    assert.equal(fit.provider, 'claude');
  });

  it('needsWebSearch undefined (signal absent) → no search promotion', () => {
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: SEARCH_REG,
      taskSignals: { risk: 'medium', routePlan: false, taskKind: 'implementation' },
    });
    assert.equal(fit.provider, 'claude', 'absent search signal behaves like no search need');
  });

  // Bound: a HIGHER-priority HARD requirement (vision) overrides the soft search
  // preference — it must NOT be bolted into the hard path.
  it('HARD vision requirement overrides the SOFT search preference (hard wins)', () => {
    // claude (policy-first) is the only vision-capable provider; codex is the only
    // search-capable one. With BOTH a vision need (hard) AND a search need (soft),
    // the hard vision pre-pass runs first and keeps claude.
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: VISION_CLAUDE_SEARCH_CODEX_REG,
      taskSignals: {
        risk: 'medium',
        routePlan: false,
        needsVision: true,
        needsWebSearch: true,
        taskKind: 'implementation',
      },
    });
    assert.equal(fit.provider, 'claude', 'hard vision requirement wins over soft search preference');
  });

  it('search need with BOTH providers search-capable → existing claude-first order wins', () => {
    const BOTH_SEARCH_REG: CapabilityRegistry = {
      claude: [
        {
          provider: 'claude',
          id: 'sonnet',
          aliases: ['claude-sonnet-4-6'],
          tierHint: 'ic',
          supportedReasoningEfforts: [],
          supportsSearchTool: true,
          source: ['declarative'],
        },
      ],
      opencode: [],
      codex: [
        {
          provider: 'codex',
          id: 'gpt-5.4',
          aliases: ['codex'],
          tierHint: 'ic',
          supportedReasoningEfforts: [],
          supportsSearchTool: true,
          source: ['codex-cache'],
        },
      ],
    };
    const fit = route('ic', BOTH, DEFAULT_POLICY, undefined, ['claude', 'codex'], undefined, {
      mode: 'balanced',
      registry: BOTH_SEARCH_REG,
      taskSignals: SEARCH_SIGNALS,
    });
    assert.equal(fit.provider, 'claude', 'when both can search, the existing claude-first order wins');
  });
});
