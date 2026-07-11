/**
 * src/commands/worker.ts — detached goal worker main loop (multi-chat PR-D).
 *
 * Claims pending/orphaned goal jobs under state home, runs each via a pluggable
 * executor (default: thin skeleton that advances job status and fail-soft logs;
 * full adaptive `runGoalLoop` still lives in menu — extraction is residual),
 * then idle-exits after TTL with an empty queue.
 *
 * Not an always-on OS service. Invoked as `myshell-tools worker`.
 */

import { appendFile, mkdir } from 'node:fs/promises';

import {
  DEFAULT_WORKER_IDLE_TTL_MS,
  DEFAULT_WORKER_POLL_MS,
  workerLogFilePath,
  type GoalJob,
} from '../infra/goal-job.js';
import {
  createGoalJobStore,
  ensureGoalJobsRoot,
  goalJobsRoot,
  writeWorkerPidFile,
  type GoalJobStore,
} from '../infra/goal-job-store.js';
import { defaultStateLayout } from '../infra/state-layout.js';
import { createFileGoalStore } from '../infra/goal-store.js';
import { systemClock } from '../infra/clock.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GoalJobRunOutcome = 'done' | 'failed' | 'parked';

/**
 * Pluggable job executor. Production default is the thin skeleton; tests inject
 * a fake. When full `runGoalLoop` is extracted from menu, wire it here.
 */
export type GoalJobExecutor = (
  job: GoalJob,
  signal: AbortSignal,
) => Promise<GoalJobRunOutcome>;

export interface WorkerLoopOptions {
  readonly store?: GoalJobStore;
  readonly jobsRoot?: string;
  readonly idleTtlMs?: number;
  readonly pollMs?: number;
  readonly executor?: GoalJobExecutor;
  /** Inject sleep (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Inject clock.now for idle math (tests). */
  readonly now?: () => number;
  /** Max jobs to run before exit (tests). Default unlimited. */
  readonly maxJobs?: number;
  /** When true, skip writing worker.pid (tests). */
  readonly skipPidFile?: boolean;
  /** Log sink (tests). Default: append worker.log. */
  readonly log?: (line: string) => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

async function defaultLog(jobsRoot: string, line: string): Promise<void> {
  try {
    await mkdir(jobsRoot, { recursive: true });
    await appendFile(workerLogFilePath(jobsRoot), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* fail-soft */
  }
}

// ---------------------------------------------------------------------------
// Default executor (skeleton)
// ---------------------------------------------------------------------------

/**
 * Thin first-slice executor:
 * - Marks goal store progress fail-soft
 * - Does NOT yet import menu's `runGoalLoop` (closure over chat state)
 * - Leaves an honest note so reattach can show status
 * - Returns `parked` so the durable goal stays recoverable (not false "done")
 *
 * Residual gap: full adaptive goal loop in the worker process.
 */
export async function defaultGoalJobExecutor(
  job: GoalJob,
  _signal: AbortSignal,
): Promise<GoalJobRunOutcome> {
  try {
    const goalStore = createFileGoalStore({ clock: systemClock });
    const goal = await goalStore.get(job.goalId).catch(() => null);
    if (goal !== null && goal.state !== 'running') {
      await goalStore.setState(job.goalId, 'running').catch(() => null);
    }
    // Skeleton: no multi-turn model loop yet. Park so TUI reattach can resume
    // via existing in-process path rather than claiming false completion.
    await goalStore.setState(job.goalId, 'parked').catch(() => null);
    await defaultLog(
      goalJobsRoot(defaultStateLayout()),
      'goalId=' + job.goalId + ' paused for TUI resume; full adaptive loop is not worker-extracted yet',
    );
    return 'parked';
  } catch {
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

/**
 * Run the worker supervisor until idle TTL with no claimable jobs.
 * Returns the number of jobs processed.
 */
export async function runWorkerLoop(options: WorkerLoopOptions = {}): Promise<number> {
  const jobsRoot = options.jobsRoot ?? goalJobsRoot(defaultStateLayout());
  await ensureGoalJobsRoot(jobsRoot);
  const store = options.store ?? createGoalJobStore({ root: jobsRoot });
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_WORKER_IDLE_TTL_MS;
  const pollMs = options.pollMs ?? DEFAULT_WORKER_POLL_MS;
  const executor = options.executor ?? defaultGoalJobExecutor;
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const t = setTimeout(resolve, ms);
        (t as { unref?: () => void }).unref?.();
      }));
  const now = options.now ?? (() => Date.now());
  const log =
    options.log ??
    ((line: string) => {
      void defaultLog(jobsRoot, line);
    });

  if (!options.skipPidFile) {
    await writeWorkerPidFile(jobsRoot, process.pid);
  }

  await log(`worker start pid=${process.pid} idleTtlMs=${idleTtlMs}`);

  let processed = 0;
  let lastWorkAt = now();

  for (;;) {
    if (options.maxJobs !== undefined && processed >= options.maxJobs) {
      await log(`worker exit maxJobs=${options.maxJobs}`);
      break;
    }

    const claimed = await store.claimNext('worker', process.pid);
    if (claimed === null) {
      const idleFor = now() - lastWorkAt;
      if (idleFor >= idleTtlMs) {
        await log(`worker idle-exit after ${idleFor}ms`);
        break;
      }
      await sleep(pollMs);
      continue;
    }

    lastWorkAt = now();
    await log(
      `claimed goalId=${claimed.goalId} conversationId=${claimed.conversationId} title=${claimed.title.slice(0, 80)}`,
    );
    await store.markRunning(
      claimed.conversationId,
      claimed.goalId,
      'detached-worker claimed; pausing for TUI resume',
    );

    const ac = new AbortController();
    let outcome: GoalJobRunOutcome = 'failed';
    try {
      outcome = await executor(claimed, ac.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await log(`executor error goalId=${claimed.goalId}: ${msg.slice(0, 200)}`);
      outcome = 'failed';
    }

    const note =
      outcome === 'done'
        ? 'detached-worker completed'
        : outcome === 'parked'
          ? 'paused for resume after exit'
          : 'detached-worker failed';
    await store.markTerminal(claimed.conversationId, claimed.goalId, outcome, note);
    await log(`finished goalId=${claimed.goalId} outcome=${outcome}`);
    processed += 1;
    lastWorkAt = now();
  }

  return processed;
}

/**
 * CLI entry: run worker loop and return process exit code.
 */
export async function runWorkerCommand(options: WorkerLoopOptions = {}): Promise<number> {
  try {
    await runWorkerLoop(options);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const root = options.jobsRoot ?? goalJobsRoot();
      await defaultLog(root, `worker fatal: ${msg.slice(0, 300)}`);
    } catch {
      /* ignore */
    }
    return 1;
  }
}
