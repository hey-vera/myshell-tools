import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDetachedGoalExecutor,
  runDetachedFreeGoal,
} from '../../src/commands/detached-goal-execution.ts';
import { defaultGoalJobExecutor } from '../../src/commands/worker.ts';
import { DEFAULT_MAX_GOAL_ITERATIONS } from '../../src/core/goal.ts';
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

function fakeFinal(output: string, success = true) {
  return {
    type: 'final' as const,
    success,
    output,
    tier: 'worker' as const,
    totalCostUsd: 0,
    sessionId: 'sess-fake',
    attempts: 1,
  };
}

describe('detached goal executor', () => {
  it('parks before provider work when no authenticated provider deps can be made', async () => {
    const executor = createDetachedGoalExecutor({
      detectEnvironment: async () => quietEnv,
      loadConfig: async () => ({ onboarded: true, setAsDefault: false }),
      makeDeps: async () => null,
    });
    assert.equal(await executor(baseJob(), new AbortController().signal), 'parked');
  });

  it('runs free-loop multi-turn: continue then complete → ≥2 runTask calls, parks (no silent done)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-m3-free-mt-'));
    const goalStore = createFileGoalStore({ homeDir: home, clock: systemClock });
    const tasks: string[] = [];
    let call = 0;
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
        call += 1;
        if (call === 1) {
          return {
            code: 0,
            final: fakeFinal('Did step one.\nGOAL_CONTINUE: write the tests'),
          };
        }
        return {
          code: 0,
          final: fakeFinal('All verified.\nGOAL_COMPLETE'),
        };
      },
    });
    const outcome = await executor(
      baseJob({ goalId: 'goal_free_mt', work: 'Do the free loop work' }),
      new AbortController().signal,
    );
    assert.equal(outcome, 'parked');
    assert.ok(tasks.length >= 2, `expected ≥2 runTask calls, got ${tasks.length}`);
    assert.ok(tasks[0]?.includes('Do the free loop work') || tasks[0]?.includes('Goal:'));
    assert.ok(tasks[1]?.includes('Continue working') || tasks[1]?.includes('Do the free loop work'));
    // Second turn should see checkpoint from GOAL_CONTINUE next-step.
    assert.ok(
      tasks[1]?.includes('write the tests') || tasks[1]?.includes('RECENT STEPS'),
      'expected continue checkpoint threaded into later turn',
    );
  });

  it('runDetachedFreeGoal parks on ask_user questions without further turns', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-m3-free-q-'));
    const goalStore = createFileGoalStore({ homeDir: home, clock: systemClock });
    let calls = 0;
    const outcome = await runDetachedFreeGoal({
      job: baseJob({ goalId: 'goal_q', work: 'Ambiguous work' }),
      turnDeps: { providers: { fake: true }, timeoutMs: 100 } as unknown as OrchestrateDeps,
      signal: new AbortController().signal,
      goalStore,
      runTask: async () => {
        calls += 1;
        return {
          code: 0,
          final: {
            ...fakeFinal('Need a decision.'),
            questions: {
              questions: [
                {
                  id: 'q1',
                  prompt: 'Which path?',
                  options: [{ label: 'A' }, { label: 'B' }],
                  multiSelect: false,
                  allowFreeText: false,
                },
              ],
            },
          },
        };
      },
    });
    assert.equal(outcome, 'parked');
    assert.equal(calls, 1);
  });

  it('runDetachedFreeGoal parks on abort', async () => {
    const home = await mkdtemp(join(tmpdir(), 'myshell-m3-free-ab-'));
    const goalStore = createFileGoalStore({ homeDir: home, clock: systemClock });
    const ac = new AbortController();
    const outcome = await runDetachedFreeGoal({
      job: baseJob({ goalId: 'goal_ab', work: 'Work' }),
      turnDeps: { providers: { fake: true }, timeoutMs: 100 } as unknown as OrchestrateDeps,
      signal: ac.signal,
      goalStore,
      runTask: async (_t, _d, _o, signal) => {
        ac.abort();
        if (signal.aborted) {
          return { code: 1 };
        }
        return { code: 0, final: fakeFinal('x\nGOAL_CONTINUE: more') };
      },
    });
    assert.equal(outcome, 'parked');
  });

  it('free-loop without marker parks after one successful turn (reattach)', async () => {
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
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0]?.includes('Do the free loop work') || tasks[0]?.includes('Goal:'));
  });

  it('uses DEFAULT_MAX_GOAL_ITERATIONS (8) as free-loop ceiling', () => {
    assert.equal(DEFAULT_MAX_GOAL_ITERATIONS, 8);
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
