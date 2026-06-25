/**
 * test/unit/mode-levels.test.ts — unit tests for the PURE 5-level firepower dial
 * (src/core/mode-levels.ts; redesign Phase 0, slice 2). Covers: each level maps to
 * the specified mode/policy/intensity/effort; High is a GENUINELY-lighter rung than
 * Max (lower effort AND lighter verification/escalation, not just a narrower panel);
 * Auto resolves via the byproduct PER-TURN ROUTE-HINT seam (a suggested rung yielding
 * a rung tuple, floor-clamped) then falls back to persisted-mode / auto-mode
 * heuristics; persisted-old-mode MIGRATION; recursion fact; and a
 * single-provider/single-model run still resolves a usable level. Pure: no spawn, no I/O.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_LEVELS,
  LEVEL_DESC,
  isLevel,
  levelLabel,
  levelToMode,
  policyForLevel,
  defaultIntensityForLevel,
  baseEffortForLevel,
  allowsAgentRecursion,
  profileForLevel,
  migrateMode,
  resolveRouteHint,
  rungTupleForLevel,
  resolveRungTuple,
  resolveLevel,
  type Level,
} from '../../src/core/mode-levels.ts';
import { POLICY_PRESETS } from '../../src/core/policy.ts';
import type { Mode } from '../../src/core/policy.ts';
import { KNOWN_REASONING_EFFORTS } from '../../src/core/model-capabilities.ts';

/** Rank a reasoning effort on the cheapest→deepest ladder (for High<Max assertions). */
function effortRank(e: string): number {
  return KNOWN_REASONING_EFFORTS.indexOf(e as never);
}

// ---------------------------------------------------------------------------
// 1. The level set + guards
// ---------------------------------------------------------------------------

describe('Level set + isLevel', () => {
  it('is exactly the five locked levels, weakest → strongest, auto last', () => {
    assert.deepEqual([...ALL_LEVELS], ['budget', 'balanced', 'high', 'max', 'auto']);
  });

  it('isLevel accepts known levels and rejects everything else', () => {
    for (const l of ALL_LEVELS) assert.equal(isLevel(l), true);
    for (const x of ['cost-saver', 'quality-first', '', 'BUDGET', 3, null, undefined, {}]) {
      assert.equal(isLevel(x), false, String(x));
    }
  });

  it('every level has a label and a one-line description', () => {
    assert.equal(levelLabel('budget'), 'Budget');
    assert.equal(levelLabel('auto'), 'Auto');
    for (const l of ALL_LEVELS) {
      assert.equal(typeof LEVEL_DESC[l], 'string');
      assert.ok(LEVEL_DESC[l].length > 0, `${l} description`);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Level → Mode (the bridge onto the shipped 3-stop dial)
// ---------------------------------------------------------------------------

describe('levelToMode — onto the existing 3-stop Mode', () => {
  it('budget≈cost-saver, balanced≈balanced, high/max ride quality-first, auto is absent', () => {
    assert.equal(levelToMode('budget'), 'cost-saver');
    assert.equal(levelToMode('balanced'), 'balanced');
    assert.equal(levelToMode('high'), 'quality-first');
    assert.equal(levelToMode('max'), 'quality-first');
    assert.equal(levelToMode('auto'), undefined);
  });
});

// ---------------------------------------------------------------------------
// 3. Level → Policy (built from the shipped presets, panel on for Max)
// ---------------------------------------------------------------------------

describe('policyForLevel — reuses POLICY_PRESETS, never a parallel system', () => {
  it('budget = cost-saver preset (no panel/hedge)', () => {
    assert.equal(policyForLevel('budget'), POLICY_PRESETS['cost-saver']);
    assert.equal(policyForLevel('budget')?.panelPolicy, 'off');
    assert.equal(policyForLevel('budget')?.hedgePolicy, 'off');
  });

  it('balanced = balanced preset (DEFAULT_POLICY)', () => {
    assert.equal(policyForLevel('balanced'), POLICY_PRESETS['balanced']);
  });

  it('max = quality-first preset with the full panel/hedge machinery ON', () => {
    const p = policyForLevel('max');
    assert.equal(p, POLICY_PRESETS['quality-first']);
    assert.equal(p?.panelPolicy, 'hard-turns');
    assert.equal(p?.hedgePolicy, 'on');
    assert.equal(p?.maxPanelProviders, 3);
    assert.equal(p?.flagshipAdmission, 'always-eligible');
  });

  it('high = quality-first flagship reachability but LIGHTER than Max (not just panel)', () => {
    const p = policyForLevel('high');
    assert.ok(p !== undefined);
    // Keeps flagship reachability + hard-turns panel posture...
    assert.equal(p.flagshipAdmission, 'always-eligible');
    assert.equal(p.panelPolicy, 'hard-turns');
    // ...but LIGHTER verification than Max's 'auto'.
    assert.equal(p.reviewPolicy, 'critical-only');
    // ...a gentler panel than Max's 3.
    assert.equal(p.maxPanelProviders, 2);
    // It is a FRESH object — never mutates the shared quality-first preset.
    assert.notEqual(p, POLICY_PRESETS['quality-first']);
    assert.equal(POLICY_PRESETS['quality-first'].maxPanelProviders, 3);
    assert.equal(POLICY_PRESETS['quality-first'].reviewPolicy, 'auto');
  });

  it('auto has no fixed policy (undefined — resolved per turn)', () => {
    assert.equal(policyForLevel('auto'), undefined);
  });
});

// ---------------------------------------------------------------------------
// 3b. High < Max DIFFERENTIATION — the genuine-rung gap (effort + verification +
//     escalation), not merely panel width.
// ---------------------------------------------------------------------------

describe('High is a genuinely LIGHTER rung than Max (effort + verification + escalation)', () => {
  it('High has a STRICTLY LOWER reasoning-effort floor than Max', () => {
    const hi = baseEffortForLevel('high');
    const mx = baseEffortForLevel('max');
    assert.ok(hi !== undefined && mx !== undefined);
    assert.ok(
      effortRank(hi) < effortRank(mx),
      `expected High effort (${hi}) < Max effort (${mx})`,
    );
  });

  it('High has LIGHTER verification than Max (critical-only vs auto)', () => {
    const hi = policyForLevel('high');
    const mx = policyForLevel('max');
    assert.equal(hi?.reviewPolicy, 'critical-only');
    assert.equal(mx?.reviewPolicy, 'auto');
    // critical-only is strictly a subset of auto's triggers → lighter verification.
    assert.notEqual(hi?.reviewPolicy, mx?.reviewPolicy);
  });

  it('High escalates LESS EAGERLY than Max on every risk band', () => {
    const hi = policyForLevel('high');
    const mx = policyForLevel('max');
    assert.ok(hi !== undefined && mx !== undefined);
    for (const risk of ['low', 'medium', 'high', 'critical'] as const) {
      assert.ok(
        hi.escalateBelowConfidence[risk] < mx.escalateBelowConfidence[risk],
        `High should escalate less eagerly than Max at ${risk} ` +
          `(${hi.escalateBelowConfidence[risk]} < ${mx.escalateBelowConfidence[risk]})`,
      );
    }
  });

  it('High still narrows the panel (2 vs 3) — the original differentiator is kept too', () => {
    assert.equal(policyForLevel('high')?.maxPanelProviders, 2);
    assert.equal(policyForLevel('max')?.maxPanelProviders, 3);
  });

  it('the rung tuple expresses the gap: same manager rung, lighter verifyDepth', () => {
    const hi = rungTupleForLevel('high');
    const mx = rungTupleForLevel('max');
    assert.equal(hi.modelRung, 'manager');
    assert.equal(mx.modelRung, 'manager');
    // High self-checks; Max runs the cross-vendor pass.
    assert.equal(hi.verifyDepth, 'self-check');
    assert.equal(mx.verifyDepth, 'cross-vendor');
    // Effort gap carried through the tuple as well.
    assert.ok(effortRank(hi.effort) < effortRank(mx.effort));
  });
});

// ---------------------------------------------------------------------------
// 4. Intensity folds UNDER the level
// ---------------------------------------------------------------------------

describe('defaultIntensityForLevel — Intensity folds under the level', () => {
  it('budget→1, balanced→3, high→4, max→5, auto→auto', () => {
    assert.equal(defaultIntensityForLevel('budget'), 1);
    assert.equal(defaultIntensityForLevel('balanced'), 3);
    assert.equal(defaultIntensityForLevel('high'), 4);
    assert.equal(defaultIntensityForLevel('max'), 5);
    assert.equal(defaultIntensityForLevel('auto'), 'auto');
  });

  it('is monotonic across the concrete levels', () => {
    const order: Exclude<Level, 'auto'>[] = ['budget', 'balanced', 'high', 'max'];
    const vals = order.map((l) => defaultIntensityForLevel(l) as number);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i]! > vals[i - 1]!);
  });
});

// ---------------------------------------------------------------------------
// 5. Base effort + recursion facts
// ---------------------------------------------------------------------------

describe('baseEffortForLevel + allowsAgentRecursion', () => {
  it('effort deepens with the level: budget→low … max→max; auto undefined', () => {
    assert.equal(baseEffortForLevel('budget'), 'low');
    assert.equal(baseEffortForLevel('balanced'), 'medium');
    assert.equal(baseEffortForLevel('high'), 'high');
    assert.equal(baseEffortForLevel('max'), 'max');
    assert.equal(baseEffortForLevel('auto'), undefined);
  });

  it('Budget forbids agent recursion; every other level permits it', () => {
    assert.equal(allowsAgentRecursion('budget'), false);
    for (const l of ['balanced', 'high', 'max', 'auto'] as Level[]) {
      assert.equal(allowsAgentRecursion(l), true, l);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. profileForLevel — the one-shape resolved profile
// ---------------------------------------------------------------------------

describe('profileForLevel — concrete levels only', () => {
  it('bundles mode/policy/intensity/effort/recursion consistently', () => {
    const p = profileForLevel('high');
    assert.equal(p.level, 'high');
    assert.equal(p.mode, 'quality-first');
    assert.equal(p.policy.maxPanelProviders, 2);
    assert.equal(p.intensity, 4);
    assert.equal(p.baseEffort, 'high');
    assert.equal(p.allowsRecursion, true);
  });

  it('budget profile is the lean, no-recursion posture', () => {
    const p = profileForLevel('budget');
    assert.equal(p.mode, 'cost-saver');
    assert.equal(p.policy.panelPolicy, 'off');
    assert.equal(p.intensity, 1);
    assert.equal(p.baseEffort, 'low');
    assert.equal(p.allowsRecursion, false);
  });
});

// ---------------------------------------------------------------------------
// 7. MIGRATION — persisted legacy config.mode → Level (backward compat)
// ---------------------------------------------------------------------------

describe('migrateMode — persisted old config.mode values', () => {
  it('cost-saver→budget, balanced→balanced, quality-first→max (strongest old stop)', () => {
    assert.equal(migrateMode('cost-saver'), 'budget');
    assert.equal(migrateMode('balanced'), 'balanced');
    assert.equal(migrateMode('quality-first'), 'max');
  });

  it('absent / unknown → auto (no explicit mode already meant Auto)', () => {
    assert.equal(migrateMode(undefined), 'auto');
    assert.equal(migrateMode(null), 'auto');
    assert.equal(migrateMode('something-else'), 'auto');
  });

  it('every shipped Mode migrates to a concrete level (no data loss)', () => {
    for (const m of ['cost-saver', 'balanced', 'quality-first'] as Mode[]) {
      const lvl = migrateMode(m);
      assert.notEqual(lvl, 'auto', m);
      assert.equal(isLevel(lvl), true);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Auto resolution — the PER-TURN ROUTE-HINT seam (suggested rung → tuple),
//    floor-clamped, then heuristic fallback.
// ---------------------------------------------------------------------------

describe('resolveRouteHint — the per-turn suggested-rung seam (NOT a coarse bucket)', () => {
  it('a byproduct-suggested rung is used directly', () => {
    assert.equal(resolveRouteHint({ suggestedLevel: 'high' }), 'high');
    assert.equal(resolveRouteHint({ suggestedLevel: 'budget' }), 'budget');
    assert.equal(resolveRouteHint({ suggestedLevel: 'max' }), 'max');
  });

  it('the suggestion is clamped UP to the floor (hint may lower, never below floor)', () => {
    // Suggestion below the floor is lifted to the floor.
    assert.equal(resolveRouteHint({ suggestedLevel: 'budget', floor: 'balanced' }), 'balanced');
    // Suggestion at/above the floor is honored.
    assert.equal(resolveRouteHint({ suggestedLevel: 'max', floor: 'balanced' }), 'max');
    assert.equal(resolveRouteHint({ suggestedLevel: 'high', floor: 'high' }), 'high');
  });

  it('the locked hard floor is Budget — an absent floor never routes below Budget', () => {
    // Default floor is budget, so any suggested rung is honored as-is (nothing below budget exists).
    assert.equal(resolveRouteHint({ suggestedLevel: 'budget' }), 'budget');
  });

  it('no usable suggestion → undefined (caller falls back to today’s session mode)', () => {
    assert.equal(resolveRouteHint(undefined), undefined);
    assert.equal(resolveRouteHint({}), undefined);
    // A floor with no suggestion is NOT a signal on its own.
    assert.equal(resolveRouteHint({ floor: 'max' }), undefined);
  });
});

describe('rungTupleForLevel — the six-dial rung tuple', () => {
  it('expands each concrete level into the full {rung,effort,verify,decomp,concurrency,context} tuple', () => {
    const budget = rungTupleForLevel('budget');
    assert.equal(budget.modelRung, 'worker');
    assert.equal(budget.effort, 'low');
    assert.equal(budget.verifyDepth, 'none');
    assert.equal(budget.decompDepth, 'shallow');
    assert.equal(budget.concurrency, 1);
    assert.equal(budget.contextBudget, 'lean');

    const max = rungTupleForLevel('max');
    assert.equal(max.modelRung, 'manager');
    assert.equal(max.effort, 'max');
    assert.equal(max.verifyDepth, 'cross-vendor');
    assert.equal(max.decompDepth, 'deep');
    assert.equal(max.concurrency, 5);
    assert.equal(max.contextBudget, 'rich');
  });

  it('the tuple never disagrees with profileForLevel on effort/intensity', () => {
    for (const l of ['budget', 'balanced', 'high', 'max'] as Exclude<Level, 'auto'>[]) {
      const t = rungTupleForLevel(l);
      const p = profileForLevel(l);
      assert.equal(t.effort, p.baseEffort, `${l} effort`);
      assert.equal(t.concurrency, p.intensity, `${l} concurrency`);
    }
  });
});

describe('resolveLevel — the single Auto decision point (route-hint shaped)', () => {
  it('a concrete chosen level wins over everything', () => {
    assert.equal(
      resolveLevel({ chosen: 'budget', routeHint: { suggestedLevel: 'max' }, autoMode: 'quality-first' }),
      'budget',
    );
    assert.equal(resolveLevel({ chosen: 'max' }), 'max');
  });

  it('Auto uses the byproduct route hint (suggested rung) when present', () => {
    assert.equal(
      resolveLevel({ chosen: 'auto', routeHint: { suggestedLevel: 'high' } }),
      'high',
    );
    assert.equal(
      resolveLevel({ chosen: 'auto', routeHint: { suggestedLevel: 'max' }, autoMode: 'cost-saver' }),
      'max',
    );
  });

  it('the route hint is floor-clamped within resolveLevel too', () => {
    assert.equal(
      resolveLevel({ chosen: 'auto', routeHint: { suggestedLevel: 'budget', floor: 'high' } }),
      'high',
    );
  });

  it('Auto WITHOUT a byproduct falls back to the persisted legacy mode (migrated)', () => {
    assert.equal(resolveLevel({ chosen: 'auto', persistedMode: 'cost-saver' }), 'budget');
    assert.equal(resolveLevel({ chosen: 'auto', persistedMode: 'quality-first' }), 'max');
  });

  it('Auto with no persisted mode falls back to the plan-derived auto mode', () => {
    assert.equal(resolveLevel({ chosen: 'auto', autoMode: 'quality-first' }), 'max');
    assert.equal(resolveLevel({ chosen: 'auto', autoMode: 'cost-saver' }), 'budget');
  });

  it('byproduct precedence: route hint beats persisted mode beats auto mode', () => {
    // persisted balanced but a byproduct suggests max → max (byproduct wins).
    assert.equal(
      resolveLevel({
        chosen: 'auto',
        routeHint: { suggestedLevel: 'max' },
        persistedMode: 'balanced',
        autoMode: 'cost-saver',
      }),
      'max',
    );
    // no byproduct: persisted mode beats auto mode.
    assert.equal(
      resolveLevel({ chosen: 'auto', persistedMode: 'balanced', autoMode: 'quality-first' }),
      'balanced',
    );
  });

  it('absent everything → balanced (safe middle); never throws, always concrete', () => {
    assert.equal(resolveLevel({}), 'balanced');
    assert.equal(resolveLevel({ chosen: 'auto' }), 'balanced');
    // Result is always a concrete (non-auto) level.
    const r = resolveLevel({ chosen: 'auto' });
    assert.notEqual(r, 'auto');
    assert.equal(isLevel(r), true);
  });
});

describe('resolveRungTuple — the tuple-shaped Auto seam + byte-identical fallback', () => {
  it('with NO byproduct hint, falls back to today’s session mode (byte-identical level)', () => {
    // No route hint → identical fallback chain to resolveLevel; tuple expands that level.
    const t = resolveRungTuple({ chosen: 'auto', persistedMode: 'quality-first' });
    assert.equal(t.level, 'max');
    assert.deepEqual(t, rungTupleForLevel('max'));
    // Absent everything → balanced tuple (the safe middle).
    assert.deepEqual(resolveRungTuple({ chosen: 'auto' }), rungTupleForLevel('balanced'));
  });

  it('a byproduct route hint drives the committed tuple', () => {
    const t = resolveRungTuple({ chosen: 'auto', routeHint: { suggestedLevel: 'high' } });
    assert.equal(t.level, 'high');
    assert.equal(t.verifyDepth, 'self-check');
  });
});

// ---------------------------------------------------------------------------
// 9. Single-provider / single-model run still works (the locked-model guarantee)
// ---------------------------------------------------------------------------

describe('single-provider / single-model — a usable level always resolves', () => {
  // On a 1-provider/1-model setup there is no plan signal and possibly no
  // persisted mode; Auto must still yield a concrete, runnable level so the turn
  // proceeds (firepower collapses onto the one model via the existing route()).
  it('Auto with zero signals on a bare setup → a concrete level (balanced)', () => {
    const resolved = resolveLevel({ chosen: 'auto' });
    const profile = profileForLevel(resolved);
    assert.equal(profile.level, 'balanced');
    assert.ok(profile.policy !== undefined);
    assert.ok(profile.mode === 'balanced');
  });

  it('every concrete level yields a complete, usable profile (nothing undefined)', () => {
    for (const l of ['budget', 'balanced', 'high', 'max'] as Exclude<Level, 'auto'>[]) {
      const p = profileForLevel(l);
      assert.ok(p.policy !== undefined, `${l} policy`);
      assert.ok(p.mode !== undefined, `${l} mode`);
      assert.ok(p.baseEffort !== undefined, `${l} effort`);
      assert.ok(p.intensity !== undefined, `${l} intensity`);
    }
  });
});
