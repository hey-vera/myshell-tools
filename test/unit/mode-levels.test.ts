/**
 * test/unit/mode-levels.test.ts — unit tests for the PURE 5-level firepower dial
 * (src/core/mode-levels.ts; redesign Phase 0, slice 2). Covers: each level maps to
 * the specified mode/policy/intensity/effort; Auto resolves via the byproduct seam
 * then falls back to persisted-mode / auto-mode heuristics; persisted-old-mode
 * MIGRATION; recursion fact; and a single-provider/single-model run still resolves a
 * usable level. Pure: no spawn, no I/O.
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
  levelFromAutoDifficulty,
  resolveLevel,
  type Level,
} from '../../src/core/mode-levels.ts';
import { POLICY_PRESETS } from '../../src/core/policy.ts';
import type { Mode } from '../../src/core/policy.ts';

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

  it('high = quality-first envelope but a NARROWER 2-provider panel (mid-high rung)', () => {
    const p = policyForLevel('high');
    assert.ok(p !== undefined);
    // Same thorough-review / flagship posture as Max...
    assert.equal(p.flagshipAdmission, 'always-eligible');
    assert.equal(p.reviewPolicy, 'auto');
    assert.equal(p.panelPolicy, 'hard-turns');
    // ...but a gentler panel than Max's 3.
    assert.equal(p.maxPanelProviders, 2);
    // It is a FRESH object — never mutates the shared quality-first preset.
    assert.notEqual(p, POLICY_PRESETS['quality-first']);
    assert.equal(POLICY_PRESETS['quality-first'].maxPanelProviders, 3);
  });

  it('auto has no fixed policy (undefined — resolved per turn)', () => {
    assert.equal(policyForLevel('auto'), undefined);
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
// 8. Auto resolution — byproduct seam then heuristic fallback
// ---------------------------------------------------------------------------

describe('levelFromAutoDifficulty — the byproduct seam', () => {
  it('an explicit suggestedLevel wins outright', () => {
    assert.equal(levelFromAutoDifficulty({ suggestedLevel: 'high' }), 'high');
    assert.equal(
      levelFromAutoDifficulty({ suggestedLevel: 'budget', difficulty: 'critical' }),
      'budget',
    );
  });

  it('difficulty buckets project onto the ladder', () => {
    assert.equal(levelFromAutoDifficulty({ difficulty: 'trivial' }), 'budget');
    assert.equal(levelFromAutoDifficulty({ difficulty: 'low' }), 'budget');
    assert.equal(levelFromAutoDifficulty({ difficulty: 'medium' }), 'balanced');
    assert.equal(levelFromAutoDifficulty({ difficulty: 'high' }), 'high');
    assert.equal(levelFromAutoDifficulty({ difficulty: 'critical' }), 'max');
  });

  it('no usable signal → undefined (caller falls back)', () => {
    assert.equal(levelFromAutoDifficulty(undefined), undefined);
    assert.equal(levelFromAutoDifficulty({}), undefined);
  });
});

describe('resolveLevel — the single Auto decision point', () => {
  it('a concrete chosen level wins over everything', () => {
    assert.equal(
      resolveLevel({ chosen: 'budget', difficulty: { difficulty: 'critical' }, autoMode: 'quality-first' }),
      'budget',
    );
    assert.equal(resolveLevel({ chosen: 'max' }), 'max');
  });

  it('Auto uses the byproduct difficulty signal when present', () => {
    assert.equal(
      resolveLevel({ chosen: 'auto', difficulty: { difficulty: 'high' } }),
      'high',
    );
    assert.equal(
      resolveLevel({ chosen: 'auto', difficulty: { suggestedLevel: 'max' }, autoMode: 'cost-saver' }),
      'max',
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

  it('byproduct precedence: signal beats persisted mode beats auto mode', () => {
    // persisted balanced but a byproduct says critical → max (byproduct wins).
    assert.equal(
      resolveLevel({
        chosen: 'auto',
        difficulty: { difficulty: 'critical' },
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
