/**
 * src/core/correction-fork.ts — pure correction-fork detection and
 * invalidation-planning helpers for MYSHELL_CORRECTION_FORK_V1 (PR4).
 *
 * PURE: no I/O, no filesystem, no side effects, never throws.
 */

import type { IntentVersion } from './intent-version.js';
import type { Goal, GoalState } from './goal-todo.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export interface CorrectionDetection {
  readonly isCorrection: true;
  readonly matchedTrigger: string;
}

/**
 * Deterministic, conservative correction detection. A turn is a correction
 * only when `hasPriorIntent` is true AND the text matches a high-confidence
 * trigger.
 *
 * Safe default: returns `null` when uncertain (no false positives).
 */
export function detectCorrectionFork(input: {
  text: string;
  hasPriorIntent: boolean;
}): CorrectionDetection | null {
  if (!input.hasPriorIntent) return null;

  const text = input.text.trim();

  // Explicit command form: /correct <replacement intent>
  const slashCorrectMatch = text.match(/^\/correct\s+(.+)/i);
  if (slashCorrectMatch !== null && slashCorrectMatch[1] !== undefined && slashCorrectMatch[1].trim().length > 0) {
    return { isCorrection: true, matchedTrigger: '/correct' };
  }

  // High-confidence literal triggers near the start (first ~100 chars)
  const head = text.slice(0, 100).toLowerCase();

  const triggers: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /^wait,\s*you\s+missed\s+my\s+point/, label: 'wait, you missed my point' },
    { pattern: /^that'?s?\s+not\s+what\s+i\s+meant/, label: "that's not what I meant" },
    { pattern: /^that\s+is\s+not\s+what\s+i\s+meant/, label: 'that is not what I meant' },
    { pattern: /^you\s+missed\s+my\s+point/, label: 'you missed my point' },
    { pattern: /^no,\s*i\s+meant/, label: 'no, I meant' },
    { pattern: /^actually,\s*i\s+meant/, label: 'actually, I meant' },
    { pattern: /^wrong\s+direction/, label: 'wrong direction' },
    { pattern: /^not\s+what\s+i\s+asked/, label: 'not what I asked' },
  ];

  for (const { pattern, label } of triggers) {
    if (pattern.test(head)) {
      return { isCorrection: true, matchedTrigger: label };
    }
  }

  // `instead, ...` only when preceded by `no`, `wait`, or `actually`
  const insteadTriggerMatch = head.match(/^(no|wait|actually)[,.]?\s+.*\binstead\b/);
  if (insteadTriggerMatch !== null) {
    return { isCorrection: true, matchedTrigger: 'instead' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Intent descendant computation
// ---------------------------------------------------------------------------

/**
 * Collect the ids of all IntentVersions whose parent chain (transitively)
 * reaches `parentId`, excluding `excludeRoot` and its descendants.
 *
 * Used to compute old-branch intent ids: everything under the old parent
 * that isn't in the new child's branch.
 */
export function intentDescendantIds(
  versions: readonly IntentVersion[],
  parentId: string,
  excludeRoot?: string,
): Set<string> {
  // Build parent→children index
  const children = new Map<string, string[]>();
  for (const v of versions) {
    const p = v.parentId ?? 'ROOT';
    let list = children.get(p);
    if (list === undefined) {
      list = [];
      children.set(p, list);
    }
    list.push(v.id);
  }

  const descendant = new Set<string>();
  const excludeSet = new Set<string>();

  // If excludeRoot is provided, compute its entire subtree first
  if (excludeRoot !== undefined) {
    const queue: string[] = [excludeRoot];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined) continue;
      if (excludeSet.has(id)) continue;
      excludeSet.add(id);
      for (const child of children.get(id) ?? []) {
        if (!excludeSet.has(child)) queue.push(child);
      }
    }
  }

  // BFS from parentId to collect all descendants, skipping excluded ids
  const queue: string[] = [parentId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) continue;
    if (visited.has(id) || excludeSet.has(id)) continue;
    visited.add(id);
    descendant.add(id);
    for (const child of children.get(id) ?? []) {
      queue.push(child);
    }
  }

  return descendant;
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

/**
 * Find the latest (by createdAt) IntentVersion for a given sessionId.
 * Returns null when no version exists.
 */
export function latestIntentVersionForSession(
  versions: readonly IntentVersion[],
  sessionId: string,
): IntentVersion | null {
  let latest: IntentVersion | null = null;
  for (const v of versions) {
    if (v.sessionId !== sessionId) continue;
    if (latest === null || v.createdAt > latest.createdAt) {
      latest = v;
    }
  }
  return latest;
}

// ---------------------------------------------------------------------------
// Invalidation planning
// ---------------------------------------------------------------------------

export interface CorrectionInvalidationPlan {
  readonly oldBranchIntentIds: readonly string[];
  readonly supersedeGoalIds: readonly string[];
  readonly preserveGoalIds: readonly string[];
}

const NON_TERMINAL_GOAL_STATES: ReadonlySet<GoalState> = new Set<GoalState>([
  'parked',
  'queued',
  'running',
]);

const TERMINAL_GOAL_STATES: ReadonlySet<GoalState> = new Set<GoalState>([
  'done',
  'failed',
  'blocked',
  'superseded',
]);

/**
 * Plan which goals to supersede after a correction fork.
 *
 * Only LIVE goals (parked/queued/running) whose intent ancestry traces to
 * the old branch are marked for supersession. Terminal, sibling, and
 * unprovenanced goals are preserved.
 */
export function planCorrectionGoalInvalidation(input: {
  goals: readonly Goal[];
  versions: readonly IntentVersion[];
  parentIntentId: string;
  newIntentId: string;
}): CorrectionInvalidationPlan {
  const { goals, versions, parentIntentId, newIntentId } = input;

  // Compute old-branch intent ids: all descendants of parentIntentId
  // EXCEPT newIntentId and its descendants
  const oldBranchIntentIds = intentDescendantIds(versions, parentIntentId, newIntentId);

  // Collect goal ids with reliable intent provenance to old-branch
  const goalsByIntent = new Map<string, string[]>();
  const goalsByParentGoal = new Map<string, string[]>();

  for (const g of goals) {
    if (g.intentVersionId !== undefined && oldBranchIntentIds.has(g.intentVersionId)) {
      let list = goalsByIntent.get(g.intentVersionId);
      if (list === undefined) {
        list = [];
        goalsByIntent.set(g.intentVersionId, list);
      }
      list.push(g.id);
    }
    const pg = g.parentGoalId;
    if (pg !== undefined && pg.length > 0) {
      let list = goalsByParentGoal.get(pg);
      if (list === undefined) {
        list = [];
        goalsByParentGoal.set(pg, list);
      }
      list.push(g.id);
    }
  }

  // Build the set of all goal ids that are intent descendants
  const intentDescendantGoalIds = new Set<string>(
    goals
      .filter((g) => g.intentVersionId !== undefined && oldBranchIntentIds.has(g.intentVersionId))
      .map((g) => g.id),
  );

  // Also include goals whose parentGoalId chain reaches an intent-descendant goal
  let changed = true;
  while (changed) {
    changed = false;
    for (const [parentId, children] of goalsByParentGoal) {
      if (!intentDescendantGoalIds.has(parentId)) continue;
      for (const childId of children) {
        if (!intentDescendantGoalIds.has(childId)) {
          intentDescendantGoalIds.add(childId);
          changed = true;
        }
      }
    }
  }

  // Classify each goal
  const supersedeGoalIds: string[] = [];
  const preserveGoalIds: string[] = [];

  for (const g of goals) {
    if (!intentDescendantGoalIds.has(g.id)) {
      // Not an intent descendant → sibling or unrelated → preserve
      preserveGoalIds.push(g.id);
      continue;
    }

    if (TERMINAL_GOAL_STATES.has(g.state)) {
      // Already terminal → preserve (done work is never overwritten)
      preserveGoalIds.push(g.id);
      continue;
    }

    if (g.goalVerdict !== undefined) {
      // Has a passing/reviewed verdict → preserve (verified work)
      preserveGoalIds.push(g.id);
      continue;
    }

    if (NON_TERMINAL_GOAL_STATES.has(g.state)) {
      // Live + old-branch → supersede
      supersedeGoalIds.push(g.id);
    } else {
      preserveGoalIds.push(g.id);
    }
  }

  return {
    oldBranchIntentIds: Array.from(oldBranchIntentIds),
    supersedeGoalIds,
    preserveGoalIds,
  };
}
