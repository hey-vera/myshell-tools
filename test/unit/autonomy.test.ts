import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  assessGoalConfidence,
  decideAutonomyOffer,
  decideGoalActivation,
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
