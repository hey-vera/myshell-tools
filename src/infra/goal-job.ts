/**
 * src/infra/goal-job.ts — pure types + helpers for detached goal job files
 * (multi-chat PR-D daemon-lite).
 *
 * Job files live under `<stateRoot>/goal-jobs/<conversationId>/<goalId>.json`.
 * They hold work text + lifecycle status only — never credentials, tokens, or
 * provider secrets. Pure helpers here are unit-tested without I/O.
 */

import { join } from 'node:path';

/** Lifecycle of a durable goal job on disk. */
export type GoalJobStatus =
  | 'pending'
  | 'claimed'
  | 'running'
  | 'done'
  | 'failed'
  | 'parked';

/** Who currently owns execution of the job. */
export type GoalJobOwner = 'tui' | 'worker';

/**
 * Durable job record. Intentionally free of secrets — only ids, work text,
 * title, cwd, status, and ownership metadata for reclaim after process exit.
 */
export interface GoalJob {
  readonly version: 1;
  readonly conversationId: string;
  readonly goalId: string;
  /** Work text handed to the goal loop / runner (objective, not credentials). */
  readonly work: string;
  readonly title: string;
  /** Working directory the job should run in (absolute path preferred). */
  readonly cwd: string;
  readonly status: GoalJobStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly owner?: GoalJobOwner;
  /** OS pid of the process that claimed / is running the job. */
  readonly claimedBy?: number;
  readonly claimedAt?: string;
  /** Short fail-soft error or progress note (never secrets). */
  readonly note?: string;
}

export const GOAL_JOB_VERSION = 1 as const;

/** Default idle TTL for the detached worker with an empty queue (2 min). */
export const DEFAULT_WORKER_IDLE_TTL_MS = 2 * 60 * 1000;

/** How often the worker polls for reclaimable jobs. */
export const DEFAULT_WORKER_POLL_MS = 2_000;

/** Statuses that mean work is finished (terminal). */
export const TERMINAL_GOAL_JOB_STATUSES: ReadonlySet<GoalJobStatus> = new Set([
  'done',
  'failed',
  'parked',
]);

/** Statuses that mean a live owner may still be working. */
export const ACTIVE_GOAL_JOB_STATUSES: ReadonlySet<GoalJobStatus> = new Set([
  'pending',
  'claimed',
  'running',
]);

/**
 * Build the absolute path for a goal job file under a jobs root.
 * Rejects empty / traversal-ish conversation or goal ids (path safety).
 */
export function goalJobFilePath(
  jobsRoot: string,
  conversationId: string,
  goalId: string,
): string {
  assertSafeJobSegment(conversationId, 'conversationId');
  assertSafeJobSegment(goalId, 'goalId');
  return join(jobsRoot, conversationId, `${goalId}.json`);
}

/**
 * Directory holding all jobs for one conversation.
 */
export function goalJobConversationDir(jobsRoot: string, conversationId: string): string {
  assertSafeJobSegment(conversationId, 'conversationId');
  return join(jobsRoot, conversationId);
}

/**
 * Path to the single-supervisor worker pid file under the jobs root.
 */
export function workerPidFilePath(jobsRoot: string): string {
  return join(jobsRoot, 'worker.pid');
}

/**
 * Path to the worker log file (fail-soft stdout/stderr capture optional).
 */
export function workerLogFilePath(jobsRoot: string): string {
  return join(jobsRoot, 'worker.log');
}

/**
 * Safe path segment: non-empty, no separators or `..`.
 */
export function isSafeJobSegment(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200) return false;
  if (value === '.' || value === '..') return false;
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false;
  return true;
}

function assertSafeJobSegment(value: string, label: string): void {
  if (!isSafeJobSegment(value)) {
    throw new Error(`invalid goal-job ${label}: ${JSON.stringify(value)}`);
  }
}

/**
 * Validate and narrow unknown JSON into a GoalJob. Returns null on any bad shape.
 * Pure, never throws.
 */
export function parseGoalJob(raw: unknown): GoalJob | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['version'] !== GOAL_JOB_VERSION) return null;
  if (typeof o['conversationId'] !== 'string' || !isSafeJobSegment(o['conversationId'])) return null;
  if (typeof o['goalId'] !== 'string' || !isSafeJobSegment(o['goalId'])) return null;
  if (typeof o['work'] !== 'string') return null;
  if (typeof o['title'] !== 'string') return null;
  if (typeof o['cwd'] !== 'string' || o['cwd'].length === 0) return null;
  if (!isGoalJobStatus(o['status'])) return null;
  if (typeof o['createdAt'] !== 'string' || o['createdAt'].length === 0) return null;
  if (typeof o['updatedAt'] !== 'string' || o['updatedAt'].length === 0) return null;

  const job: GoalJob = {
    version: GOAL_JOB_VERSION,
    conversationId: o['conversationId'],
    goalId: o['goalId'],
    work: o['work'],
    title: o['title'],
    cwd: o['cwd'],
    status: o['status'],
    createdAt: o['createdAt'],
    updatedAt: o['updatedAt'],
  };

  const withOwner =
    o['owner'] === 'tui' || o['owner'] === 'worker'
      ? { ...job, owner: o['owner'] as GoalJobOwner }
      : job;
  const withClaimed =
    typeof o['claimedBy'] === 'number' && Number.isFinite(o['claimedBy'])
      ? { ...withOwner, claimedBy: o['claimedBy'] }
      : withOwner;
  const withClaimedAt =
    typeof o['claimedAt'] === 'string'
      ? { ...withClaimed, claimedAt: o['claimedAt'] }
      : withClaimed;
  const withNote =
    typeof o['note'] === 'string' && o['note'].length > 0
      ? { ...withClaimedAt, note: o['note'].slice(0, 500) }
      : withClaimedAt;

  return withNote;
}

export function isGoalJobStatus(value: unknown): value is GoalJobStatus {
  return (
    value === 'pending' ||
    value === 'claimed' ||
    value === 'running' ||
    value === 'done' ||
    value === 'failed' ||
    value === 'parked'
  );
}

/**
 * Serialize a job to pretty JSON for disk. Pure.
 */
export function serializeGoalJob(job: GoalJob): string {
  return `${JSON.stringify(job, null, 2)}\n`;
}

/**
 * Build a new pending job record. Pure (clock injected via `nowIso`).
 */
export function createPendingGoalJob(input: {
  readonly conversationId: string;
  readonly goalId: string;
  readonly work: string;
  readonly title: string;
  readonly cwd: string;
  readonly nowIso: string;
}): GoalJob {
  if (!isSafeJobSegment(input.conversationId)) {
    throw new Error(`invalid conversationId for goal job`);
  }
  if (!isSafeJobSegment(input.goalId)) {
    throw new Error(`invalid goalId for goal job`);
  }
  return {
    version: GOAL_JOB_VERSION,
    conversationId: input.conversationId,
    goalId: input.goalId,
    work: input.work,
    title: input.title,
    cwd: input.cwd,
    status: 'pending',
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

/**
 * Whether a job is in a terminal status.
 */
export function isTerminalGoalJob(job: GoalJob): boolean {
  return TERMINAL_GOAL_JOB_STATUSES.has(job.status);
}

/**
 * Whether a job is still active (pending/claimed/running).
 */
export function isActiveGoalJob(job: GoalJob): boolean {
  return ACTIVE_GOAL_JOB_STATUSES.has(job.status);
}

/**
 * Pure claim decision: can this process take ownership?
 *
 * - `pending` → always claimable
 * - `claimed` / `running` → claimable only when `claimedBy` is missing or
 *   `isOwnerAlive(claimedBy)` is false (orphan reclaim after TUI/worker exit)
 * - terminal → never
 */
export function canClaimGoalJob(
  job: GoalJob,
  isOwnerAlive: (pid: number) => boolean,
): boolean {
  if (isTerminalGoalJob(job)) return false;
  if (job.status === 'pending') return true;
  if (job.status === 'claimed' || job.status === 'running') {
    if (job.claimedBy === undefined) return true;
    return !isOwnerAlive(job.claimedBy);
  }
  return false;
}

/**
 * Produce a claimed/running job owned by `pid`. Pure.
 */
export function applyClaim(
  job: GoalJob,
  pid: number,
  owner: GoalJobOwner,
  nowIso: string,
): GoalJob {
  return {
    ...job,
    status: 'claimed',
    owner,
    claimedBy: pid,
    claimedAt: nowIso,
    updatedAt: nowIso,
  };
}

/**
 * Transition a claimed job to running (heartbeat / start of work). Pure.
 */
export function applyRunning(job: GoalJob, nowIso: string, note?: string): GoalJob {
  return {
    ...job,
    status: 'running',
    updatedAt: nowIso,
    ...(note !== undefined && note.length > 0 ? { note: note.slice(0, 500) } : {}),
  };
}

/**
 * Mark job terminal. Pure.
 */
export function applyTerminal(
  job: GoalJob,
  status: 'done' | 'failed' | 'parked',
  nowIso: string,
  note?: string,
): GoalJob {
  return {
    ...job,
    status,
    updatedAt: nowIso,
    ...(note !== undefined && note.length > 0 ? { note: note.slice(0, 500) } : {}),
  };
}

/**
 * Pure: filter running goal ids that have neither a live in-process controller
 * nor an active detached job. Used by TUI zombie heal so reattach after restart
 * does not park goals the worker still owns.
 */
export function zombieRunningGoalIdsWithJobs(
  runningGoalIds: readonly string[],
  liveControllerIds: ReadonlySet<string>,
  activeDetachedGoalIds: ReadonlySet<string>,
): string[] {
  return runningGoalIds.filter(
    (id) => !liveControllerIds.has(id) && !activeDetachedGoalIds.has(id),
  );
}

/**
 * Parse worker.pid file contents. Accepts plain pid or JSON `{ "pid": n }`.
 * Pure, never throws.
 */
export function parseWorkerPidFile(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const asNum = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asNum) && asNum > 0 && String(asNum) === trimmed) return asNum;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { pid?: unknown }).pid === 'number'
    ) {
      const pid = (parsed as { pid: number }).pid;
      if (Number.isFinite(pid) && pid > 0) return pid;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

/**
 * Serialize worker pid file. Pure when `nowIso` is injected.
 */
export function serializeWorkerPidFile(pid: number, nowIso: string = '1970-01-01T00:00:00.000Z'): string {
  return `${JSON.stringify({ version: 1, pid, updatedAt: nowIso }, null, 2)}\n`;
}
