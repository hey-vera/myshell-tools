/**
 * test/unit/select-reasoning-effort.test.ts — unit tests for the PURE reasoning-
 * effort selector (capability registry §3 "Effort selector", §5). Covers the full
 * ladder (mode × tier × risk/taskKind), step-down when an effort is unsupported,
 * and `undefined` when the model declares no efforts. Pure: no spawn, no I/O.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import { selectReasoningEffort } from '../../src/core/route.ts';
import type {
  ModelCapability,
  ReasoningEffort,
} from '../../src/core/model-capabilities.ts';
import type { Mode } from '../../src/core/policy.ts';
import type { Tier, Risk } from '../../src/core/types.ts';
import type { TaskKind } from '../../src/core/model-capabilities.ts';

/** A codex-like model declaring the full effort ladder. */
function model(efforts: readonly ReasoningEffort[]): ModelCapability {
  return {
    provider: 'codex',
    id: 'gpt-5.5',
    aliases: [],
    supportedReasoningEfforts: efforts,
    source: ['codex-cache'],
  };
}

const FULL: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh'];

interface Difficulty {
  depth?: 0 | 1 | 2;
  intentConfidence?: 'high' | 'medium' | 'low';
  planFirst?: boolean;
  forkCount?: number;
}

function pick(opts: {
  efforts?: readonly ReasoningEffort[];
  mode: Mode;
  tier: Tier;
  risk?: Risk;
  taskKind?: TaskKind;
  routePlan?: boolean;
  difficulty?: Difficulty;
}): ReasoningEffort | undefined {
  return selectReasoningEffort({
    model: model(opts.efforts ?? FULL),
    mode: opts.mode,
    tier: opts.tier,
    risk: opts.risk ?? 'low',
    taskKind: opts.taskKind ?? 'implementation',
    routePlan: opts.routePlan ?? false,
    ...(opts.difficulty !== undefined ? { difficulty: opts.difficulty } : {}),
  });
}

/** The 5 efforts the Claude Code CLI exposes (`--effort`), max deepest. */
const CLAUDE_FULL: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

describe('selectReasoningEffort — Max ladder reaches `max` for a Claude model, steps down for Codex', () => {
  it('Max admitted-manager hard turn on a model that supports max → max', () => {
    for (const hard of [
      { risk: 'high' as Risk },
      { risk: 'critical' as Risk },
      { taskKind: 'architecture' as TaskKind },
      { taskKind: 'review' as TaskKind },
      { taskKind: 'large-context' as TaskKind },
    ]) {
      assert.strictEqual(
        pick({ efforts: CLAUDE_FULL, mode: 'quality-first', tier: 'manager', ...hard }),
        'max',
        `Max manager hard turn ${JSON.stringify(hard)} should reach max`,
      );
    }
  });

  it('Codex (no max in its supported set) steps DOWN to xhigh — UNAFFECTED', () => {
    assert.strictEqual(
      pick({ efforts: FULL, mode: 'quality-first', tier: 'manager', taskKind: 'architecture' }),
      'xhigh',
    );
  });

  it('Max admitted-manager NON-hard turn stays high (not max), even with max available', () => {
    assert.strictEqual(
      pick({ efforts: CLAUDE_FULL, mode: 'quality-first', tier: 'manager' }),
      'high',
    );
  });

  it('Max IC never reaches max (max is admitted-manager-hard only)', () => {
    assert.strictEqual(
      pick({ efforts: CLAUDE_FULL, mode: 'quality-first', tier: 'ic', taskKind: 'architecture' }),
      'high',
    );
  });

  it('Efficient NEVER returns max or xhigh, even on a max-capable model', () => {
    const e = pick({
      efforts: CLAUDE_FULL,
      mode: 'cost-saver',
      tier: 'manager',
      risk: 'critical',
      taskKind: 'architecture',
    });
    assert.notStrictEqual(e, 'max');
    assert.notStrictEqual(e, 'xhigh');
    assert.strictEqual(e, 'medium');
  });

  it('Balanced admitted-manager xhigh-class turn caps at xhigh, never max', () => {
    assert.strictEqual(
      pick({ efforts: CLAUDE_FULL, mode: 'balanced', tier: 'manager', taskKind: 'architecture' }),
      'xhigh',
    );
  });
});

describe('selectReasoningEffort — empty efforts → undefined (#1 non-regression bar)', () => {
  it('returns undefined when the model declares NO efforts', () => {
    for (const mode of ['cost-saver', 'balanced', 'quality-first'] as const) {
      for (const tier of ['worker', 'ic', 'manager'] as const) {
        assert.strictEqual(
          pick({ efforts: [], mode, tier, risk: 'critical', taskKind: 'architecture' }),
          undefined,
          `mode=${mode} tier=${tier} with no efforts must be undefined`,
        );
      }
    }
  });
});

describe('selectReasoningEffort — Efficient (cost-saver): low IC, medium manager, NEVER xhigh', () => {
  it('worker → low', () => {
    assert.strictEqual(pick({ mode: 'cost-saver', tier: 'worker' }), 'low');
  });
  it('IC → low', () => {
    assert.strictEqual(pick({ mode: 'cost-saver', tier: 'ic' }), 'low');
  });
  it('admitted manager → medium', () => {
    assert.strictEqual(pick({ mode: 'cost-saver', tier: 'manager' }), 'medium');
  });
  it('NEVER xhigh, even for a critical/architecture manager turn', () => {
    const e = pick({
      mode: 'cost-saver',
      tier: 'manager',
      risk: 'critical',
      taskKind: 'architecture',
    });
    assert.notStrictEqual(e, 'xhigh');
    assert.strictEqual(e, 'medium');
  });
});

describe('selectReasoningEffort — Balanced: medium default, high on hard turns, xhigh only admitted-manager+critical/arch/large-context', () => {
  it('low-risk IC → medium default', () => {
    assert.strictEqual(pick({ mode: 'balanced', tier: 'ic' }), 'medium');
  });
  it('high-risk IC → high', () => {
    assert.strictEqual(pick({ mode: 'balanced', tier: 'ic', risk: 'high' }), 'high');
  });
  it('review taskKind → high', () => {
    assert.strictEqual(pick({ mode: 'balanced', tier: 'ic', taskKind: 'review' }), 'high');
  });
  it('large-context taskKind → high (IC)', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'ic', taskKind: 'large-context' }),
      'high',
    );
  });
  it('admitted manager + architecture → xhigh', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'manager', taskKind: 'architecture' }),
      'xhigh',
    );
  });
  it('admitted manager + critical → xhigh', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'manager', risk: 'critical' }),
      'xhigh',
    );
  });
  it('manager + high risk (NOT critical/arch/large-context) → high, NOT xhigh', () => {
    assert.strictEqual(pick({ mode: 'balanced', tier: 'manager', risk: 'high' }), 'high');
  });
  it('manager + review (not an xhigh-class turn in Balanced) → high', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'manager', taskKind: 'review' }),
      'high',
    );
  });
});

describe('selectReasoningEffort — Max (quality-first): high default, xhigh for admitted-manager hard turns', () => {
  it('IC low-risk → high default', () => {
    assert.strictEqual(pick({ mode: 'quality-first', tier: 'ic' }), 'high');
  });
  it('worker low-risk → medium (not a hard turn, not IC/manager)', () => {
    assert.strictEqual(pick({ mode: 'quality-first', tier: 'worker' }), 'medium');
  });
  it('worker hard turn → high', () => {
    assert.strictEqual(
      pick({ mode: 'quality-first', tier: 'worker', risk: 'high' }),
      'high',
    );
  });
  it('admitted manager + architecture → xhigh', () => {
    assert.strictEqual(
      pick({ mode: 'quality-first', tier: 'manager', taskKind: 'architecture' }),
      'xhigh',
    );
  });
  it('admitted manager + high risk → xhigh (high is a hard turn in Max)', () => {
    assert.strictEqual(
      pick({ mode: 'quality-first', tier: 'manager', risk: 'high' }),
      'xhigh',
    );
  });
  it('admitted manager + review → xhigh', () => {
    assert.strictEqual(
      pick({ mode: 'quality-first', tier: 'manager', taskKind: 'review' }),
      'xhigh',
    );
  });
  it('admitted manager, low-risk, non-hard → high (NOT xhigh)', () => {
    assert.strictEqual(pick({ mode: 'quality-first', tier: 'manager' }), 'high');
  });
});

describe('selectReasoningEffort — step DOWN to the nearest lower supported effort', () => {
  it('Max manager architecture wants xhigh; model only supports up to high → high', () => {
    assert.strictEqual(
      pick({
        efforts: ['low', 'medium', 'high'],
        mode: 'quality-first',
        tier: 'manager',
        taskKind: 'architecture',
      }),
      'high',
    );
  });
  it('Balanced default medium; model supports only [low, high] → low (nearest LOWER)', () => {
    assert.strictEqual(
      pick({ efforts: ['low', 'high'], mode: 'balanced', tier: 'ic' }),
      'low',
    );
  });
  it('Max IC wants high; model supports only [low, medium] → medium', () => {
    assert.strictEqual(
      pick({ efforts: ['low', 'medium'], mode: 'quality-first', tier: 'ic' }),
      'medium',
    );
  });
  it('desired effort below the model floor → undefined (nothing at/below)', () => {
    // Efficient IC wants `low`, but the model only declares `high`/`xhigh`.
    assert.strictEqual(
      pick({ efforts: ['high', 'xhigh'], mode: 'cost-saver', tier: 'ic' }),
      undefined,
    );
  });
  it('exact-supported effort is returned unchanged (no needless step-down)', () => {
    assert.strictEqual(
      pick({ efforts: FULL, mode: 'quality-first', tier: 'manager', taskKind: 'architecture' }),
      'xhigh',
    );
  });
});

// ---------------------------------------------------------------------------
// P0.3 — per-task difficulty sizing. The new `difficulty` signals (engagement
// depth, intent GOAL-confidence, plan-first, genuine-fork count) bump the coarse
// bucket by at most ±1 ladder step, bounded by the mode+tier hard-turn ceiling.
// ---------------------------------------------------------------------------

describe('selectReasoningEffort — difficulty is NEUTRAL by default (no inflation)', () => {
  it('absent difficulty leaves every bucket unchanged', () => {
    assert.strictEqual(pick({ mode: 'balanced', tier: 'ic' }), 'medium');
    assert.strictEqual(pick({ mode: 'cost-saver', tier: 'ic' }), 'low');
    assert.strictEqual(pick({ mode: 'quality-first', tier: 'manager' }), 'high');
  });
  it('neutral signals (depth 1, high/absent confidence, no plan-first, ≤1 fork) leave effort unchanged', () => {
    for (const difficulty of [
      { depth: 1 as const },
      { depth: 1 as const, intentConfidence: 'high' as const, planFirst: false, forkCount: 1 },
      { intentConfidence: 'high' as const },
      { forkCount: 0 },
    ]) {
      assert.strictEqual(
        pick({ mode: 'balanced', tier: 'ic', difficulty }),
        'medium',
        `neutral ${JSON.stringify(difficulty)} must stay medium`,
      );
    }
  });
});

describe('selectReasoningEffort — a deep / low-confidence / hard turn RAISES (bounded)', () => {
  it('Balanced IC depth-2 raises medium → high', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'ic', difficulty: { depth: 2 } }),
      'high',
    );
  });
  it('Balanced IC low GOAL-confidence raises medium → high', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'ic', difficulty: { intentConfidence: 'low' } }),
      'high',
    );
  });
  it('Balanced IC plan-first raises medium → high', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'ic', difficulty: { planFirst: true } }),
      'high',
    );
  });
  it('Balanced IC ≥2 genuine forks raises medium → high', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'ic', difficulty: { forkCount: 2 } }),
      'high',
    );
  });
  it('a single raise step never leaps the ladder: Balanced IC stays at high, never xhigh', () => {
    assert.strictEqual(
      pick({
        mode: 'balanced',
        tier: 'ic',
        difficulty: { depth: 2, intentConfidence: 'low', planFirst: true, forkCount: 3 },
      }),
      'high',
    );
  });
  it('raise is bounded by the hard-turn ceiling: Balanced IC never reaches xhigh from difficulty', () => {
    // An IC hard turn earns `high` in Balanced; difficulty cannot exceed that even
    // when every signal screams hard.
    assert.notStrictEqual(
      pick({
        mode: 'balanced',
        tier: 'ic',
        difficulty: { depth: 2, intentConfidence: 'low', planFirst: true, forkCount: 5 },
      }),
      'xhigh',
    );
  });
  it('Balanced admitted-manager non-xhigh-class deep turn raises medium → high (NOT xhigh)', () => {
    // base 'medium' (implementation), hard-turn manager ceiling in Balanced is
    // 'high' (high-risk is not xhigh-class), so a deep manager implementation turn
    // tops out at high.
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'manager', difficulty: { depth: 2 } }),
      'high',
    );
  });
});

describe('selectReasoningEffort — a genuinely trivial / shallow turn LOWERS (no floor breach)', () => {
  it('Balanced IC depth-0 high-confidence lowers medium → low', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'ic', difficulty: { depth: 0, intentConfidence: 'high' } }),
      'low',
    );
  });
  it('depth-0 with lingering medium confidence does NOT lower (medium blocks the step down)', () => {
    assert.strictEqual(
      pick({ mode: 'balanced', tier: 'ic', difficulty: { depth: 0, intentConfidence: 'medium' } }),
      'medium',
    );
  });
  it('lower never breaches the low floor: cost-saver IC (low) with depth-0 stays low', () => {
    assert.strictEqual(
      pick({ mode: 'cost-saver', tier: 'ic', difficulty: { depth: 0 } }),
      'low',
    );
  });
});

describe('selectReasoningEffort — Efficient never RAISES on a difficulty hint (cost discipline)', () => {
  it('cost-saver manager (medium) stays medium even on a deep/low-confidence turn', () => {
    assert.strictEqual(
      pick({
        mode: 'cost-saver',
        tier: 'manager',
        difficulty: { depth: 2, intentConfidence: 'low', planFirst: true, forkCount: 3 },
      }),
      'medium',
    );
  });
  it('cost-saver IC (low) stays low on a deep turn (never above low in Efficient)', () => {
    assert.strictEqual(
      pick({ mode: 'cost-saver', tier: 'ic', difficulty: { depth: 2 } }),
      'low',
    );
  });
});

describe('selectReasoningEffort — capability reconciliation still caps a bumped effort to supported', () => {
  it('Balanced IC depth-2 wants high; model supports only [low, medium] → medium (stepped down)', () => {
    assert.strictEqual(
      pick({ efforts: ['low', 'medium'], mode: 'balanced', tier: 'ic', difficulty: { depth: 2 } }),
      'medium',
    );
  });
  it('a bumped desired beyond the supported set never escapes resolveSupported', () => {
    // Wants high (medium + raise), model tops out at medium → medium, NOT high.
    assert.strictEqual(
      pick({
        efforts: ['low', 'medium'],
        mode: 'balanced',
        tier: 'ic',
        difficulty: { intentConfidence: 'low' },
      }),
      'medium',
    );
  });
  it('empty efforts → undefined regardless of difficulty', () => {
    assert.strictEqual(
      pick({ efforts: [], mode: 'balanced', tier: 'ic', difficulty: { depth: 2 } }),
      undefined,
    );
  });
});
