/**
 * src/core/goal-todo.ts — the PURE shaping/formatting core for the unified
 * goal-lifecycle / to-do feature (vision doc .tmp-vision-todos.md, Phase 5a).
 *
 * THE MODEL (owner-confirmed): there is ONE construct — a GOAL with a lifecycle
 * state. A goal OWNS its to-do list = its `roadmap` (the SAME `RoadmapItem`
 * shape work-contract.ts already uses, cap 8). A "to-do list" is just a PARKED
 * goal's roadmap — nothing floats; every to-do is a step of exactly one goal.
 *
 * The lifecycle is one axis (how far along the work is):
 *   parked → queued → running → done | failed
 * `parked` is the ONLY new state; `queued|running|done|failed` are EXACTLY the
 * existing `AgentRunState` values (src/interface/ui/state.ts) the live status
 * renderer already knows. One enum, superset by exactly one member.
 *
 * This module is PURE: no I/O, no time, no randomness, never throws. All I/O
 * (persistence, locking, recovery) lives in src/infra/goal-store.ts. Anything
 * that shapes/formats a goal for display lives HERE so it is table-testable.
 *
 * HARD RULE (owner, non-negotiable): a parked goal's to-dos are PROVISIONAL.
 * When a parked goal is promoted/activated its roadmap must be RE-VALIDATED by
 * the brain against current reality before any action — NEVER executed blindly.
 * In Phase 5a "promote" hands the goal's title to runGoalLoop (the adaptive
 * brain runner), so re-validation is inherent. This module deliberately exposes
 * NO "execute this roadmap" helper — only shaping/formatting.
 */

import type { RoadmapItem, RoadmapStatus } from './work-contract.js';

// ---------------------------------------------------------------------------
// The unified goal type
// ---------------------------------------------------------------------------

/**
 * The goal lifecycle. `queued|running|done|failed` === `AgentRunState`
 * (src/interface/ui/state.ts); `parked` is the one new pre-queue value.
 */
export type GoalState = 'parked' | 'queued' | 'running' | 'done' | 'failed';

/** How a goal entered the store. Phase 5a creates only `user-explicit` goals;
 *  the auto-capture sources (5b) are part of the shape so the store is forward
 *  compatible without a migration. */
type GoalSource =
  | 'user-explicit' // /todo or /goal park <text>
  | 'declined-from-plan' // 5b: a decomposed goal the user did NOT pick
  | 'blocked-item' // 5b: a roadmap item left 'blocked' when its parent goal ended
  | 'inferred-defer-cue'; // 5b: an explicit "later/TODO/remind me" cue (ask-gated)

/** A goal's scope — mirrors user-memory's two-scope model exactly. */
export type GoalScope = 'global' | 'project';

/**
 * The persisted goal. `roadmap` reuses `RoadmapItem` (work-contract.ts) verbatim
 * — a to-do IS a roadmap item; `done`/`blocked` are existing statuses. `title`
 * maps 1:1 to `WorkContract.objective` / `GoalView.label`.
 */
export interface Goal {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly state: GoalState;
  readonly source: GoalSource;
  readonly roadmap: readonly RoadmapItem[];
  readonly scope: GoalScope;
  /** Privacy-preserving `basename#shorthash` (never the raw path); null = global. */
  readonly projectKey: string | null;
  /** The thread the goal was born in (ConversationMeta.id); null when unlinked. */
  readonly conversationId: string | null;
  readonly createdAt: string; // ISO
  readonly lastTouched: string; // ISO — bumped on any state/roadmap change
}

/** Roadmap cap — the SAME bound work-contract.ts enforces (cap 8). */
export const ROADMAP_LIMIT = 8;

const TITLE_LIMIT = 240;
const ROADMAP_TEXT_LIMIT = 160;

const VALID_STATES: ReadonlySet<string> = new Set<GoalState>([
  'parked',
  'queued',
  'running',
  'done',
  'failed',
]);

const VALID_STATUSES: ReadonlySet<string> = new Set<RoadmapStatus>([
  'pending',
  'active',
  'done',
  'blocked',
]);

const VALID_SOURCES: ReadonlySet<string> = new Set<GoalSource>([
  'user-explicit',
  'declined-from-plan',
  'blocked-item',
  'inferred-defer-cue',
]);

const VALID_SCOPES: ReadonlySet<string> = new Set<GoalScope>(['global', 'project']);

// ---------------------------------------------------------------------------
// Defensive shaping (mirrors work-contract.capContract — never throws)
// ---------------------------------------------------------------------------

function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return String(value);
  } catch {
    return '';
  }
}

function capText(value: unknown, limit: number): string {
  return safeString(value).slice(0, limit);
}

function capRoadmapStatus(value: unknown): RoadmapStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value)
    ? (value as RoadmapStatus)
    : 'pending';
}

function capState(value: unknown): GoalState {
  return typeof value === 'string' && VALID_STATES.has(value) ? (value as GoalState) : 'parked';
}

function capSource(value: unknown): GoalSource {
  return typeof value === 'string' && VALID_SOURCES.has(value)
    ? (value as GoalSource)
    : 'user-explicit';
}

function capScope(value: unknown): GoalScope {
  return typeof value === 'string' && VALID_SCOPES.has(value) ? (value as GoalScope) : 'project';
}

/**
 * Return a deterministic, capped copy of a roadmap (cap 8, capped text/status).
 * Pure, never throws on malformed input. Mirrors the roadmap branch of
 * `capContract` so a goal's to-dos obey the same bounds as a live contract's.
 */
export function capRoadmap(roadmap: unknown): RoadmapItem[] {
  if (!Array.isArray(roadmap)) return [];
  return roadmap.slice(0, ROADMAP_LIMIT).map((item) => {
    const r =
      item !== null && typeof item === 'object'
        ? (item as { readonly id?: unknown; readonly text?: unknown; readonly status?: unknown })
        : {};
    return {
      id: safeString(r.id),
      text: capText(r.text, ROADMAP_TEXT_LIMIT),
      status: capRoadmapStatus(r.status),
    };
  });
}

/**
 * Return a deterministic, capped copy of a goal. Defensive at runtime: any
 * malformed field falls back to a safe default (state→parked, scope→project)
 * rather than throwing. Used by the store on every read so a hand-edited or
 * partially-written index can never crash a caller.
 */
export function capGoal(g: Goal): Goal {
  const raw = g as unknown;
  const r =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const scope = capScope(r['scope']);
  return {
    version: 1,
    id: safeString(r['id']),
    title: capText(r['title'], TITLE_LIMIT),
    state: capState(r['state']),
    source: capSource(r['source']),
    roadmap: capRoadmap(r['roadmap']),
    scope,
    projectKey: scope === 'project' ? (typeof r['projectKey'] === 'string' ? r['projectKey'] : null) : null,
    conversationId: typeof r['conversationId'] === 'string' ? r['conversationId'] : null,
    createdAt: safeString(r['createdAt']),
    lastTouched: safeString(r['lastTouched']),
  };
}

// ---------------------------------------------------------------------------
// Pure shaping / formatting
// ---------------------------------------------------------------------------

/** Roadmap progress for a goal: done / total + blocked count. Pure. */
export interface RoadmapProgress {
  readonly done: number;
  readonly total: number;
  readonly blocked: number;
}

export function roadmapProgress(roadmap: readonly RoadmapItem[]): RoadmapProgress {
  let done = 0;
  let blocked = 0;
  for (const item of roadmap) {
    if (item.status === 'done') done += 1;
    else if (item.status === 'blocked') blocked += 1;
  }
  return { done, total: roadmap.length, blocked };
}

/** A short "3/8 to-dos" label (singular "to-do" at 1). Pure, never throws. */
export function formatTodoCount(roadmap: readonly RoadmapItem[]): string {
  const { done, total } = roadmapProgress(roadmap);
  const noun = total === 1 ? 'to-do' : 'to-dos';
  return `${done}/${total} ${noun}`;
}

/**
 * Days since a goal was last touched, given the current ISO time. Pure (the
 * "now" is injected, not read from the wall clock). Returns 0 on unparseable
 * input rather than throwing — staleness is a hint, never load-bearing.
 */
export function ageInDays(lastTouchedIso: string, nowIso: string): number {
  const then = Date.parse(lastTouchedIso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(then) || Number.isNaN(now) || now <= then) return 0;
  return Math.floor((now - then) / 86_400_000);
}

/** Default staleness window in days (vision doc §4 — dim, never silent-delete). */
const STALE_DAYS = 30;

/** True when a parked goal is past the staleness window (dim it, never drop). */
export function isStale(goal: Goal, nowIso: string, staleDays = STALE_DAYS): boolean {
  return ageInDays(goal.lastTouched, nowIso) >= staleDays;
}

/**
 * The glyph for a goal's lifecycle state, reusing the StatusBlock vocabulary:
 * parked/queued `○`-family, running `◐`, done `✓`, failed `✗`. A parked goal
 * with a blocked roadmap item gets the `⚠` flag (vision doc §5). Pure.
 */
export function goalGlyph(goal: Goal): string {
  if (goal.state === 'done') return '✓';
  if (goal.state === 'failed') return '✗';
  if (goal.state === 'running') return '◐';
  if (goal.state === 'parked') {
    return roadmapProgress(goal.roadmap).blocked > 0 ? '⚠' : '◷';
  }
  return '○'; // queued
}

/**
 * One concise menu row for a parked goal, e.g.
 *   `◷ Redesign feed · 3/8 to-dos · parked · this repo`
 * A blocked parked goal surfaces the first blocker instead of the bare count.
 * `dim` only renders age when stale (caller themes the dimming). Pure.
 */
export function formatGoalRow(goal: Goal, nowIso: string): string {
  const glyph = goalGlyph(goal);
  const parts: string[] = [`${glyph} ${goal.title}`];
  const prog = roadmapProgress(goal.roadmap);
  if (prog.blocked > 0) {
    const firstBlocked = goal.roadmap.find((i) => i.status === 'blocked');
    parts.push(`${prog.done}/${prog.total}`);
    parts.push(`blocked: ${firstBlocked?.text ?? 'needs input'}`);
  } else {
    parts.push(formatTodoCount(goal.roadmap));
  }
  const age = ageInDays(goal.lastTouched, nowIso);
  parts.push(isStale(goal, nowIso) ? `parked ${age}d ago` : 'parked');
  parts.push(goal.scope === 'global' ? 'global' : 'this repo');
  return parts.join(' · ');
}

const ROADMAP_BOX: Record<RoadmapStatus, string> = {
  done: '[✓]',
  pending: '[ ]',
  active: '[ ]',
  blocked: '[⚠]',
};

/**
 * The lines for an EXPANDED parked goal — its roadmap (the to-dos) as a numbered
 * checklist, each item `[✓]/[ ]/[⚠]` (done/pending|active/blocked). The numbers
 * are 1-based so they line up with the `[d <n>]` / `[b <n>]` commands. Pure.
 */
export function formatRoadmapLines(roadmap: readonly RoadmapItem[]): string[] {
  return roadmap.map((item, i) => {
    const box = ROADMAP_BOX[item.status];
    return `   ${i + 1}. ${box} ${item.text}`;
  });
}

/**
 * Filter + order a goal list for display: by `state` (and `scope` when given),
 * newest-touched first. Pure — the store keeps the canonical newest-first order,
 * this is the display-time narrowing the menu/commands use. Never mutates input.
 */
export function selectGoals(
  goals: readonly Goal[],
  filter?: { readonly state?: GoalState; readonly scope?: GoalScope; readonly projectKey?: string | null },
): Goal[] {
  return goals.filter((g) => {
    if (filter?.state !== undefined && g.state !== filter.state) return false;
    if (filter?.scope !== undefined && g.scope !== filter.scope) return false;
    if (filter?.projectKey !== undefined && g.projectKey !== filter.projectKey) return false;
    return true;
  });
}
