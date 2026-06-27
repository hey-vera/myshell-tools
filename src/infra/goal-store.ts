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
  ROADMAP_LIMIT,
  capGoal,
  capRoadmap,
  cascadeTerminate,
  selectGoals,
  type Goal,
  type GoalScope,
  type GoalState,
  type GoalVerdict,
} from '../core/goal-todo.js';
import {
  capRoadmapItem,
  type RoadmapItem,
  type RoadmapItemApproach,
  type RoadmapItemVerdict,
  type RoadmapStatus,
} from '../core/work-contract.js';

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
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as GoalIndex).goals)
    ) {
      return { kind: 'corrupt', reason: 'index.json missing goals array' };
    }
    // Defensive: cap every row so a hand-edited/partial index can't crash a caller.
    return { kind: 'ok', goals: (parsed as GoalIndex).goals.map(capGoal) };
  } catch (err) {
    const nodeErr = err as NodeJS.ErrnoException;
    if (nodeErr.code === 'ENOENT') return { kind: 'absent' };
    return {
      kind: 'corrupt',
      reason:
        err instanceof SyntaxError ? 'index.json is invalid JSON' : 'index.json is unreadable',
    };
  }
}

/** Newest-touched first (the canonical display order; ties keep insertion order). */
function sortNewestFirst(goals: Goal[]): Goal[] {
  return [...goals].sort((a, b) =>
    a.lastTouched < b.lastTouched ? 1 : a.lastTouched > b.lastTouched ? -1 : 0,
  );
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

async function recoverIndex(
  homeDir: string,
  reason: string,
  onWarning?: StoreWarning,
): Promise<Goal[]> {
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
  /**
   * The best-approach the manager-tier planner stated for this goal (chosen +
   * why). Additive + optional (mirrors the roadmap/source fields): absent ⇒ the
   * goal is created with no approach and round-trips byte-identically. Capped
   * defensively by capGoal (chosen/rationale required, else omitted entirely).
   */
  readonly approach?: Goal['approach'];
  /**
   * The goal's classified CATEGORY (security/infra/…), set at staging so the
   * STANDING-RULES launch gate (Phase 4) can fire a category-keyed rule. Additive +
   * optional (mirrors `approach`): absent ⇒ capGoal omits it ⇒ byte-identical.
   */
  readonly category?: Goal['category'];
  /** Free-form goal tags (forward-compatible). Additive + optional; capped by capGoal. */
  readonly tags?: Goal['tags'];
  /**
   * GOAL-LEVEL parent (Phase 4a) — the id of the goal this one was decomposed out
   * of. Additive + optional (mirrors `approach`/`tags`): absent ⇒ a root goal that
   * round-trips byte-identically. capGoal validates the id format + rejects a
   * self-parent, omitting an invalid value entirely. SEPARATE from a RoadmapItem's
   * within-goal `parentId`.
   */
  readonly parentGoalId?: Goal['parentGoalId'];
  readonly intentVersionId?: string;
}

/** A batch patch for a goal's roadmap. All operations run on the same in-memory array. */
interface RoadmapPatch {
  readonly add?: readonly RoadmapItem[];
  readonly edit?: readonly { readonly itemId: string; readonly patch: RoadmapItemPatch }[];
  readonly remove?: readonly string[];
  readonly reorder?: readonly string[];
}

/** A patch for a goal's scalar fields + an optional roadmap batch patch. */
export interface GoalPatch {
  readonly title?: string;
  readonly state?: GoalState;
  readonly approach?: RoadmapItemApproach;
  readonly tags?: readonly string[];
  /**
   * GOAL-LEVEL parent (Phase 4a). A string SETS the parent (capGoal validates the
   * id format + rejects a self-parent on round-trip); `null` CLEARS it (re-roots the
   * goal). Omitted ⇒ the existing parent is preserved. SEPARATE from a RoadmapItem's
   * within-goal `parentId` (patched via `roadmapPatch.edit`).
   */
  readonly parentGoalId?: string | null;
  readonly roadmapPatch?: RoadmapPatch;
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
   * Patch a goal's scalar fields and/or roadmap in one atomic transaction.
   * Bumps `lastTouched`. Returns the updated goal, or null if the id is unknown.
   * The roadmap patch applies edit → add → remove → reorder on a single in-memory
   * array, then the whole goal is capped and persisted. Verified-done items and
   * depended-on items are retained during remove (same honesty rules as
   * removeRoadmapItem).
   */
  patchGoal(id: string, patch: GoalPatch): Promise<Goal | null>;
  /**
   * Record the goal-level evidence-backed verdict (Elite-partner Part 3, the
   * anti-fabrication backbone). Bumps `lastTouched`. Returns the updated goal, or
   * null if the id is unknown.
   *
   * HARD anti-fabrication rule (the honesty boundary is sacred): this is the ONLY
   * write path for `goalVerdict`, and the value persisted is EXACTLY what the caller
   * passes — a verdict the caller computed from a REAL {@link VerifyOutcome} (a real
   * git-diff + the project's own test run). The store NEVER infers, defaults, or
   * upgrades a verdict; `setState` and the roadmap-CRUD methods deliberately have NO
   * verdict-write path, so a model's GOAL_COMPLETE claim can never reach this field
   * except as a real, evidence-backed verdict the verify phase produced. The verdict
   * is capped defensively by capGoal (an invalid state is omitted, never green-washed).
   */
  setGoalVerdict(id: string, verdict: GoalVerdict): Promise<Goal | null>;
  /**
   * Record the evidence-backed verdict for ONE to-do, keyed by RoadmapItem.id
   * (never array index). Bumps `lastTouched`. Returns the updated goal, or null
   * if id/itemId is unknown.
   *
   * HARD anti-fabrication rule (the honesty boundary is sacred): this is the ONLY
   * write path for a RoadmapItem's `verdict`, and the value persisted is EXACTLY
   * what the caller passes — a verdict the caller computed from a REAL
   * {@link VerifyOutcome} (a real git-diff + the project's own test run). It
   * mirrors setGoalVerdict exactly one level down: `setRoadmapItemStatus`,
   * `updateRoadmapItem`, `addRoadmapItem`, and `reorderRoadmap` all deliberately
   * have NO per-item verdict-write path, so a model's claim can never reach this
   * field except as a real, evidence-backed verdict the verify phase produced.
   * capRoadmapItem caps/omits an invalid state (never green-washed) on round-trip.
   */
  setRoadmapItemVerdict(
    id: string,
    itemId: string,
    verdict: RoadmapItemVerdict,
  ): Promise<Goal | null>;
  /**
   * Set the status of roadmap item #index (0-based) of a goal. Bumps
   * `lastTouched`. Returns the updated goal, or null if id/index is unknown.
   * Honesty: callers mark `done` only on real evidence (a manual user check-off
   * or an evidence-backed trace transition) — the store records, never infers.
   */
  setRoadmapItemStatus(id: string, index: number, status: RoadmapStatus): Promise<Goal | null>;
  /**
   * Insert a new to-do (RoadmapItem) into a goal's roadmap. Bumps `lastTouched`.
   * `atIndex` (0-based, clamped) chooses the insertion point; omitted = append.
   * The item is capped via capRoadmapItem (text/status/optional fields). The
   * roadmap cap (ROADMAP_LIMIT=8) is honoured: a full roadmap is a no-op that
   * returns `{ ok: false, reason: 'full', goal }` so the caller can surface a
   * clear "split into a child goal" message. Unknown id → `{ ok: false,
   * reason: 'unknown-goal' }`. Keyed by RoadmapItem.id, never array index, so a
   * later reorder/insert never orphans an existing item's identity.
   */
  addRoadmapItem(id: string, item: RoadmapItem, atIndex?: number): Promise<AddRoadmapItemResult>;
  /**
   * Patch one to-do's editable fields (text / acceptanceCriterion / approach),
   * keyed by RoadmapItem.id (never array index). Bumps `lastTouched`. Returns the
   * updated goal, or null if id/itemId is unknown.
   *
   * HARD anti-fabrication rule: this NEVER writes `verdict` — verdicts are
   * evidence-only, written exclusively by the later verify phase. A `verdict`
   * key on the patch is ignored.
   */
  updateRoadmapItem(id: string, itemId: string, patch: RoadmapItemPatch): Promise<Goal | null>;
  /**
   * Reorder a goal's roadmap by an ordered list of RoadmapItem.ids. Defensive:
   * unknown ids are ignored; any existing item whose id is omitted is kept, in
   * its original relative order, AFTER the listed ones (no item is ever dropped
   * by a reorder). Bumps `lastTouched`. Returns the updated goal, or null if the
   * id is unknown.
   */
  reorderRoadmap(id: string, orderedItemIds: readonly string[]): Promise<Goal | null>;
  /**
   * Remove one to-do by RoadmapItem.id (never array index). Bumps `lastTouched`.
   *
   * AUDIT-TRAIL honesty: a verified-done item (verdict.state ∈ {passing,
   * reviewed}) is NOT hard-deleted — the record of real, verified work must
   * survive plan edits. Such an item is RETAINED (kept in place); the method
   * returns `{ ok: false, reason: 'retained-verified', goal }`. A non-verified
   * item (no verdict, or verdict.state ∈ {unverified, failing}) is removed
   * normally → `{ ok: true, goal }`. Unknown id/itemId → `{ ok: false,
   * reason: 'unknown' }`.
   *
   * DEPENDENCY-SAFETY: a to-do that another to-do still lists in its `dependsOn`
   * is NOT removed (it would orphan a live dependency edge) — the method returns
   * `{ ok: false, reason: 'depended-on', goal }` so the caller can re-point or
   * clear the edge first. Mirrors the retained-verified guard.
   */
  removeRoadmapItem(id: string, itemId: string): Promise<RemoveRoadmapItemResult>;
  /** Hard-remove a goal by id (never silent — the caller surfaces it). */
  remove(id: string): Promise<boolean>;
  /**
   * Cancel a whole goal TREE (Phase 4b): set `rootId` and all its transitive
   * descendants (via `parentGoalId`) that are CURRENTLY non-terminal
   * (parked|queued|running) to 'failed' in ONE atomic write transaction. Bumps
   * `lastTouched` on each goal it flips. Returns the ids it terminated.
   *
   * HONESTY (mirrors the `blocked-item` precedent): a descendant already 'done'
   * is PRESERVED — verified work is NEVER overwritten — and one already 'failed'
   * is left untouched (no-op). The terminal is always 'failed' because there is
   * no `cancelled` state (owner hard rule). Fail-soft: an unknown/invalid root
   * yields `{ terminated: [] }` (nothing changed). The plan is computed purely by
   * {@link cascadeTerminate}; this method only applies + persists it.
   */
  cancelGoalTree(rootId: string): Promise<{ readonly terminated: readonly string[] }>;
}

/** The fields a caller may patch on a to-do — NEVER `verdict` (verify-only). */
export interface RoadmapItemPatch {
  readonly text?: string;
  readonly acceptanceCriterion?: string;
  readonly approach?: RoadmapItem['approach'];
  /** Set the dependency edges; relational guards re-run on round-trip (capGoal). */
  readonly dependsOn?: readonly string[];
  /** Set the 1-level grouping parent; depth/cycle guard re-runs on round-trip. */
  readonly parentId?: string;
}

/** Result of {@link GoalStore.addRoadmapItem}. */
export type AddRoadmapItemResult =
  | { readonly ok: true; readonly goal: Goal }
  | { readonly ok: false; readonly reason: 'unknown-goal' }
  | { readonly ok: false; readonly reason: 'full'; readonly goal: Goal };

/** Result of {@link GoalStore.removeRoadmapItem}. */
export type RemoveRoadmapItemResult =
  | { readonly ok: true; readonly goal: Goal }
  | { readonly ok: false; readonly reason: 'unknown' }
  | { readonly ok: false; readonly reason: 'retained-verified'; readonly goal: Goal }
  | { readonly ok: false; readonly reason: 'depended-on'; readonly goal: Goal };

/** A verdict that marks an item as real, verified, completed work (audit-trail). */
function isVerifiedDone(item: RoadmapItem): boolean {
  return item.verdict?.state === 'passing' || item.verdict?.state === 'reviewed';
}

/** True when some OTHER item in the roadmap lists `itemId` in its dependsOn. */
function isDependedOnByOthers(roadmap: readonly RoadmapItem[], itemId: string): boolean {
  return roadmap.some((it) => it.id !== itemId && (it.dependsOn ?? []).includes(itemId));
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
      const goals = await withLock(getIndexLockPath(home), async () =>
        readIndexLocked(home, onWarning),
      );
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
          // Additive: capGoal omits a malformed/absent approach, so a create
          // WITHOUT one round-trips byte-identically to before this field existed.
          ...(input.approach !== undefined ? { approach: input.approach } : {}),
          // Additive: capGoal omits an absent/empty category|tags, so a create
          // WITHOUT them round-trips byte-identically to before these fields existed.
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          // Additive: capGoal validates the id format + rejects a self-parent, so a
          // create WITHOUT a parent round-trips byte-identically to before.
          ...(input.parentGoalId !== undefined ? { parentGoalId: input.parentGoalId } : {}),
          ...(input.intentVersionId !== undefined ? { intentVersionId: input.intentVersionId } : {}),
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
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return updated;
      });
    },

    async patchGoal(id, patch): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return null;

        // Work on a mutable copy of the roadmap so all roadmapPatch steps compose
        // on one array before capping.
        let roadmap: RoadmapItem[] = [...target.roadmap];
        if (patch.roadmapPatch !== undefined) {
          const { add, edit, remove, reorder } = patch.roadmapPatch;

          // 1. Edit existing items keyed by itemId (verdict and other fields are preserved).
          if (edit !== undefined) {
            for (const { itemId, patch: itemPatch } of edit) {
              const idx = roadmap.findIndex((it) => it.id === itemId);
              if (idx === -1) continue;
              roadmap[idx] = {
                ...roadmap[idx],
                ...(itemPatch.text !== undefined ? { text: itemPatch.text } : {}),
                ...(itemPatch.acceptanceCriterion !== undefined
                  ? { acceptanceCriterion: itemPatch.acceptanceCriterion }
                  : {}),
                ...(itemPatch.approach !== undefined ? { approach: itemPatch.approach } : {}),
                ...(itemPatch.dependsOn !== undefined
                  ? { dependsOn: [...itemPatch.dependsOn] }
                  : {}),
                ...(itemPatch.parentId !== undefined ? { parentId: itemPatch.parentId } : {}),
              } as RoadmapItem;
            }
          }

          // 2. Append new items (capped), dropping extras beyond ROADMAP_LIMIT and
          // skipping ids that already exist.
          if (add !== undefined) {
            for (const item of add) {
              if (roadmap.length >= ROADMAP_LIMIT) break;
              const capped = capRoadmapItem(item);
              if (roadmap.some((it) => it.id === capped.id)) continue;
              roadmap.push(capped);
            }
          }

          // 3. Remove requested items, retaining verified-done and depended-on ones.
          if (remove !== undefined) {
            const idsToRemove = new Set(remove);
            roadmap = roadmap.filter((it) => {
              if (!idsToRemove.has(it.id)) return true;
              if (isVerifiedDone(it)) return true; // audit-trail honesty
              if (isDependedOnByOthers(roadmap, it.id)) return true; // dependency safety
              return false;
            });
          }

          // 4. Reorder by listed ids; omitted ids stay at the end in original order.
          if (reorder !== undefined) {
            const byId = new Map(roadmap.map((it) => [it.id, it]));
            const seen = new Set<string>();
            const ordered: RoadmapItem[] = [];
            for (const wantedId of reorder) {
              const it = byId.get(wantedId);
              if (it !== undefined && !seen.has(wantedId)) {
                ordered.push(it);
                seen.add(wantedId);
              }
            }
            for (const it of roadmap) {
              if (!seen.has(it.id)) ordered.push(it);
            }
            roadmap = ordered;
          }
        }

        // GOAL-LEVEL parent: a string sets it (capGoal validates), `null` clears it
        // (omit from the spread so the field is dropped), omitted preserves it.
        const { parentGoalId: _existingParent, ...targetSansParent } = target;
        const parentSpread =
          patch.parentGoalId === undefined
            ? _existingParent !== undefined
              ? { parentGoalId: _existingParent }
              : {}
            : patch.parentGoalId === null
              ? {}
              : { parentGoalId: patch.parentGoalId };

        const updated = capGoal({
          ...targetSansParent,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.state !== undefined ? { state: patch.state } : {}),
          ...(patch.approach !== undefined ? { approach: patch.approach } : {}),
          ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
          ...parentSpread,
          roadmap,
          lastTouched: clock.isoNow(),
        });
        await persistGoal(home, updated);
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return updated;
      });
    },

    async setGoalVerdict(id, verdict): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return null;
        // The ONLY write path for goalVerdict. The value is EXACTLY the caller's
        // (computed from a real VerifyOutcome); capGoal omits an invalid state so a
        // malformed verdict can never green-wash — the honesty boundary survives the
        // round-trip. lastTouched bumps so the board reflects the verdict immediately.
        const updated = capGoal({ ...target, goalVerdict: verdict, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return updated;
      });
    },

    async setRoadmapItemVerdict(id, itemId, verdict): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return null;
        if (!target.roadmap.some((it) => it.id === itemId)) return null;
        // The ONLY per-item verdict write path. The value is EXACTLY the caller's
        // (computed from a real VerifyOutcome); capRoadmapItem omits an invalid
        // state so a malformed verdict can never green-wash — the honesty boundary
        // survives the round-trip. Keyed by RoadmapItem.id, never array index.
        const nextRoadmap = target.roadmap.map((it) =>
          it.id === itemId ? { ...it, verdict } : it,
        );
        const updated = capGoal({ ...target, roadmap: nextRoadmap, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
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
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return updated;
      });
    },

    async addRoadmapItem(id, item, atIndex): Promise<AddRoadmapItemResult> {
      if (!isValidId(id)) return { ok: false, reason: 'unknown-goal' };
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return { ok: false, reason: 'unknown-goal' };
        const capped = capRoadmapItem(item);
        if (target.roadmap.some((it) => it.id === capped.id)) {
          return { ok: true, goal: target };
        }
        if (target.roadmap.length >= ROADMAP_LIMIT) {
          // Cap-full: no-op, but report it so the caller can split into a child
          // goal (the architecture's cap-8⇒sub-goal escape, Part 4).
          return { ok: false, reason: 'full', goal: target };
        }
        const at =
          typeof atIndex === 'number' && Number.isFinite(atIndex)
            ? Math.max(0, Math.min(Math.floor(atIndex), target.roadmap.length))
            : target.roadmap.length;
        const nextRoadmap = [...target.roadmap.slice(0, at), capped, ...target.roadmap.slice(at)];
        const updated = capGoal({ ...target, roadmap: nextRoadmap, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return { ok: true, goal: updated };
      });
    },

    async updateRoadmapItem(id, itemId, patch): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return null;
        if (!target.roadmap.some((it) => it.id === itemId)) return null;
        const nextRoadmap = target.roadmap.map((it) => {
          if (it.id !== itemId) return it;
          // Patch ONLY the editable fields. `verdict` is deliberately NOT in the
          // patch shape and is preserved verbatim from the existing item — there
          // is no verdict-write path here (anti-fabrication; verify phase owns it).
          return {
            ...it,
            ...(patch.text !== undefined ? { text: patch.text } : {}),
            ...(patch.acceptanceCriterion !== undefined
              ? { acceptanceCriterion: patch.acceptanceCriterion }
              : {}),
            ...(patch.approach !== undefined ? { approach: patch.approach } : {}),
            // The two structural fields. The raw value is set here; the relational
            // guards (sibling-existence/cycle/depth) re-run via capGoal → capRoadmap
            // → normalizeRoadmapRelations on the round-trip below, so a dangling or
            // cyclic edge can never persist.
            ...(patch.dependsOn !== undefined ? { dependsOn: [...patch.dependsOn] } : {}),
            ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
          };
        });
        const updated = capGoal({ ...target, roadmap: nextRoadmap, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return updated;
      });
    },

    async reorderRoadmap(id, orderedItemIds): Promise<Goal | null> {
      if (!isValidId(id)) return null;
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return null;
        const byId = new Map(target.roadmap.map((it) => [it.id, it]));
        const seen = new Set<string>();
        const ordered: RoadmapItem[] = [];
        // Listed ids first (ignore unknown / duplicate ids — defensive).
        for (const wantedId of orderedItemIds) {
          const it = byId.get(wantedId);
          if (it !== undefined && !seen.has(wantedId)) {
            ordered.push(it);
            seen.add(wantedId);
          }
        }
        // Any omitted item is kept, in its original relative order, at the end —
        // a reorder NEVER drops an existing to-do.
        for (const it of target.roadmap) {
          if (!seen.has(it.id)) ordered.push(it);
        }
        const updated = capGoal({ ...target, roadmap: ordered, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return updated;
      });
    },

    async removeRoadmapItem(id, itemId): Promise<RemoveRoadmapItemResult> {
      if (!isValidId(id)) return { ok: false, reason: 'unknown' };
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        const target = goals.find((g) => g.id === id);
        if (target === undefined) return { ok: false, reason: 'unknown' };
        const item = target.roadmap.find((it) => it.id === itemId);
        if (item === undefined) return { ok: false, reason: 'unknown' };
        if (isVerifiedDone(item)) {
          // Audit-trail honesty: a verified-done to-do is RETAINED (the record of
          // real verified work survives plan edits) — never hard-deleted here.
          return { ok: false, reason: 'retained-verified', goal: target };
        }
        if (isDependedOnByOthers(target.roadmap, itemId)) {
          // Dependency-safety: removing this would orphan another item's dependsOn
          // edge. Refuse so the caller clears/re-points the edge first.
          return { ok: false, reason: 'depended-on', goal: target };
        }
        const nextRoadmap = target.roadmap.filter((it) => it.id !== itemId);
        const updated = capGoal({ ...target, roadmap: nextRoadmap, lastTouched: clock.isoNow() });
        await persistGoal(home, updated);
        await writeIndex(
          home,
          goals.map((g) => (g.id === id ? updated : g)),
        );
        return { ok: true, goal: updated };
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

    async cancelGoalTree(rootId): Promise<{ readonly terminated: readonly string[] }> {
      // Fail-soft on an invalid id (path-traversal guard) — nothing to cancel.
      if (!isValidId(rootId)) return { terminated: [] };
      await ensureDirs(home);
      return withLock(getIndexLockPath(home), async () => {
        const goals = await readIndexLocked(home, onWarning);
        // PURE plan: root + transitive non-terminal descendants → 'failed'. A 'done'
        // descendant is excluded (verified work preserved); 'failed' is a no-op.
        const plan = cascadeTerminate(goals, rootId, 'failed');
        if (plan.length === 0) return { terminated: [] }; // unknown root / nothing live
        const now = clock.isoNow();
        const stateById = new Map(plan.map((t) => [t.id, t.state]));
        // Apply to the in-memory set, persisting each flipped goal's own file, then
        // write the index ONCE — the same atomic read-inside-lock / rebuildable-index
        // model the other mutators use.
        const nextGoals = goals.map((g) => {
          const newState = stateById.get(g.id);
          if (newState === undefined) return g;
          return capGoal({ ...g, state: newState, lastTouched: now });
        });
        for (const g of nextGoals) {
          if (stateById.has(g.id)) await persistGoal(home, g);
        }
        await writeIndex(home, nextGoals);
        return { terminated: plan.map((t) => t.id) };
      });
    },
  };
}
