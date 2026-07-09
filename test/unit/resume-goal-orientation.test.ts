/**
 * test/unit/resume-goal-orientation.test.ts — pure resume partner orientation
 * for parked/inactive goals (P0.16).
 */

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';

import type { Goal } from '../../src/core/goal-todo.ts';
import type { RoadmapItem } from '../../src/core/work-contract.ts';
import {
  buildResumeGoalOrientation,
  isResumePartnerGoal,
  selectResumePartnerGoals,
  RESUME_GOAL_ORIENTATION_MAX_CHARS,
} from '../../src/core/resume-goal-orientation.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeItem(
  overrides: Partial<RoadmapItem> & { readonly id: string; readonly text: string },
): RoadmapItem {
  return {
    status: 'pending',
    ...overrides,
  };
}

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Auth JWT migration',
    state: 'parked',
    source: 'user-explicit',
    roadmap: [],
    scope: 'project',
    projectKey: 'repo#abc',
    conversationId: 'conv-1',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastTouched: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

const SCOPE = { conversationId: 'conv-1', projectKey: 'repo#abc' as string | null };

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

describe('isResumePartnerGoal / selectResumePartnerGoals', () => {
  it('includes parked goals linked to the conversation', () => {
    const g = makeGoal({ state: 'parked', conversationId: 'conv-1' });
    assert.equal(isResumePartnerGoal(g, SCOPE), true);
  });

  it('includes workspace goals that match projectKey even without conversation link', () => {
    const g = makeGoal({
      conversationId: null,
      projectKey: 'repo#abc',
      state: 'parked',
    });
    assert.equal(isResumePartnerGoal(g, SCOPE), true);
  });

  it('excludes terminal goals and unrelated projects', () => {
    assert.equal(
      isResumePartnerGoal(makeGoal({ state: 'done' }), SCOPE),
      false,
    );
    assert.equal(
      isResumePartnerGoal(makeGoal({ state: 'failed' }), SCOPE),
      false,
    );
    assert.equal(
      isResumePartnerGoal(
        makeGoal({
          conversationId: 'other',
          projectKey: 'other#zzz',
          state: 'parked',
        }),
        SCOPE,
      ),
      false,
    );
  });

  it('orders blocked before running before queued before parked', () => {
    const goals = [
      makeGoal({ id: 'goal_p', state: 'parked', title: 'Parked' }),
      makeGoal({ id: 'goal_b', state: 'blocked', title: 'Blocked' }),
      makeGoal({ id: 'goal_r', state: 'running', title: 'Running' }),
      makeGoal({ id: 'goal_q', state: 'queued', title: 'Queued' }),
    ];
    const selected = selectResumePartnerGoals(goals, SCOPE);
    assert.deepEqual(
      selected.map((g) => g.id),
      ['goal_b', 'goal_r', 'goal_q', 'goal_p'],
    );
  });

  it('returns empty when nothing is in scope', () => {
    assert.deepEqual(selectResumePartnerGoals([], SCOPE), []);
    assert.deepEqual(
      selectResumePartnerGoals(
        [makeGoal({ state: 'done' }), makeGoal({ state: 'failed', id: 'goal_2' })],
        SCOPE,
      ),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// Orientation body
// ---------------------------------------------------------------------------

describe('buildResumeGoalOrientation', () => {
  it('returns null when there are no partner goals', () => {
    assert.equal(buildResumeGoalOrientation([], SCOPE), null);
    assert.equal(
      buildResumeGoalOrientation([makeGoal({ state: 'done' })], SCOPE),
      null,
    );
  });

  it('addresses a parked goal with next open step + resume/drop/adjust', () => {
    const g = makeGoal({
      roadmap: [
        makeItem({ id: 't1', text: 'Sketch plan', status: 'done' }),
        makeItem({ id: 't2', text: 'Write expiry tests', status: 'pending' }),
      ],
    });
    const line = buildResumeGoalOrientation([g], SCOPE);
    assert.ok(line !== null);
    assert.match(line!, /Parked/);
    assert.match(line!, /Auth JWT migration/);
    assert.match(line!, /Write expiry tests/);
    assert.match(line!, /Resume, drop, or adjust/);
    assert.match(line!, /1\/2 to-dos/);
  });

  it('parked goal without todos still asks resume/drop/adjust', () => {
    const line = buildResumeGoalOrientation([makeGoal({ roadmap: [] })], SCOPE);
    assert.ok(line !== null);
    assert.match(line!, /Parked/);
    assert.match(line!, /Resume, drop, or adjust/);
    assert.match(line!, /what's next|say what's next/i);
  });

  it('blocked goal surfaces needs input', () => {
    const g = makeGoal({
      state: 'blocked',
      title: 'Deploy pipeline',
      roadmap: [makeItem({ id: 't1', text: 'Prod credentials', status: 'blocked' })],
    });
    const line = buildResumeGoalOrientation([g], SCOPE);
    assert.ok(line !== null);
    assert.match(line!, /Blocked/);
    assert.match(line!, /Deploy pipeline/);
    assert.match(line!, /Unblock, drop, or adjust/);
  });

  it('running goal offers keep going / pause / adjust with next step', () => {
    const g = makeGoal({
      state: 'running',
      roadmap: [makeItem({ id: 't1', text: 'Wire auth middleware', status: 'active' })],
    });
    const line = buildResumeGoalOrientation([g], SCOPE);
    assert.ok(line !== null);
    assert.match(line!, /In progress/);
    assert.match(line!, /Wire auth middleware/);
    assert.match(line!, /Keep going, pause, or adjust/);
  });

  it('multi-goal orientation names open goals without becoming a board', () => {
    const goals = [
      makeGoal({
        id: 'goal_a',
        title: 'Auth JWT',
        state: 'parked',
        roadmap: [makeItem({ id: 't1', text: 'Expiry tests' })],
      }),
      makeGoal({
        id: 'goal_b',
        title: 'Docs pass',
        state: 'parked',
        roadmap: [],
      }),
      makeGoal({
        id: 'goal_c',
        title: 'CI green',
        state: 'queued',
        roadmap: [],
      }),
    ];
    const line = buildResumeGoalOrientation(goals, SCOPE);
    assert.ok(line !== null);
    assert.match(line!, /3 open goals/);
    assert.match(line!, /Resume one, drop, or adjust/);
    // Not a multi-line board
    assert.ok(!line!.includes('\n'));
    assert.ok(line!.length <= RESUME_GOAL_ORIENTATION_MAX_CHARS);
  });

  it('never invents goals — only shapes the supplied snapshot', () => {
    // Unrelated conversation + project must not surface a fabricated goal.
    const foreign = makeGoal({
      conversationId: 'conv-other',
      projectKey: 'other#zzz',
      title: 'Secret foreign goal',
    });
    assert.equal(buildResumeGoalOrientation([foreign], SCOPE), null);
  });

  it('caps long orientation to the max char budget', () => {
    const longTitle = 'A'.repeat(200);
    const longStep = 'B'.repeat(200);
    const g = makeGoal({
      title: longTitle,
      roadmap: [makeItem({ id: 't1', text: longStep })],
    });
    const line = buildResumeGoalOrientation([g], SCOPE);
    assert.ok(line !== null);
    assert.ok(line!.length <= RESUME_GOAL_ORIENTATION_MAX_CHARS);
    assert.ok(line!.endsWith('…') || line!.length < RESUME_GOAL_ORIENTATION_MAX_CHARS);
  });

  it('workspace-scoped parked goal is addressed without conversationId', () => {
    const g = makeGoal({
      conversationId: null,
      projectKey: 'repo#abc',
      title: 'Workspace parked work',
      state: 'parked',
      roadmap: [makeItem({ id: 't1', text: 'Ship the fix' })],
    });
    const line = buildResumeGoalOrientation([g], {
      conversationId: 'conv-1',
      projectKey: 'repo#abc',
    });
    assert.ok(line !== null);
    assert.match(line!, /Workspace parked work/);
    assert.match(line!, /Ship the fix/);
  });
});
