/**
 * test/unit/select-reasoning-effort.test.ts — unit tests for the PURE reasoning-
 * effort selector (capability registry §3 "Effort selector", §5). Covers the full
 * ladder (mode × tier × risk/taskKind), step-down when an effort is unsupported,
 * and `undefined` when the model declares no efforts. Pure: no spawn, no I/O.
 */

import { describe, it } from 'node:test';
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

function pick(opts: {
  efforts?: readonly ReasoningEffort[];
  mode: Mode;
  tier: Tier;
  risk?: Risk;
  taskKind?: TaskKind;
  routePlan?: boolean;
}): ReasoningEffort | undefined {
  return selectReasoningEffort({
    model: model(opts.efforts ?? FULL),
    mode: opts.mode,
    tier: opts.tier,
    risk: opts.risk ?? 'low',
    taskKind: opts.taskKind ?? 'implementation',
    routePlan: opts.routePlan ?? false,
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
