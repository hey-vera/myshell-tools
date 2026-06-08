/**
 * src/infra/goal-store.ts — the I/O layer for the unified goal-lifecycle / to-do
 * subsystem (vision doc .tmp-vision-todos.md §2, Phase 5a).
 *
 * Modeled EXACTLY on src/infra/user-memory-store.ts — the codebase has built
 * this shape twice (conversations + memory); this is the third, reusing the same
 * primitives VERBATIM:
 *   - atomicWrite / withLock (atomic.ts) — the whole-transaction advisory lock
 *   - defaultStateHome() (state-dir.ts) — persistent dir (Replit-aware)
 *   - read-INSIDE-the-lock (RC-4) so two writers can't double-add
 *   - corrupt-index recovery: the per-goal files are authoritative, the index is
 *     a rebuildable cache; on corruption the index is preserved + rebuilt
 *   - the injected Clock (no wall-clock — hermetic tests)
 *   - two-scope deriveProjectKey / resolveProjectKey (re-exported from the memory
 *     store so the goal store shares ONE definition — not a copy)
 *
 * Storage layout under <homeDir>/.myshell-tools/goals/:
 *   index.json          — array of Goal facets, newest-touched first (cache)
 *   index.json.lock     — withLock advisory lock over the whole write transaction
 *   index.json.corrupt  — last corrupt index preserved on recovery
 *   items/<id>.json     — the full Goal, one file per goal, mode 0o600
 *
 * Security (mirrors memory store §10): goal files are 0o600; ids are validated
 * against /^goal_[A-Za-z0-9]+$/ before ANY fs op (path-traversal reject); the
 * project key is the privacy-preserving basename#shorthash (never the raw path).
 *
 * Pure-ish + fail-soft: this module NEVER throws to the caller for an expected
 * miss (a bad id → null/false, a missing index → []); only programmer misuse
 * (an invalid id reaching the internal path builder) throws the guard error,
 * which the public API never triggers.
 */

import { mkdir, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

import type { Clock } from '../core/types.js';
import { atomicWrite, withLock } from './atomic.js';
import { defaultStateHome } from './state-dir.js';
import { deriveProjectKey, resolveProjectKey } from './user-memory-store.js';
import {
  capGoal,
  capRoadmap,
  selectGoals,
  type Goal,
  type GoalScope,
  type GoalState,
} from '../core/goal-todo.js';
import type { RoadmapItem, RoadmapStatus } from '../core/work-contract.js';

// Re-export the two-scope helpers so callers share ONE definition with the
// memory store (the vision doc's "reuse verbatim" — not a second copy).
export { deriveProjectKey, resolveProjectKey };

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getGoalsDir(homeDir: string): string {
  return join(homeDir, '.myshell-tools', 'goals');
}
function getItemsDir(homeDir: string): string {
  return join(getGoalsDir(homeDir), 'items');
}
function getIndexPath(homeDir: string): string {
  return join(getGoalsDir(homeDir), 'index.json');
}
function getCorruptIndexPath(homeDir: string): string {
  return join(getGoalsDir(homeDir), 'index.json.corrupt');
}
function getIndexLockPath(homeDir: string): string {
  return join(getGoalsDir(homeDir), 'index.json.lock');
}

/** Path-traversal guard: only `goal_<alnum>` ids ever touch the filesystem. */
const VALID_ID_RE = /^goal_[A-Za-z0-9]+$/;
function isValidId(id: string): boolean {
  return typeof id === 'string' && VALID_ID_RE.test(id);
}

export class InvalidGoalIdError extends Error {
  constructor(id: string) {
    super(`Invalid goal id (path-traversal reject): ${JSON.stringify(id)}`);
    this.name = 'InvalidGoalIdError';
  }
}

function getItemPath(homeDir: string, id: string): string {
  if (!isValidId(id)) {
    throw new InvalidGoalIdError(id);
  }
  return join(getItemsDir(homeDir), `${id}.json`);
}

// ---------------------------------------------------------------------------
// Index + recovery (the per-goal files are authoritative; index is a cache)
// ---------------------------------------------------------------------------

interface GoalIndex {
  readonly version: 1;
  readonly goals: Goal[];
}

type StoreWarning = (message: string) => void;

type IndexReadResult =
  | { readonly kind: 'ok'; readonly goals: Goal[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'corrupt'; readonly reason: string };

async function ensureDirs(homeDir: string): Promise<void> {
  await mkdir(getItemsDir(homeDir), { recursive: true });
}

async function readIndexFile(homeDir: string): Promise<IndexReadResult> {
  try {
    const raw = await readFile(getIndexPath(homeDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as GoalIndex).goals)) {
      return { kind: 'corrupt', reason: 'index.json missing goals array' };
    }
    // Defensive: cap every row so a hand-edited/partial index can't crash a caller.
    return { kind: 'ok', goals: (parsed as GoalIndex).goals.map(capGoal) };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'corrupt',
      reason: err instanceof SyntaxError ? 'index.json is invalid JSON' : 'index.json is unreadable',
    };
  }
}

/** Newest-touched first (the canonical display order; ties keep insertion order). */
function sortNewestFirst(goals: Goal[]): Goal[] {
  return [...goals].sort((a, b) => (a.lastTouched < b.lastTouched ? 1 : a.lastTouched > b.lastTouched ? -1 : 0));
}

async function writeIndex(homeDir: string, goals: Goal[]): Promise<void> {
  const index: GoalIndex = { version: 1, goals: sortNewestFirst(goals) };
  await atomicWrite(getIndexPath(homeDir), JSON.stringify(index, null, 2), 0o600);
}

async function persistGoal(homeDir: string, goal: Goal): Promise<void> {
  await atomicWrite(getItemPath(homeDir, goal.id), JSON.stringify(goal, null, 2), 0o600);
}

async function readGoalFile(homeDir: string, id: string): Promise<Goal | null> {
  if (!isValidId(id)) return null;
  try {
    const raw = await readFile(getItemPath(homeDir, id), 'utf8');
    return capGoal(JSON.parse(raw) as Goal);
  } catch {
    return null;
  }
}

async function preserveCorruptIndex(homeDir: string): Promise<string> {
  const corruptPath = getCorruptIndexPath(homeDir);
  try {
    await rename(getIndexPath(homeDir), corruptPath);
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code !== 'ENOENT') throw err;
  }
  return corruptPath;
}

/** Rebuild the index from items/*.json (the goal files are authoritative). */
async function rebuildIndexFromItems(homeDir: string): Promise<Goal[]> {
  const dir = getItemsDir(homeDir);
  let files: string[] = [];
  try {
    files = (await readdir(dir, { withFileTypes: true }))
      .filter((d) => d.isFile() && d.name.endsWith('.json'))
      .map((d) => d.name);
  } catch {
    return [];
  }
  const goals: Goal[] = [];
  for (const name of files) {
    const id = name.slice(0, -'.json'.length);
    if (!isValidId(id)) continue;
    try {
      const raw = await readFile(join(dir, name), 'utf8');
      const goal = capGoal(JSON.parse(raw) as Goal);
      if (goal.id.length > 0) goals.push(goal);
    } catch {
      // Best-effort: one corrupt goal file must not block the rest.
    }
  }
  return sortNewestFirst(goals);
}

async function recoverIndex(homeDir: string, reason: string, onWarning?: StoreWarning): Promise<Goal[]> {
  const corruptPath = await preserveCorruptIndex(homeDir);
  const rebuilt = await rebuildIndexFromItems(homeDir);
  await writeIndex(homeDir, rebuilt);
  onWarning?.(
    `Recovered goal index (${reason}); rebuilt ${rebuilt.length} goal(s), preserved original at ${corruptPath}.`,
  );
  return rebuilt;
}

/** Read the index INSIDE the lock (RC-4). Recovers a missing/corrupt index. */
async function readIndexLocked(homeDir: string, onWarning?: StoreWarning): Promise<Goal[]> {
  const result = await readIndexFile(homeDir);
  if (result.kind === 'ok') return result.goals;
  if (result.kind === 'absent') return [];
  return recoverIndex(homeDir, result.reason, onWarning);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** A request to create a new PARKED goal (the only state a goal is born in). */
export interface CreateGoalInput {
  readonly title: string;
  /** The to-dos. Capped to 8 + capped text/status by the store (never throws). */
  readonly roadmap?: readonly RoadmapItem[];
  readonly scope?: GoalScope;
  readonly projectKey?: string | null;
  readonly conversationId?: string | null;
  /** Defaults to `user-explicit` (the only Phase 5a producer). */
  readonly source?: Goal['source'];
}

export interface GoalStore {
  /** Goals, newest-touched first, optionally filtered by state/scope/projectKey. */
  list(filter?: {
    readonly state?: GoalState;
    readonly scope?: GoalScope;
    readonly projectKey?: string | null;
  }): Promise<Goal[]>;
  /** Load one full goal by id (null if missing/invalid). */
  get(id: string): Promise<Goal | null>;
  /** Create a new PARKED goal. Returns the persisted goal. */
  create(input: CreateGoalInput): Promise<Goal>;
  /**
   * Set a goal's lifecycle state (the promote/park flip). Bumps `lastTouched`.
   * Returns the updated goal, or null if the id is unknown.
   *
   * NOTE (owner hard rule): this only records the STATE. It does NOT execute the
   * goal's roadmap. Promotion to `queued`/`running` and the brain re-validation
   * of the (provisional) parked roadmap happen in the interface layer via
   * runGoalLoop — never here. There is deliberately no "run this roadmap" path.
   */
  setState(id: string, state: GoalState): Promise<Goal | null>;
  /**
   * Set the status of roadmap item #index (0-based) of a goal. Bumps
   * `lastTouched`. Returns the updated goal, or null if id/index is unknown.
   * Honesty: callers mark `done` only on real evidence (a manual user check-off
   * or an evidence-backed trace transition) — the store records, never infers.
   */
  setRoadmapItemStatus(id: string, index: number, status: RoadmapStatus): Promise<Goal | null>;
  /** Hard-remove a goal by id (never silent — the caller surfaces it). */
  remove(id: string): Promise<boolean>;
}

export function createFileGoalStore(opts: {
  homeDir?: string;
  clock: Clock;
  onWarning?: StoreWarning;
}): GoalStore {
  const home = opts.homeDir ?? defaultStateHome();
  const { clock } = opts;
  const onWarning = opts.onWarning;

  function mintId(): string {
    const raw = clock.uuid().replace(/[^A-Za-z0-9]/g, '');
    return `goal_${raw.length > 0 ? raw : '0'}`;
  }

  return {
    async list(filter): Promise<Goal[]> {
      await ensureDirs(home);
      const goals = await withLock(getIndexLockPath(home), async () => readIndexLocked(home, onWarning));
      return selectGoals(goals, filter);
    },

    async get(id): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      return readGoalFile(home, id);
    },

    async create(input): Promise<Goal> {
      await ensureDirs(home);
      const scope: GoalScope = input.scope ?? 'project';
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const now = clock.isoNow();
        const goal: Goal = capGoal({
          version: 1,
          id: mintId(),
          title: input.title,
          state: 'parked', // a goal is ALWAYS born parked (vision doc §1)
          source: input.source ?? 'user-explicit',
          roadmap: capRoadmap(input.roadmap),
          scope,
          projectKey: scope === 'project' ? (input.projectKey ?? null) : null,
          conversationId: input.conversationId ?? null,
          createdAt: now,
          lastTouched: now,
        });
        await persistGoal(home, goal);
        await writeIndex(home, [...goals, goal]);
        return goal;
      });
    },

    async setState(id, state): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return null;
        const updated = capGoal({ ...target, state, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(home, goals.map((g) => (g.id === id ? updated : g)));
        return updated;
      });
    },

    async setRoadmapItemStatus(id, index, status): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return null;
        if (index < 0 || index >= target.roadmap.length) return null;
        const nextRoadmap = target.roadmap.map((item, i) =>
          i === index ? { ...item, status } : item,
        );
        const updated = capGoal({ ...target, roadmap: nextRoadmap, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(home, goals.map((g) => (g.id === id ? updated : g)));
        return updated;
      });
    },

    async remove(id): Promise<boolean> {
      if (!isValidId(id)) return false;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const present = goals.some((g) => g.id === id);
        try {
          await unlink(getItemPath(home, id));
        } catch {
          // already gone — still purge from the index below
        }
        const next = goals.filter((g) => g.id !== id);
        if (next.length === goals.length && !present) return false;
        await writeIndex(home, next);
        return true;
      });
    },
  };
}
