/**
 * test/unit/goal-steward.test.ts — pure audit engine + flag tests.
 * Run with: node --import ./test/register.mjs --test "test/unit/goal-steward.test.ts"
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Goal, GoalVerdict } from '../../src/core/goal-todo.ts';
import { isGoalVerifiedDone } from '../../src/core/goal-todo.ts';
import {
  auditGoals,
  selectTopFinding,
  type GoalFinding,
} from '../../src/core/goal-steward.ts';
import { goalStewardEnabled } from '../../src/interface/ui/goal-steward-flag.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Test goal',
    state: 'parked',
    source: 'user-explicit',
    roadmap: [],
    scope: 'project',
    projectKey: null,
    conversationId: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    lastTouched: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeVerdict(state: GoalVerdict['state']): GoalVerdict {
  return { state, receipt: 'test receipt', at: '2026-06-15T00:00:00.000Z' };
}

/** 2026-07-15T00:00:00.000Z as epoch ms — 44 days after 2026-06-01. */
const NOW_MS = new Date('2026-07-15T00:00:00.000Z').getTime();

/** 2026-06-05T00:00:00.000Z as epoch ms — 4 days after 2026-06-01. */
const RECENT_MS = new Date('2026-06-05T00:00:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Flag tests
// ---------------------------------------------------------------------------

describe('goal-steward-flag', () => {
  it('defaults OFF: no env, no config → false', () => {
    assert.equal(goalStewardEnabled(undefined, undefined), false);
    assert.equal(goalStewardEnabled({}, {}), false);
  });

  it('env MYSHELL_GOAL_STEWARD=1 → true', () => {
    assert.equal(goalStewardEnabled({ MYSHELL_GOAL_STEWARD: '1' }, undefined), true);
  });

  it('env MYSHELL_GOAL_STEWARD=true → true', () => {
    assert.equal(goalStewardEnabled({ MYSHELL_GOAL_STEWARD: 'true' }, undefined), true);
  });

  it('env MYSHELL_GOAL_STEWARD=on (case-insensitive, trimmed) → true', () => {
    assert.equal(goalStewardEnabled({ MYSHELL_GOAL_STEWARD: ' ON ' }, undefined), true);
  });

  it('env MYSHELL_GOAL_STEWARD=yes → true', () => {
    assert.equal(goalStewardEnabled({ MYSHELL_GOAL_STEWARD: 'yes' }, undefined), true);
  });

  it('env MYSHELL_GOAL_STEWARD=0 → false', () => {
    assert.equal(goalStewardEnabled({ MYSHELL_GOAL_STEWARD: '0' }, undefined), false);
  });

  it('env MYSHELL_GOAL_STEWARD=false → false', () => {
    assert.equal(goalStewardEnabled({ MYSHELL_GOAL_STEWARD: 'false' }, undefined), false);
  });

  it('config.experimentalGoalSteward=true → true', () => {
    assert.equal(
      goalStewardEnabled(undefined, { experimentalGoalSteward: true }),
      true,
    );
  });

  it('config.experimentalGoalSteward=false → false', () => {
    assert.equal(
      goalStewardEnabled(undefined, { experimentalGoalSteward: false }),
      false,
    );
  });

  it('config takes precedence over absent env', () => {
    assert.equal(
      goalStewardEnabled({}, { experimentalGoalSteward: true }),
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// auditGoals classification tests
// ---------------------------------------------------------------------------

describe('auditGoals — blocked', () => {
  it('classifies blocked state as blocked → review', () => {
    const g = makeGoal({ id: 'goal_B', state: 'blocked' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.classification, 'blocked');
    assert.equal(findings[0]!.recommendedAction, 'review');
    assert.match(findings[0]!.reason, /blocked/);
  });
});

describe('auditGoals — inactive', () => {
  it('classifies running goal past stale window as inactive → review', () => {
    const g = makeGoal({ id: 'goal_R', state: 'running' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.classification, 'inactive');
    assert.equal(findings[0]!.recommendedAction, 'review');
  });

  it('classifies queued goal past stale window as inactive → review', () => {
    const g = makeGoal({ id: 'goal_Q', state: 'queued' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.classification, 'inactive');
    assert.equal(findings[0]!.recommendedAction, 'review');
  });

  it('running goal within stale window → fresh', () => {
    const g = makeGoal({ id: 'goal_R', state: 'running' });
    const findings = auditGoals({ goals: [g], nowMs: RECENT_MS });
    assert.equal(findings[0]!.classification, 'fresh');
  });
});

describe('auditGoals — stale', () => {
  it('classifies parked goal past stale window as stale → review', () => {
    const g = makeGoal({ id: 'goal_P', state: 'parked' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.classification, 'stale');
    assert.equal(findings[0]!.recommendedAction, 'review');
  });

  it('parked goal within stale window → fresh', () => {
    const g = makeGoal({ id: 'goal_P', state: 'parked' });
    const findings = auditGoals({ goals: [g], nowMs: RECENT_MS });
    assert.equal(findings[0]!.classification, 'fresh');
  });
});

describe('auditGoals — verified-complete', () => {
  it('done + passing verdict → verified-complete, resolve-done', () => {
    const g = makeGoal({
      id: 'goal_D',
      state: 'done',
      goalVerdict: makeVerdict('passing'),
    });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.classification, 'verified-complete');
    assert.equal(findings[0]!.recommendedAction, 'resolve-done');
  });

  it('done + reviewed verdict → verified-complete, resolve-done', () => {
    const g = makeGoal({
      id: 'goal_D',
      state: 'done',
      goalVerdict: makeVerdict('reviewed'),
    });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.classification, 'verified-complete');
    assert.equal(findings[0]!.recommendedAction, 'resolve-done');
  });

  it('done + failing verdict → verified-complete, review (never resolve-done)', () => {
    const g = makeGoal({
      id: 'goal_D',
      state: 'done',
      goalVerdict: makeVerdict('failing'),
    });
    assert.equal(isGoalVerifiedDone(makeVerdict('failing')), false);
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.classification, 'verified-complete');
    assert.equal(findings[0]!.recommendedAction, 'review');
  });

  it('done + unverified verdict → verified-complete, review', () => {
    const g = makeGoal({
      id: 'goal_D',
      state: 'done',
      goalVerdict: makeVerdict('unverified'),
    });
    assert.equal(isGoalVerifiedDone(makeVerdict('unverified')), false);
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.classification, 'verified-complete');
    assert.equal(findings[0]!.recommendedAction, 'review');
  });

  it('done + no verdict → verified-complete, review (never resolve-done)', () => {
    const g = makeGoal({ id: 'goal_D', state: 'done' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.classification, 'verified-complete');
    assert.equal(findings[0]!.recommendedAction, 'review');
  });
});

describe('auditGoals — fresh', () => {
  it('recent parked → fresh, none', () => {
    const g = makeGoal({ id: 'goal_F', state: 'parked' });
    const findings = auditGoals({ goals: [g], nowMs: RECENT_MS });
    assert.equal(findings[0]!.classification, 'fresh');
    assert.equal(findings[0]!.recommendedAction, 'none');
  });

  it('recent running → fresh, none', () => {
    const g = makeGoal({ id: 'goal_F', state: 'running' });
    const findings = auditGoals({ goals: [g], nowMs: RECENT_MS });
    assert.equal(findings[0]!.classification, 'fresh');
    assert.equal(findings[0]!.recommendedAction, 'none');
  });

  it('failed → fresh, none', () => {
    const g = makeGoal({ id: 'goal_F', state: 'failed' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.classification, 'fresh');
    assert.equal(findings[0]!.recommendedAction, 'none');
  });

  it('superseded → fresh, none', () => {
    const g = makeGoal({ id: 'goal_F', state: 'superseded' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.classification, 'fresh');
    assert.equal(findings[0]!.recommendedAction, 'none');
  });
});

describe('auditGoals — custom staleWindowMs', () => {
  it('respects a shorter stale window (5 days)', () => {
    const g = makeGoal({
      id: 'goal_S',
      state: 'parked',
      lastTouched: '2026-07-01T00:00:00.000Z',
    });
    // 14 days later; default 30-day window would be fresh, but 5-day window → stale
    const findings = auditGoals({
      goals: [g],
      nowMs: NOW_MS,
      staleWindowMs: 5 * 86_400_000,
    });
    assert.equal(findings[0]!.classification, 'stale');
  });

  it('within a longer stale window (60 days) → fresh', () => {
    const g = makeGoal({ id: 'goal_L', state: 'parked' });
    const findings = auditGoals({
      goals: [g],
      nowMs: NOW_MS,
      staleWindowMs: 60 * 86_400_000,
    });
    assert.equal(findings[0]!.classification, 'fresh');
  });
});

describe('auditGoals — multiple goals', () => {
  it('returns one finding per goal', () => {
    const goals = [
      makeGoal({ id: 'goal_1', state: 'parked' }),
      makeGoal({ id: 'goal_2', state: 'running' }),
      makeGoal({ id: 'goal_3', state: 'blocked' }),
    ];
    const findings = auditGoals({ goals, nowMs: NOW_MS });
    assert.equal(findings.length, 3);
  });

  it('empty goals → empty findings', () => {
    const findings = auditGoals({ goals: [], nowMs: NOW_MS });
    assert.equal(findings.length, 0);
  });
});

describe('auditGoals — conversationId passthrough', () => {
  it('passes through conversationId from goal', () => {
    const g = makeGoal({ id: 'goal_C', state: 'blocked', conversationId: 'conv_abc' });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.conversationId, 'conv_abc');
  });

  it('passes through null conversationId', () => {
    const g = makeGoal({ id: 'goal_C', state: 'blocked', conversationId: null });
    const findings = auditGoals({ goals: [g], nowMs: NOW_MS });
    assert.equal(findings[0]!.conversationId, null);
  });
});

// ---------------------------------------------------------------------------
// selectTopFinding tests
// ---------------------------------------------------------------------------

describe('selectTopFinding — priority order', () => {
  function f(
    id: string,
    classification: GoalFinding['classification'],
  ): GoalFinding {
    return {
      goalId: id,
      conversationId: null,
      state: 'parked',
      classification,
      recommendedAction: 'none',
      reason: 'test',
    };
  }

  it('blocked > inactive', () => {
    const findings = [
      f('g1', 'inactive'),
      f('g2', 'blocked'),
      f('g3', 'stale'),
    ];
    const top = selectTopFinding(findings);
    assert.notEqual(top, null);
    assert.equal(top!.goalId, 'g2');
    assert.equal(top!.classification, 'blocked');
  });

  it('inactive > stale', () => {
    const findings = [f('g1', 'stale'), f('g2', 'inactive'), f('g3', 'fresh')];
    const top = selectTopFinding(findings);
    assert.notEqual(top, null);
    assert.equal(top!.goalId, 'g2');
    assert.equal(top!.classification, 'inactive');
  });

  it('stale > verified-complete', () => {
    const findings = [
      f('g1', 'verified-complete'),
      f('g2', 'stale'),
      f('g3', 'fresh'),
    ];
    const top = selectTopFinding(findings);
    assert.notEqual(top, null);
    assert.equal(top!.goalId, 'g2');
    assert.equal(top!.classification, 'stale');
  });

  it('verified-complete > fresh', () => {
    const findings = [f('g1', 'fresh'), f('g2', 'verified-complete')];
    const top = selectTopFinding(findings);
    assert.notEqual(top, null);
    assert.equal(top!.goalId, 'g2');
    assert.equal(top!.classification, 'verified-complete');
  });

  it('returns null for empty findings', () => {
    assert.equal(selectTopFinding([]), null);
  });

  it('returns single finding', () => {
    const findings = [f('g1', 'stale')];
    const top = selectTopFinding(findings);
    assert.notEqual(top, null);
    assert.equal(top!.goalId, 'g1');
  });
});

describe('selectTopFinding — conversationId filter', () => {
  function f(
    id: string,
    classification: GoalFinding['classification'],
    conversationId: string | null,
  ): GoalFinding {
    return {
      goalId: id,
      conversationId,
      state: 'parked',
      classification,
      recommendedAction: 'none',
      reason: 'test',
    };
  }

  it('filters to matching conversationId', () => {
    const findings = [
      f('g1', 'blocked', 'conv_A'),
      f('g2', 'stale', 'conv_B'),
    ];
    const top = selectTopFinding(findings, { conversationId: 'conv_B' });
    assert.notEqual(top, null);
    assert.equal(top!.goalId, 'g2');
  });

  it('returns null when no findings match conversationId', () => {
    const findings = [f('g1', 'blocked', 'conv_A')];
    const top = selectTopFinding(findings, { conversationId: 'conv_C' });
    assert.equal(top, null);
  });

  it('filters null conversationId when opts.conversationId is null', () => {
    const findings = [
      f('g1', 'stale', 'conv_A'),
      f('g2', 'blocked', null),
    ];
    const top = selectTopFinding(findings, { conversationId: null });
    assert.notEqual(top, null);
    assert.equal(top!.goalId, 'g2');
  });
});
