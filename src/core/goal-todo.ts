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

import type { RoadmapItem, RoadmapItemApproach, RoadmapStatus } from './work-contract.js';
import { capRoadmapItem, normalizeRoadmapRelations } from './work-contract.js';
import type { VerifiedState, VerifyOutcome } from './verify.js';
import { buildVerifyReceipt } from './verify.js';
import type { BlockedRecord } from './blocked.js';
import { isBlockedRecord } from './blocked.js';

// ---------------------------------------------------------------------------
// The unified goal type
// ---------------------------------------------------------------------------

/**
 * The goal lifecycle. `queued|running|done|failed` === `AgentRunState`
 * (src/interface/ui/state.ts); `parked` is the one new pre-queue value.
 */
export type GoalState = 'parked' | 'queued' | 'running' | 'done' | 'failed' | 'blocked' | 'superseded';

/** How a goal entered the store. Phase 5a creates only `user-explicit` goals;
 *  the auto-capture sources (5b) are part of the shape so the store is forward
 *  compatible without a migration. */
type GoalSource =
  | 'user-explicit' // /todo or /goal park <text>
  | 'declined-from-plan' // 5b: a decomposed goal the user did NOT pick
  | 'blocked-item' // 5b: a roadmap item left 'blocked' when its parent goal ended
  | 'inferred-defer-cue' // 5b: an explicit "later/TODO/remind me" cue (ask-gated)
  | 'auto-staged' // P6: judged + auto-staged by the planning brain post-turn (parked)
  | 'byproduct-draft'; // redesign Phase 1: draft skeleton emitted as byproduct of a build-intent turn (parked, never auto-executed)

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
  /**
   * The best-approach record set by the manager-tier planner at goal-creation
   * time — the goal's CHOSEN strategy + WHY it beats the alternatives, grounded
   * in the whole-picture SystemModel when one is warm (the "best approach" half
   * of truly-complete). Reuses {@link RoadmapItemApproach} verbatim (one type,
   * one cap discipline). Additive + optional: a goal staged WITHOUT an approach
   * (a trivial goal, or one from a model reply that omitted the marker) round-
   * trips byte-identically. Capped in {@link capGoal} (chosen/rationale required,
   * else the whole field is omitted — never a half-record).
   */
  readonly approach?: RoadmapItemApproach;
  /**
   * The goal's classified CATEGORY (security/infra/data/release/…), set when the
   * goal is staged — deterministically from the goal text (core/rules.ts
   * `classifyCategory`) or by the planner. The STANDING-RULES launch gate (Phase 4)
   * keys a rule's category trigger on this so "pause before any security-type goal"
   * can fire before the goal runs. Additive + optional: a goal staged WITHOUT a
   * category round-trips byte-identically (capGoal omits an unknown value).
   */
  readonly category?: string;
  /**
   * Free-form tags for the goal (forward-compatible; the rules gate may key on
   * these later). Capped to a handful of short strings. Additive + optional: a
   * goal without tags round-trips byte-identically (capGoal omits an empty list).
   */
  readonly tags?: readonly string[];
  /**
   * GOAL-LEVEL nesting (Phase 4a): the id of this goal's PARENT goal, when it was
   * decomposed out of a larger goal. This is SEPARATE from RoadmapItem.parentId
   * (work-contract.ts), which groups to-dos WITHIN one goal — this points one whole
   * goal at another. Must match the goal id format (`/^goal_[A-Za-z0-9]+$/`) and may
   * never equal this goal's own id (a goal can't parent itself). Additive + optional:
   * a goal WITHOUT a parent round-trips byte-identically (capGoal omits an
   * absent/invalid/self-referential value). The decomposer + tree view + cancellation
   * propagation that consume this land in Phase 4b.
   */
  readonly parentGoalId?: string;
  /**
   * Intent-version correlation id (MYSHELL_INTENT_STORE_V1). Links the goal back
   * to the single captured turn intent that produced it. Additive + optional: a
   * goal WITHOUT one round-trips byte-identically.
   */
  readonly intentVersionId?: string;
  /**
   * Blocked terminal record (MYSHELL_BLOCKED_STATE_V1). Additive + optional:
   * a goal WITHOUT one round-trips byte-identically.
   */
  readonly blocked?: BlockedRecord;
  /**
   * Correction-fork supersession metadata (MYSHELL_CORRECTION_FORK_V1).
   * Additive + optional: a goal WITHOUT these round-trips byte-identically.
   */
  readonly supersededByIntentId?: string;
  readonly supersededReason?: string;
}

/** Roadmap cap — the SAME bound work-contract.ts enforces (cap 8). */
export const ROADMAP_LIMIT = 8;

const TITLE_LIMIT = 240;
// Phase 2 caps for the new goal-level acceptance/verdict fields.
const GOAL_ACCEPTANCE_LIMIT = 400;
const GOAL_VERDICT_RECEIPT_LIMIT = 400;
// Approach caps — mirror work-contract.ts's APPROACH_* bounds exactly so a
// goal-level approach and a roadmap-item approach cap identically.
const GOAL_APPROACH_CHOSEN_LIMIT = 400;
const GOAL_APPROACH_RATIONALE_LIMIT = 400;
const GOAL_APPROACH_ALT_LIMIT = 160;
const GOAL_APPROACH_ALTS_LIMIT = 8;
// Category / tags caps (Phase 4 — the standing-rules gate keys on category).
const GOAL_CATEGORY_LIMIT = 40;
const GOAL_TAG_LIMIT = 40;
const GOAL_TAGS_LIMIT = 8;

/** Goal id format — the SAME `goal_<alnum>` shape goal-store.ts validates for the
 *  filesystem path. A `parentGoalId` must match this or it is dropped (capGoal). */
const GOAL_ID_RE = /^goal_[A-Za-z0-9]+$/;

const VALID_STATES: ReadonlySet<string> = new Set<GoalState>([
  'parked',
  'queued',
  'running',
  'done',
  'failed',
  'blocked',
  'superseded',
]);

const VALID_SOURCES: ReadonlySet<string> = new Set<GoalSource>([
  'user-explicit',
  'declined-from-plan',
  'blocked-item',
  'inferred-defer-cue',
  'auto-staged',
  'byproduct-draft',
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
  return normalizeRoadmapRelations(roadmap.slice(0, ROADMAP_LIMIT).map(capRoadmapItem));
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

  // approach — omit the whole field if chosen or rationale is missing (mirrors
  // capRoadmapItem's approach handling exactly: never a half-record).
  let cappedApproach: RoadmapItemApproach | undefined;
  if (r['approach'] !== undefined && r['approach'] !== null && typeof r['approach'] === 'object') {
    const a = r['approach'] as Record<string, unknown>;
    const chosen = capText(a['chosen'], GOAL_APPROACH_CHOSEN_LIMIT);
    const rationale = capText(a['rationale'], GOAL_APPROACH_RATIONALE_LIMIT);
    if (chosen.length > 0 && rationale.length > 0) {
      cappedApproach = {
        chosen,
        rationale,
        ...(Array.isArray(a['alternatives'])
          ? {
              alternatives: a['alternatives']
                .slice(0, GOAL_APPROACH_ALTS_LIMIT)
                .map((alt) => capText(alt, GOAL_APPROACH_ALT_LIMIT)),
            }
          : {}),
      };
    }
    // If chosen/rationale missing → cappedApproach stays undefined (omit).
  }

  // category — a single short label; omit when absent/empty (byte-identical).
  const catRaw = r['category'];
  const cappedCategory =
    typeof catRaw === 'string' && catRaw.trim().length > 0
      ? capText(catRaw, GOAL_CATEGORY_LIMIT)
      : undefined;

  // tags — a bounded list of short non-empty strings; omit when absent/empty.
  let cappedTags: string[] | undefined;
  if (Array.isArray(r['tags'])) {
    const tags = r['tags']
      .map((t) => capText(t, GOAL_TAG_LIMIT))
      .filter((t) => t.trim().length > 0)
      .slice(0, GOAL_TAGS_LIMIT);
    if (tags.length > 0) cappedTags = tags;
  }

  const id = safeString(r['id']);

  // parentGoalId (Phase 4a — GOAL-level nesting) — must match the goal id format
  // and may NOT be this goal's own id (no self-parent). Omit otherwise, so a goal
  // WITHOUT a parent (or with a malformed/self-referential one) round-trips
  // byte-identically to before this field existed.
  const pgRaw = r['parentGoalId'];
  const cappedParentGoalId =
    typeof pgRaw === 'string' && GOAL_ID_RE.test(pgRaw) && pgRaw !== id ? pgRaw : undefined;

  // intentVersionId — preserve only a non-empty string. Omit blank/absent, so a
  // goal WITHOUT one round-trips byte-identically.
  const ivRaw = r['intentVersionId'];
  const cappedIntentVersionId =
    typeof ivRaw === 'string' && ivRaw.trim().length > 0 ? ivRaw : undefined;

  // blocked — preserve only a valid BlockedRecord. Omit malformed/absent.
  let cappedBlocked: BlockedRecord | undefined;
  if (isBlockedRecord(r['blocked'])) {
    cappedBlocked = r['blocked'] as BlockedRecord;
  }

  // supersededByIntentId / supersededReason — preserve only non-empty strings.
  // Also require state to be 'superseded' to keep the shape honest.
  const cappedSupersededByIntentId =
    typeof r['supersededByIntentId'] === 'string' && r['supersededByIntentId'].trim().length > 0
      ? r['supersededByIntentId']
      : undefined;
  const cappedSupersededReason =
    typeof r['supersededReason'] === 'string' && r['supersededReason'].trim().length > 0
      ? r['supersededReason']
      : undefined;

  return {
    version: 1,
    id,
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
    ...(cappedApproach !== undefined ? { approach: cappedApproach } : {}),
    ...(cappedCategory !== undefined ? { category: cappedCategory } : {}),
    ...(cappedTags !== undefined ? { tags: cappedTags } : {}),
    ...(cappedParentGoalId !== undefined ? { parentGoalId: cappedParentGoalId } : {}),
    ...(cappedIntentVersionId !== undefined ? { intentVersionId: cappedIntentVersionId } : {}),
    ...(cappedBlocked !== undefined ? { blocked: cappedBlocked } : {}),
    ...(cappedSupersededByIntentId !== undefined ? { supersededByIntentId: cappedSupersededByIntentId } : {}),
    ...(cappedSupersededReason !== undefined ? { supersededReason: cappedSupersededReason } : {}),
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
  if (goal.state === 'done') return '\u2713';
  if (goal.state === 'failed') return '\u2717';
  if (goal.state === 'blocked') return '\u2717';
  if (goal.state === 'superseded') return '\u2717';
  if (goal.state === 'running') return '\u25D0';
  if (goal.state === 'parked') {
    return roadmapProgress(goal.roadmap).blocked > 0 ? '\u26A0' : '\u25F7';
  }
  return '\u25CB'; // queued
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

/**
 * A concise one-liner for a goal's recorded best-approach, for the expanded goal
 * view / staging receipt: `approach: <chosen>`. Returns `undefined` when the goal
 * carries no approach (nothing to show — never a fabricated line), so a goal
 * without one renders EXACTLY as before. Pure, total — the caller themes the
 * dimming. The `chosen` strategy is the load-bearing summary; the full rationale +
 * alternatives stay on the record for the planner/critic, not the one-liner.
 */
export function formatGoalApproachLine(goal: Goal): string | undefined {
  const a = goal.approach;
  if (a === undefined) return undefined;
  const chosen = a.chosen.trim();
  if (chosen.length === 0) return undefined;
  return `approach: ${chosen}`;
}

const ROADMAP_BOX: Record<RoadmapStatus, string> = {
  done: '[\u2713]',
  pending: '[ ]',
  active: '[ ]',
  blocked: '[\u26A0]',
  superseded: '[\u2717]',
};

/** Verified-done bar, local copy (mirrors isTodoVerifiedDone) so this module
 *  stays free of a goal-manager import. Pure. */
function isItemVerifiedDone(item: RoadmapItem): boolean {
  return item.verdict?.state === 'passing' || item.verdict?.state === 'reviewed';
}

/**
 * The lines for an EXPANDED parked goal — its roadmap (the to-dos) as a numbered
 * checklist, each item `[✓]/[ ]/[⚠]` (done/pending|active/blocked). The numbers
 * are 1-based so they line up with the `[d <n>]` / `[b <n>]` commands. Pure.
 *
 * STRUCTURE (additive, neutral when absent):
 *  - a GROUP HEADER (an item some sibling names as `parentId`) is prefixed `▸`,
 *    and its grouped children are rendered with ONE extra indent level beneath
 *    their original numbered position (no box-drawing trees — just one indent);
 *  - an item with an UNSATISFIED dependency (a `dependsOn` id that is not yet
 *    verified-done) gets a dim `⤷ needs <n>` hint appended; a fully-satisfied
 *    dependency adds NO noise.
 * With no `dependsOn`/`parentId` anywhere this returns EXACTLY the prior output.
 */
export function formatRoadmapLines(roadmap: readonly RoadmapItem[]): string[] {
  const byId = new Map(roadmap.map((it) => [it.id, it]));
  const headers = new Set<string>();
  for (const it of roadmap) {
    if (it.parentId !== undefined && it.parentId.length > 0) headers.add(it.parentId);
  }
  return roadmap.map((item, i) => {
    const box = ROADMAP_BOX[item.status];
    const isChild = item.parentId !== undefined && headers.has(item.parentId);
    const isHeader = headers.has(item.id);
    const indent = isChild ? '      ' : '   ';
    const marker = isHeader ? '▸ ' : '';
    // Count UNSATISFIED deps only (a satisfied dep is silent — no noise).
    let unmet = 0;
    for (const depId of item.dependsOn ?? []) {
      const dep = byId.get(depId);
      if (dep === undefined || !isItemVerifiedDone(dep)) unmet += 1;
    }
    const needs = unmet > 0 ? ` ⤷ needs ${String(unmet)}` : '';
    return `${indent}${i + 1}. ${box} ${marker}${item.text}${needs}`;
  });
}

// ---------------------------------------------------------------------------
// CURRENT GOALS / PLAN — the compact prompt-context render (the partner's plan)
// ---------------------------------------------------------------------------

/** How many goals at most to render into the prompt block (bounded so the plan
 *  can never bloat the prompt). The most relevant non-terminal goals first. */
const GOAL_CONTEXT_GOAL_CAP = 6;
/** Per-goal to-do cap inside the block. Goals carry at most ROADMAP_LIMIT(8)
 *  to-dos; we surface the first few so a wide plan stays compact. */
const GOAL_CONTEXT_TODO_CAP = 6;

/** Display rank for the plan block: LIVE work first, terminal last. Mirrors the
 *  board's state ordering so the prompt and the board agree. */
const GOAL_CONTEXT_STATE_RANK: Record<GoalState, number> = {
  running: 0,
  queued: 1,
  parked: 2,
  done: 3,
  failed: 4,
  blocked: 4,
  superseded: 4,
};

/** A short to-do status word for the plan block. Pure, total. */
function todoStatusWord(status: RoadmapStatus): string {
  switch (status) {
    case 'done':
      return 'done';
    case 'blocked':
      return 'blocked';
    case 'active':
      return 'in progress';
    case 'pending':
    default:
      return 'pending';
  }
}

/**
 * Render a COMPACT, plain-text CURRENT GOALS / PLAN block for the chat prompt
 * context, so the partner always knows its OWN plan — its goals, their state, the
 * to-dos with status, intra-goal `dependsOn` edges ("after #n"), any honest verdict
 * tag, and the chosen approach. This is the fix for "the partner doesn't know its
 * own plan": goalStore is persisted + shown on the board but never reached the
 * model's prompt, so "what's the plan?" answered cluelessly.
 *
 * Selection + bounds (so the prompt can never bloat):
 *  - LIVE goals (running/queued/parked) first, then optionally the most-recent
 *    terminal (done/failed) goal as recency context; capped at
 *    {@link GOAL_CONTEXT_GOAL_CAP} goals total;
 *  - at most {@link GOAL_CONTEXT_TODO_CAP} to-dos per goal (with a "+N more" tail).
 *
 * Empty list ⇒ returns '' (NO block — the assembled prompt stays byte-identical to
 * today). PURE: no I/O, no time, no randomness; never throws.
 */
export function formatGoalsForContext(goals: readonly Goal[]): string {
  if (!Array.isArray(goals) || goals.length === 0) return '';

  // Partition: live (non-terminal) vs terminal, preserving the caller's order
  // (the store hands newest-first) within each partition.
  const live: Goal[] = [];
  const terminal: Goal[] = [];
  for (const g of goals) {
    if (g.state === 'done' || g.state === 'failed' || g.state === 'blocked' || g.state === 'superseded') terminal.push(g);
    else live.push(g);
  }
  // Order live work by lifecycle rank (running → queued → parked), recency-stable
  // within a rank — the SAME ordering the board uses.
  const orderedLive = live
    .map((g, i) => ({ g, i }))
    .sort((a, b) => GOAL_CONTEXT_STATE_RANK[a.g.state] - GOAL_CONTEXT_STATE_RANK[b.g.state] || a.i - b.i)
    .map((x) => x.g);

  // Fill the cap with live goals first; if room remains, add the most-recent
  // terminal goal as recency context (never more than one — keep the plan focused).
  const selected: Goal[] = orderedLive.slice(0, GOAL_CONTEXT_GOAL_CAP);
  if (selected.length < GOAL_CONTEXT_GOAL_CAP && terminal.length > 0) {
    selected.push(terminal[0] as Goal);
  }
  if (selected.length === 0) return '';

  const lines: string[] = [];
  selected.forEach((goal, gi) => {
    const prog = roadmapProgress(goal.roadmap);
    const scope = goal.scope === 'global' ? 'global' : 'this repo';
    const verdict = goalVerdictTag(goal);
    const head =
      `${gi + 1}. ${goal.title} — ${goal.state}` +
      ` · ${prog.done}/${prog.total} to-dos` +
      ` · ${scope}` +
      (verdict !== undefined ? ` · ${verdict}` : '');
    lines.push(head);

    const approach = formatGoalApproachLine(goal);
    if (approach !== undefined) lines.push(`   ${approach}`);

    const shown = goal.roadmap.slice(0, GOAL_CONTEXT_TODO_CAP);
    shown.forEach((item) => {
      // Resolve dependsOn edges to the 1-based positions WITHIN this goal's roadmap
      // (so "after #2" lines up with the printed numbers); unknown ids are dropped.
      const deps: number[] = [];
      for (const depId of item.dependsOn ?? []) {
        const idx = goal.roadmap.findIndex((it) => it.id === depId);
        if (idx >= 0) deps.push(idx + 1);
      }
      const after = deps.length > 0 ? ` (after ${deps.map((n) => `#${String(n)}`).join(', ')})` : '';
      lines.push(`   - [${todoStatusWord(item.status)}] ${item.text}${after}`);
    });
    const remaining = goal.roadmap.length - shown.length;
    if (remaining > 0) lines.push(`   - (+${String(remaining)} more to-dos)`);
  });

  return `CURRENT GOALS (your plan — you own these; reference them when the user asks):\n${lines.join('\n')}`;
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

// ---------------------------------------------------------------------------
// GOAL-LEVEL nesting helpers (Phase 4a foundation — consumed by 4b's decomposer
// + tree view). Pure, total; never throw. SEPARATE from RoadmapItem.parentId
// (within-goal to-do grouping in work-contract.ts) — these operate on whole goals.
// ---------------------------------------------------------------------------

/**
 * The DIRECT children of `parentId`: every goal whose `parentGoalId === parentId`,
 * in the input's order. Pure; an empty/garbage `parentId` yields no matches (a goal
 * with no `parentGoalId` can never match). The later tree view (4b) walks this.
 */
export function childrenOf(goals: readonly Goal[], parentId: string): Goal[] {
  if (!Array.isArray(goals) || typeof parentId !== 'string' || parentId.length === 0) return [];
  return goals.filter((g) => g.parentGoalId === parentId);
}

/** Hard ceiling on the parent chain a depth walk will follow before bailing — a
 *  malformed cyclic chain (which capGoal blocks for self-parents but NOT for a
 *  longer A→B→A cycle) must never spin forever. Far above any sane nesting depth. */
const GOAL_DEPTH_CAP = 64;

/**
 * The nesting depth of goal `id`: 0 for a root (no `parentGoalId`), 1 for a direct
 * child, and so on, by walking the `parentGoalId` chain upward through `goals`.
 * Pure, total. CYCLE GUARD: the walk both tracks visited ids AND caps total hops at
 * {@link GOAL_DEPTH_CAP}, so a malformed cyclic chain (A→B→A) bails at the cap
 * instead of looping forever. An unknown id, or a parent pointer to a goal not in
 * the set, terminates the walk (the missing link is treated as a root boundary).
 */
export function goalDepth(goals: readonly Goal[], id: string): number {
  if (!Array.isArray(goals) || typeof id !== 'string' || id.length === 0) return 0;
  const byId = new Map(goals.map((g) => [g.id, g]));
  const seen = new Set<string>();
  let depth = 0;
  let current = byId.get(id);
  while (current !== undefined) {
    const parentId = current.parentGoalId;
    if (parentId === undefined || parentId.length === 0) break; // reached a root
    if (seen.has(current.id)) break; // CYCLE GUARD: re-visiting an id ⇒ a cycle, bail
    if (depth >= GOAL_DEPTH_CAP) break; // CYCLE GUARD: pathological chain, bail at the cap
    seen.add(current.id);
    const parent = byId.get(parentId);
    if (parent === undefined) break; // parent not in the set ⇒ boundary root
    depth += 1;
    current = parent;
  }
  return depth;
}

/** A terminal state a goal can be cascade-set to. There is NO `cancelled` state
 *  (owner hard rule) — `failed` is the terminal for cancelled work. Kept as its
 *  own narrowed type so the cascade signature documents the one legal terminal. */
type CascadeTerminal = 'failed' | 'superseded';

/** A non-terminal goal state is one the cascade is allowed to TERMINATE. */
const NON_TERMINAL_STATES: ReadonlySet<GoalState> = new Set<GoalState>(['parked', 'queued', 'running']);

/** One planned cascade transition: a goal id + the terminal state to set it to. */
export interface CascadeTransition {
  readonly id: string;
  readonly state: GoalState;
}

/**
 * Plan a goal-tree CANCELLATION cascade: given `rootId`, return the root plus all
 * its transitive descendants (via `parentGoalId`) that are CURRENTLY NON-TERMINAL
 * (state ∈ parked|queued|running) and so should be set to `terminal` (always
 * 'failed' — there is no `cancelled` state). Pure, total; never throws.
 *
 * HONESTY (mirrors the `blocked-item` verdict precedent): a descendant already
 * 'done' is PRESERVED — verified work is NEVER overwritten by a cancellation — and
 * a descendant already 'failed' is a no-op. Both are EXCLUDED from the result, so
 * the caller only ever flips live work to failed. An unknown `rootId` (or a root
 * not in `goals`) yields `[]` (nothing to cancel — fail-soft).
 *
 * TRAVERSAL: deterministic BFS from the root — root first, then each level's
 * children in the input's order (childrenOf preserves input order). CYCLE GUARD:
 * the SAME discipline as {@link goalDepth} — a `seen` set (each goal visited at
 * most once) AND a hard hop cap ({@link GOAL_DEPTH_CAP} × goal count, generous but
 * finite) — so a malformed cyclic parent chain (A→B→A) can never spin forever.
 */
export function cascadeTerminate(
  goals: readonly Goal[],
  rootId: string,
  terminal: CascadeTerminal,
): CascadeTransition[] {
  if (!Array.isArray(goals) || typeof rootId !== 'string' || rootId.length === 0) return [];
  const byId = new Map(goals.map((g) => [g.id, g]));
  const root = byId.get(rootId);
  if (root === undefined) return []; // unknown root ⇒ nothing to cancel (fail-soft)

  const out: CascadeTransition[] = [];
  const seen = new Set<string>();
  // Generous-but-finite hop budget: even a fully-cyclic set can't exceed one visit
  // per goal, but we cap explicitly (× GOAL_DEPTH_CAP) as belt-and-braces against
  // a pathological structure, matching goalDepth's cap discipline.
  let hops = 0;
  const hopCap = (goals.length + 1) * GOAL_DEPTH_CAP;

  // BFS queue, root first; children appended in input order at each level.
  const queue: Goal[] = [root];
  while (queue.length > 0 && hops < hopCap) {
    hops += 1;
    const current = queue.shift() as Goal;
    if (seen.has(current.id)) continue; // CYCLE GUARD: never revisit a goal
    seen.add(current.id);
    // Only flip LIVE work; preserve 'done' (verified) + skip 'failed' (no-op).
    if (NON_TERMINAL_STATES.has(current.state)) {
      out.push({ id: current.id, state: terminal });
    }
    // Walk into the children regardless of the current goal's own state — a 'done'
    // parent can still have live descendants that the cancel should reach.
    for (const child of childrenOf(goals, current.id)) {
      if (!seen.has(child.id)) queue.push(child);
    }
  }
  return out;
}
