import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessGoalConfidence,
  chooseInitialPlanningDepth,
  choosePlannerTier,
  decideAutonomyOffer,
  decideGoalActivation,
  detectActivationOverride,
  needStrongPlanner,
  planningDepthCap,
  planningSelectionEntitlement,
  planningDepthReason,
  plannerTierCeiling,
  shouldRunPlanningSelection,
} from '../../src/core/autonomy.ts';
import type { Classification } from '../../src/core/types.ts';
import type { Mode } from '../../src/core/policy.ts';

const ORDINARY: Classification = {
  tier: 'ic',
  risk: 'low',
  rationale: 'tier: ic (matched: implement); risk: low (no risk keyword matched — defaulting to low)',
};

const MANAGER_WITH_PLAN: Classification = {
  tier: 'manager',
  risk: 'medium',
  rationale: 'tier: manager (matched: design); risk: medium (matched: tests)',
};

const MANAGER_TWO_SIGNALS: Classification = {
  tier: 'manager',
  risk: 'medium',
  rationale: 'tier: manager (matched: review, design); risk: medium (matched: tests)',
};

const MODES: readonly Mode[] = ['cost-saver', 'balanced', 'quality-first'];

describe('detectActivationOverride', () => {
  it('detects clear standing go-when-confident preferences', () => {
    for (const line of [
      "from now on just go when you're confident",
      'always auto-run when confident',
      'by default go ahead whenever you are confident',
      "from now on just go when you're confident, and refactor the parser",
    ]) {
      assert.equal(detectActivationOverride(line), 'go-when-confident', line);
    }
  });

  it('detects clear standing plan-first preferences', () => {
    for (const line of [
      'always relay the plan first',
      'from now on show me the plan first',
      'run it by me first',
      'always run it by me first, then continue',
    ]) {
      assert.equal(detectActivationOverride(line), 'always-plan-first', line);
    }
  });

  it('detects explicit returns to adaptive behavior', () => {
    for (const line of [
      'back to adaptive',
      'switch back to adaptive please',
      'use your best judgment',
      'use best judgment from now on',
    ]) {
      assert.equal(detectActivationOverride(line), 'adaptive', line);
    }
  });

  it('does not hijack ordinary work, one-off planning, questions, or empty input', () => {
    for (const line of [
      '',
      '   ',
      "let's plan the migration first, then build it",
      'go implement the parser',
      'go ahead and fix the tests',
      'show me the plan for the auth rewrite',
      'relay the plan first for this migration',
      'use your judgment to choose a database',
      'are you confident?',
      'can you always relay the plan first?',
      'should we go back to adaptive?',
    ]) {
      assert.equal(detectActivationOverride(line), null, line);
    }
  });
});

describe('decideAutonomyOffer', () => {
  for (const mode of MODES) {
    for (const autoGoalEnabled of [false, true]) {
      it(`${mode}, autoGoal=${String(autoGoalEnabled)} does not act on ordinary turns`, () => {
        assert.deepEqual(
          decideAutonomyOffer({
            mode,
            classification: ORDINARY,
            autoGoalEnabled,
          }),
          { kind: 'none' },
        );
      });

      it(`${mode}, autoGoal=${String(autoGoalEnabled)} gates manager with two classifier signals`, () => {
        const expected =
          mode === 'quality-first' && autoGoalEnabled
            ? { kind: 'auto_engage' as const, reason: 'multi_step' as const }
            : { kind: 'none' as const };
        assert.deepEqual(
          decideAutonomyOffer({
            mode,
            classification: MANAGER_TWO_SIGNALS,
            autoGoalEnabled,
          }),
          expected,
        );
      });
    }
  }

  it('does not auto-engage on a lone manager signal without route plan', () => {
    assert.deepEqual(
      decideAutonomyOffer({
        mode: 'quality-first',
        classification: MANAGER_WITH_PLAN,
        autoGoalEnabled: true,
      }),
      { kind: 'none' },
    );
  });
});

describe('assessGoalConfidence', () => {
  it('returns no-stage when work intent is absent', () => {
    assert.deepEqual(
      assessGoalConfidence({
        hasWorkIntent: false,
        plannerStaged: true,
        goal: 'Ship the fix',
        hasGenuineFork: false,
        hasDoneWhen: true,
        verificationAvailable: true,
      }),
      { kind: 'not-confident', reason: 'no-stage' },
    );
  });

  it('returns no-stage when the planner did not stage work', () => {
    assert.deepEqual(
      assessGoalConfidence({
        hasWorkIntent: true,
        plannerStaged: false,
        goal: 'Ship the fix',
        hasGenuineFork: false,
        hasDoneWhen: true,
        verificationAvailable: true,
      }),
      { kind: 'not-confident', reason: 'no-stage' },
    );
  });

  it('returns no-goal for an empty intended outcome', () => {
    assert.deepEqual(
      assessGoalConfidence({
        hasWorkIntent: true,
        plannerStaged: true,
        goal: '   ',
        hasGenuineFork: false,
        hasDoneWhen: true,
        verificationAvailable: true,
      }),
      { kind: 'not-confident', reason: 'no-goal' },
    );
  });

  it('returns needs-clarification for a genuine fork', () => {
    assert.deepEqual(
      assessGoalConfidence({
        hasWorkIntent: true,
        plannerStaged: true,
        goal: 'Ship the fix',
        hasGenuineFork: true,
        hasDoneWhen: true,
        verificationAvailable: true,
      }),
      { kind: 'needs-clarification', missing: 'fork' },
    );
  });

  it('parks on missing doneWhen instead of inventing a question', () => {
    const result = assessGoalConfidence({
      hasWorkIntent: true,
      plannerStaged: true,
      goal: 'Ship the fix',
      hasGenuineFork: false,
      hasDoneWhen: false,
      verificationAvailable: true,
    });
    assert.deepEqual(result, { kind: 'not-confident', reason: 'no-done-when' });
    assert.notDeepEqual(result, { kind: 'needs-clarification', missing: 'fork' });
  });

  it('returns no-verification when no real verification route exists', () => {
    assert.deepEqual(
      assessGoalConfidence({
        hasWorkIntent: true,
        plannerStaged: true,
        goal: 'Ship the fix',
        hasGenuineFork: false,
        hasDoneWhen: true,
        verificationAvailable: false,
      }),
      { kind: 'not-confident', reason: 'no-verification' },
    );
  });

  it('treats verifiability as the blocking conjunct for an otherwise-confident turn', () => {
    assert.deepEqual(
      assessGoalConfidence({
        hasWorkIntent: true,
        plannerStaged: true,
        goal: 'Ship the fix',
        hasGenuineFork: false,
        hasDoneWhen: true,
        verificationAvailable: false,
      }),
      { kind: 'not-confident', reason: 'no-verification' },
    );
  });

  it('returns confident when all confidence requirements are satisfied', () => {
    assert.deepEqual(
      assessGoalConfidence({
        hasWorkIntent: true,
        plannerStaged: true,
        goal: 'Ship the fix',
        hasGenuineFork: false,
        hasDoneWhen: true,
        verificationAvailable: true,
      }),
      { kind: 'confident' },
    );
  });
});

describe('decideGoalActivation', () => {
  it('holds when confidence failed regardless of other activation signals', () => {
    assert.deepEqual(
      decideGoalActivation({
        confident: false,
        shape: 'quick',
        substantial: false,
        highStakes: false,
        hasGenuineFork: false,
        override: 'go-when-confident',
      }),
      { kind: 'hold' },
    );
  });

  it('awaits greenlight in always-plan-first mode even for quick work', () => {
    assert.deepEqual(
      decideGoalActivation({
        confident: true,
        shape: 'quick',
        substantial: false,
        highStakes: false,
        hasGenuineFork: false,
        override: 'always-plan-first',
      }),
      { kind: 'await-greenlight' },
    );
  });

  it('auto-runs in go-when-confident mode', () => {
    assert.deepEqual(
      decideGoalActivation({
        confident: true,
        shape: 'risky',
        substantial: true,
        highStakes: true,
        hasGenuineFork: true,
        override: 'go-when-confident',
      }),
      { kind: 'auto-run' },
    );
  });

  for (const shape of ['quick', 'build', 'explain'] as const) {
    it(`adaptive auto-runs reversible ${shape} work`, () => {
      assert.deepEqual(
        decideGoalActivation({
          confident: true,
          shape,
          substantial: false,
          highStakes: false,
          hasGenuineFork: false,
          override: 'adaptive',
        }),
        { kind: 'auto-run' },
      );
    });
  }

  it('tuning never forces depth: a quick reversible task auto-runs (no excavator for a birdhouse)', () => {
    assert.deepEqual(
      decideGoalActivation({
        confident: true,
        shape: 'quick',
        substantial: false,
        highStakes: false,
        hasGenuineFork: false,
        override: 'adaptive',
      }),
      { kind: 'auto-run' },
    );
  });

  for (const shape of ['decide', 'risky', 'investigate'] as const) {
    it(`adaptive waits for ${shape} work`, () => {
      assert.deepEqual(
        decideGoalActivation({
          confident: true,
          shape,
          substantial: false,
          highStakes: false,
          hasGenuineFork: false,
          override: 'adaptive',
        }),
        { kind: 'await-greenlight' },
      );
    });
  }

  it('adaptive waits for substantial work', () => {
    assert.deepEqual(
      decideGoalActivation({
        confident: true,
        shape: 'build',
        substantial: true,
        highStakes: false,
        hasGenuineFork: false,
        override: 'adaptive',
      }),
      { kind: 'await-greenlight' },
    );
  });

  it('adaptive waits for high-stakes work', () => {
    assert.deepEqual(
      decideGoalActivation({
        confident: true,
        shape: 'build',
        substantial: false,
        highStakes: true,
        hasGenuineFork: false,
        override: 'adaptive',
      }),
      { kind: 'await-greenlight' },
    );
  });

  it('adaptive waits when a genuine fork remains', () => {
    assert.deepEqual(
      decideGoalActivation({
        confident: true,
        shape: 'build',
        substantial: false,
        highStakes: false,
        hasGenuineFork: true,
        override: 'adaptive',
      }),
      { kind: 'await-greenlight' },
    );
  });
});

describe('planningDepthCap', () => {
  for (const shape of ['quick', 'explain'] as const) {
    for (const resolvedIntensity of [1, 2, 3, 4, 5] as const) {
      for (const callBudgetCeiling of [1, 2, 3] as const) {
        it(`${shape} stays at depth 1 for intensity ${resolvedIntensity} and budget ${callBudgetCeiling}`, () => {
          assert.equal(
            planningDepthCap({
              resolvedIntensity,
              callBudgetCeiling,
              shape,
            }),
            1,
          );
        });
      }
    }
  }

  for (const resolvedIntensity of [1, 2] as const) {
    it(`returns depth 1 for build work at intensity ${resolvedIntensity} with budget 3`, () => {
      assert.equal(
        planningDepthCap({
          resolvedIntensity,
          callBudgetCeiling: 3,
          shape: 'build',
        }),
        1,
      );
    });
  }

  for (const resolvedIntensity of [3, 4, 5] as const) {
    it(`returns depth 2 for build work at intensity ${resolvedIntensity} with budget 3`, () => {
      assert.equal(
        planningDepthCap({
          resolvedIntensity,
          callBudgetCeiling: 3,
          shape: 'build',
        }),
        2,
      );
    });
  }

  it('returns depth 1 when call-budget ceiling is 1 even at intensity 5', () => {
    assert.equal(
      planningDepthCap({
        resolvedIntensity: 5,
        callBudgetCeiling: 1,
        shape: 'investigate',
      }),
      1,
    );
  });

  for (const callBudgetCeiling of [2, 3] as const) {
    it(`returns depth 2 when call-budget ceiling is ${callBudgetCeiling} and intensity is 3 or higher`, () => {
      assert.equal(
        planningDepthCap({
          resolvedIntensity: 5,
          callBudgetCeiling,
          shape: 'decide',
        }),
        2,
      );
    });
  }
});

describe('chooseInitialPlanningDepth', () => {
  it('returns depth 1 whenever the cap is 1', () => {
    assert.equal(
      chooseInitialPlanningDepth({
        cap: 1,
        shape: 'investigate',
        substantial: true,
        repoOriented: true,
        risk: 'critical',
        engagementDepth: 2,
      }),
      1,
    );
  });

  for (const engagementDepth of [0, 1] as const) {
    it(`returns depth 1 for a non-substantial low-risk build at engagement depth ${engagementDepth}`, () => {
      assert.equal(
        chooseInitialPlanningDepth({
          cap: 2,
          shape: 'build',
          substantial: false,
          repoOriented: false,
          risk: 'low',
          engagementDepth,
        }),
        1,
      );
    });
  }

  it('tuning never forces depth: a high-cap simple task still chooses L1', () => {
    assert.equal(
      chooseInitialPlanningDepth({
        cap: 2,
        shape: 'build',
        substantial: false,
        repoOriented: false,
        risk: 'low',
        engagementDepth: 0,
      }),
      1,
    );
  });

  it('returns depth 2 when repo-oriented work is substantial', () => {
    assert.equal(
      chooseInitialPlanningDepth({
        cap: 2,
        shape: 'build',
        substantial: true,
        repoOriented: true,
        risk: 'medium',
        engagementDepth: 1,
      }),
      2,
    );
  });

  it('returns depth 2 for investigate work', () => {
    assert.equal(
      chooseInitialPlanningDepth({
        cap: 2,
        shape: 'investigate',
        substantial: false,
        repoOriented: false,
        risk: 'low',
        engagementDepth: 0,
      }),
      2,
    );
  });

  it('returns depth 2 for risky work', () => {
    assert.equal(
      chooseInitialPlanningDepth({
        cap: 2,
        shape: 'risky',
        substantial: false,
        repoOriented: false,
        risk: 'low',
        engagementDepth: 0,
      }),
      2,
    );
  });

  for (const risk of ['high', 'critical'] as const) {
    it(`returns depth 2 for ${risk}-risk work`, () => {
      assert.equal(
        chooseInitialPlanningDepth({
          cap: 2,
          shape: 'build',
          substantial: false,
          repoOriented: false,
          risk,
          engagementDepth: 1,
        }),
        2,
      );
    });
  }

  it('returns depth 2 for engagement depth 2', () => {
    assert.equal(
      chooseInitialPlanningDepth({
        cap: 2,
        shape: 'build',
        substantial: false,
        repoOriented: false,
        risk: 'medium',
        engagementDepth: 2,
      }),
      2,
    );
  });
});

describe('planningDepthReason', () => {
  it('returns a short phrase for each planning depth', () => {
    assert.equal(planningDepthReason(1), 'single planning pass');
    assert.equal(planningDepthReason(2), 'grounded planning pass');
  });
});

describe('planningSelectionEntitlement', () => {
  const unlockedInput = {
    gateOn: true,
    resolvedIntensity: 4 as const,
    turnCallBudget: 3 as const,
    panelAllowed: true,
    authenticatedProviderCount: 2,
  };

  it('returns unlocked when every conjunct holds', () => {
    assert.equal(planningSelectionEntitlement(unlockedInput), 'unlocked');
  });

  it('returns locked when gateOn is false', () => {
    assert.equal(planningSelectionEntitlement({ ...unlockedInput, gateOn: false }), 'locked');
  });

  it('returns locked when resolvedIntensity is 3', () => {
    assert.equal(planningSelectionEntitlement({ ...unlockedInput, resolvedIntensity: 3 }), 'locked');
  });

  it('returns locked when turnCallBudget is 2', () => {
    assert.equal(planningSelectionEntitlement({ ...unlockedInput, turnCallBudget: 2 }), 'locked');
  });

  it('returns locked when panelAllowed is false', () => {
    assert.equal(planningSelectionEntitlement({ ...unlockedInput, panelAllowed: false }), 'locked');
  });

  it('returns locked when authenticatedProviderCount is 1', () => {
    assert.equal(
      planningSelectionEntitlement({ ...unlockedInput, authenticatedProviderCount: 1 }),
      'locked',
    );
  });
});

describe('shouldRunPlanningSelection', () => {
  const ordinaryScope = {
    shape: 'decide' as const,
    substantial: false,
    repoOriented: false,
    risk: 'low' as const,
    engagementDepth: 1 as const,
  };

  const hardScope = {
    shape: 'investigate' as const,
    substantial: false,
    repoOriented: false,
    risk: 'medium' as const,
    engagementDepth: 1 as const,
  };

  const stagePlan = {
    judgment: 'stage' as const,
    substantialGoalMissingApproach: false,
    nonTrivialGoalMissingDoneWhen: false,
    capDropped: false,
    genericFallbackOnly: false,
    confidenceNoDoneWhen: false,
    onlyGapIsNoVerification: false,
  };

  it('returns false when entitlement is locked', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'locked',
        scope: hardScope,
        firstPlan: { ...stagePlan, capDropped: true },
      }),
      false,
    );
  });

  it('returns false for quick work', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: { ...hardScope, shape: 'quick' },
        firstPlan: { ...stagePlan, capDropped: true },
      }),
      false,
    );
  });

  it('returns false for explain work', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: { ...hardScope, shape: 'explain' },
        firstPlan: { ...stagePlan, capDropped: true },
      }),
      false,
    );
  });

  it('tuning never forces a second brain: unlocked + birdhouse -> false', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: {
          shape: 'build',
          substantial: false,
          repoOriented: false,
          risk: 'medium',
          engagementDepth: 1,
        },
        firstPlan: { ...stagePlan, nonTrivialGoalMissingDoneWhen: true },
      }),
      false,
    );
  });

  it('returns false when judgment is clarify', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: hardScope,
        firstPlan: { ...stagePlan, judgment: 'clarify', capDropped: true },
      }),
      false,
    );
  });

  it('returns false when judgment is none', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: hardScope,
        firstPlan: { ...stagePlan, judgment: 'none', capDropped: true },
      }),
      false,
    );
  });

  it('returns false when the only gap is no verification', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: hardScope,
        firstPlan: { ...stagePlan, onlyGapIsNoVerification: true, confidenceNoDoneWhen: true },
      }),
      false,
    );
  });

  it('returns false for a hard goal with no deficiency', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: { ...ordinaryScope, risk: 'high' },
        firstPlan: stagePlan,
      }),
      false,
    );
  });

  it('returns false for a deficiency on a non-hard goal', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: ordinaryScope,
        firstPlan: { ...stagePlan, nonTrivialGoalMissingDoneWhen: true },
      }),
      false,
    );
  });

  it('returns true for investigate work with a capDropped deficiency', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: hardScope,
        firstPlan: { ...stagePlan, capDropped: true },
      }),
      true,
    );
  });

  it('returns true for critical-risk work with fallback judgment', () => {
    assert.equal(
      shouldRunPlanningSelection({
        entitlement: 'unlocked',
        scope: { ...ordinaryScope, risk: 'critical' },
        firstPlan: { ...stagePlan, judgment: 'fallback' },
      }),
      true,
    );
  });
});

describe('plannerTierCeiling', () => {
  for (const resolvedIntensity of [1, 2, 3] as const) {
    it(`returns ic for intensity ${resolvedIntensity}`, () => {
      assert.equal(plannerTierCeiling(resolvedIntensity), 'ic');
    });
  }

  for (const resolvedIntensity of [4, 5] as const) {
    it(`returns manager for intensity ${resolvedIntensity}`, () => {
      assert.equal(plannerTierCeiling(resolvedIntensity), 'manager');
    });
  }
});

describe('needStrongPlanner', () => {
  const plainScope = {
    shape: 'build' as const,
    substantial: false,
    repoOriented: false,
    risk: 'low' as const,
    engagementDepth: 0 as const,
  };

  it('returns true for high risk', () => {
    assert.equal(
      needStrongPlanner({
        scope: { ...plainScope, risk: 'high' },
        planFixableDeficiency: false,
      }),
      true,
    );
  });

  it('returns true for critical risk', () => {
    assert.equal(
      needStrongPlanner({
        scope: { ...plainScope, risk: 'critical' },
        planFixableDeficiency: false,
      }),
      true,
    );
  });

  it('returns true for risky shape', () => {
    assert.equal(
      needStrongPlanner({
        scope: { ...plainScope, shape: 'risky' },
        planFixableDeficiency: false,
      }),
      true,
    );
  });

  it('returns true for investigate shape', () => {
    assert.equal(
      needStrongPlanner({
        scope: { ...plainScope, shape: 'investigate' },
        planFixableDeficiency: false,
      }),
      true,
    );
  });

  it('returns true for substantial decide work with a plan-fixable deficiency', () => {
    assert.equal(
      needStrongPlanner({
        scope: { ...plainScope, shape: 'decide', substantial: true },
        planFixableDeficiency: true,
      }),
      true,
    );
  });

  it('returns false for an ordinary low-risk build', () => {
    assert.equal(
      needStrongPlanner({
        scope: plainScope,
        planFixableDeficiency: false,
      }),
      false,
    );
  });

  it('returns false for substantial decide work without a plan-fixable deficiency', () => {
    assert.equal(
      needStrongPlanner({
        scope: { ...plainScope, shape: 'decide', substantial: true },
        planFixableDeficiency: false,
      }),
      false,
    );
  });

  it('returns false for decide work when substantial is false even if deficiency is plan-fixable', () => {
    assert.equal(
      needStrongPlanner({
        scope: { ...plainScope, shape: 'decide', substantial: false },
        planFixableDeficiency: true,
      }),
      false,
    );
  });

  it('returns false for a plain non-hard scope', () => {
    assert.equal(
      needStrongPlanner({
        scope: {
          shape: 'explain',
          substantial: false,
          repoOriented: false,
          risk: 'medium',
          engagementDepth: 1,
        },
        planFixableDeficiency: false,
      }),
      false,
    );
  });
});

describe('choosePlannerTier', () => {
  for (const resolvedIntensity of [4, 5] as const) {
    it(`returns manager when needed at intensity ${resolvedIntensity}`, () => {
      assert.equal(
        choosePlannerTier({
          resolvedIntensity,
          needStrongPlanner: true,
        }),
        'manager',
      );
    });
  }

  for (const resolvedIntensity of [1, 2, 3] as const) {
    it(`returns ic when needed at intensity ${resolvedIntensity}`, () => {
      assert.equal(
        choosePlannerTier({
          resolvedIntensity,
          needStrongPlanner: true,
        }),
        'ic',
      );
    });
  }

  it('low tuning never raises the planner tier even when needed', () => {
    assert.equal(
      choosePlannerTier({
        resolvedIntensity: 2,
        needStrongPlanner: true,
      }),
      'ic',
    );
  });

  it('returns ic when not needed even at intensity 5', () => {
    assert.equal(
      choosePlannerTier({
        resolvedIntensity: 5,
        needStrongPlanner: false,
      }),
      'ic',
    );
  });

  it('max tuning does not raise without need', () => {
    assert.equal(
      choosePlannerTier({
        resolvedIntensity: 5,
        needStrongPlanner: false,
      }),
      'ic',
    );
  });
});
