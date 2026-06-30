import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import {
  detectCorrectionFork,
  intentDescendantIds,
  planCorrectionGoalInvalidation,
} from '../../src/core/correction-fork.ts';
import type { IntentVersion } from '../../src/core/intent-version.ts';
import type { Goal } from '../../src/core/goal-todo.ts';

function makeVersion(id: string, sessionId: string, createdAt: string, parentId?: string | null): IntentVersion {
  return {
    version: 1,
    id,
    parentId: parentId ?? undefined,
    sessionId,
    createdAt,
    rawUserTurnText: 'test',
    intent: { objective: 'test' },
  };
}

function makeGoal(overrides: Partial<Goal> & { id: string; state: Goal['state'] }): Goal {
  return {
    version: 1,
    id: overrides.id,
    title: 'test goal',
    state: overrides.state,
    source: 'user-explicit',
    roadmap: [],
    scope: 'project',
    projectKey: null,
    conversationId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastTouched: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('detectCorrectionFork', () => {
  it('returns correction for slash correct with prior intent', () => {
    const r = detectCorrectionFork({ text: '/correct do something else', hasPriorIntent: true });
    assert.notEqual(r, null);
    assert.equal(r!.matchedTrigger, '/correct');
  });

  it('returns none when no prior intent exists', () => {
    const r = detectCorrectionFork({ text: '/correct do something else', hasPriorIntent: false });
    assert.equal(r, null);
  });

  it('returns correction for high-confidence triggers', () => {
    const triggerPairs: [string, string][] = [
      ['wait, you missed my point', 'wait, you missed my point'],
      ["that's not what I meant", "that's not what I meant"],
      ['that is not what I meant', 'that is not what I meant'],
      ['you missed my point', 'you missed my point'],
      ['no, I meant deploy the api', 'no, I meant'],
      ['actually, I meant testing', 'actually, I meant'],
      ['wrong direction entirely', 'wrong direction'],
      ['not what I asked for', 'not what I asked'],
    ];
    for (const [text, label] of triggerPairs) {
      const r = detectCorrectionFork({ text, hasPriorIntent: true });
      assert.notEqual(r, null, `should detect "${text}"`);
      assert.equal(r!.matchedTrigger, label);
    }
  });

  it('returns correction for instead preceded by no/wait/actually', () => {
    assert.notEqual(detectCorrectionFork({ text: 'no, instead deploy the API', hasPriorIntent: true }), null);
    assert.notEqual(detectCorrectionFork({ text: 'wait instead do the frontend', hasPriorIntent: true }), null);
    assert.notEqual(detectCorrectionFork({ text: 'actually, instead fix the auth', hasPriorIntent: true }), null);
  });

  it('returns none for uncertain actually phrasing', () => {
    assert.equal(detectCorrectionFork({ text: 'actually implement the login page', hasPriorIntent: true }), null);
    assert.equal(detectCorrectionFork({ text: 'actually we should also consider the cache', hasPriorIntent: true }), null);
  });

  it('returns none for generic wording', () => {
    assert.equal(detectCorrectionFork({ text: 'actually implement X', hasPriorIntent: true }), null);
  });
});

describe('intentDescendantIds', () => {
  it('includes descendants and excludes siblings', () => {
    const versions = [
      makeVersion('v1', 's1', '2026-01-01T00:00:00Z', null),
      makeVersion('v2', 's1', '2026-01-01T01:00:00Z', 'v1'),
      makeVersion('v3', 's1', '2026-01-01T02:00:00Z', 'v2'),
      makeVersion('v4', 's1', '2026-01-01T01:30:00Z', null),
    ];
    const desc = intentDescendantIds(versions, 'v1');
    assert.equal(desc.has('v1'), true);
    assert.equal(desc.has('v2'), true);
    assert.equal(desc.has('v3'), true);
    assert.equal(desc.has('v4'), false, 'sibling v4 (different parent) should be excluded');
  });

  it('excludes excludeRoot and its descendants', () => {
    const versions = [
      makeVersion('v1', 's1', '2026-01-01T00:00:00Z', null),
      makeVersion('v2', 's1', '2026-01-01T01:00:00Z', 'v1'),
      makeVersion('v3', 's1', '2026-01-01T02:00:00Z', 'v2'),
    ];
    const desc = intentDescendantIds(versions, 'v1', 'v2');
    assert.equal(desc.has('v1'), true, 'v1 should be included');
    assert.equal(desc.has('v2'), false, 'v2 excluded');
    assert.equal(desc.has('v3'), false, 'v3 excluded as descendant of v2');
  });
});

describe('planCorrectionGoalInvalidation', () => {
  it('supersedes only live old-branch goals', () => {
    const versions = [
      makeVersion('iv1', 's1', '2026-01-01T00:00:00Z', null),
      makeVersion('iv2', 's1', '2026-01-01T01:00:00Z', 'iv1'),
    ];
    const goals: Goal[] = [
      makeGoal({ id: 'g1', state: 'parked', intentVersionId: 'iv1' }),
      makeGoal({ id: 'g2', state: 'running', intentVersionId: 'iv1' }),
      makeGoal({ id: 'g3', state: 'done', intentVersionId: 'iv1' }),
    ];
    const plan = planCorrectionGoalInvalidation({
      goals,
      versions,
      parentIntentId: 'iv1',
      newIntentId: 'iv2',
    });
    assert.deepStrictEqual(plan.supersedeGoalIds.sort(), ['g1', 'g2'].sort());
  });

  it('preserves done failed blocked superseded and unrelated goals', () => {
    const versions = [
      makeVersion('iv1', 's1', '2026-01-01T00:00:00Z', null),
      makeVersion('iv2', 's1', '2026-01-01T01:00:00Z', 'iv1'),
    ];
    const goals: Goal[] = [
      makeGoal({ id: 'g_done', state: 'done', intentVersionId: 'iv1' }),
      makeGoal({ id: 'g_failed', state: 'failed', intentVersionId: 'iv1' }),
      makeGoal({ id: 'g_parked', state: 'parked', intentVersionId: 'iv1' }),
      makeGoal({ id: 'g_unrelated', state: 'parked', intentVersionId: 'other' }),
    ];
    const plan = planCorrectionGoalInvalidation({
      goals,
      versions,
      parentIntentId: 'iv1',
      newIntentId: 'iv2',
    });
    assert.deepStrictEqual(plan.supersedeGoalIds, ['g_parked']);
    assert.equal(plan.preserveGoalIds.includes('g_done'), true);
    assert.equal(plan.preserveGoalIds.includes('g_failed'), true);
    assert.equal(plan.preserveGoalIds.includes('g_unrelated'), true);
  });

  it('preserves goals without provenance', () => {
    const versions = [
      makeVersion('iv1', 's1', '2026-01-01T00:00:00Z', null),
      makeVersion('iv2', 's1', '2026-01-01T01:00:00Z', 'iv1'),
    ];
    const goals: Goal[] = [
      makeGoal({ id: 'g1', state: 'parked' }),
      makeGoal({ id: 'g2', state: 'queued' }),
    ];
    const plan = planCorrectionGoalInvalidation({
      goals,
      versions,
      parentIntentId: 'iv1',
      newIntentId: 'iv2',
    });
    assert.deepStrictEqual(plan.supersedeGoalIds, []);
    assert.equal(plan.preserveGoalIds.includes('g1'), true);
    assert.equal(plan.preserveGoalIds.includes('g2'), true);
  });

  it('preserves goals with passing verdict', () => {
    const versions = [
      makeVersion('iv1', 's1', '2026-01-01T00:00:00Z', null),
      makeVersion('iv2', 's1', '2026-01-01T01:00:00Z', 'iv1'),
    ];
    const goals: Goal[] = [
      makeGoal({
        id: 'g1',
        state: 'parked',
        intentVersionId: 'iv1',
        goalVerdict: { state: 'passing', receipt: 'verified', at: '2026-01-01T00:00:00Z' },
      }),
    ];
    const plan = planCorrectionGoalInvalidation({
      goals,
      versions,
      parentIntentId: 'iv1',
      newIntentId: 'iv2',
    });
    assert.deepStrictEqual(plan.supersedeGoalIds, []);
    assert.equal(plan.preserveGoalIds.includes('g1'), true);
  });
});
