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
  /**
   * Intra-goal dependency edges: ids of SIBLING roadmap items this one blocks on.
   * Additive + optional (mirrors approach/verdict): absent ⇒ the item is
   * independent and the linear march behaves EXACTLY as before. Normalized
   * fail-soft in {@link capRoadmapItem}: kept only when they reference existing
   * siblings, self-edges dropped, deduped, capped at {@link DEPENDS_ON_LIMIT}, and
   * any edge that would form a CYCLE is stripped (degrade to fewer edges, never a
   * deadlock — mirrors decompose.ts cycle-stripping).
   */
  readonly dependsOn?: readonly string[];
  /**
   * Optional 1-level grouping: the id of a SIBLING item used as a group header.
   * Depth is capped at exactly 1 — a parent that is itself a child (or a self/
   * cyclic reference) is dropped fail-soft. Absent ⇒ ungrouped (the default).
   * Hierarchy beyond one level lives at the goal boundary (cap-8 ⇒ child goal),
   * never as a deep tree here.
   */
  readonly parentId?: string;
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
  readonly intentVersionId?: string;
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
/** Bounded dependency fan-in per to-do (a handful of real blockers, not a web). */
export const DEPENDS_ON_LIMIT = 7;
const DEPENDS_ON_ID_LIMIT = 64;
const PARENT_ID_LIMIT = 64;

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

  // dependsOn — shape per-item only (dedupe, drop self/empty, cap length). The
  // RELATIONAL guards (sibling-existence + cycle-strip) need the full roadmap and
  // run in normalizeRoadmapRelations (called by capRoadmap / capContract). When an
  // item is capped in ISOLATION (no sibling context) the raw ids are preserved here
  // and validated at the array level; a self-edge or empty id is always dropped.
  let cappedDependsOn: string[] | undefined;
  if (Array.isArray(r['dependsOn'])) {
    const selfId = base.id;
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const raw of r['dependsOn']) {
      const id = safeString(raw).slice(0, DEPENDS_ON_ID_LIMIT).trim();
      if (id.length === 0 || id === selfId || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= DEPENDS_ON_LIMIT) break;
    }
    if (ids.length > 0) cappedDependsOn = ids;
  }

  // parentId — shape per-item only (string + cap). Depth/cycle guard is relational
  // and runs in normalizeRoadmapRelations. A self-reference is dropped here.
  let cappedParentId: string | undefined;
  if (r['parentId'] !== undefined) {
    const pid = safeString(r['parentId']).slice(0, PARENT_ID_LIMIT).trim();
    if (pid.length > 0 && pid !== base.id) cappedParentId = pid;
  }

  return {
    ...base,
    ...(cappedAc !== undefined ? { acceptanceCriterion: cappedAc } : {}),
    ...(cappedVerdict !== undefined ? { verdict: cappedVerdict } : {}),
    ...(cappedApproach !== undefined ? { approach: cappedApproach } : {}),
    ...(cappedDependsOn !== undefined ? { dependsOn: cappedDependsOn } : {}),
    ...(cappedParentId !== undefined ? { parentId: cappedParentId } : {}),
  };
}

/**
 * Apply the RELATIONAL guards to a roadmap's dependency edges + grouping refs —
 * the part that needs the WHOLE item set (sibling existence, cycle-freedom,
 * 1-level depth). Mirrors decompose.ts: unknown/self edges are dropped, and any
 * item on a CYCLE has its `dependsOn` stripped so the graph degrades to fewer
 * edges rather than a deadlock. `parentId` is kept only when it points at an
 * existing SIBLING that is itself NOT a child (depth cap = 1) and forms no cycle;
 * otherwise the field is dropped. PURE, total, never throws. An item with neither
 * field round-trips byte-identically (the spread omits absent fields).
 */
export function normalizeRoadmapRelations(items: readonly RoadmapItem[]): RoadmapItem[] {
  const ids = new Set<string>();
  for (const it of items) if (it.id.length > 0) ids.add(it.id);

  // Pass 1: drop unknown/self dep ids (sibling-existence guard), dedupe, and cap
  // the fan-in at DEPENDS_ON_LIMIT. Done HERE too (not only in capRoadmapItem) so
  // this function is robust when called on raw items (e.g. the re-plan reducer
  // sets edges directly, never round-tripping through capRoadmapItem first).
  const deps = new Map<string, string[]>();
  for (const it of items) {
    if (it.dependsOn === undefined) continue;
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const d of it.dependsOn) {
      if (d === it.id || !ids.has(d) || seen.has(d)) continue;
      seen.add(d);
      kept.push(d);
      if (kept.length >= DEPENDS_ON_LIMIT) break;
    }
    deps.set(it.id, kept);
  }

  // Pass 2: break cycles with a Kahn-style topological peel (mirrors
  // decompose.ts/breakCycles). Anything that cannot be ordered is on a cycle →
  // strip ANY of its edges that point at a node not peel-ordered. We track the
  // PEEL-ordered set separately from the post-peel sweep so a later item on the
  // same cycle can never have its back-edge spuriously "satisfied" by an earlier
  // item we just added during the sweep.
  const peelOrdered = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const it of items) {
      if (peelOrdered.has(it.id)) continue;
      const d = deps.get(it.id) ?? [];
      if (d.every((x) => peelOrdered.has(x))) {
        peelOrdered.add(it.id);
        progressed = true;
      }
    }
  }
  // Sweep: every item NOT peel-ordered is on (or downstream of) a cycle — keep
  // only its edges to peel-ordered nodes (honest edges survive; the cyclic ones
  // are dropped), so the graph degrades to fewer edges rather than a deadlock.
  for (const it of items) {
    if (!peelOrdered.has(it.id)) {
      deps.set(it.id, (deps.get(it.id) ?? []).filter((x) => peelOrdered.has(x)));
    }
  }

  // parentId depth guard: a valid parent is an existing sibling that is NOT itself
  // a child (depth cap = 1) and is not the item itself. Compute the set of items
  // that are children-candidates first (those with a surviving parentId), then
  // resolve depth: a parent must NOT have a parentId of its own.
  const rawParent = new Map<string, string>();
  for (const it of items) {
    if (it.parentId !== undefined && it.parentId !== it.id && ids.has(it.parentId)) {
      rawParent.set(it.id, it.parentId);
    }
  }
  const parent = new Map<string, string>();
  for (const [childId, parentId] of rawParent) {
    // depth = 1: the parent itself must not be a child (no grandparents) and must
    // not point back at this child (no 2-cycle).
    if (rawParent.has(parentId)) continue; // parent is itself grouped → over-depth, drop
    if (rawParent.get(parentId) === childId) continue; // direct cycle, drop
    parent.set(childId, parentId);
  }

  return items.map((it) => {
    const nextDeps = deps.get(it.id) ?? [];
    const nextParent = parent.get(it.id);
    // Rebuild WITHOUT the two relational fields, then re-add only the survivors so
    // an item whose edges were all stripped omits the field entirely (byte-identical
    // to one that never had it).
    const { dependsOn: _d, parentId: _p, ...rest } = it;
    return {
      ...rest,
      ...(nextDeps.length > 0 ? { dependsOn: nextDeps } : {}),
      ...(nextParent !== undefined ? { parentId: nextParent } : {}),
    };
  });
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
          readonly intentVersionId?: unknown;
        })
      : {};

  const intentVersionId =
    typeof raw.intentVersionId === 'string' && raw.intentVersionId.trim().length > 0
      ? raw.intentVersionId
      : undefined;

  const roadmap = Array.isArray(raw.roadmap)
    ? normalizeRoadmapRelations(raw.roadmap.slice(0, ROADMAP_LIMIT).map(capRoadmapItem))
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
    ...(intentVersionId !== undefined ? { intentVersionId } : {}),
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

export function stampContractIntentVersion(
  c: WorkContract | undefined,
  id: string | undefined,
): WorkContract | undefined {
  if (c === undefined) return undefined;
  if (id === undefined || typeof id !== 'string' || id.trim().length === 0) return c;
  return capContract({ ...c, intentVersionId: id });
}
