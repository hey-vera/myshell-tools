/**
 * src/core/work-state.ts — Adaptive Partner Engine v2, STAGE 2: persistent
 * work-state awareness ("what's done / what's next"), per adaptive-partner-v2-5.6.md
 * §2.3 B and the §4 Stage-2 real-run test.
 *
 * The persisted `SessionEntry.workTrace?: WorkContract` is an append-only AUDIT
 * trail that is "not consumed by runtime routing today" (types.ts). This module
 * closes that gap WITHOUT touching memory (durable user/project preference):
 * work-state is task/session continuity, derived ONLY from the workTrace folded
 * onto accepted prior assistant turns — never from profile memory.
 *
 * TRUTHFULNESS IS THE WHOLE POINT (§2.3 B "Rules for truthfulness"):
 *   - "Done" requires EVIDENCE. Valid evidence is a successful provider final with
 *     an explicit completed step (a roadmap item already at status 'done'), a
 *     passing command reported, a reviewer approval (contract verification
 *     verdict 'approve'), or GOAL_COMPLETE. `verifiedDone` holds ONLY such items.
 *   - `Checkpoint.summary` stays a model-STATED next action, NOT verified
 *     completion. It feeds `claimedNext`, never `verifiedDone`.
 *   - Roadmap status transitions are conservative; a 'blocked' item is reported
 *     blocked, an 'active' item is in progress, only an evidence-backed 'done'
 *     item is reported done.
 *   - NEVER infer completion from silence: an empty/absent assistant content, a
 *     missing roadmap, or a checkpoint with no evidence never becomes "done".
 *
 * PURE: no I/O, no time, no randomness (test/arch/guards.ts). A pure reducer over
 * an already-loaded, already-persisted history — NO model call, no API key, no
 * embeddings, no metered service (subscription-cost clean, §5).
 */

import type { SessionEntry } from './types.js';
import type {
  WorkContract,
  RoadmapItem,
  Checkpoint,
  ContractVerification,
} from './work-contract.js';

/**
 * The runtime work-state input (§2.3 B). A truthful, capped snapshot of where the
 * task stands, reconstructed from accepted prior turns' `workTrace`. Distinct from
 * memory; seeded only from `workTrace`.
 */
export interface WorkStateSnapshot {
  /** The latest objective from the most recent trusted workTrace. */
  readonly objective: string;
  /** The latest vision, when present. */
  readonly vision?: string;
  /** The latest roadmap (conservative item statuses), capped. */
  readonly roadmap: readonly RoadmapItem[];
  /** The most-recent model-stated next-action checkpoints, capped (claims, not done). */
  readonly recentCheckpoints: readonly Checkpoint[];
  /**
   * EVIDENCE-BACKED completed step texts ONLY (§2.3 B): roadmap items already at
   * status 'done', plus a GOAL_COMPLETE marker. Never a bare checkpoint summary.
   */
  readonly verifiedDone: readonly string[];
  /** The latest model-stated next action (clearly a CLAIM, not done). */
  readonly claimedNext?: string;
  /** Provenance. Stage 2 derives from persisted session workTrace. */
  readonly source: 'current-goal' | 'session-workTrace' | 'none';
}

/** Caps for the rendered WORK STATE block — small, honest, never crowds the task. */
const VERIFIED_DONE_LIMIT = 6;
const ROADMAP_RENDER_LIMIT = 8;
const RENDER_TEXT_LIMIT = 160;
const CLAIMED_NEXT_LIMIT = 200;

/** GOAL markers the autonomous /goal loop emits. */
const GOAL_COMPLETE_RE = /\bGOAL_COMPLETE\b/;

function capLine(value: string, limit: number): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? oneLine.slice(0, limit) : oneLine;
}

/**
 * Is a contract verification an evidence-backed approval? Only a reviewer
 * 'approve' verdict counts as evidence; 'revise'/'escalate' do NOT (the work was
 * sent back, so nothing is verified done by review). PURE.
 */
function isReviewApproved(v: ContractVerification | undefined): boolean {
  return v !== undefined && v.verdict === 'approve';
}

/**
 * The latest trusted `workTrace` from accepted prior turns. We scan assistant
 * entries oldest→newest and keep the LAST one carrying a workTrace (the most
 * recent trusted state). A resumed chat with stale prose still surfaces the
 * latest trusted workTrace, never the prose. PURE.
 *
 * Returns the trace plus whether ANY accepted assistant turn reported
 * GOAL_COMPLETE (evidence the goal finished).
 */
function latestTrace(
  history: readonly SessionEntry[],
): { readonly trace: WorkContract; readonly goalComplete: boolean } | undefined {
  let trace: WorkContract | undefined;
  let goalComplete = false;
  for (const entry of history) {
    if (entry === null || typeof entry !== 'object') continue;
    if (entry.role !== 'assistant') continue;
    // GOAL_COMPLETE is evidence the autonomous loop finished — it can appear on
    // any accepted assistant turn, independent of whether THAT turn carried a
    // trace, so scan content across all assistant entries.
    if (typeof entry.content === 'string' && GOAL_COMPLETE_RE.test(entry.content)) {
      goalComplete = true;
    }
    if (entry.workTrace !== undefined && entry.workTrace !== null) {
      trace = entry.workTrace;
    }
  }
  return trace !== undefined ? { trace, goalComplete } : undefined;
}

/**
 * Reconstruct a truthful {@link WorkStateSnapshot} from persisted history (§2.3 B).
 * PURE; never throws. Returns `undefined` when no accepted prior turn carries a
 * `workTrace` (an empty or trace-less history → no work-state, so the block is
 * omitted — never fabricated).
 *
 * Signature:
 *   deriveWorkStateFromHistory(history: readonly SessionEntry[]): WorkStateSnapshot | undefined
 *
 * Evidence rules ENFORCED here (truthful or absent):
 *   - `verifiedDone` is populated ONLY from roadmap items whose persisted status is
 *     already 'done' (the conservative transitions in work-contract advance an item
 *     to 'done' only on evidence/approval), from a review verdict of 'approve'
 *     (reviewer approval), and from a GOAL_COMPLETE marker. A passing command
 *     reported by the provider is captured as a 'done' roadmap item / approval, not
 *     re-parsed here.
 *   - `Checkpoint.summary` is treated as a CLAIM: it feeds `recentCheckpoints` and
 *     `claimedNext`, NEVER `verifiedDone`.
 *   - Completion is NEVER inferred from silence: a missing roadmap, an empty
 *     assistant turn, or a checkpoint without an evidence-backed 'done' item yields
 *     NO verifiedDone entry.
 */
export function deriveWorkStateFromHistory(
  history: readonly SessionEntry[],
): WorkStateSnapshot | undefined {
  if (!Array.isArray(history) || history.length === 0) return undefined;

  const found = latestTrace(history);
  if (found === undefined) return undefined;

  const { trace, goalComplete } = found;
  const objective = typeof trace.objective === 'string' ? trace.objective : '';
  // No usable objective and no roadmap/checkpoints → no honest work-state to show.
  const roadmap = Array.isArray(trace.roadmap) ? trace.roadmap : [];
  const checkpoints = Array.isArray(trace.checkpoints) ? trace.checkpoints : [];
  if (objective.length === 0 && roadmap.length === 0 && checkpoints.length === 0) {
    return undefined;
  }

  // verifiedDone: EVIDENCE-BACKED only.
  const verifiedDone: string[] = [];
  for (const item of roadmap) {
    if (item !== null && typeof item === 'object' && item.status === 'done') {
      const text = typeof item.text === 'string' && item.text.length > 0 ? item.text : item.id;
      if (typeof text === 'string' && text.length > 0) {
        verifiedDone.push(capLine(text, RENDER_TEXT_LIMIT));
      }
    }
  }
  // Reviewer approval is evidence the verified work passed — record it once.
  if (isReviewApproved(trace.verification)) {
    const note =
      trace.verification?.notes !== undefined && trace.verification.notes.length > 0
        ? `reviewer approved: ${trace.verification.notes}`
        : 'reviewer approved this work';
    verifiedDone.push(capLine(note, RENDER_TEXT_LIMIT));
  }
  // GOAL_COMPLETE is explicit evidence the objective finished.
  if (goalComplete) {
    verifiedDone.push('GOAL_COMPLETE: the objective was reported complete');
  }

  // claimedNext: the LATEST model-stated next action (a claim, not done). Prefer
  // the most recent checkpoint summary; never an evidence-backed completion.
  let claimedNext: string | undefined;
  for (const cp of checkpoints) {
    if (cp !== null && typeof cp === 'object' && typeof cp.summary === 'string' && cp.summary.length > 0) {
      claimedNext = capLine(cp.summary, CLAIMED_NEXT_LIMIT);
    }
  }

  const snapshot: WorkStateSnapshot = {
    objective: capLine(objective, RENDER_TEXT_LIMIT),
    ...(typeof trace.vision === 'string' && trace.vision.length > 0
      ? { vision: capLine(trace.vision, RENDER_TEXT_LIMIT) }
      : {}),
    roadmap: roadmap.slice(0, ROADMAP_RENDER_LIMIT),
    recentCheckpoints: checkpoints,
    verifiedDone: verifiedDone.slice(0, VERIFIED_DONE_LIMIT),
    ...(claimedNext !== undefined ? { claimedNext } : {}),
    source: 'session-workTrace',
  };
  return snapshot;
}

/**
 * Render the truthful `WORK STATE` block for the prompt seam (§2.3 B example).
 * Returns "" when there is no honest state to show (the seam then omits it). PURE.
 *
 * Shape (matches the doc example):
 *   WORK STATE (truthful, from accepted prior turns):
 *   OBJECTIVE: <objective>
 *   DONE: <evidence-backed done items; "none yet" when none>
 *   NEXT: <model-stated next action / active roadmap item; "unspecified" when none>
 *   BLOCKED: <blocked roadmap items; "none" when none>
 *
 * Honest by construction: DONE is "none yet" unless an evidence-backed item exists;
 * NEXT is a CLAIM; BLOCKED reflects only items the trace marks blocked.
 */
export function renderWorkStateBlock(snapshot: WorkStateSnapshot | undefined): string {
  if (snapshot === undefined || snapshot === null) return '';
  if (snapshot.source === 'none') return '';

  const lines: string[] = ['WORK STATE (truthful, from accepted prior turns):'];
  lines.push(`OBJECTIVE: ${snapshot.objective.length > 0 ? snapshot.objective : 'unspecified'}`);

  const done =
    snapshot.verifiedDone.length > 0 ? snapshot.verifiedDone.join('; ') : 'none yet (no verified evidence of completed work)';
  lines.push(`DONE: ${done}`);

  // NEXT prefers the explicit claimed next action; falls back to an active roadmap
  // item; never a 'done' item. Stays clearly a claim, not verified completion.
  const active = snapshot.roadmap.find((i) => i.status === 'active');
  const next =
    snapshot.claimedNext !== undefined && snapshot.claimedNext.length > 0
      ? snapshot.claimedNext
      : active !== undefined
        ? `${active.id}: ${active.text}`
        : 'unspecified — confirm the next step before acting';
  lines.push(`NEXT (model-stated, not yet verified): ${next}`);

  const blocked = snapshot.roadmap
    .filter((i) => i.status === 'blocked')
    .map((i) => `${i.id}: ${i.text}`);
  lines.push(`BLOCKED: ${blocked.length > 0 ? blocked.join('; ') : 'none'}`);

  return lines.join('\n');
}
