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
import { capRoadmapItem } from './work-contract.js';
import type { VerifiedState, VerifyOutcome } from './verify.js';
import { buildVerifyReceipt } from './verify.js';

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
  | 'inferred-defer-cue' // 5b: an explicit "later/TODO/remind me" cue (ask-gated)
  | 'auto-staged'; // P6: judged + auto-staged by the planning brain post-turn (parked)

/** A goal's scope — mirrors user-memory's two-scope model exactly. */
export type GoalScope = 'global' | 'project';

/**
 * Goal-level verdict shape — mirrors RoadmapItemVerdict but without
 * changedPaths (goals aggregate multiple to-dos; paths are per-item).
 * Reuses the same VerifiedState four-state union (verify.ts).
 */
export interface GoalVerdict {
  readonly state: VerifiedState;
  /** The honest receipt string from the goal-level acceptance check. */
  readonly receipt: string;
  /** ISO timestamp when the verdict was recorded. */
  readonly at: string;
}

/**
 * The honesty boundary, in one pure function: build a {@link GoalVerdict} from a
 * REAL {@link VerifyOutcome} (the only legitimate source of a verdict state). The
 * `state` is copied VERBATIM from the outcome's honest four-state — never inferred,
 * never upgraded — and the receipt is the honest one-line string the verify engine
 * itself composes (buildVerifyReceipt), so the verdict can never overclaim. `at` is
 * the injected ISO time (pure — no wall clock here). This is the ONLY constructor
 * the verified-done gate uses; a model's GOAL_COMPLETE claim never reaches it.
 */
export function goalVerdictFromOutcome(outcome: VerifyOutcome, nowIso: string): GoalVerdict {
  return {
    state: outcome.verified,
    receipt: buildVerifyReceipt(outcome),
    at: nowIso,
  };
}

/**
 * Whether a goal-level verdict counts as VERIFIED DONE — the gate's promote test.
 * ONLY `passing` (the project's own tests ran GREEN) or `reviewed` (a critic looked,
 * a weaker-but-real signal) qualify. `failing` and `unverified` (including an empty
 * diff ⇒ nothing to verify) do NOT — the goal stays open. Pure, total.
 */
export function isGoalVerifiedDone(verdict: GoalVerdict): boolean {
  return verdict.state === 'passing' || verdict.state === 'reviewed';
}

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
  /**
   * The goal-level end-to-end definition of done. Authored by the manager
   * tier at goal creation or re-plan; threaded into the goal-level acceptance
   * check (Part 3, dim a). Optional — goals created before Phase 2 lack it
   * and continue to work normally.
   */
  readonly goalAcceptance?: string;
  /**
   * Evidence-backed goal-level verdict. Set only by the goal-manager after
   * every RoadmapItem.verdict ∈ {passing, reviewed} AND the goal-level
   * verifyStage check passes against goalAcceptance (Part 3). Never
   * hand-set by a model — anti-fabrication hard rule.
   */
  readonly goalVerdict?: GoalVerdict;
}

/** Roadmap cap — the SAME bound work-contract.ts enforces (cap 8). */
export const ROADMAP_LIMIT = 8;

const TITLE_LIMIT = 240;
// Phase 2 caps for the new goal-level acceptance/verdict fields.
const GOAL_ACCEPTANCE_LIMIT = 400;
const GOAL_VERDICT_RECEIPT_LIMIT = 400;

const VALID_STATES: ReadonlySet<string> = new Set<GoalState>([
  'parked',
  'queued',
  'running',
  'done',
  'failed',
]);

const VALID_SOURCES: ReadonlySet<string> = new Set<GoalSource>([
  'user-explicit',
  'declined-from-plan',
  'blocked-item',
  'inferred-defer-cue',
  'auto-staged',
]);

const VALID_SCOPES: ReadonlySet<string> = new Set<GoalScope>(['global', 'project']);

const VALID_VERIFIED_STATES: ReadonlySet<string> = new Set<VerifiedState>([
  'unverified',
  'reviewed',
  'passing',
  'failing',
]);

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

function capVerifiedState(value: unknown): VerifiedState | undefined {
  return typeof value === 'string' && VALID_VERIFIED_STATES.has(value)
    ? (value as VerifiedState)
    : undefined;
}

/**
 * Return a deterministic, capped copy of a roadmap (cap 8, capped text/status
 * + the Phase 2 optional fields acceptanceCriterion/verdict/approach).
 * Pure, never throws on malformed input. Delegates per-item capping to
 * `capRoadmapItem` (work-contract.ts) so both paths stay in sync.
 */
export function capRoadmap(roadmap: unknown): RoadmapItem[] {
  if (!Array.isArray(roadmap)) return [];
  return roadmap.slice(0, ROADMAP_LIMIT).map(capRoadmapItem);
}

/**
 * Return a deterministic, capped copy of a goal. Defensive at runtime: any
 * malformed field falls back to a safe default (state→parked, scope→project)
 * rather than throwing. Used by the store on every read so a hand-edited or
 * partially-written index can never crash a caller.
 *
 * Phase 2 additive fields (goalAcceptance, goalVerdict) are omitted when
 * absent or malformed — an existing Goal without them round-trips identically.
 */
export function capGoal(g: Goal): Goal {
  const raw = g as unknown;
  const r =
    raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const scope = capScope(r['scope']);

  // goalAcceptance — omit if absent; cap length.
  const ga = r['goalAcceptance'];
  const cappedGa = ga !== undefined ? capText(ga, GOAL_ACCEPTANCE_LIMIT) : undefined;

  // goalVerdict — omit the whole field if state is missing/invalid (anti-fabrication).
  let cappedGv: GoalVerdict | undefined;
  if (r['goalVerdict'] !== undefined && r['goalVerdict'] !== null && typeof r['goalVerdict'] === 'object') {
    const gv = r['goalVerdict'] as Record<string, unknown>;
    const state = capVerifiedState(gv['state']);
    if (state !== undefined) {
      cappedGv = {
        state,
        receipt: capText(gv['receipt'], GOAL_VERDICT_RECEIPT_LIMIT),
        at: safeString(gv['at']),
      };
    }
    // If state is invalid/missing → cappedGv stays undefined (omit entirely).
  }

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
    ...(cappedGa !== undefined ? { goalAcceptance: cappedGa } : {}),
    ...(cappedGv !== undefined ? { goalVerdict: cappedGv } : {}),
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
 * A short, honest verdict tag for a goal's evidence-backed `goalVerdict`, for the
 * persistent board so completion honesty is VISIBLE: `passing` ⇒ `✓verified`,
 * `reviewed` ⇒ `~reviewed` (a critic looked, no tests — weaker), `failing` ⇒
 * `✗failing`, `unverified` ⇒ `⚠unverified`. Returns `undefined` when the goal has
 * no recorded verdict (nothing to show — never a fabricated tag). Pure, total.
 */
export function goalVerdictTag(goal: Goal): string | undefined {
  const v = goal.goalVerdict;
  if (v === undefined) return undefined;
  switch (v.state) {
    case 'passing':
      return '✓verified';
    case 'reviewed':
      return '~reviewed';
    case 'failing':
      return '✗failing';
    case 'unverified':
    default:
      return '⚠unverified';
  }
}

/**
 * Normalize a goal title for duplicate detection: lowercased, punctuation folded
 * to spaces, whitespace collapsed. Pure + deterministic — the basis for telling
 * "Redesign the feed" and "redesign feed!" apart from a genuinely new goal.
 */
export function normalizeGoalTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decide whether a candidate goal title is a NEAR-DUPLICATE of any already-known
 * title. True on an exact normalized match OR strong token overlap (Jaccard ≥
 * `threshold`). This is the smart guard (not a dumb cap) that keeps the auto-stage
 * planner from piling up duplicate parked goals when the owner circles the same
 * topic across consecutive turns — an elite partner recognizes "we already have a
 * goal for that" instead of stamping out copies. Pure; empty candidate → false.
 */
export function isDuplicateGoalTitle(
  candidate: string,
  existing: readonly string[],
  threshold = 0.7,
): boolean {
  const c = normalizeGoalTitle(candidate);
  if (c.length === 0) return false;
  const cTokens = new Set(c.split(' ').filter((t) => t.length > 0));
  if (cTokens.size === 0) return false;
  for (const e of existing) {
    const n = normalizeGoalTitle(e);
    if (n.length === 0) continue;
    if (n === c) return true;
    const eTokens = new Set(n.split(' ').filter((t) => t.length > 0));
    let inter = 0;
    for (const t of cTokens) if (eTokens.has(t)) inter += 1;
    const union = cTokens.size + eTokens.size - inter;
    if (union > 0 && inter / union >= threshold) return true;
  }
  return false;
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
