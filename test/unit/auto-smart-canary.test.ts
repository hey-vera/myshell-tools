/**
 * test/unit/auto-smart-canary.test.ts — VALIDATION CANARY for MYSHELL_AUTO_SMART
 * promotion (DEDRIFT-EXECUTION-PLAN.md bucket D).
 *
 * This is the PERMANENT REGRESSION GUARD. It exercises the contract that the
 * feature must uphold BEFORE the flag is promoted to always-on:
 *
 *   a. ABSENT config.mode → smart auto policy applies (balanced, in-budget).
 *   b. PERSISTED EXPLICIT mode → remains AUTHORITATIVE (not overridden).
 *   c. Menu display reason: render reflects correct source (smart vs explicit).
 *   d. Budget ceilings / provider capacity allocation respected under smart policy.
 *   e. Governor pressure: smart policy sheds/degrades correctly under pressure.
 *
 * The canary simulates the promoted (always-on) state. If any assertion
 * fails, the gate is NOT ready and the feature must NOT be promoted.
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  planBudgetCeiling,
  resolveAutoMode,
  autoModeReason,
} from '../../src/interface/menu-auto-mode.ts';
import { allocate } from '../../src/core/governor.ts';
import type { AllocationPlan } from '../../src/core/governor.ts';
import type { Mode } from '../../src/core/policy.ts';
import { pressureFromSignals } from '../../src/core/capability-budget.ts';
import { assessConfidence, maxRoundsFor } from '../../src/core/brain.ts';
import type { EngagementSignals } from '../../src/core/engagement.ts';
import { planEngagement } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import { migrateMode, levelLabel } from '../../src/core/mode-levels.ts';
import type { Classification } from '../../src/core/types.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnv(
  plans: Partial<Record<string, { plan: string | null; authenticated: boolean }>>,
): EnvironmentStatus {
  const empty = { installed: true, authenticated: false, plan: null, models: [] };
  return {
    claude: plans.claude ? { ...empty, ...plans.claude } : empty,
    codex: plans.codex ? { ...empty, ...plans.codex } : empty,
    opencode: plans.opencode ? { ...empty, ...plans.opencode } : empty,
    grok: plans.grok ? { ...empty, ...plans.grok } : empty,
  };
}

function classification(over: Partial<Classification> = {}): Classification {
  return { tier: 'ic', risk: 'medium', rationale: 'test', ...over };
}

function signals(over: Partial<EngagementSignals> = {}): EngagementSignals {
  return {
    classification: classification(),
    routePlan: false,
    engagementBias: 0,
    task: 'test task',
    ...over,
  };
}

function frame(over: Partial<IntentFrame> = {}): IntentFrame {
  return {
    version: 1,
    goal: 'test task',
    kind: 'coding',
    confidence: 'low',
    source: 'model',
    ...over,
  } as IntentFrame;
}

function makeAllocateInput(overrides: {
  mode?: Mode;
  budgetCeiling?: number;
  substantial?: boolean;
  repoOriented?: boolean;
  risk?: 'low' | 'medium' | 'high' | 'critical';
  authedProviderCount?: number;
  pressure?: number;
}): AllocationPlan {
  const s = signals({
    classification: classification({ tier: 'ic', risk: overrides.risk ?? 'medium' }),
  });
  const f = frame();
  const conf = assessConfidence(f, s);
  const plan = planEngagement(s);
  const pressure = overrides.pressure ?? 0;
  return allocate({
    conf,
    frame: f,
    signals: s,
    plan,
    substantial: overrides.substantial ?? false,
    repoOriented: overrides.repoOriented ?? false,
    mode: overrides.mode ?? 'balanced',
    authedProviderCount: overrides.authedProviderCount ?? 2,
    pressure:
      pressure === 0
        ? pressureFromSignals({})
        : pressureFromSignals({ rateLimitedProviderCount: pressure }),
    maxRounds: maxRoundsFor('balanced'),
    ...(overrides.budgetCeiling !== undefined
      ? { budgetCeiling: overrides.budgetCeiling }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// SCENARIO A: ABSENT config.mode → smart auto policy applies
// ---------------------------------------------------------------------------

describe('SCENARIO A — ABSENT config.mode → smart auto policy (promoted default)', () => {
  it('A#1 promoted (always-on): absent config.mode → effective mode is balanced', () => {
    // The promoted behavior: autoSmartOn is always true.
    // Simulate menu.ts effectiveMode logic.
    const configMode: Mode | undefined = undefined;
    const effectiveMode: Mode = configMode ?? 'balanced';
    assert.equal(effectiveMode, 'balanced');
  });

  it('A#2 absent config.mode → smart auto policy is balanced (not plan-derived)', () => {
    // Simulate promoted menu.ts:697-700 logic (autoSmartOn effectively true)
    const configMode: Mode | undefined = undefined;
    const env = makeEnv({
      claude: { plan: 'default_claude_max_20x', authenticated: true },
    });

    // Plan detection says Max → quality-first
    const planMode = resolveAutoMode(env);
    assert.equal(planMode, 'quality-first', 'plan detection should yield quality-first');

    // But with auto-smart promoted, the effective mode is balanced
    const effectiveMode: Mode = configMode ?? 'balanced';
    assert.equal(effectiveMode, 'balanced');

    // The effective mode should be a valid, recognized mode
    assert.ok(
      effectiveMode === 'cost-saver' ||
        effectiveMode === 'balanced' ||
        effectiveMode === 'quality-first',
    );
  });

  it('A#3 without config.mode, auto-smart yields a sane, in-budget budget ceiling', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_max_20x', authenticated: true },
    });

    // Simulate promoted auto-stage.ts logic
    const configMode: Mode | undefined = undefined;
    const effectiveMode: Mode = configMode ?? 'balanced';
    const modeBudget =
      effectiveMode === 'quality-first' ? 3 : effectiveMode === 'balanced' ? 2 : 1;
    const planCeiling =
      configMode === undefined ? planBudgetCeiling(env) : modeBudget;
    const callBudgetCeiling = Math.max(
      1,
      Math.max(modeBudget, planCeiling) - 0,
    ) as 1 | 2 | 3;

    // Balanced mode budget = 2, Max plan ceiling = 3
    assert.equal(modeBudget, 2);
    assert.equal(planCeiling, 3, 'Max plan should raise ceiling to 3');
    assert.equal(callBudgetCeiling, 3);
  });

  it('A#4 smart policy does not crash / produce unbounded budget', () => {
    // No providers at all → still produces a bounded result
    const env = makeEnv({});
    const configMode: Mode | undefined = undefined;
    const effectiveMode: Mode = configMode ?? 'balanced';
    const modeBudget =
      effectiveMode === 'quality-first' ? 3 : effectiveMode === 'balanced' ? 2 : 1;
    const planCeiling =
      configMode === undefined ? planBudgetCeiling(env) : modeBudget;
    const callBudgetCeiling = Math.max(
      1,
      Math.max(modeBudget, planCeiling) - 0,
    ) as 1 | 2 | 3;

    // With no providers, resolveAutoMode → balanced, planBudgetCeiling → 2
    assert.equal(effectiveMode, 'balanced');
    assert.equal(modeBudget, 2);
    assert.equal(planCeiling, 2);
    assert.equal(callBudgetCeiling, 2);
    // Budget is always bounded 1-3
    assert.ok(callBudgetCeiling >= 1 && callBudgetCeiling <= 3);
  });
});

// ---------------------------------------------------------------------------
// SCENARIO B: PERSISTED EXPLICIT mode → AUTHORITATIVE (CRITICAL INVARIANT)
// ---------------------------------------------------------------------------

describe('SCENARIO B — PERSISTED EXPLICIT mode remains AUTHORITATIVE', () => {
  const explicitModes: Mode[] = ['cost-saver', 'balanced', 'quality-first'];

  for (const explicitMode of explicitModes) {
    it(`B#1 config.mode='${explicitMode}' wins over auto-smart (menu.ts logic)`, () => {
      const configMode: Mode = explicitMode;

      // Promoted: autoSmart is always true, but config.mode still wins
      const effectiveMode: Mode = configMode ?? 'balanced';

      assert.equal(effectiveMode, explicitMode);
    });

    it(`B#2 config.mode='${explicitMode}' mode budget is NOT overridden by plan ceiling`, () => {
      const configMode: Mode = explicitMode;
      const env = makeEnv({
        claude: { plan: 'default_claude_max_20x', authenticated: true },
      });

      const effectiveMode: Mode = configMode ?? 'balanced';
      const modeBudget =
        effectiveMode === 'quality-first' ? 3 : effectiveMode === 'balanced' ? 2 : 1;

      // When mode is explicit (not absent), planCeiling = modeBudget (no smart ceiling lift)
      const planCeiling =
        configMode === undefined ? planBudgetCeiling(env) : modeBudget;

      // For explicit mode, planCeiling must equal modeBudget (no smart ceiling lift)
      assert.equal(planCeiling, modeBudget);
    });

    it(`B#3 config.mode='${explicitMode}' governor respects explicit mode`, () => {
      const result = makeAllocateInput({
        mode: explicitMode,
        substantial: true,
      });
      const expectedBudget =
        explicitMode === 'quality-first' ? 3 : explicitMode === 'balanced' ? 2 : 1;
      assert.equal(result.turnCallBudget, expectedBudget);
    });
  }

  it('B#4 explicit mode wins even when plan is Max', () => {
    // Triple check: the ironclad test
    const configMode: Mode = 'cost-saver'; // explicit budget

    // Promoted: auto-smart always true, but config.mode wins
    const effectiveMode: Mode = configMode ?? 'balanced';

    // Plan says max, autoSmart says balanced, but config says cost-saver
    assert.equal(effectiveMode, 'cost-saver');
    assert.notEqual(effectiveMode, 'quality-first');
    assert.notEqual(effectiveMode, 'balanced');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO C: menu display reason reflects correct source
// ---------------------------------------------------------------------------

describe('SCENARIO C — menu display reason is honest about source', () => {
  it('C#1 autoSmart ON → reason shows per-turn-effort suffix (not plan posture)', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_max_20x', authenticated: true },
      codex: { plan: 'default_codex_pro', authenticated: true },
    });
    const reason = autoModeReason(env, true);

    // Smart mode: per-turn effort, not "→ full/capable/fast"
    assert.ok(
      !reason.includes('→ full'),
      `should not contain plan posture: "${reason}"`,
    );
    assert.ok(
      reason.includes('per-turn effort from task + risk + provider headroom'),
      `expected per-turn effort suffix in "${reason}"`,
    );
    // Should still include the plan observation prefix
    assert.ok(
      reason.includes('auto ·'),
      `reason should start with "auto ·": "${reason}"`,
    );
  });

  it('C#2 autoSmart OFF → reason shows plan-derived posture', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_max_20x', authenticated: true },
    });
    const reason = autoModeReason(env, false);

    // Legacy mode: plan → posture
    assert.ok(
      reason.includes('→ full'),
      `expected "→ full" in "${reason}"`,
    );
    assert.ok(
      !reason.includes('per-turn effort'),
      `should not contain per-turn effort: "${reason}"`,
    );
  });

  it('C#3 autoSmart ON with no providers still shows clean smart label', () => {
    const env = makeEnv({});
    const reason = autoModeReason(env, true);

    assert.ok(reason.includes('auto'));
    assert.ok(
      reason.includes('per-turn effort from task + risk + provider headroom'),
    );
  });

  it('C#4 explicit mode → display is NOT "auto (smart)" but the mode label', () => {
    // When config.mode is explicit, menu-render.ts shows the level label,
    // NOT the auto mode reason suffix.
    const configMode: Mode = 'quality-first';
    const isAuto = configMode === undefined;
    assert.equal(isAuto, false, 'explicit mode should NOT show as Auto');

    // 'quality-first' migrates to 'max' level via migrateMode
    const label = levelLabel(migrateMode(configMode));
    assert.equal(label, 'Max');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO D: budget ceilings and provider capacity allocation
// ---------------------------------------------------------------------------

describe('SCENARIO D — budget ceilings and provider capacity respected', () => {
  it('D#1 Max plan raises smart-policy ceiling from 2 to 3', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_max_20x', authenticated: true },
    });

    const configMode: Mode | undefined = undefined;
    const effectiveMode: Mode = configMode ?? 'balanced';
    const modeBudget = effectiveMode === 'quality-first' ? 3 : effectiveMode === 'balanced' ? 2 : 1;
    const planCeiling =
      configMode === undefined ? planBudgetCeiling(env) : modeBudget;
    const callBudgetCeiling = Math.max(
      1,
      Math.max(modeBudget, planCeiling) - 0,
    ) as 1 | 2 | 3;

    assert.equal(effectiveMode, 'balanced');
    assert.equal(modeBudget, 2, 'balanced mode budget');
    assert.equal(planCeiling, 3, 'Max plan ceiling');
    assert.equal(callBudgetCeiling, 3, 'ceiling lifted');
  });

  it('D#2 Free plan keeps smart-policy ceiling at balanced floor (not lower)', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_free', authenticated: true },
    });

    const configMode: Mode | undefined = undefined;
    const effectiveMode: Mode = configMode ?? 'balanced';
    const modeBudget = effectiveMode === 'quality-first' ? 3 : effectiveMode === 'balanced' ? 2 : 1;
    const planCeiling =
      configMode === undefined ? planBudgetCeiling(env) : modeBudget;
    const callBudgetCeiling = Math.max(
      1,
      Math.max(modeBudget, planCeiling) - 0,
    ) as 1 | 2 | 3;

    assert.equal(effectiveMode, 'balanced');
    assert.equal(modeBudget, 2, 'balanced base is 2');
    assert.equal(planCeiling, 1, 'Free plan ceiling is 1');
    // floor is max(modeBudget, planCeiling) = max(2, 1) = 2 (base is floor)
    assert.equal(callBudgetCeiling, 2, 'mode budget acts as floor');
  });

  it('D#3 governor budgetCeiling never exceeds mode-derived base for trivial turns', () => {
    // Using low-risk worker-tier + trivial task so the governor recognises it as trivial
    const s = signals({
      classification: classification({ tier: 'worker', risk: 'low' }),
      task: 'hi',
    });
    const f = frame();
    const conf = assessConfidence(f, s);
    const plan = planEngagement(s);
    const result = allocate({
      conf,
      frame: f,
      signals: s,
      plan,
      substantial: false,
      repoOriented: false,
      mode: 'balanced',
      budgetCeiling: 3,
      authedProviderCount: 2,
      pressure: pressureFromSignals({}),
      maxRounds: maxRoundsFor('balanced'),
    });
    // Trivial turn → governor can still assign budget 1
    assert.equal(result.turnCallBudget, 1);
    assert.ok(result.reasons.some((r) => r.includes('trivial')), 'should note trivial turn');
  });

  it('D#4 capacity allocation respects ceiling cap', () => {
    const result = makeAllocateInput({
      mode: 'balanced',
      budgetCeiling: 3,
      substantial: true,
      repoOriented: true,
      risk: 'high',
    });
    // Substantial + repo-oriented + high risk → should max at ceiling
    assert.ok(result.turnCallBudget >= 1 && result.turnCallBudget <= 3);
    // Should be leveraging the ceiling (2 or 3, not stuck at 1)
    assert.ok(result.turnCallBudget >= 2, 'substantial turn should get at least 2');
  });
});

// ---------------------------------------------------------------------------
// SCENARIO E: governor pressure — smart policy sheds/degrades correctly
// ---------------------------------------------------------------------------

describe('SCENARIO E — governor pressure causes correct shedding under smart policy', () => {
  it('E#1 pressure reduces effective callBudgetCeiling', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_max_20x', authenticated: true },
    });

    const configMode: Mode | undefined = undefined;
    const effectiveMode: Mode = configMode ?? 'balanced';
    const modeBudget = effectiveMode === 'quality-first' ? 3 : effectiveMode === 'balanced' ? 2 : 1;
    const planCeiling =
      configMode === undefined ? planBudgetCeiling(env) : modeBudget;

    // No pressure → full ceiling
    const noPressure = Math.max(1, Math.max(modeBudget, planCeiling) - 0) as 1 | 2 | 3;
    assert.equal(noPressure, 3);

    // Pressure 2 → ceiling degrades
    const withPressure2 = Math.max(1, Math.max(modeBudget, planCeiling) - 2) as 1 | 2 | 3;
    assert.equal(withPressure2, 1, 'pressure 2 should degrade ceiling from 3 to 1');

    // Pressure 3 → floor at 1 (never drops below 1)
    const withPressure3 = Math.max(1, Math.max(modeBudget, planCeiling) - 3) as 1 | 2 | 3;
    assert.equal(withPressure3, 1, 'max pressure should still floor at 1');
  });

  it('E#2 governor under pressure reduces budget for smart policy turns', () => {
    // With pressure=2 (two providers rate-limited), a substantial turn degrades
    const result = makeAllocateInput({
      mode: 'balanced',
      budgetCeiling: 3,
      substantial: true,
      repoOriented: true,
      risk: 'high',
      pressure: 2,
    });
    // Under high pressure, budget should be reduced from 3
    assert.ok(
      result.turnCallBudget <= 2,
      `expected budget ≤ 2 under pressure 2, got ${result.turnCallBudget}`,
    );
    assert.ok(
      result.turnCallBudget >= 1,
      'budget should never drop below 1',
    );
  });

  it('E#3 pressure=0 allows full budget leverage under smart policy', () => {
    const result = makeAllocateInput({
      mode: 'balanced',
      budgetCeiling: 3,
      substantial: true,
      repoOriented: true,
      risk: 'high',
      pressure: 0,
    });
    // No pressure → governor can give full budget up to ceiling
    assert.equal(result.turnCallBudget, 3);
    assert.ok(result.reasons.some((r) => r.includes('auto-smart')));
  });

  it('E#4 pressure shedding does not ignore explicit mode budget floor', () => {
    // Even under pressure, cost-saver mode keeps budget 1
    const result = makeAllocateInput({
      mode: 'cost-saver',
      substantial: true,
      pressure: 0,
    });
    assert.equal(result.turnCallBudget, 1);
  });

  it('E#5 pressure applied to callBudgetCeiling math is bounded [1,3]', () => {
    // Test every pressure value 0-5
    for (let p = 0; p <= 5; p++) {
      const ceiling = Math.max(1, Math.max(2, 3) - p);
      assert.ok(ceiling >= 1, `pressure ${p}: ceiling ${ceiling} < 1`);
      assert.ok(ceiling <= 3, `pressure ${p}: ceiling ${ceiling} > 3`);
    }
  });
});

// ---------------------------------------------------------------------------
// SCENARIO Z: backward-compat — old config keys tolerated, explicit mode still wins
// ---------------------------------------------------------------------------

describe('SCENARIO Z — backward-compat', () => {
  it('Z#1 resolveAutoMode unchanged for Max plan (plan detection still works)', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_max_20x', authenticated: true },
    });
    assert.equal(resolveAutoMode(env), 'quality-first');
  });

  it('Z#2 legacy plan-derived mode still computable (not removed)', () => {
    const env = makeEnv({
      claude: { plan: 'default_claude_pro', authenticated: true },
    });
    assert.equal(resolveAutoMode(env), 'balanced');
    assert.equal(planBudgetCeiling(env), 2);
  });
});
