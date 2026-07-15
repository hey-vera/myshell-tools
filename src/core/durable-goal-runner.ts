/**
 * src/core/durable-goal-runner.ts — headless, persisted-roadmap execution loop
 * shared by the detached worker (and future FG parity).
 *
 * Owns lifecycle truth only: pick next todo → run injected work → require
 * evidence before marking items/goals done. Model execution and verification
 * are injected ports so unit tests need no network and the worker can wire
 * real providers.
 *
 * Pure of process I/O beyond the injected GoalStore ports (store methods are
 * the persistence boundary). No Date.now / Math.random / fs / child_process.
 */

import { buildTodoTask, managerCycleComplete, pickNextTodo } from './goal-manager.js';
import type { Goal, GoalVerdict } from './goal-todo.js';
import type { RoadmapItemVerdict } from './work-contract.js';
import type { GoalStore } from '../infra/goal-store.js';

export type DurableGoalOutcome = 'done' | 'parked' | 'failed';

export type DurableTodoResult =
  | { readonly kind: 'verified'; readonly verdict: RoadmapItemVerdict }
  | { readonly kind: 'unverified'; readonly reason: string }
  | {
      readonly kind:
        | 'waiting_on_user'
        | 'waiting_on_manual_task'
        | 'waiting_on_auth'
        | 'waiting_on_quota';
      readonly reason: string;
    }
  | { readonly kind: 'failed'; readonly reason: string };

/** Minimal progress/state events for logs and future control-plane wiring. */
export type DurableGoalEvent =
  | {
      readonly type: 'goal/state';
      readonly goalId: string;
      readonly state:
        | 'working'
        | 'paused'
        | 'blocked'
        | 'verifying'
        | 'done'
        | 'failed'
        | 'waiting_on_user'
        | 'waiting_on_manual_task'
        | 'waiting_on_auth'
        | 'waiting_on_quota';
      readonly reason?: string;
    }
  | {
      readonly type: 'goal/progress';
      readonly goalId: string;
      readonly done: number;
      readonly total: number;
      readonly activeTodo?: string;
    };

export interface DurableGoalRunnerPorts {
  readonly goalStore: Pick<
    GoalStore,
    | 'get'
    | 'setState'
    | 'setGoalVerdict'
    | 'setRoadmapItemStatus'
    | 'setRoadmapItemVerdict'
  >;
  readonly runTodo: (
    task: string,
    goal: Goal,
    signal: AbortSignal,
  ) => Promise<DurableTodoResult>;
  /** Real acceptance verification after every todo is evidence-backed done. */
  readonly verifyGoal: (
    goal: Goal,
    signal: AbortSignal,
  ) => Promise<{
    readonly done: boolean;
    readonly verdict?: GoalVerdict;
    readonly reason?: string;
  }>;
  readonly emit?: (event: DurableGoalEvent) => void | Promise<void>;
  readonly maxTurns?: number;
  readonly onWait?: (
    wait: Extract<
      DurableTodoResult,
      {
        readonly kind:
          | 'waiting_on_user'
          | 'waiting_on_manual_task'
          | 'waiting_on_auth'
          | 'waiting_on_quota';
      }
    >,
  ) => void | Promise<void>;
}

function runtimeStateFor(
  result: DurableTodoResult,
): Extract<DurableGoalEvent, { type: 'goal/state' }>['state'] {
  switch (result.kind) {
    case 'waiting_on_user':
      return 'waiting_on_user';
    case 'waiting_on_manual_task':
      return 'waiting_on_manual_task';
    case 'waiting_on_auth':
      return 'waiting_on_auth';
    case 'waiting_on_quota':
      return 'waiting_on_quota';
    case 'failed':
      return 'failed';
    default:
      return 'blocked';
  }
}

async function emit(
  ports: DurableGoalRunnerPorts,
  event: DurableGoalEvent,
): Promise<void> {
  await ports.emit?.(event);
}

/**
 * Run one persisted goal a todo at a time. Never accepts a model claim as
 * completion: every todo needs a supplied evidence verdict and the whole goal
 * needs a supplied acceptance check before state becomes done.
 */
export async function runDurableGoal(
  goalId: string,
  ports: DurableGoalRunnerPorts,
  signal: AbortSignal,
): Promise<DurableGoalOutcome> {
  const maxTurns = Math.max(1, Math.floor(ports.maxTurns ?? 8));
  let goal = await ports.goalStore.get(goalId);
  if (goal === null) return 'failed';
  if (goal.roadmap.length === 0) {
    await ports.goalStore.setState(goalId, 'parked');
    await emit(ports, {
      type: 'goal/state',
      goalId,
      state: 'paused',
      reason: 'no persisted roadmap',
    });
    return 'parked';
  }

  await ports.goalStore.setState(goalId, 'running');
  await emit(ports, { type: 'goal/state', goalId, state: 'working' });

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (signal.aborted) {
      await ports.goalStore.setState(goalId, 'parked');
      await emit(ports, {
        type: 'goal/state',
        goalId,
        state: 'paused',
        reason: 'worker canceled',
      });
      return 'parked';
    }
    goal = await ports.goalStore.get(goalId);
    if (goal === null) return 'failed';
    const todo = pickNextTodo(goal.roadmap);
    if (todo === null) {
      if (!managerCycleComplete(goal)) {
        await ports.goalStore.setState(goalId, 'blocked');
        await emit(ports, {
          type: 'goal/state',
          goalId,
          state: 'blocked',
          reason: 'no actionable todo',
        });
        return 'parked';
      }
      await emit(ports, { type: 'goal/state', goalId, state: 'verifying' });
      const acceptance = await ports.verifyGoal(goal, signal);
      if (!acceptance.done || acceptance.verdict === undefined) {
        await ports.goalStore.setState(goalId, 'parked');
        await emit(ports, {
          type: 'goal/state',
          goalId,
          state: 'blocked',
          reason:
            acceptance.reason ?? 'goal acceptance did not produce evidence',
        });
        return 'parked';
      }
      await ports.goalStore.setGoalVerdict(goalId, acceptance.verdict);
      await ports.goalStore.setState(goalId, 'done');
      await emit(ports, { type: 'goal/state', goalId, state: 'done' });
      return 'done';
    }

    const index = goal.roadmap.findIndex((item) => item.id === todo.id);
    if (index >= 0) await ports.goalStore.setRoadmapItemStatus(goalId, index, 'active');
    await emit(ports, {
      type: 'goal/progress',
      goalId,
      done: turn,
      total: goal.roadmap.length,
      activeTodo: todo.text,
    });
    const result = await ports.runTodo(buildTodoTask(goal, todo), goal, signal);
    if (result.kind === 'verified') {
      await ports.goalStore.setRoadmapItemVerdict(goalId, todo.id, result.verdict);
      const refreshed = await ports.goalStore.get(goalId);
      const refreshedIndex =
        refreshed?.roadmap.findIndex((item) => item.id === todo.id) ?? -1;
      if (refreshedIndex >= 0) {
        await ports.goalStore.setRoadmapItemStatus(goalId, refreshedIndex, 'done');
      }
      continue;
    }

    const state = runtimeStateFor(result);
    if (result.kind === 'failed') await ports.goalStore.setState(goalId, 'failed');
    else await ports.goalStore.setState(goalId, 'parked');
    if (
      result.kind === 'waiting_on_user' ||
      result.kind === 'waiting_on_manual_task' ||
      result.kind === 'waiting_on_auth' ||
      result.kind === 'waiting_on_quota'
    ) {
      await ports.onWait?.(result);
    }
    await emit(ports, {
      type: 'goal/state',
      goalId,
      state,
      reason: result.reason,
    });
    return result.kind === 'failed' ? 'failed' : 'parked';
  }

  await ports.goalStore.setState(goalId, 'parked');
  await emit(ports, {
    type: 'goal/state',
    goalId,
    state: 'paused',
    reason: 'work budget reached',
  });
  return 'parked';
}
