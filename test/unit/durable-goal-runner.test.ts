import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { runDurableGoal } from '../../src/core/durable-goal-runner.ts';
import type { Goal } from '../../src/core/goal-todo.ts';

function goal(): Goal {
  return {
    version: 1,
    id: 'goal_1',
    title: 'Ship',
    state: 'parked',
    source: 'user-explicit',
    scope: 'project',
    projectKey: null,
    conversationId: 'c1',
    createdAt: 'now',
    lastTouched: 'now',
    roadmap: [{ id: 'todo1', text: 'Add test', status: 'pending' }],
  };
}

function fakeStore(current: Goal) {
  return {
    async get() {
      return current;
    },
    async setState(_id: string, state: Goal['state']) {
      current = { ...current, state };
      return current;
    },
    async setGoalVerdict(_id: string, goalVerdict: NonNullable<Goal['goalVerdict']>) {
      current = { ...current, goalVerdict };
      return current;
    },
    async setRoadmapItemStatus(
      _id: string,
      index: number,
      status: Goal['roadmap'][number]['status'],
    ) {
      current = {
        ...current,
        roadmap: current.roadmap.map((item, i) =>
          i === index ? { ...item, status } : item,
        ),
      };
      return current;
    },
    async setRoadmapItemVerdict(
      _id: string,
      itemId: string,
      verdict: NonNullable<Goal['roadmap'][number]['verdict']>,
    ) {
      current = {
        ...current,
        roadmap: current.roadmap.map((item) =>
          item.id === itemId ? { ...item, verdict } : item,
        ),
      };
      return current;
    },
    current: () => current,
  };
}

describe('durable goal runner', () => {
  it('only marks done after todo evidence and goal acceptance both pass', async () => {
    const store = fakeStore(goal());
    const outcome = await runDurableGoal(
      'goal_1',
      {
        goalStore: store,
        runTodo: async () => ({
          kind: 'verified',
          verdict: { state: 'passing', receipt: 'tests green', at: 'now' },
        }),
        verifyGoal: async () => ({
          done: true,
          verdict: { state: 'passing', receipt: 'goal tests green', at: 'now' },
        }),
      },
      new AbortController().signal,
    );
    assert.equal(outcome, 'done');
    assert.equal(store.current().state, 'done');
    assert.equal(store.current().roadmap[0]?.verdict?.state, 'passing');
    assert.equal(store.current().goalVerdict?.state, 'passing');
  });

  it('parks with an explicit wait state instead of claiming completion', async () => {
    const store = fakeStore(goal());
    const states: string[] = [];
    const outcome = await runDurableGoal(
      'goal_1',
      {
        goalStore: store,
        runTodo: async () => ({
          kind: 'waiting_on_user',
          reason: 'Need database choice',
        }),
        verifyGoal: async () => ({
          done: true,
          verdict: { state: 'passing', receipt: 'goal tests green', at: 'now' },
        }),
        emit: (event) => {
          if (event.type === 'goal/state') states.push(event.state);
        },
      },
      new AbortController().signal,
    );
    assert.equal(outcome, 'parked');
    assert.equal(store.current().state, 'parked');
    assert.ok(states.includes('waiting_on_user'));
  });

  it('parks empty-roadmap goals without claiming done', async () => {
    const empty: Goal = { ...goal(), roadmap: [] };
    const store = fakeStore(empty);
    const outcome = await runDurableGoal(
      'goal_1',
      {
        goalStore: store,
        runTodo: async () => {
          throw new Error('should not run');
        },
        verifyGoal: async () => ({ done: true }),
      },
      new AbortController().signal,
    );
    assert.equal(outcome, 'parked');
    assert.equal(store.current().state, 'parked');
  });
});
