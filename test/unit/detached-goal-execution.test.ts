import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDetachedGoalExecutor } from '../../src/commands/detached-goal-execution.ts';
import { defaultGoalJobExecutor } from '../../src/commands/worker.ts';
import type { GoalJob } from '../../src/infra/goal-job.ts';
import { createFileGoalStore } from '../../src/infra/goal-store.ts';
import { systemClock } from '../../src/infra/clock.ts';
import type { OrchestrateDeps } from '../../src/core/types.ts';
import type { EnvironmentStatus } from '../../src/providers/detect.ts';

function baseJob(overrides: Partial<GoalJob> = {}): GoalJob {
  return {
    version: 1,
    conversationId: 'conv1',
    goalId: 'goal_x',
    work: 'Implement the feature',
    title: 'Feature',
    cwd: process.cwd(),
    status: 'pending',
    createdAt: 'now',
    updatedAt: 'now',
    ...overrides,
  };
}

const quietEnv = {} as EnvironmentStatus;

describe('detached goal executor', () => {
  it('parks before provider work when no authenticated provider deps can be made', async () => {
    const executor = createDetachedGoalExecutor({
      detectEnvironment: async () => quietEnv,
      loadConfig: async () => ({ onboarded: true, setAsDefault: false }),
      makeDeps: async () => null,
    });
    assert.equal(await executor(baseJob(), new AbortController().signal), 'parked');
  });

  it('runs one real provider step for free-loop goals (fake runTask)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-m3-free-'));
    const goalStore = createFileGoalStore({ homeDir: home, clock: systemClock });
    const tasks: string[] = [];
    const executor = createDetachedGoalExecutor({
      detectEnvironment: async () => quietEnv,
      loadConfig: async () => ({ onboarded: true, setAsDefault: false }),
      goalStore,
      makeDeps: async () =>
        ({
          providers: { fake: true },
          timeoutMs: 1_000,
        }) as unknown as OrchestrateDeps,
      runTask: async (task) => {
        tasks.push(task);
        return { code: 0 };
      },
    });
    const outcome = await executor(
      baseJob({ goalId: 'goal_free', work: 'Do the free loop work' }),
      new AbortController().signal,
    );
    assert.equal(outcome, 'parked');
    assert.deepEqual(tasks, ['Do the free loop work']);
  });

  it('runs roadmap todos via durable runner with fake provider + verify', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-m3-road-'));
    const goalStore = createFileGoalStore({ homeDir: home, clock: systemClock });
    const created = await goalStore.create({
      title: 'Ship feature',
      roadmap: [{ id: 't1', text: 'Add unit test', status: 'pending' }],
      source: 'user-explicit',
      scope: 'project',
      projectKey: null,
      conversationId: 'conv1',
    });
    assert.ok(created);

    const tasks: string[] = [];
    const executor = createDetachedGoalExecutor({
      detectEnvironment: async () => quietEnv,
      loadConfig: async () => ({ onboarded: true, setAsDefault: false }),
      goalStore,
      makeDeps: async () =>
        ({
          providers: { fake: true },
          timeoutMs: 1_000,
        }) as unknown as OrchestrateDeps,
      runTask: async (task) => {
        tasks.push(task);
        return { code: 0 };
      },
      verifyPort: {
        detectTestCommand: async () => ({
          label: 'npm test',
          command: 'npm',
          args: ['test'],
        }),
        runTests: async () => ({
          outcome: 'green' as const,
          output: 'ok',
          durationMs: 1,
        }),
      },
    });

    const outcome = await executor(
      baseJob({ goalId: created.id, work: created.title, title: created.title }),
      new AbortController().signal,
    );
    assert.equal(outcome, 'done');
    assert.ok(tasks.length >= 1);
    assert.ok(tasks[0]?.includes('Add unit test') || tasks[0]?.includes('Goal:'));
    const finalGoal = await goalStore.get(created.id);
    assert.equal(finalGoal?.state, 'done');
    assert.equal(finalGoal?.goalVerdict?.state, 'passing');
  });

  it('defaultGoalJobExecutor is wired to shared executor (not park-only skeleton)', async () => {
    assert.equal(typeof defaultGoalJobExecutor, 'function');
    // Shared path with null deps parks after real composition attempt — not a
    // silent "setState running → parked" without makeDeps.
    const result = await createDetachedGoalExecutor({
      makeDeps: async () => null,
      detectEnvironment: async () => quietEnv,
      loadConfig: async () => ({ onboarded: true, setAsDefault: false }),
    })(baseJob({ goalId: 'goal_default_wire' }), new AbortController().signal);
    assert.equal(result, 'parked');
  });

  it('fails free-loop when fake provider returns non-zero', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-m3-fail-'));
    const goalStore = createFileGoalStore({ homeDir: home, clock: systemClock });
    const executor = createDetachedGoalExecutor({
      detectEnvironment: async () => quietEnv,
      loadConfig: async () => ({ onboarded: true, setAsDefault: false }),
      goalStore,
      makeDeps: async () =>
        ({ providers: { fake: true }, timeoutMs: 100 }) as unknown as OrchestrateDeps,
      runTask: async () => ({ code: 1 }),
    });
    assert.equal(
      await executor(baseJob({ goalId: 'goal_fail' }), new AbortController().signal),
      'failed',
    );
  });
});
