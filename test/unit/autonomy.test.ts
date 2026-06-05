import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decideAutonomyOffer } from '../../src/core/autonomy.ts';
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
      it(`${mode}, autoGoal=${String(autoGoalEnabled)} preserves timeout offer`, () => {
        assert.deepEqual(
          decideAutonomyOffer({
            mode,
            classification: ORDINARY,
            routePlan: false,
            finalErrorCategory: 'timeout',
            keepGoingOffered: false,
            autoGoalEnabled,
          }),
          { kind: 'offer', reason: 'timeout' },
        );
      });

      it(`${mode}, autoGoal=${String(autoGoalEnabled)} preserves keep_going offer`, () => {
        assert.deepEqual(
          decideAutonomyOffer({
            mode,
            classification: ORDINARY,
            routePlan: false,
            keepGoingOffered: true,
            autoGoalEnabled,
          }),
          { kind: 'offer', reason: 'keep_going' },
        );
      });

      it(`${mode}, autoGoal=${String(autoGoalEnabled)} does not act on ordinary turns`, () => {
        assert.deepEqual(
          decideAutonomyOffer({
            mode,
            classification: ORDINARY,
            routePlan: false,
            keepGoingOffered: false,
            autoGoalEnabled,
          }),
          { kind: 'none' },
        );
      });

      it(`${mode}, autoGoal=${String(autoGoalEnabled)} gates manager+plan multi-step`, () => {
        const expected =
          mode === 'quality-first' && autoGoalEnabled
            ? { kind: 'auto_engage' as const, reason: 'multi_step' as const }
            : { kind: 'none' as const };
        assert.deepEqual(
          decideAutonomyOffer({
            mode,
            classification: MANAGER_WITH_PLAN,
            routePlan: true,
            keepGoingOffered: false,
            autoGoalEnabled,
          }),
          expected,
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
            routePlan: false,
            keepGoingOffered: false,
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
        routePlan: false,
        keepGoingOffered: false,
        autoGoalEnabled: true,
      }),
      { kind: 'none' },
    );
  });
});
