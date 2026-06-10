/**
 * src/core/work-contract.ts — pure work-contract helpers.
 *
 * Stage 1 keeps contracts ephemeral: they are rendered into verifier prompts
 * only, never persisted and never parsed from model output.
 */

import type { Classification } from './types.js';
import type { ReviewVerdict } from './review.js';
import type { VerifiedState } from './verify.js';

export type RoadmapStatus = 'pending' | 'active' | 'done' | 'blocked';

/**
 * Evidence-backed verdict for a single to-do item. `state` mirrors the
 * {@link VerifiedState} four-state union from verify.ts. Never hand-set by a
 * model — only written by the verify stage (Phase 4).
 */
export interface RoadmapItemVerdict {
  readonly state: VerifiedState;
  /** The honest receipt string from buildVerifyReceipt (verify.ts). */
  readonly receipt: string;
  /** The repo-relative paths the diff actually touched (the real grounding). */
  readonly changedPaths?: readonly string[];
  /** ISO timestamp when the verdict was recorded. */
  readonly at: string;
}

/**
 * The best-approach record — set by the goal-manager at planning time from
 * the SystemModel (Phase 5). Kept on the item so the approach can be
 * interrogated by the approach-quality critic.
 */
export interface RoadmapItemApproach {
  /** The chosen implementation strategy for this to-do. */
  readonly chosen: string;
  /** Alternatives the manager considered but did not choose. */
  readonly alternatives?: readonly string[];
  /** Why the chosen approach is preferred over the alternatives. */
  readonly rationale: string;
}

export interface RoadmapItem {
  readonly id: string;
  readonly text: string;
  readonly status: RoadmapStatus;
  /**
   * The explicit, checkable definition of done for this to-do. Authored at
   * to-do creation by the manager tier; threaded into the critic prompt so
   * verification is anchored to a real criterion (Part 3a).
   */
  readonly acceptanceCriterion?: string;
  /**
   * Evidence-backed verdict. Only written by the verify stage — never
   * hand-set by a model (hard anti-fabrication rule, Part 3a).
   */
  readonly verdict?: RoadmapItemVerdict;
  /**
   * The best-approach record set by the goal-manager at planning time
   * (Part 3b). Enables the approach-quality critic question.
   */
  readonly approach?: RoadmapItemApproach;
}

export interface Checkpoint {
  readonly id: string;
  /** A model-stated next action from a GOAL_CONTINUE marker, not a verified completion. */
  readonly summary: string;
  readonly roadmapId?: string;
  readonly evidence?: string;
}

export interface ContractVerification {
  readonly verdict: ReviewVerdict['verdict'];
  readonly notes?: string;
  readonly failedCheckpointIds?: readonly string[];
}

export interface WorkContract {
  readonly version: 1;
  readonly objective: string;
  readonly vision?: string;
  readonly roadmap?: readonly RoadmapItem[];
  readonly checkpoints?: readonly Checkpoint[];
  readonly verification?: ContractVerification;
}

type MaterializeContext = 'goal' | 'keep_going' | 'normal';

const ROADMAP_LIMIT = 8;
const CHECKPOINT_LIMIT = 6;
const OBJECTIVE_LIMIT = 240;
const VISION_LIMIT = 240;
const NOTES_LIMIT = 240;
const ROADMAP_TEXT_LIMIT = 160;
const CHECKPOINT_SUMMARY_LIMIT = 160;
const EVIDENCE_LIMIT = 120;
// New caps for Phase 2 data-model fields (Part 3 of the architecture).
const ACCEPTANCE_CRITERION_LIMIT = 400;
const VERDICT_RECEIPT_LIMIT = 400;
const VERDICT_PATH_LIMIT = 200;
const VERDICT_PATHS_LIMIT = 20;
const APPROACH_CHOSEN_LIMIT = 400;
const APPROACH_RATIONALE_LIMIT = 400;
const APPROACH_ALT_LIMIT = 160;
const APPROACH_ALTS_LIMIT = 8;

const VALID_VERIFIED_STATES: ReadonlySet<string> = new Set<VerifiedState>([
  'unverified',
  'reviewed',
  'passing',
  'failing',
]);

const VALID_STATUSES: ReadonlySet<string> = new Set<RoadmapStatus>([
  'pending',
  'active',
  'done',
  'blocked',
]);

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

function capStatus(value: unknown): RoadmapStatus {
  return typeof value === 'string' && VALID_STATUSES.has(value)
    ? (value as RoadmapStatus)
    : 'pending';
}

function capVerifiedState(value: unknown): VerifiedState | undefined {
  return typeof value === 'string' && VALID_VERIFIED_STATES.has(value)
    ? (value as VerifiedState)
    : undefined;
}

/**
 * Cap a single RoadmapItem defensively. Handles the three new optional Phase 2
 * fields (acceptanceCriterion, verdict, approach) with the same fail-soft,
 * never-throw discipline as the rest of the shapers. Unknown or malformed new
 * fields are OMITTED rather than defaulted, keeping the shape forward-compatible.
 * An item that was created WITHOUT the new fields round-trips byte-identically.
 */
export function capRoadmapItem(item: unknown): RoadmapItem {
  const r =
    item !== null && typeof item === 'object'
      ? (item as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const base: RoadmapItem = {
    id: safeString(r['id']),
    text: capText(r['text'], ROADMAP_TEXT_LIMIT),
    status: capStatus(r['status']),
  };

  // acceptanceCriterion — omit if absent or empty after capping.
  const ac = r['acceptanceCriterion'];
  const cappedAc = ac !== undefined ? capText(ac, ACCEPTANCE_CRITERION_LIMIT) : undefined;

  // verdict — omit the whole field if state is missing or invalid (anti-fabrication).
  let cappedVerdict: RoadmapItemVerdict | undefined;
  if (r['verdict'] !== undefined && r['verdict'] !== null && typeof r['verdict'] === 'object') {
    const v = r['verdict'] as Record<string, unknown>;
    const state = capVerifiedState(v['state']);
    if (state !== undefined) {
      cappedVerdict = {
        state,
        receipt: capText(v['receipt'], VERDICT_RECEIPT_LIMIT),
        at: safeString(v['at']),
        ...(Array.isArray(v['changedPaths'])
          ? {
              changedPaths: v['changedPaths']
                .slice(0, VERDICT_PATHS_LIMIT)
                .map((p) => capText(p, VERDICT_PATH_LIMIT)),
            }
          : {}),
      };
    }
    // If state is invalid/missing → cappedVerdict stays undefined (omit entirely).
  }

  // approach — omit the whole field if chosen or rationale is missing.
  let cappedApproach: RoadmapItemApproach | undefined;
  if (r['approach'] !== undefined && r['approach'] !== null && typeof r['approach'] === 'object') {
    const a = r['approach'] as Record<string, unknown>;
    const chosen = capText(a['chosen'], APPROACH_CHOSEN_LIMIT);
    const rationale = capText(a['rationale'], APPROACH_RATIONALE_LIMIT);
    if (chosen.length > 0 && rationale.length > 0) {
      cappedApproach = {
        chosen,
        rationale,
        ...(Array.isArray(a['alternatives'])
          ? {
              alternatives: a['alternatives']
                .slice(0, APPROACH_ALTS_LIMIT)
                .map((alt) => capText(alt, APPROACH_ALT_LIMIT)),
            }
          : {}),
      };
    }
    // If chosen/rationale missing → cappedApproach stays undefined (omit).
  }

  return {
    ...base,
    ...(cappedAc !== undefined ? { acceptanceCriterion: cappedAc } : {}),
    ...(cappedVerdict !== undefined ? { verdict: cappedVerdict } : {}),
    ...(cappedApproach !== undefined ? { approach: cappedApproach } : {}),
  };
}

/**
 * Return a deterministic, capped copy of a contract. This function is defensive
 * at runtime and never throws on malformed values.
 */
export function capContract(c: WorkContract): WorkContract {
  const rawValue = c as unknown;
  const raw =
    rawValue !== null && typeof rawValue === 'object'
      ? (rawValue as {
          readonly objective?: unknown;
          readonly vision?: unknown;
          readonly roadmap?: unknown;
          readonly checkpoints?: unknown;
          readonly verification?: unknown;
        })
      : {};

  const roadmap = Array.isArray(raw.roadmap)
    ? raw.roadmap.slice(0, ROADMAP_LIMIT).map(capRoadmapItem)
    : undefined;

  const checkpoints = Array.isArray(raw.checkpoints)
    ? raw.checkpoints.slice(0, CHECKPOINT_LIMIT).map((checkpoint) => {
        const cp =
          checkpoint !== null && typeof checkpoint === 'object'
            ? (checkpoint as {
                readonly id?: unknown;
                readonly summary?: unknown;
                readonly roadmapId?: unknown;
                readonly evidence?: unknown;
              })
            : {};
        return {
          id: safeString(cp.id),
          summary: capText(cp.summary, CHECKPOINT_SUMMARY_LIMIT),
          ...(cp.roadmapId !== undefined ? { roadmapId: safeString(cp.roadmapId) } : {}),
          ...(cp.evidence !== undefined ? { evidence: capText(cp.evidence, EVIDENCE_LIMIT) } : {}),
        };
      })
    : undefined;

  const verification =
    raw.verification !== undefined && raw.verification !== null
      ? (raw.verification as {
          readonly verdict?: unknown;
          readonly notes?: unknown;
          readonly failedCheckpointIds?: unknown;
        })
      : undefined;

  // Honesty gate: only an EXPLICIT positive verdict counts as approval. A
  // missing, malformed, or under-specified verdict (e.g. `{}` or `verdict:'bad'`)
  // must NOT silently default to 'approve' — that would let a weak verification
  // payload fabricate "verified done" downstream (work-state.isReviewApproved).
  // Anything that is not an exact 'approve'/'revise'/'escalate' falls back to the
  // fail-safe non-approval verdict 'revise' (the reviewer "sent it back").
  const verdict =
    verification?.verdict === 'approve' ||
    verification?.verdict === 'revise' ||
    verification?.verdict === 'escalate'
      ? verification.verdict
      : 'revise';
  const failedCheckpointIds = Array.isArray(verification?.failedCheckpointIds)
    ? verification.failedCheckpointIds.map(safeString)
    : undefined;

  return {
    version: 1,
    objective: capText(raw.objective, OBJECTIVE_LIMIT),
    ...(raw.vision !== undefined ? { vision: capText(raw.vision, VISION_LIMIT) } : {}),
    ...(roadmap !== undefined ? { roadmap } : {}),
    ...(checkpoints !== undefined ? { checkpoints } : {}),
    ...(verification !== undefined
      ? {
          verification: {
            verdict,
            ...(verification.notes !== undefined
              ? { notes: capText(verification.notes, NOTES_LIMIT) }
              : {}),
            ...(failedCheckpointIds !== undefined ? { failedCheckpointIds } : {}),
          },
        }
      : {}),
  };
}

export function renderContractForPrompt(c: WorkContract): string {
  const lines = [`OBJECTIVE: ${c.objective}`];

  if (c.vision !== undefined && c.vision.length > 0) {
    lines.push(`VISION: ${c.vision}`);
  }

  if (c.roadmap !== undefined && c.roadmap.length > 0) {
    lines.push('ROADMAP:');
    for (const item of c.roadmap) {
      lines.push(`- [${item.status}] ${item.id}: ${item.text}`);
    }
  }

  if (c.checkpoints !== undefined && c.checkpoints.length > 0) {
    lines.push("RECENT STEPS (each turn's stated next action):");
    for (const checkpoint of c.checkpoints) {
      const roadmap = checkpoint.roadmapId !== undefined ? ` (${checkpoint.roadmapId})` : '';
      const evidence = checkpoint.evidence !== undefined ? ` — evidence: ${checkpoint.evidence}` : '';
      lines.push(`- ${checkpoint.id}${roadmap}: ${checkpoint.summary}${evidence}`);
    }
  }

  return lines.join('\n');
}

/**
 * Fold one autonomous /goal GOAL_CONTINUE next-step into the contract's running
 * next-action trace. These entries are what the model said it would do next,
 * not verified completed progress. Keeps the most recent CHECKPOINT_LIMIT
 * entries, dropping the oldest when the trace grows past the prompt cap.
 */
export function appendCheckpointFromContinue(
  contract: WorkContract,
  continueText: string,
  turnIndex: number,
): WorkContract {
  const summary = safeString(continueText).trim();
  if (summary.length === 0) return contract;

  const capped = capContract(contract);
  const nextCheckpoint: Checkpoint = {
    id: `C${turnIndex + 1}`,
    summary,
  };
  const checkpoints = [...(capped.checkpoints ?? []), nextCheckpoint].slice(-CHECKPOINT_LIMIT);

  return capContract({
    ...capped,
    checkpoints,
  });
}

export function shouldMaterializeContract(opts: {
  readonly classification: Classification;
  readonly routePlan: boolean;
  readonly context: MaterializeContext;
  readonly reviewWillRun: boolean;
}): { readonly criteria: boolean; readonly roadmap: boolean } {
  return {
    criteria: opts.reviewWillRun,
    roadmap:
      opts.context !== 'normal' ||
      opts.routePlan === true ||
      opts.classification.tier === 'manager',
  };
}

export function isCleanObjectiveTask(task: string): boolean {
  const trimmed = task.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith('OBJECTIVE:')) return false;
  if (trimmed.includes('\nBefore acting, confirm this turn still directly serves the OBJECTIVE')) {
    return false;
  }
  return true;
}
