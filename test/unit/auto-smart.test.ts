/**
 * test/unit/auto-smart.test.ts — Auto Smart Default (Redesign Slice C) tests.
 *
 * Covers:
 *   1. autoSmartEnabled flag (default OFF, env ON, config ON)
 *   2. planBudgetCeiling (Max→3, Pro→2, Free→1)
 *   3. autoModeReason with autoSmart flag (per-turn suffix)
 *   4. Governor budgetCeiling — base balanced + ceiling from plan
 *   5. Flag OFF → resolveAutoMode unchanged (characterization)
 *   6. Explicit modes (budget/balanced/max) unchanged regardless of flag
 *   7. Quick turn under Auto gets small budget
 *   8. Risky turn under Auto earns larger budget/stronger model
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { autoSmartEnabled } from '../../src/interface/ui/auto-smart-flag.ts';
import { planBudgetCeiling, resolveAutoMode, autoModeReason } from '../../src/interface/menu-auto-mode.ts';
import { allocate } from '../../src/core/governor.ts';
import type { AllocationPlan } from '../../src/core/governor.ts';
import type { Mode } from '../../src/core/policy.ts';
import { pressureFromSignals } from '../../src/core/capability-budget.ts';
import { assessConfidence, maxRoundsFor } from '../../src/core/brain.ts';
import type { EngagementSignals } from '../../src/core/engagement.ts';
import { planEngagement } from '../../src/core/engagement.ts';
import type { IntentFrame } from '../../src/core/intent.ts';
import type { Classification } from '../../src/core/types.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';

// ---------------------------------------------------------------------------
// 1. autoSmartEnabled — default OFF
// ---------------------------------------------------------------------------

describe('autoSmartEnabled', () => {
  it('defaults to false (absent env, absent config)', () => {
    assert.equal(autoSmartEnabled(undefined, undefined), false);
    assert.equal(autoSmartEnabled({}, {}), false);
  });

  it('returns true for env MYSHELL_AUTO_SMART=1', () => {
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: '1' }, undefined), true);
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: 'true' }, undefined), true);
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: 'on' }, undefined), true);
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: 'yes' }, undefined), true);
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: ' TRUE ' }, undefined), true);
  });

  it('returns false for env garbage/off values', () => {
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: '0' }, undefined), false);
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: 'false' }, undefined), false);
    assert.equal(autoSmartEnabled({ MYSHELL_AUTO_SMART: '' }, undefined), false);
  });

  it('returns true for config.experimentalAutoSmart === true', () => {
    assert.equal(autoSmartEnabled(undefined, { experimentalAutoSmart: true }), true);
    assert.equal(autoSmartEnabled({}, { experimentalAutoSmart: true }), true);
  });

  it('returns false for config missing the key', () => {
    assert.equal(autoSmartEnabled(undefined, { experimentalAutoSmart: undefined }), false);
  });

  it('env wins (env on, config off)', () => {
    assert.equal(
      autoSmartEnabled({ MYSHELL_AUTO_SMART: '1' }, { experimentalAutoSmart: false }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. planBudgetCeiling — maps plan-derived mode to budget
// ---------------------------------------------------------------------------

function makeEnv(plans: Partial<Record<string, { plan: string | null; authenticated: boolean }>>): EnvironmentStatus {
  const empty = { installed: true, authenticated: false, plan: null, models: [] };
  return {
    claude: plans.claude ? { ...empty, ...plans.claude } : empty,
    codex: plans.codex ? { ...empty, ...plans.codex } : empty,
    opencode: plans.opencode ? { ...empty, ...plans.opencode } : empty,
    grok: plans.grok ? { ...empty, ...plans.grok } : empty,
  };
}

describe('planBudgetCeiling', () => {
  it('returns 3 for Max plan', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_max_20x', authenticated: true } });
    assert.equal(planBudgetCeiling(env), 3);
  });

  it('returns 2 for Pro plan', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_pro', authenticated: true } });
    assert.equal(planBudgetCeiling(env), 2);
  });

  it('returns 1 for Free plan', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_free', authenticated: true } });
    assert.equal(planBudgetCeiling(env), 1);
  });

  it('returns 2 for unknown/absent plan', () => {
    const env = makeEnv({ claude: { plan: null, authenticated: true } });
    assert.equal(planBudgetCeiling(env), 2);
  });

  it('returns 2 when no providers are authenticated', () => {
    const env = makeEnv({});
    assert.equal(planBudgetCeiling(env), 2);
  });
});

// ---------------------------------------------------------------------------
// 3. autoModeReason with autoSmart flag
// ---------------------------------------------------------------------------

describe('autoModeReason — autoSmart suffix', () => {
  it('without autoSmart shows plan → posture', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_max_20x', authenticated: true } });
    const reason = autoModeReason(env, false);
    assert.ok(reason.includes('→ full'), `expected "→ full" in "${reason}"`);
    assert.ok(reason.includes('auto ·'), `expected "auto ·" in "${reason}"`);
  });

  it('with autoSmart=true shows per-turn effort suffix instead of posture', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_max_20x', authenticated: true } });
    const reason = autoModeReason(env, true);
    assert.ok(!reason.includes('→ full'), `should not contain "→ full": "${reason}"`);
    assert.ok(
      reason.includes('per-turn effort from task + risk + provider headroom'),
      `expected per-turn suffix in "${reason}"`,
    );
  });

  it('with autoSmart=true and no providers still shows clean label', () => {
    const env = makeEnv({});
    const reason = autoModeReason(env, true);
    assert.ok(reason.includes('auto'), `expected "auto" in "${reason}"`);
    assert.ok(
      reason.includes('per-turn effort'),
      `expected per-turn suffix in "${reason}"`,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Governor budgetCeiling — AutoSmart mode
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for building allocate inputs (mirror governor.test.ts builders)
// ---------------------------------------------------------------------------

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
}): AllocationPlan {
  const s = signals({
    classification: classification({ tier: 'ic', risk: overrides.risk ?? 'medium' }),
  });
  const f = frame();
  const conf = assessConfidence(f, s);
  const plan = planEngagement(s);
  return allocate({
    conf,
    frame: f,
    signals: s,
    plan,
    substantial: overrides.substantial ?? false,
    repoOriented: overrides.repoOriented ?? false,
    mode: overrides.mode ?? 'balanced',
    authedProviderCount: overrides.authedProviderCount ?? 2,
    pressure: pressureFromSignals({}),
    maxRounds: maxRoundsFor('balanced'),
    ...(overrides.budgetCeiling !== undefined ? { budgetCeiling: overrides.budgetCeiling } : {}),
  });
}

describe('governor with budgetCeiling (AutoSmart)', () => {
  it('without budgetCeiling, balanced mode gets budget 2 on a normal turn', () => {
    const result = makeAllocateInput({ mode: 'balanced', substantial: false });
    assert.equal(result.turnCallBudget, 2);
  });

  it('with budgetCeiling=3 (Max plan capacity), balanced mode gets budget 3 ceiling', () => {
    const result = makeAllocateInput({ mode: 'balanced', budgetCeiling: 3, substantial: true, repoOriented: true });
    assert.equal(result.turnCallBudget, 3);
  });

  it('quick turn stays budget 1 even with ceiling', () => {
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
    assert.equal(result.turnCallBudget, 1);
    assert.ok(result.reasons.some((r) => r.includes('trivial turn')), 'should note trivial turn');
  });

  it('without budgetCeiling (flag OFF), quality-first mode gets budget 3 for Max plans', () => {
    const result = makeAllocateInput({ mode: 'quality-first', substantial: true });
    assert.equal(result.turnCallBudget, 3);
  });

  it('budgetCeiling never lowers the base (ceiling 1 over balanced 2 stays 2)', () => {
    const result = makeAllocateInput({ mode: 'balanced', budgetCeiling: 1, substantial: true });
    assert.equal(result.turnCallBudget, 2);
  });

  it('risky turn under Auto earns larger budget with ceiling', () => {
    const result = makeAllocateInput({
      mode: 'balanced',
      budgetCeiling: 3,
      substantial: true,
      repoOriented: true,
      risk: 'high',
    });
    assert.equal(result.turnCallBudget, 3);
    assert.ok(result.reasons.some((r) => r.includes('auto-smart')));
  });
});

// ---------------------------------------------------------------------------
// 5. Flag OFF → resolveAutoMode unchanged (characterization)
// ---------------------------------------------------------------------------

describe('resolveAutoMode — flag OFF characterization', () => {
  it('Max plan → quality-first', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_max_20x', authenticated: true } });
    assert.equal(resolveAutoMode(env), 'quality-first');
  });

  it('Pro plan → balanced', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_pro', authenticated: true } });
    assert.equal(resolveAutoMode(env), 'balanced');
  });

  it('Free plan → cost-saver', () => {
    const env = makeEnv({ claude: { plan: 'default_claude_free', authenticated: true } });
    assert.equal(resolveAutoMode(env), 'cost-saver');
  });

  it('unknown/absent plan → balanced', () => {
    const env = makeEnv({ claude: { plan: null, authenticated: true } });
    assert.equal(resolveAutoMode(env), 'balanced');
  });

  it('no authenticated providers → balanced', () => {
    const env = makeEnv({});
    assert.equal(resolveAutoMode(env), 'balanced');
  });
});

// ---------------------------------------------------------------------------
// 6. Explicit modes unchanged regardless of flag
// ---------------------------------------------------------------------------

describe('explicit modes are unchanged', () => {
  it('cost-saver governor budget stays 1', () => {
    const result = makeAllocateInput({ mode: 'cost-saver', substantial: true });
    assert.equal(result.turnCallBudget, 1);
  });

  it('balanced governor budget stays 2', () => {
    const result = makeAllocateInput({ mode: 'balanced', substantial: true });
    assert.equal(result.turnCallBudget, 2);
  });

  it('quality-first governor budget stays 3', () => {
    const result = makeAllocateInput({ mode: 'quality-first', substantial: true });
    assert.equal(result.turnCallBudget, 3);
  });
});

// ---------------------------------------------------------------------------
// 7. Base policy is balanced for Auto (not quality-first)
// ---------------------------------------------------------------------------

describe('AutoSmart base policy is neutral balanced', () => {
  it('effective mode for Auto+flag is balanced (not quality-first)', () => {
    // Simulating what menu.ts does: when autoSmartOn && config.mode undefined → 'balanced'
    const autoSmartOn = true;
    const configMode: Mode | undefined = undefined;
    const planMode = resolveAutoMode(
      makeEnv({ claude: { plan: 'default_claude_max_20x', authenticated: true } }),
    );
    
    // Plan detects Max → quality-first
    assert.equal(planMode, 'quality-first');
    
    // But effective mode is balanced (not the plan-derived quality-first)
    const effectiveMode: Mode = configMode ?? (autoSmartOn ? 'balanced' : planMode);
    assert.equal(effectiveMode, 'balanced');
  });

  it('Auto+flag OFF → effective mode still resolves to plan-derived mode', () => {
    const autoSmartOn = false;
    const configMode: Mode | undefined = undefined;
    const planMode = resolveAutoMode(
      makeEnv({ claude: { plan: 'default_claude_max_20x', authenticated: true } }),
    );
    
    const effectiveMode: Mode = configMode ?? (autoSmartOn ? 'balanced' : planMode);
    assert.equal(effectiveMode, 'quality-first');
  });
});

// ---------------------------------------------------------------------------
// 8. planBudgetCeiling combined with base budget for Auto
// ---------------------------------------------------------------------------

describe('baseBudgetForMode with plan ceiling', () => {
  it('balanced base budget is 2', () => {
    // Note: baseBudgetForMode is not exported, testing indirectly via governor
    const result = makeAllocateInput({ mode: 'balanced', substantial: false });
    assert.equal(result.turnCallBudget, 2);
  });

  it('plan raises ceiling from balanced base (2) to Max capacity (3)', () => {
    const result = makeAllocateInput({
      mode: 'balanced',
      budgetCeiling: 3,
      substantial: true,
      repoOriented: true,
      risk: 'high',
    });
    // Ceiling allows up to 3, and since this is a substantial/repoOriented/high-risk turn,
    // the governor can leverage it
    assert.equal(result.turnCallBudget, 3);
  });

  it('plan-derived Free ceiling keeps budget at effective floor', () => {
    const result = makeAllocateInput({
      mode: 'balanced',
      budgetCeiling: 1,
      substantial: true,
    });
    // base=2, ceiling=1 → max(2,1)=2, so stays at 2
    assert.equal(result.turnCallBudget, 2);
  });
});
