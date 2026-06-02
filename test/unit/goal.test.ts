/**
 * test/unit/goal.test.ts — the pure `/goal` decision core (core/goal.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGoalTask,
  parseGoalSignal,
  decideGoalNext,
  DEFAULT_MAX_GOAL_ITERATIONS,
} from '../../src/core/goal.ts';

describe('buildGoalTask', () => {
  it('frames the goal on the first turn and asks to continue after', () => {
    const first = buildGoalTask('ship the login page', 0);
    assert.ok(first.startsWith('Goal: ship the login page'));
    const later = buildGoalTask('ship the login page', 3);
    assert.ok(/Continue working autonomously/.test(later));
    assert.ok(later.includes('ship the login page'));
  });

  it('always instructs the completion + continue markers', () => {
    const t = buildGoalTask('x', 0);
    assert.ok(t.includes('GOAL_COMPLETE'));
    assert.ok(t.includes('GOAL_CONTINUE'));
  });
});

describe('parseGoalSignal', () => {
  it('"complete" only on a clear completion marker', () => {
    assert.equal(parseGoalSignal('All done.\nGOAL_COMPLETE'), 'complete');
  });

  it('"continue" on a continue marker', () => {
    assert.equal(parseGoalSignal('Did step 1.\nGOAL_CONTINUE: write the tests'), 'continue');
  });

  it('"continue" when no marker is present (never guesses completion)', () => {
    assert.equal(parseGoalSignal('I made some changes.'), 'continue');
    assert.equal(parseGoalSignal(''), 'continue');
  });

  it('when both markers appear, trusts the LAST one', () => {
    assert.equal(
      parseGoalSignal('GOAL_CONTINUE: more\n...later...\nGOAL_COMPLETE'),
      'complete',
    );
    assert.equal(
      parseGoalSignal('GOAL_COMPLETE earlier was wrong\nGOAL_CONTINUE: keep going'),
      'continue',
    );
  });
});

describe('decideGoalNext', () => {
  const ceilings = { maxIterations: 8, maxCostUsd: 2 };

  it('stops on a failed turn', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: false, completedIterations: 1, ceilings, costSoFarUsd: 0 });
    assert.equal(s.action, 'stop-error');
  });

  it('completes when the model signals complete', () => {
    const s = decideGoalNext({ signal: 'complete', lastSucceeded: true, completedIterations: 2, ceilings, costSoFarUsd: 0.5 });
    assert.equal(s.action, 'complete');
  });

  it('stops on the cost ceiling before another turn', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: true, completedIterations: 2, ceilings, costSoFarUsd: 2.5 });
    assert.equal(s.action, 'stop-budget');
  });

  it('stops on the iteration ceiling', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: true, completedIterations: 8, ceilings, costSoFarUsd: 0.1 });
    assert.equal(s.action, 'stop-iterations');
  });

  it('continues when work remains and ceilings are not hit', () => {
    const s = decideGoalNext({ signal: 'continue', lastSucceeded: true, completedIterations: 3, ceilings, costSoFarUsd: 0.1 });
    assert.equal(s.action, 'continue');
  });

  it('cost ceiling is optional (no cap → never stop-budget)', () => {
    const s = decideGoalNext({
      signal: 'continue',
      lastSucceeded: true,
      completedIterations: 3,
      ceilings: { maxIterations: 8 },
      costSoFarUsd: 999,
    });
    assert.equal(s.action, 'continue');
  });

  it('exposes a sane default iteration ceiling', () => {
    assert.ok(DEFAULT_MAX_GOAL_ITERATIONS >= 3 && DEFAULT_MAX_GOAL_ITERATIONS <= 25);
  });
});
