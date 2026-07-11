/**
 * src/infra/goal-job-store.ts — durable job file I/O for detached goal workers
 * (multi-chat PR-D).
 *
 * Layout under state root:
 *   goal-jobs/
 *     worker.pid
 *     worker.log
 *     <conversationId>/<goalId>.json
 *
 * Fail-soft: public methods never throw for expected miss / corrupt file
 * (return null / [] / false). Programmer misuse (bad path segment) may throw
 * from path helpers.
 */

import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { atomicWrite, withLock } from './atomic.js';
import { defaultStateLayout, type AppStateLayout } from './state-layout.js';
import {
  applyClaim,
  applyRunning,
  applyTerminal,
  canClaimGoalJob,
  createPendingGoalJob,
  goalJobConversationDir,
  goalJobFilePath,
  isActiveGoalJob,
  parseGoalJob,
  parseWorkerPidFile,
  serializeGoalJob,
  serializeWorkerPidFile,
  workerPidFilePath,
  type GoalJob,
  type GoalJobOwner,
  type GoalJobStatus,
} from './goal-job.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function goalJobsRoot(layout?: AppStateLayout): string {
  const root = (layout ?? defaultStateLayout()).stateRoot;
  return join(root, 'goal-jobs');
}

// ---------------------------------------------------------------------------
// Process liveness (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Best-effort: is `pid` still running? Uses `process.kill(pid, 0)`.
 * Never throws — unknown/ESRCH → false.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface GoalJobStore {
  readonly root: string;
  /** Enqueue (or refresh) a pending job. Overwrites terminal jobs for re-run. */
  enqueue(input: {
    readonly conversationId: string;
    readonly goalId: string;
    readonly work: string;
    readonly title: string;
    readonly cwd: string;
    readonly nowIso?: string;
  }): Promise<GoalJob>;
  get(conversationId: string, goalId: string): Promise<GoalJob | null>;
  listActive(): Promise<GoalJob[]>;
  listByConversation(conversationId: string): Promise<GoalJob[]>;
  /** Active (non-terminal) goal ids for a conversation — for zombie heal. */
  activeGoalIds(conversationId: string): Promise<ReadonlySet<string>>;
  /**
   * Claim job for this process if claimable. Returns updated job or null if
   * not claimable / missing.
   */
  claim(
    conversationId: string,
    goalId: string,
    owner: GoalJobOwner,
    pid?: number,
    nowIso?: string,
  ): Promise<GoalJob | null>;
  /** Atomically claim the next claimable job (scan). */
  claimNext(owner: GoalJobOwner, pid?: number, nowIso?: string): Promise<GoalJob | null>;
  markRunning(conversationId: string, goalId: string, note?: string, nowIso?: string): Promise<GoalJob | null>;
  markTerminal(
    conversationId: string,
    goalId: string,
    status: 'done' | 'failed' | 'parked',
    note?: string,
    nowIso?: string,
  ): Promise<GoalJob | null>;
  updateStatus(
    conversationId: string,
    goalId: string,
    status: GoalJobStatus,
    patch?: { readonly note?: string; readonly owner?: GoalJobOwner; readonly claimedBy?: number },
    nowIso?: string,
  ): Promise<GoalJob | null>;
}

function nowIsoDefault(nowIso?: string): string {
  return nowIso ?? new Date().toISOString();
}

async function readJobFile(filePath: string): Promise<GoalJob | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return parseGoalJob(parsed);
  } catch {
    return null;
  }
}

async function writeJobFile(filePath: string, job: GoalJob): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await atomicWrite(filePath, serializeGoalJob(job));
}

/** Ensure parent dirs exist before withLock creates a lock next to the job file. */
async function ensureJobParent(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

/**
 * Create a file-backed goal job store under `root` (default: state layout).
 */
export function createGoalJobStore(options?: {
  readonly root?: string;
  readonly layout?: AppStateLayout;
  readonly isOwnerAlive?: (pid: number) => boolean;
}): GoalJobStore {
  const root = options?.root ?? goalJobsRoot(options?.layout);
  const isOwnerAlive = options?.isOwnerAlive ?? isProcessAlive;

  const lockPathFor = (conversationId: string, goalId: string): string =>
    `${goalJobFilePath(root, conversationId, goalId)}.lock`;

  const store: GoalJobStore = {
    root,

    async enqueue(input) {
      const nowIso = nowIsoDefault(input.nowIso);
      const filePath = goalJobFilePath(root, input.conversationId, input.goalId);
      await ensureJobParent(filePath);
      return withLock(lockPathFor(input.conversationId, input.goalId), async () => {
        const existing = await readJobFile(filePath);
        // Refresh pending/active with latest work text; new record if missing/terminal.
        if (existing !== null && isActiveGoalJob(existing)) {
          const refreshed: GoalJob = {
            ...existing,
            work: input.work,
            title: input.title,
            cwd: input.cwd,
            updatedAt: nowIso,
            // If still pending, keep pending; if already claimed/running leave status.
            ...(existing.status === 'pending' ? {} : {}),
          };
          await writeJobFile(filePath, refreshed);
          return refreshed;
        }
        const job = createPendingGoalJob({
          conversationId: input.conversationId,
          goalId: input.goalId,
          work: input.work,
          title: input.title,
          cwd: input.cwd,
          nowIso,
        });
        await writeJobFile(filePath, job);
        return job;
      });
    },

    async get(conversationId, goalId) {
      try {
        return await readJobFile(goalJobFilePath(root, conversationId, goalId));
      } catch {
        return null;
      }
    },

    async listActive() {
      const all = await listAllJobs(root);
      return all.filter(isActiveGoalJob);
    },

    async listByConversation(conversationId) {
      try {
        const dir = goalJobConversationDir(root, conversationId);
        const names = await readdir(dir).catch(() => [] as string[]);
        const jobs: GoalJob[] = [];
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const job = await readJobFile(join(dir, name));
          if (job !== null) jobs.push(job);
        }
        return jobs;
      } catch {
        return [];
      }
    },

    async activeGoalIds(conversationId) {
      const jobs = await store.listByConversation(conversationId);
      const ids = new Set<string>();
      for (const j of jobs) {
        if (isActiveGoalJob(j)) ids.add(j.goalId);
      }
      return ids;
    },

    async claim(conversationId, goalId, owner, pid = process.pid, nowIso) {
      const ts = nowIsoDefault(nowIso);
      const filePath = goalJobFilePath(root, conversationId, goalId);
      try {
        await ensureJobParent(filePath);
        return await withLock(lockPathFor(conversationId, goalId), async () => {
          const existing = await readJobFile(filePath);
          if (existing === null) return null;
          if (!canClaimGoalJob(existing, isOwnerAlive)) return null;
          const claimed = applyClaim(existing, pid, owner, ts);
          await writeJobFile(filePath, claimed);
          return claimed;
        });
      } catch {
        return null;
      }
    },

    async claimNext(owner, pid = process.pid, nowIso) {
      const active = await store.listActive();
      // Prefer pure pending, then orphaned claimed/running.
      const ordered = [
        ...active.filter((j) => j.status === 'pending'),
        ...active.filter((j) => j.status !== 'pending'),
      ];
      for (const job of ordered) {
        if (!canClaimGoalJob(job, isOwnerAlive)) continue;
        const claimed = await store.claim(job.conversationId, job.goalId, owner, pid, nowIso);
        if (claimed !== null) return claimed;
      }
      return null;
    },

    async markRunning(conversationId, goalId, note, nowIso) {
      const ts = nowIsoDefault(nowIso);
      const filePath = goalJobFilePath(root, conversationId, goalId);
      try {
        await ensureJobParent(filePath);
        return await withLock(lockPathFor(conversationId, goalId), async () => {
          const existing = await readJobFile(filePath);
          if (existing === null) return null;
          const next = applyRunning(existing, ts, note);
          await writeJobFile(filePath, next);
          return next;
        });
      } catch {
        return null;
      }
    },

    async markTerminal(conversationId, goalId, status, note, nowIso) {
      const ts = nowIsoDefault(nowIso);
      const filePath = goalJobFilePath(root, conversationId, goalId);
      try {
        await ensureJobParent(filePath);
        return await withLock(lockPathFor(conversationId, goalId), async () => {
          const existing = await readJobFile(filePath);
          if (existing === null) return null;
          const next = applyTerminal(existing, status, ts, note);
          await writeJobFile(filePath, next);
          return next;
        });
      } catch {
        return null;
      }
    },

    async updateStatus(conversationId, goalId, status, patch, nowIso) {
      const ts = nowIsoDefault(nowIso);
      const filePath = goalJobFilePath(root, conversationId, goalId);
      try {
        await ensureJobParent(filePath);
        return await withLock(lockPathFor(conversationId, goalId), async () => {
          const existing = await readJobFile(filePath);
          if (existing === null) return null;
          const next: GoalJob = {
            ...existing,
            status,
            updatedAt: ts,
            ...(patch?.note !== undefined ? { note: patch.note.slice(0, 500) } : {}),
            ...(patch?.owner !== undefined ? { owner: patch.owner } : {}),
            ...(patch?.claimedBy !== undefined ? { claimedBy: patch.claimedBy } : {}),
          };
          await writeJobFile(filePath, next);
          return next;
        });
      } catch {
        return null;
      }
    },
  };

  return store;
}

async function listAllJobs(root: string): Promise<GoalJob[]> {
  const jobs: GoalJob[] = [];
  let convDirs: string[] = [];
  try {
    convDirs = await readdir(root);
  } catch {
    return [];
  }
  for (const conv of convDirs) {
    // skip files at root (worker.pid, worker.log)
    const convPath = join(root, conv);
    let names: string[] = [];
    try {
      names = await readdir(convPath);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const job = await readJobFile(join(convPath, name));
      if (job !== null) jobs.push(job);
    }
  }
  return jobs;
}

/**
 * Remove a job file (test / cleanup). Fail-soft.
 */
export async function removeGoalJobFile(
  root: string,
  conversationId: string,
  goalId: string,
): Promise<boolean> {
  try {
    await unlink(goalJobFilePath(root, conversationId, goalId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure jobs root exists. Fail-soft.
 */
export async function ensureGoalJobsRoot(root?: string): Promise<string> {
  const r = root ?? goalJobsRoot();
  try {
    await mkdir(r, { recursive: true });
  } catch {
    /* fail-soft */
  }
  return r;
}

/**
 * Write worker pid file. Fail-soft returns false on error.
 */
export async function writeWorkerPidFile(
  root: string,
  pid: number,
  nowIso?: string,
): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      workerPidFilePath(root),
      serializeWorkerPidFile(pid, nowIso ?? new Date().toISOString()),
      'utf8',
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Read worker pid file. null if missing/corrupt.
 */
export async function readWorkerPid(root: string): Promise<number | null> {
  try {
    const raw = await readFile(workerPidFilePath(root), 'utf8');
    return parseWorkerPidFile(raw);
  } catch {
    return null;
  }
}
