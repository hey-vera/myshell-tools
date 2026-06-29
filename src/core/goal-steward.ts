/**
 * src/core/goal-steward.ts — PURE deterministic audit engine for the Goal
 * Steward (Phase 6 first slice). Classifies live/done goals into findings
 * without any I/O, wall-clock, randomness, or model calls.
 *
 * Purity: no fs, no Date.now(), no Math.random(), no console. The "now" is
 * injected as epoch milliseconds; the input goals are read-only. Every
 * classification is a pure function of the input.
 */

import type { Goal, GoalState } from './goal-todo.js';
import { isGoalVerifiedDone } from './goal-todo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The steward's classification of a goal. */
export type GoalClassification =
  | 'fresh'
  | 'stale'
  | 'inactive'
  | 'blocked'
  | 'verified-complete';

/** The action the steward recommends for a goal. */
export type GoalRecommendedAction = 'none' | 'review' | 'resolve-done';

/** One goal audit finding. */
export interface GoalFinding {
  readonly goalId: string;
  readonly conversationId: string | null;
  readonly state: GoalState;
  readonly classification: GoalClassification;
  readonly recommendedAction: GoalRecommendedAction;
  readonly reason: string;
}

/** Input for {@link auditGoals}. */
export interface AuditGoalsInput {
  readonly goals: readonly Goal[];
  /** Current time as epoch milliseconds (injected — no wall clock). */
  readonly nowMs: number;
  /** Staleness window in milliseconds. Default: 30 days (2_592_000_000 ms). */
  readonly staleWindowMs?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default staleness window: 30 days in milliseconds. */
const DEFAULT_STALE_WINDOW_MS = 30 * 86_400_000;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Days since last touch, as a whole number. Pure — both times are injected.
 * Returns 0 on unparseable input.
 */
function ageDays(lastTouchedIso: string, nowMs: number): number {
  const then = Date.parse(lastTouchedIso);
  if (Number.isNaN(then) || nowMs <= then) return 0;
  return Math.floor((nowMs - then) / 86_400_000);
}

/** Build a human-readable reason string given the context. */
function buildReason(
  classification: GoalClassification,
  state: GoalState,
  ageDays: number,
  verdictState?: string,
): string {
  switch (classification) {
    case 'blocked':
      return 'Goal is blocked — requires unblock or cancellation';
    case 'inactive':
      return `Goal is ${state} and untouched for ${ageDays} days — may need resumption or review`;
    case 'stale':
      return `Goal is parked and untouched for ${ageDays} days — may be outdated`;
    case 'verified-complete':
      if (verdictState !== undefined) {
        return `Goal is verified complete (verdict: ${verdictState}) — safe to mark done`;
      }
      return 'Goal is done but lacks a verified verdict — manual review recommended';
    case 'fresh':
      return 'Goal is current';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Audit an array of goals and return a {@link GoalFinding} for every goal.
 *
 * Classification rules (deterministic, per the Goal Steward first slice):
 *
 * 1. **blocked** — state is `'blocked'`. Action: `'review'`.
 * 2. **inactive** — state is `'running'` or `'queued'` and age >= stale
 *    window. These were actively in-flight but untouched too long.
 *    Action: `'review'`.
 * 3. **stale** — state is `'parked'` and age >= stale window. Action: `'review'`.
 * 4. **verified-complete** —
 *    - When `goalVerdict` exists AND `isGoalVerifiedDone` returns true →
 *      action `'resolve-done'` (the ONLY safe auto-mutation).
 *    - When the goal is `'done'` but no such verdict exists, or verdict is not
 *      passing/reviewed → classification still `'verified-complete'` but action
 *      `'review'` (never auto-resolve).
 * 5. **fresh** — everything else. Action: `'none'`.
 *
 * Terminal states (`'done'` without verdict issues, `'failed'`, `'superseded'`)
 * that don't match any of the above are classified `'fresh'`.
 *
 * Pure. Never throws.
 */
export function auditGoals(input: AuditGoalsInput): GoalFinding[] {
  const { goals, nowMs } = input;
  const staleWindowMs = input.staleWindowMs ?? DEFAULT_STALE_WINDOW_MS;

  return goals.map((goal) => {
    const days = ageDays(goal.lastTouched, nowMs);
    const ageMs = nowMs - Date.parse(goal.lastTouched);
    const pastWindow = !Number.isNaN(ageMs) && ageMs >= staleWindowMs;

    // Rule 1: blocked
    if (goal.state === 'blocked') {
      return {
        goalId: goal.id,
        conversationId: goal.conversationId,
        state: goal.state,
        classification: 'blocked',
        recommendedAction: 'review',
        reason: buildReason('blocked', goal.state, days),
      };
    }

    // Rule 2: inactive (running/queued past the stale window)
    if ((goal.state === 'running' || goal.state === 'queued') && pastWindow) {
      return {
        goalId: goal.id,
        conversationId: goal.conversationId,
        state: goal.state,
        classification: 'inactive',
        recommendedAction: 'review',
        reason: buildReason('inactive', goal.state, days),
      };
    }

    // Rule 3: stale (parked past the stale window)
    if (goal.state === 'parked' && pastWindow) {
      return {
        goalId: goal.id,
        conversationId: goal.conversationId,
        state: goal.state,
        classification: 'stale',
        recommendedAction: 'review',
        reason: buildReason('stale', goal.state, days),
      };
    }

    // Rule 4: verified-complete
    if (goal.state === 'done') {
      const verdict = goal.goalVerdict;
      if (verdict !== undefined && isGoalVerifiedDone(verdict)) {
        return {
          goalId: goal.id,
          conversationId: goal.conversationId,
          state: goal.state,
          classification: 'verified-complete',
          recommendedAction: 'resolve-done',
          reason: buildReason('verified-complete', goal.state, days, verdict.state),
        };
      }
      // Done but not verified → still 'verified-complete' with 'review' action
      return {
        goalId: goal.id,
        conversationId: goal.conversationId,
        state: goal.state,
        classification: 'verified-complete',
        recommendedAction: 'review',
        reason: buildReason('verified-complete', goal.state, days),
      };
    }

    // Rule 5: fresh (default)
    return {
      goalId: goal.id,
      conversationId: goal.conversationId,
      state: goal.state,
      classification: 'fresh',
      recommendedAction: 'none',
      reason: buildReason('fresh', goal.state, days),
    };
  });
}

/**
 * Priority order for selecting the top finding.
 * blocked > inactive > stale > verified-complete > fresh
 */
const CLASSIFICATION_PRIORITY: Record<GoalClassification, number> = {
  blocked: 0,
  inactive: 1,
  stale: 2,
  'verified-complete': 3,
  fresh: 4,
};

/** Options for {@link selectTopFinding}. */
export interface SelectTopFindingOpts {
  /** If provided, only consider findings for this conversation. */
  readonly conversationId?: string | null;
}

/**
 * Select the single highest-priority finding from the list, for surfacing in
 * the conversation-open prompt or badge.
 *
 * Priority: blocked > inactive > stale > verified-complete > fresh.
 * Returns `null` when the list is empty or no finding matches the optional
 * {@link SelectTopFindingOpts.conversationId} filter.
 *
 * Pure. Never throws.
 */
export function selectTopFinding(
  findings: readonly GoalFinding[],
  opts?: SelectTopFindingOpts,
): GoalFinding | null {
  if (findings.length === 0) return null;

  const filtered =
    opts?.conversationId !== undefined
      ? findings.filter((f) => f.conversationId === opts.conversationId)
      : findings;

  if (filtered.length === 0) return null;

  let best: GoalFinding | undefined;
  for (const f of filtered) {
    if (
      best === undefined ||
      CLASSIFICATION_PRIORITY[f.classification] <
        CLASSIFICATION_PRIORITY[best.classification]
    ) {
      best = f;
    }
  }
  return best ?? null;
}
