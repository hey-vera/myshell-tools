/**
 * src/commands/detached-goal-execution.ts — shared detached goal executor.
 *
 * Production path for `myshell-tools worker`: after TUI/process exit, claimed
 * goal jobs continue real provider work + verification (not park-only).
 *
 * Composition:
 *   - Build OrchestrateDeps from live detect + config (same primitives as CLI)
 *   - Roadmap goals → `runDurableGoal` (todo-at-a-time, evidence-gated)
 *   - Free-loop goals (no roadmap) → one real `runTask` turn on job.work, then
 *     park with progress note so reattach can continue (full free multi-turn
 *     adaptive loop still lives primarily in menu runGoalLoop — residual)
 *
 * Ports are injectable for no-network unit tests.
 */

import {
  runDurableGoal,
  type DurableGoalOutcome,
  type DurableTodoResult,
} from '../core/durable-goal-runner.js';
import { DEFAULT_POLICY, POLICY_PRESETS } from '../core/policy.js';
import type { OrchestrateDeps } from '../core/types.js';
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
  /** Max durable-roadmap turns (tests). */
  readonly maxTurns?: number;
}

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

      // Free-loop: no goal record or empty roadmap → one real provider turn.
      if (goal === null || goal.roadmap.length === 0) {
        await goalStore.setState(job.goalId, 'running').catch(() => null);
        const task =
          job.work.trim().length > 0
            ? job.work
            : job.title.trim().length > 0
              ? job.title
              : 'Continue the open goal';
        const result = await run(task, turnDeps, QUIET, signal, 'quiet');
        if (signal.aborted) {
          await goalStore.setState(job.goalId, 'parked').catch(() => null);
          return 'parked';
        }
        if (result.code !== 0) {
          await goalStore.setState(job.goalId, 'failed').catch(() => null);
          return 'failed';
        }
        // One useful step done; do not claim verified goal complete without
        // roadmap + acceptance evidence. Park for reattach/resume.
        await goalStore.setState(job.goalId, 'parked').catch(() => null);
        return 'parked';
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
