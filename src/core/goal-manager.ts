/**
 * src/core/goal-manager.ts — the PURE decision core for the PER-GOAL MANAGER
 * CYCLE (elite-partner Part 7, orchestration Shape C). This module makes the
 * cycle's DECISIONS; all I/O (worker turns, verification, persistence, the board)
 * stays in menu.ts. Everything here is pure, table-testable, and never throws.
 *
 * The cycle (driven by menu.ts when the manager flag is ON and the goal has a
 * real roadmap): pickNextTodo → buildTodoTask → ONE worker turn → a REAL
 * tests-only verification → per-item verdict (evidence-only) → mark done when
 * passing/reviewed, else spawn a bounded fixItTodo. When managerCycleComplete is
 * true, the goal-level verified-done gate runs before the goal can settle `done`.
 *
 * HONESTY BOUNDARY (sacred): nothing here ever fabricates a verdict. A to-do is
 * "verified done" ONLY when its persisted verdict.state ∈ {passing, reviewed}
 * (the same bar isGoalVerifiedDone enforces). pickNextTodo and
 * managerCycleComplete read verdict + status; they never set them.
 */

import type { RoadmapItem } from './work-contract.js';

// ---------------------------------------------------------------------------
// The verified-done bar (item level) — mirrors isGoalVerifiedDone (goal-todo.ts)
// ---------------------------------------------------------------------------

/**
 * Whether ONE to-do counts as VERIFIED DONE: it carries a REAL verdict whose
 * state is `passing` (the project's own tests ran green) or `reviewed` (a critic
 * looked — weaker but real). `failing`, `unverified`, or NO verdict at all do NOT
 * qualify — the to-do still needs work. Pure, total. This is the SOLE definition
 * of item-completeness the cycle uses; a `done` status without a verdict never
 * passes this bar (the status is set BY the cycle only after this returns true,
 * so the two stay consistent).
 */
export function isTodoVerifiedDone(item: RoadmapItem): boolean {
  const state = item.verdict?.state;
  return state === 'passing' || state === 'reviewed';
}

// ---------------------------------------------------------------------------
// Dependency / grouping helpers (additive — neutral when the fields are absent)
// ---------------------------------------------------------------------------

/** The set of item ids that are used as a GROUP HEADER (some sibling's parentId). */
function parentHeaderIds(roadmap: readonly RoadmapItem[]): ReadonlySet<string> {
  const headers = new Set<string>();
  for (const it of roadmap) {
    if (it.parentId !== undefined && it.parentId.length > 0) headers.add(it.parentId);
  }
  return headers;
}

/**
 * Whether an item is a PURE parent header — it groups children (some sibling
 * names it as `parentId`) and is therefore NOT directly worker-actionable: its
 * completion is COMPUTED from its children's verdicts (parent rollup), never
 * worked or verified on its own. With no grouping in play this is always false,
 * so the linear march is unchanged.
 */
function isPureParentHeader(item: RoadmapItem, headers: ReadonlySet<string>): boolean {
  return headers.has(item.id);
}

/**
 * Whether every dependency of an item is verified-done. An item with no
 * `dependsOn` (the default) is trivially ready — so the linear march is exactly
 * preserved. An unknown dep id can never appear here (capRoadmapItem +
 * normalizeRoadmapRelations strip them), but we are defensive: a dep id with no
 * matching item is treated as UNSATISFIED (it can never become verified-done, so
 * the item correctly stays blocked rather than silently advancing).
 */
function dependenciesSatisfied(
  item: RoadmapItem,
  byId: ReadonlyMap<string, RoadmapItem>,
): boolean {
  const deps = item.dependsOn;
  if (deps === undefined || deps.length === 0) return true;
  for (const depId of deps) {
    const dep = byId.get(depId);
    if (dep === undefined) return false; // dangling dep → not satisfiable → blocked
    if (!isTodoVerifiedDone(dep)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// pickNextTodo — the next actionable item
// ---------------------------------------------------------------------------

/**
 * The next to-do the cycle should work, or `null` when every item is verified
 * done (⇒ the goal is ready for the goal-level acceptance check). "Actionable" =
 * NOT verified-done AND NOT blocked (a blocked item needs user input, not a
 * worker turn — the cycle skips it so it can't spin). Items are considered in
 * roadmap order, so the plan executes top-to-bottom. Pure, total: an empty or
 * all-done roadmap returns null; a roadmap with only blocked-but-unverified
 * items also returns null (nothing the cycle can advance on its own).
 */
export function pickNextTodo(roadmap: readonly RoadmapItem[]): RoadmapItem | null {
  const byId = new Map(roadmap.map((it) => [it.id, it]));
  const headers = parentHeaderIds(roadmap);
  for (const item of roadmap) {
    if (isTodoVerifiedDone(item)) continue; // already real, verified work
    if (item.status === 'blocked') continue; // needs input — not worker-actionable
    if (isPureParentHeader(item, headers)) continue; // rollup-only, never worked directly
    if (!dependenciesSatisfied(item, byId)) continue; // a blocker is not yet verified-done
    return item;
  }
  return null;
}

/**
 * ALL currently-unblocked actionable items, in roadmap order — the same per-item
 * gate as {@link pickNextTodo} but returning EVERY ready item instead of just the
 * first. This is the pure substrate for a FUTURE parallel-execution phase (work
 * several independent ready items at once); it is deliberately NOT wired into the
 * cycle yet. Pure, total, never throws. With no dependencies/grouping it returns
 * every not-done, not-blocked item (the whole remaining linear plan).
 */
export function pickReadyTodos(roadmap: readonly RoadmapItem[]): RoadmapItem[] {
  const byId = new Map(roadmap.map((it) => [it.id, it]));
  const headers = parentHeaderIds(roadmap);
  const ready: RoadmapItem[] = [];
  for (const item of roadmap) {
    if (isTodoVerifiedDone(item)) continue;
    if (item.status === 'blocked') continue;
    if (isPureParentHeader(item, headers)) continue;
    if (!dependenciesSatisfied(item, byId)) continue;
    ready.push(item);
  }
  return ready;
}

// ---------------------------------------------------------------------------
// itemBlockReason — WHY an item is blocked (pure, derived from existing fields)
// ---------------------------------------------------------------------------

/**
 * The text marker an item carries when it was parked awaiting an OWNER answer
 * (a clarify / fork). Reuses the same `Fix:`-style note convention `fixItTodo`
 * uses (a human-readable prefix in the item `text`) — NO new field. A blocked
 * item whose text starts with this marker is "waiting on a person", not on a
 * dependency or a self-heal cap.
 */
const CLARIFY_PREFIX = 'Clarify: ';

/**
 * Why an item is blocked, or `null` when it is NOT blocked — centralizing A.1's
 * definition so honest surfacing and the cross-goal demand count read one source
 * of truth. Derived ENTIRELY from existing fields (`status`, `dependsOn`, and the
 * `Fix:`/`Clarify:` text-marker convention); adds NO new state. Pure, total,
 * never throws.
 *
 * Precedence (most specific first):
 *  - `'dependency'` — an unmet `dependsOn` (a blocker that is not yet
 *    verified-done, or a dangling dep id). This holds REGARDLESS of status: an
 *    item with an unmet dependency is not actionable even while `pending`, which
 *    is exactly what `pickNextTodo` skips (goal-manager.ts:105).
 *  - `'clarify'` — `status === 'blocked'` AND the item text carries the
 *    `Clarify:` marker (parked awaiting an owner answer — the fork case A.2).
 *  - `'unverifiable'` — `status === 'blocked'` after self-heal is exhausted: a
 *    fix-it item (its id encodes a `fixN` depth ≥ 1) that is itself blocked. This
 *    is the "fix-it depth cap was hit and the cycle parked it" case
 *    (goal-manager.ts:279-281, menu.ts blocked-on-failure path).
 *  - `null` — not blocked: every dependency satisfied AND status is not blocked.
 *
 * Note: a plain `status === 'blocked'` item with no clarify marker and no fix-it
 * depth still reports `'unverifiable'` (it was parked by the cycle on a failure
 * it could not self-heal) — the catch-all blocked reason, never `null`.
 */
export function itemBlockReason(
  item: RoadmapItem,
  byId: ReadonlyMap<string, RoadmapItem>,
): 'dependency' | 'clarify' | 'unverifiable' | null {
  // An unmet dependency dominates: the item cannot be worked until its blocker is
  // verified-done, whatever its own status says.
  if (!dependenciesSatisfied(item, byId)) return 'dependency';
  // Past here, all dependencies are satisfied — the only remaining block is the
  // item's own `blocked` status (a clarify park or an unverifiable self-heal).
  if (item.status !== 'blocked') return null;
  const text = typeof item.text === 'string' ? item.text : '';
  if (text.startsWith(CLARIFY_PREFIX)) return 'clarify';
  return 'unverifiable';
}

// ---------------------------------------------------------------------------
// managerCycleComplete — every item verified done
// ---------------------------------------------------------------------------

/**
 * True when EVERY roadmap item is verified-done (verdict.state ∈
 * {passing,reviewed}) — i.e. the goal is ready for the goal-level acceptance
 * check (Part 3). An empty roadmap is NOT complete (there is nothing verified,
 * and the manager cycle only runs for goals that HAVE a roadmap — an empty one
 * means "no plan to drive", handled by the caller, never reported done here).
 * One unverified/failing/blocked item ⇒ false. Pure, total, never throws.
 */
export function managerCycleComplete(goal: { readonly roadmap: readonly RoadmapItem[] }): boolean {
  const roadmap = goal.roadmap;
  if (roadmap.length === 0) return false;
  const headers = parentHeaderIds(roadmap);
  // A pure parent header carries no verdict of its own — its completion is
  // ROLLED UP (computed) from its real children's verdicts. We never fabricate a
  // verdict on the parent: a header is "done" iff every child is verified-done.
  const childrenOf = new Map<string, RoadmapItem[]>();
  if (headers.size > 0) {
    for (const it of roadmap) {
      if (it.parentId !== undefined && headers.has(it.parentId)) {
        const list = childrenOf.get(it.parentId) ?? [];
        list.push(it);
        childrenOf.set(it.parentId, list);
      }
    }
  }
  return roadmap.every((item) => {
    if (isPureParentHeader(item, headers)) {
      const children = childrenOf.get(item.id) ?? [];
      // A header with no surviving children rolls up as done (nothing left to do
      // under it); otherwise every child must be verified-done.
      return children.every(isTodoVerifiedDone);
    }
    return isTodoVerifiedDone(item);
  });
}

// ---------------------------------------------------------------------------
// buildTodoTask — the worker task scoped to ONE to-do
// ---------------------------------------------------------------------------

const TASK_TODO_LIMIT = 400;
const TASK_CRITERION_LIMIT = 400;
const TASK_VISION_LIMIT = 400;

function clip(value: string, limit: number): string {
  const s = typeof value === 'string' ? value : '';
  return s.length > limit ? s.slice(0, limit) : s;
}

/**
 * The worker task string scoped to ONE to-do, reusing buildGoalTask's
 * conventions (a clear header, the goal's vision for context, then the single
 * concrete step + its checkable definition of done). The worker is told to do
 * EXACTLY this to-do — not the whole goal — so the cycle advances one verified
 * step at a time. The acceptanceCriterion (when present) is surfaced verbatim so
 * the worker knows the bar; the goal's vision/title grounds the step in the
 * larger objective. Pure, total: missing fields degrade to a still-coherent task
 * (the to-do text alone is always enough). Never throws.
 *
 * `goal.title` is the goal's objective; `goal.goalAcceptance` (when set) is the
 * goal-level definition of done, included as vision context.
 */
export function buildTodoTask(
  goal: { readonly title: string; readonly goalAcceptance?: string },
  item: RoadmapItem,
): string {
  const todoText = clip(item.text ?? '', TASK_TODO_LIMIT);
  const criterion =
    item.acceptanceCriterion !== undefined
      ? clip(item.acceptanceCriterion, TASK_CRITERION_LIMIT)
      : '';
  const vision =
    goal.goalAcceptance !== undefined ? clip(goal.goalAcceptance, TASK_VISION_LIMIT) : '';
  const title = clip(goal.title ?? '', TASK_VISION_LIMIT);

  const lines: string[] = [`Goal: ${title}`];
  if (vision.length > 0) {
    lines.push('', `The goal is done when: ${vision}`);
  }
  lines.push(
    '',
    'You are executing this goal ONE to-do at a time. Do EXACTLY this to-do now',
    '(read, edit, run — whatever genuinely completes it). Do NOT skip ahead to',
    'other to-dos and do NOT pursue unrelated improvements.',
    '',
    `This to-do: ${todoText}`,
  );
  if (criterion.length > 0) {
    lines.push(`Done means: ${criterion}`);
  }
  lines.push(
    '',
    "When you have finished THIS to-do, stop — a real verification (the project's",
    'own tests) decides whether it actually passed; your word alone never marks it',
    'done.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// fixItTodo — the self-heal item spawned when a to-do failed verification
// ---------------------------------------------------------------------------

/** Hard cap on how many fix-it spawns a single to-do can accrue (boundedness:
 *  the plan must self-heal a FINITE number of times, never forever). */
export const FIX_IT_MAX_DEPTH = 2;

const FIX_IT_TEXT_LIMIT = 160;
const FIX_IT_FAILURE_LIMIT = 240;

/** Marker prefix so fix-it items are recognizable + their depth is countable. */
const FIX_IT_PREFIX = 'Fix: ';

/**
 * The current fix-it depth of a to-do — how many times it has already been
 * wrapped as a fix-it (counts the `Fix:` prefixes its id encodes). A fresh
 * to-do is depth 0. Pure, total. Used by the caller to enforce FIX_IT_MAX_DEPTH
 * (stop spawning once the cap is hit — bounded self-healing, never an infinite
 * fix-of-a-fix chain).
 */
export function fixItDepth(item: { readonly id: string }): number {
  const id = typeof item.id === 'string' ? item.id : '';
  const m = id.match(/(?:^|-)fix(\d+)$/);
  if (m === null) return 0;
  const n = Number.parseInt(m[1] ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Build a new RoadmapItem describing the fix a to-do needs after it verified
 * `failing`/`unverified`, so the plan SELF-HEALS (Part 3a: failing/unverified ⇒
 * stays open + a fix-it to-do carrying the failure note). The new item:
 *  - has a fresh, deterministic id derived from the failed item's id, encoding
 *    the incremented fix-it depth (so fixItDepth can cap it);
 *  - status `pending` (worker-actionable next cycle);
 *  - carries the failed item's acceptanceCriterion (the bar is unchanged — the
 *    work still has to meet it) when present;
 *  - text = a concise "Fix: <original> — <failure>" so the worker sees both the
 *    original intent and what went wrong.
 * Returns `null` when the cap is already reached (depth ≥ FIX_IT_MAX_DEPTH) — the
 * caller stops honestly rather than spawning forever. Pure, total, never throws.
 */
export function fixItTodo(item: RoadmapItem, failure: string): RoadmapItem | null {
  const depth = fixItDepth(item);
  if (depth >= FIX_IT_MAX_DEPTH) return null; // bounded: no infinite fix-of-a-fix

  const nextDepth = depth + 1;
  const baseId = typeof item.id === 'string' && item.id.length > 0 ? item.id : 'r';
  // Strip a trailing `-fixN` so the chain stays `r1-fix1`, `r1-fix2`, not nested.
  const rootId = baseId.replace(/-fix\d+$/, '');
  const newId = `${rootId}-fix${String(nextDepth)}`;

  // The original to-do's intent, stripped of any prior `Fix:` wrapper so the text
  // doesn't accrete prefixes.
  const original = (typeof item.text === 'string' ? item.text : '').replace(
    new RegExp(`^${FIX_IT_PREFIX}`),
    '',
  );
  const failNote = clip(typeof failure === 'string' ? failure : '', FIX_IT_FAILURE_LIMIT).trim();
  const text = clip(
    `${FIX_IT_PREFIX}${original}${failNote.length > 0 ? ` — ${failNote}` : ''}`,
    FIX_IT_TEXT_LIMIT,
  );

  const fix: RoadmapItem = {
    id: newId,
    text,
    status: 'pending',
    ...(item.acceptanceCriterion !== undefined
      ? { acceptanceCriterion: item.acceptanceCriterion }
      : {}),
  };
  return fix;
}
