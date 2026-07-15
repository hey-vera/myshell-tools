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
 *
 * Optional fenced lease fields (v1 additive): reclaim when lease expires or
 * owner PID is dead — do not trust PID alone.
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
  /**
   * Opaque fence id minted on each successful claim. Mid-run workers renew
   * against this id; a stealer mints a new id so the loser aborts.
   */
  readonly leaseId?: string;
  /** Monotonic generation bumped on every claim/reclaim (starts at 1). */
  readonly leaseGeneration?: number;
  /** ISO expiry; reclaim allowed when now >= this (or owner PID dead). */
  readonly leaseExpiresAt?: string;
}

export const GOAL_JOB_VERSION = 1 as const;

/** Default idle TTL for the detached worker with an empty queue (2 min). */
export const DEFAULT_WORKER_IDLE_TTL_MS = 2 * 60 * 1000;

/** How often the worker polls for reclaimable jobs. */
export const DEFAULT_WORKER_POLL_MS = 2_000;

/** Default fenced lease TTL (~3 minutes). Worker renews well before expiry. */
export const DEFAULT_GOAL_JOB_LEASE_TTL_MS = 3 * 60 * 1000;

/** How often a running worker renews its lease (~45s, mid of 30–60s band). */
export const DEFAULT_GOAL_JOB_LEASE_RENEW_MS = 45 * 1000;

/** Fence identity for renew / isLeaseHeld checks. */
export interface GoalJobLeaseFence {
  readonly leaseId: string;
  readonly leaseGeneration: number;
  /** When set, must match job.claimedBy. */
  readonly pid?: number;
}

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

  const withLeaseId =
    typeof o['leaseId'] === 'string' && o['leaseId'].length > 0 && o['leaseId'].length <= 200
      ? { ...withNote, leaseId: o['leaseId'] }
      : withNote;
  const withLeaseGen =
    typeof o['leaseGeneration'] === 'number' &&
    Number.isFinite(o['leaseGeneration']) &&
    o['leaseGeneration'] > 0 &&
    Number.isInteger(o['leaseGeneration'])
      ? { ...withLeaseId, leaseGeneration: o['leaseGeneration'] }
      : withLeaseId;
  const withLeaseExp =
    typeof o['leaseExpiresAt'] === 'string' && o['leaseExpiresAt'].length > 0
      ? { ...withLeaseGen, leaseExpiresAt: o['leaseExpiresAt'] }
      : withLeaseGen;

  return withLeaseExp;
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
 * Whether the job's fenced lease has expired at `nowMs`.
 * Missing/unparseable `leaseExpiresAt` → treated as expired (reclaimable).
 * Pure.
 */
export function isLeaseExpired(job: GoalJob, nowMs: number): boolean {
  if (job.leaseExpiresAt === undefined || job.leaseExpiresAt.length === 0) return true;
  const exp = Date.parse(job.leaseExpiresAt);
  if (!Number.isFinite(exp)) return true;
  return nowMs >= exp;
}

/**
 * True when this process still holds the active fenced lease:
 * matching leaseId + generation, optional pid, not expired, claimed/running.
 * Pure.
 */
export function isLeaseHeld(
  job: GoalJob,
  fence: GoalJobLeaseFence,
  nowMs: number,
): boolean {
  if (job.status !== 'claimed' && job.status !== 'running') return false;
  if (job.leaseId === undefined || job.leaseId !== fence.leaseId) return false;
  if (job.leaseGeneration === undefined || job.leaseGeneration !== fence.leaseGeneration) {
    return false;
  }
  if (fence.pid !== undefined && job.claimedBy !== undefined && job.claimedBy !== fence.pid) {
    return false;
  }
  return !isLeaseExpired(job, nowMs);
}

/**
 * Pure claim decision: can this process take ownership?
 *
 * - `pending` → always claimable
 * - `claimed` / `running` → claimable when owner PID is dead **or** lease
 *   expired (fenced reclaim). Missing claimedBy → claimable.
 * - terminal → never
 *
 * `nowMs` defaults to Date.now() for call-site convenience; tests inject clock.
 */
export function canClaimGoalJob(
  job: GoalJob,
  isOwnerAlive: (pid: number) => boolean,
  nowMs: number = Date.now(),
): boolean {
  if (isTerminalGoalJob(job)) return false;
  if (job.status === 'pending') return true;
  if (job.status === 'claimed' || job.status === 'running') {
    if (job.claimedBy === undefined) return true;
    if (!isOwnerAlive(job.claimedBy)) return true;
    // Owner still alive: reclaim only when a lease was written and has expired.
    // Legacy jobs without leaseExpiresAt keep pre-fence PID-only hold.
    if (
      job.leaseExpiresAt !== undefined &&
      job.leaseExpiresAt.length > 0 &&
      isLeaseExpired(job, nowMs)
    ) {
      return true;
    }
    return false;
  }
  return false;
}

/**
 * Produce a claimed job owned by `pid` with a fresh fenced lease. Pure.
 *
 * - Bumps `leaseGeneration` (0/missing → 1)
 * - Sets `leaseId` (injected or derived for purity)
 * - Sets `leaseExpiresAt` = now + TTL
 */
export function applyClaim(
  job: GoalJob,
  pid: number,
  owner: GoalJobOwner,
  nowIso: string,
  options?: {
    readonly leaseId?: string;
    readonly leaseTtlMs?: number;
  },
): GoalJob {
  const leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_GOAL_JOB_LEASE_TTL_MS;
  const nowMs = Date.parse(nowIso);
  const baseMs = Number.isFinite(nowMs) ? nowMs : 0;
  const prevGen =
    typeof job.leaseGeneration === 'number' &&
    Number.isFinite(job.leaseGeneration) &&
    job.leaseGeneration > 0
      ? job.leaseGeneration
      : 0;
  const leaseId =
    options?.leaseId !== undefined && options.leaseId.length > 0
      ? options.leaseId
      : `lease_${pid}_${nowIso}`;
  return {
    ...job,
    status: 'claimed',
    owner,
    claimedBy: pid,
    claimedAt: nowIso,
    updatedAt: nowIso,
    leaseId,
    leaseGeneration: prevGen + 1,
    leaseExpiresAt: new Date(baseMs + leaseTtlMs).toISOString(),
  };
}

/**
 * Renew lease expiry if fence still matches. Returns null on fence mismatch,
 * terminal/pending status, or already-expired lease. Pure.
 */
export function applyRenewLease(
  job: GoalJob,
  fence: GoalJobLeaseFence,
  nowIso: string,
  leaseTtlMs: number = DEFAULT_GOAL_JOB_LEASE_TTL_MS,
): GoalJob | null {
  if (job.status !== 'claimed' && job.status !== 'running') return null;
  if (job.leaseId !== fence.leaseId) return null;
  if (job.leaseGeneration !== fence.leaseGeneration) return null;
  if (fence.pid !== undefined && job.claimedBy !== undefined && job.claimedBy !== fence.pid) {
    return null;
  }
  const nowMs = Date.parse(nowIso);
  const baseMs = Number.isFinite(nowMs) ? nowMs : 0;
  // Expired lease cannot be renewed — stealer/reclaim must claim fresh.
  if (isLeaseExpired(job, baseMs)) return null;
  return {
    ...job,
    leaseExpiresAt: new Date(baseMs + leaseTtlMs).toISOString(),
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
 * Release TUI (or dead-owner) claim so a detached worker can claim immediately.
 * Clears ownership metadata and returns status to `pending` without parking.
 * Pure — used on Esc/process exit handoff (M2). Does not invent work text.
 */
export function applyReleaseForHandoff(
  job: GoalJob,
  nowIso: string,
  note: string = 'tui exit handoff — released for worker claim',
): GoalJob {
  // Explicitly omit owner/claimedBy/claimedAt and all lease fence fields so a
  // detached worker can claim without waiting on PID or lease expiry.
  return {
    version: job.version,
    conversationId: job.conversationId,
    goalId: job.goalId,
    work: job.work,
    title: job.title,
    cwd: job.cwd,
    status: 'pending',
    createdAt: job.createdAt,
    updatedAt: nowIso,
    note: note.slice(0, 500),
  };
}

/**
 * Whether this process still owns an active job claim (TUI path).
 * Used so spawn finally does not stomp a handoff/worker claim.
 */
export function isOwnedByPid(job: GoalJob, pid: number, owner: GoalJobOwner = 'tui'): boolean {
  if (!isActiveGoalJob(job)) return false;
  if (job.owner !== owner) return false;
  if (job.claimedBy === undefined) return false;
  return job.claimedBy === pid;
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

/** Reopen-chat honesty categories for active/settled job files (M2). */
export type GoalJobReopenKind = 'worker-running' | 'pending-handoff' | 'parked-job' | 'other-active';

/**
 * Pure classifier for one job on chat re-enter messaging.
 * - worker-running: detached worker owns claimed/running
 * - pending-handoff: pending (released or never claimed)
 * - parked-job: terminal parked (worker skeleton or TUI settle)
 * - other-active: claimed/running under tui or unknown owner
 */
export function classifyGoalJobForReopen(job: GoalJob): GoalJobReopenKind {
  if (job.status === 'parked') return 'parked-job';
  if (job.status === 'pending') return 'pending-handoff';
  if (
    (job.status === 'claimed' || job.status === 'running') &&
    job.owner === 'worker'
  ) {
    return 'worker-running';
  }
  if (isActiveGoalJob(job)) return 'other-active';
  return 'parked-job';
}

/**
 * Build dim reopen lines from job classification + zombie heal counts.
 * Pure; caller writes. Empty array when nothing to say.
 */
export function formatExitHandoffReopenMessages(input: {
  readonly healedOrphans: number;
  readonly workerRunning: number;
  readonly pendingHandoff: number;
  readonly parkedGoals: number;
  readonly storeRunning: number;
}): string[] {
  const lines: string[] = [];
  if (input.healedOrphans > 0) {
    lines.push(
      `(healed ${input.healedOrphans} orphaned running goal(s) → parked — no live worker or job)`,
    );
  }
  if (input.workerRunning > 0) {
    lines.push(
      `(detached worker running ${input.workerRunning} goal(s) — work continues outside this chat)`,
    );
  }
  if (input.pendingHandoff > 0) {
    lines.push(
      `(${input.pendingHandoff} goal job(s) queued for detached worker — may park until full executor lands)`,
    );
  }
  const parts: string[] = [];
  if (input.storeRunning > 0) parts.push(`${input.storeRunning} running`);
  if (input.parkedGoals > 0) parts.push(`${input.parkedGoals} parked`);
  if (parts.length > 0) {
    lines.push(
      `(resuming — ${parts.join(', ')} goal(s) active; chat "status", "accept", "pause", or "adjust" to control)`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Process-exit handoff latch (in-memory, this TUI process only)
// ---------------------------------------------------------------------------

let tuiExitHandoffActive = false;

/** Arm when Esc/process exit begins goal handoff (before abort/release). */
export function beginTuiExitHandoff(): void {
  tuiExitHandoffActive = true;
}

/** True while this process is handing jobs to the detached worker. */
export function isTuiExitHandoffActive(): boolean {
  return tuiExitHandoffActive;
}

/** Test-only reset. */
export function resetTuiExitHandoffForTests(): void {
  tuiExitHandoffActive = false;
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
