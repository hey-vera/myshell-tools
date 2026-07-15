/**
 * src/commands/detached-goal-execution.ts — shared detached goal executor.
 *
 * Production path for `myshell-tools worker`: after TUI/process exit, claimed
 * goal jobs continue real provider work + verification (not park-only).
 *
 * Composition:
 *   - Build OrchestrateDeps from live detect + config (same primitives as CLI)
 *   - Roadmap goals → `runDurableGoal` (todo-at-a-time, evidence-gated)
 *   - Free-loop goals (no roadmap) → multi-turn `runDetachedFreeGoal` using
 *     core/goal pure helpers (buildGoalTask / parseGoalSignal / decideGoalNext)
 *     + runTask, bounded by DEFAULT_MAX_GOAL_ITERATIONS
 *
 * Free-loop outcome policy (honest, no false verified-done):
 *   - GOAL_COMPLETE without roadmap/acceptance evidence → parked (not done)
 *   - ask_user / structured questions → parked for reattach
 *   - abort → parked
 *   - fail (provider non-zero / decideGoalNext stop-error) → failed
 *   - GOAL_CONTINUE → next turn with checkpoint (appendCheckpointFromContinue)
 *   - missing signal / turn ceiling → parked for reattach
 *
 * Ports are injectable for no-network unit tests.
 */

import {
  runDurableGoal,
  type DurableGoalOutcome,
  type DurableTodoResult,
} from '../core/durable-goal-runner.js';
import {
  buildGoalTask,
  decideGoalNext,
  DEFAULT_MAX_GOAL_ITERATIONS,
  parseGoalContinueText,
  parseGoalSignal,
  stripTrailingGoalConfidenceEnvelope,
} from '../core/goal.js';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../core/policy.js';
import type { OrchestrateDeps } from '../core/types.js';
import {
  appendCheckpointFromContinue,
  type WorkContract,
} from '../core/work-contract.js';
import { systemClock } from '../infra/clock.js';
import { loadConfig, type AppConfig } from '../infra/config.js';
import { createFileConversationStore } from '../infra/conversations.js';
import { createIntentStore } from '../infra/intent-store.js';
import { createLedger } from '../infra/ledger.js';
import { createFileGoalStore } from '../infra/goal-store.js';
import { sandboxForEnvironment } from '../infra/sandbox.js';
import { nodeVerifyPort } from '../infra/verify-port.js';
import { buildSharedOrchestrateCore } from '../interface/build-orchestrate-deps.js';
import { runTask, type RunTaskResult } from '../interface/run.js';
import type { OutputSink } from '../interface/render.js';
import { detectEnvironment, type EnvironmentStatus } from '../providers/detect.js';
import { buildAuthenticatedProviders } from '../providers/registry.js';
import type { GoalJob } from '../infra/goal-job.js';

const QUIET: OutputSink = { color: false, isTty: false, write: () => undefined };
const DEFAULT_TIMEOUT_MS = 120_000;

export interface DetachedGoalExecutionDeps {
  readonly detectEnvironment?: () => Promise<EnvironmentStatus>;
  readonly loadConfig?: () => Promise<AppConfig>;
  readonly makeDeps?: (
    job: GoalJob,
    env: EnvironmentStatus,
    config: AppConfig,
  ) => Promise<OrchestrateDeps | null>;
  readonly runTask?: (
    task: string,
    deps: OrchestrateDeps,
    out: OutputSink,
    signal: AbortSignal,
    verbosity?: 'quiet',
  ) => Promise<RunTaskResult>;
  readonly verifyPort?: Pick<
    typeof nodeVerifyPort,
    'detectTestCommand' | 'runTests'
  >;
  /** Override goal store (tests). */
  readonly goalStore?: ReturnType<typeof createFileGoalStore>;
  /** Max free-loop / durable-roadmap turns (tests). Default DEFAULT_MAX_GOAL_ITERATIONS. */
  readonly maxTurns?: number;
}

type GoalStoreLike = Pick<
  ReturnType<typeof createFileGoalStore>,
  'get' | 'setState' | 'setGoalVerdict' | 'setRoadmapItemStatus' | 'setRoadmapItemVerdict'
>;

async function productionDeps(
  job: GoalJob,
  env: EnvironmentStatus,
  config: AppConfig,
): Promise<OrchestrateDeps | null> {
  const providers = buildAuthenticatedProviders(job.cwd, env, process.env, config);
  if (Object.keys(providers).length === 0) return null;
  const mode = config.mode;
  const policy =
    mode === undefined ? DEFAULT_POLICY : POLICY_PRESETS[mode] ?? DEFAULT_POLICY;
  return {
    clock: systemClock,
    session: createFileConversationStore({ clock: systemClock }).writer(
      job.conversationId,
    ),
    ledger: createLedger({ cwd: job.cwd }),
    intentVersionId: systemClock.uuid(),
    intentStore: createIntentStore({ cwd: job.cwd }),
    policy,
    providers,
    cwd: job.cwd,
    sandbox: sandboxForEnvironment('workspace-write'),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...buildSharedOrchestrateCore(env),
  };
}

function verifiedReceipt(label: string): {
  readonly state: 'passing';
  readonly receipt: string;
  readonly at: string;
} {
  return {
    state: 'passing',
    receipt: `${label} passed in detached worker`,
    at: systemClock.isoNow(),
  };
}

function freeLoopGoalText(job: GoalJob): string {
  if (job.work.trim().length > 0) return job.work;
  if (job.title.trim().length > 0) return job.title;
  return 'Continue the open goal';
}

/**
 * Multi-turn free-loop for detached worker: same pure control plane as menu
 * `runGoalLoop` free path (buildGoalTask / parseGoalSignal / decideGoalNext /
 * checkpoints), composed over injected `runTask`. Never marks goal `done`
 * without roadmap + acceptance evidence — GOAL_COMPLETE parks for reattach.
 */
export async function runDetachedFreeGoal(opts: {
  readonly job: GoalJob;
  readonly turnDeps: OrchestrateDeps;
  readonly signal: AbortSignal;
  readonly goalStore: GoalStoreLike;
  readonly runTask: (
    task: string,
    deps: OrchestrateDeps,
    out: OutputSink,
    signal: AbortSignal,
    verbosity?: 'quiet',
  ) => Promise<RunTaskResult>;
  readonly maxTurns?: number;
}): Promise<DurableGoalOutcome> {
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_GOAL_ITERATIONS;
  const goalText = freeLoopGoalText(opts.job);
  let contract: WorkContract = { version: 1, objective: goalText };

  await opts.goalStore.setState(opts.job.goalId, 'running').catch(() => null);

  for (let i = 0; i < maxTurns; i++) {
    if (opts.signal.aborted) {
      await opts.goalStore.setState(opts.job.goalId, 'parked').catch(() => null);
      return 'parked';
    }

    const task = buildGoalTask(goalText, i, contract);
    const result = await opts.runTask(task, opts.turnDeps, QUIET, opts.signal, 'quiet');

    if (opts.signal.aborted) {
      await opts.goalStore.setState(opts.job.goalId, 'parked').catch(() => null);
      return 'parked';
    }

    // Structured ask_user / questions: park for interactive reattach.
    if (result.final?.questions !== undefined) {
      await opts.goalStore.setState(opts.job.goalId, 'parked').catch(() => null);
      return 'parked';
    }

    // Timeout: keep chunking within the turn ceiling (menu free-loop parity).
    if (
      result.final?.success !== true &&
      result.final?.errorCategory === 'timeout' &&
      i + 1 < maxTurns
    ) {
      continue;
    }

    const turnOutput = result.final?.output ?? '';
    const controlOutput = stripTrailingGoalConfidenceEnvelope(turnOutput);
    const goalSignal = parseGoalSignal(controlOutput);
    if (goalSignal === 'continue') {
      contract = appendCheckpointFromContinue(
        contract,
        parseGoalContinueText(controlOutput),
        i,
      );
    }

    const lastSucceeded =
      result.code === 0 &&
      (result.final === undefined || result.final.success === true);

    const step = decideGoalNext({
      signal: goalSignal,
      lastSucceeded,
      completedIterations: i + 1,
      ceilings: { maxIterations: maxTurns },
      costSoFarUsd: 0,
    });

    if (step.action === 'continue') {
      continue;
    }

    if (step.action === 'stop-error') {
      await opts.goalStore.setState(opts.job.goalId, 'failed').catch(() => null);
      return 'failed';
    }

    // complete | stop-iterations | stop-budget | stop-signal:
    // free-loop has no roadmap/acceptance evidence path → park, never silent done.
    await opts.goalStore.setState(opts.job.goalId, 'parked').catch(() => null);
    return 'parked';
  }

  await opts.goalStore.setState(opts.job.goalId, 'parked').catch(() => null);
  return 'parked';
}

/**
 * Build the production executor used as the worker default.
 * Ports are injectable for no-network tests.
 */
export function createDetachedGoalExecutor(
  deps: DetachedGoalExecutionDeps = {},
): (job: GoalJob, signal: AbortSignal) => Promise<DurableGoalOutcome> {
  const detect = deps.detectEnvironment ?? detectEnvironment;
  const readConfig = deps.loadConfig ?? loadConfig;
  const makeDeps = deps.makeDeps ?? productionDeps;
  const run =
    deps.runTask ??
    ((task, turnDeps, out, signal) => runTask(task, turnDeps, out, signal, 'quiet'));
  const verify = deps.verifyPort ?? nodeVerifyPort;
  const goalStore = deps.goalStore ?? createFileGoalStore({ clock: systemClock });

  return async (job, signal) => {
    try {
      const [env, config] = await Promise.all([detect(), readConfig()]);
      const turnDeps = await makeDeps(job, env, config);
      if (turnDeps === null) {
        // Honest no-provider: park so reattach / login can resume.
        await goalStore.setState(job.goalId, 'parked').catch(() => null);
        return 'parked';
      }

      const goal = await goalStore.get(job.goalId).catch(() => null);

      // Free-loop: no goal record or empty roadmap → multi-turn free path.
      if (goal === null || goal.roadmap.length === 0) {
        return runDetachedFreeGoal({
          job,
          turnDeps,
          signal,
          goalStore,
          runTask: run,
          ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
        });
      }

      const outcome = await runDurableGoal(
        job.goalId,
        {
          goalStore,
          ...(deps.maxTurns !== undefined ? { maxTurns: deps.maxTurns } : {}),
          runTodo: async (task, _g, todoSignal) => {
            const result = await run(task, turnDeps, QUIET, todoSignal, 'quiet');
            if (todoSignal.aborted) {
              return {
                kind: 'waiting_on_user',
                reason: 'worker canceled mid-todo',
              } satisfies DurableTodoResult;
            }
            if (result.code !== 0) {
              return {
                kind: 'failed',
                reason: 'provider task failed',
              } satisfies DurableTodoResult;
            }
            const command = await verify.detectTestCommand(job.cwd);
            if (command === null) {
              return {
                kind: 'unverified',
                reason: 'no test command detected',
              } satisfies DurableTodoResult;
            }
            const tested = await verify.runTests(
              job.cwd,
              command,
              turnDeps.timeoutMs,
            );
            return tested.outcome === 'green'
              ? {
                  kind: 'verified',
                  verdict: verifiedReceipt(command.label),
                }
              : {
                  kind: 'unverified',
                  reason: `${command.label} ${tested.outcome}`,
                };
          },
          verifyGoal: async (_g, verifySignal) => {
            if (verifySignal.aborted) {
              return { done: false, reason: 'worker canceled' };
            }
            const command = await verify.detectTestCommand(job.cwd);
            if (command === null) {
              return { done: false, reason: 'no test command detected' };
            }
            const tested = await verify.runTests(
              job.cwd,
              command,
              turnDeps.timeoutMs,
            );
            return tested.outcome === 'green'
              ? { done: true, verdict: verifiedReceipt(command.label) }
              : {
                  done: false,
                  reason: `${command.label} ${tested.outcome}`,
                };
          },
        },
        signal,
      );
      return outcome;
    } catch {
      return 'failed';
    }
  };
}
