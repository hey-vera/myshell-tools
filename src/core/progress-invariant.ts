/**
 * src/core/progress-invariant.ts — pure progress invariant for auto-continue
 * and the per-goal manager cycle (CLAUDEPLAN R7 / Terra Loop Failure).
 *
 * Prevents status-theater loops: reworded heartbeats and identical "still working"
 * continuations are NOT progress. Meaningful progress requires a real signal:
 * verdict write, evidence, blocker/code change, or file/diff receipt.
 *
 * Tracks:
 *   - lastMeaningfulProgressAt (caller-supplied abstract tick; no Date.now)
 *   - progress fingerprint (hash of durable roadmap / evidence facts)
 *   - continuation count / no-progress streak
 *   - repeated blocker fingerprint
 *
 * After N consecutive no-progress cycles → shouldStopAutoContinue with a typed
 * blocked reason so the manager loop can stop honestly (not narrate forever).
 *
 * PURE: no I/O, no time, no randomness, never throws.
 */

import { buildBlockedRecord, type BlockedRecord } from './blocked.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default bound on consecutive cycles without meaningful progress. */
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

/**
 * Typed code for the no-progress terminal. Not yet in BlockedReasonCode
 * (kept local so we do not expand the shared blocked vocabulary without a
 * broader contract slice). Callers map to BlockedRecord via
 * {@link blockedRecordForNoProgress}.
 */
export type ProgressBlockedCode = 'no_meaningful_progress';

// ---------------------------------------------------------------------------
// Meaningful vs non-meaningful events
// ---------------------------------------------------------------------------

/**
 * Kinds that count as useful work (CLAUDEPLAN progress invariant).
 * Heartbeat / status-only rewrites never appear here.
 */
export type MeaningfulProgressKind =
  | 'verdict_write'
  | 'evidence'
  | 'blocker_code_change'
  | 'file_diff_receipt';

/** Observation recorded once per manager / auto-continue cycle. */
export type ProgressCycleObservation =
  | {
      readonly kind: MeaningfulProgressKind;
      /**
       * Stable fingerprint fragment for this event (e.g. verdict state+receipt,
       * changed paths joined, blocker item id+status). Empty string is allowed
       * but collapses identical empty events into one fingerprint cell.
       */
      readonly detail: string;
    }
  | {
      /** Reworded status, heartbeat, empty re-plan, or identical continue. */
      readonly kind: 'status_only';
      readonly detail?: string;
    }
  | {
      readonly kind: 'heartbeat';
      readonly detail?: string;
    };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface ProgressInvariantState {
  /**
   * Abstract tick of the last meaningful progress (caller clock / cycle index).
   * `null` until the first meaningful event. Never wall-clock from this module.
   */
  readonly lastMeaningfulProgressAt: number | null;
  /** Fingerprint of the last *meaningful* progress payload. */
  readonly progressFingerprint: string;
  /** Total observe calls (every cycle, meaningful or not). */
  readonly continuationCount: number;
  /** Consecutive cycles without meaningful progress. */
  readonly noProgressStreak: number;
  /**
   * Fingerprint of the last blocker-shaped observation (for detecting the same
   * blocker repeating without new evidence).
   */
  readonly lastBlockerFingerprint: string | null;
  /** How many times in a row the same blocker fingerprint was seen. */
  readonly repeatedBlockerCount: number;
}

export interface ProgressStopDecision {
  readonly shouldStopAutoContinue: boolean;
  /**
   * Present when shouldStopAutoContinue is true. Built via buildBlockedRecord
   * so invalid strings never ship as a half-empty blocked claim.
   */
  readonly blocked: BlockedRecord | null;
  readonly code: ProgressBlockedCode | null;
  readonly reason: string;
}

export interface ObserveProgressOptions {
  /** Abstract time/tick for lastMeaningfulProgressAt (required for purity). */
  readonly nowTick: number;
  /** Consecutive no-progress cycles before stop (default DEFAULT_NO_PROGRESS_LIMIT). */
  readonly noProgressLimit?: number;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/**
 * Build a stable, order-sensitive fingerprint from string parts.
 * Pure, never throws. Empty parts are kept so position stays meaningful.
 */
export function buildProgressFingerprint(parts: readonly string[]): string {
  const cleaned = parts.map((p) => (typeof p === 'string' ? p.replace(/\s+/g, ' ').trim() : ''));
  // Simple non-crypto mix suitable for equality tests only (not security).
  let h = 2166136261;
  const joined = cleaned.join('\u001f');
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // unsigned 32-bit hex + length for collision resistance in tests
  const u = (h >>> 0).toString(16).padStart(8, '0');
  return `${u}:${String(joined.length)}:${cleaned.length}`;
}

/**
 * Roadmap-shaped fingerprint for manager cycles: id|status|verdict|receipt per item.
 * Pure substrate so the interface layer can pass durable store truth without
 * re-deriving policy. Missing fields degrade to empty cells.
 */
export function fingerprintRoadmap(
  items: readonly {
    readonly id?: string;
    readonly status?: string;
    readonly verdict?: { readonly state?: string; readonly receipt?: string };
    readonly text?: string;
  }[],
): string {
  const parts: string[] = [];
  for (const it of items) {
    const id = typeof it.id === 'string' ? it.id : '';
    const status = typeof it.status === 'string' ? it.status : '';
    const vState = it.verdict?.state ?? '';
    const vReceipt = it.verdict?.receipt ?? '';
    // text is deliberately excluded: reworded status must not change fingerprint
    parts.push(`${id}|${status}|${vState}|${vReceipt}`);
  }
  return buildProgressFingerprint(parts);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** True when the observation is one of the four meaningful kinds. */
export function isMeaningfulProgress(obs: ProgressCycleObservation): boolean {
  return (
    obs.kind === 'verdict_write' ||
    obs.kind === 'evidence' ||
    obs.kind === 'blocker_code_change' ||
    obs.kind === 'file_diff_receipt'
  );
}

/**
 * Classify a manager-cycle step into a progress observation from concrete facts.
 * Pure composition — the sole place that decides "did this cycle count?".
 *
 * Priority (first match wins for the primary kind; fingerprint uses all facts):
 *  1. file/diff receipt when changed paths are non-empty
 *  2. verdict write when a verdict state was persisted
 *  3. evidence when verify evidence string is non-empty
 *  4. blocker/code change when status moved to blocked or a fix-it was spawned
 *  5. else status_only (reworded UI / empty replan / no durable change)
 */
export function classifyManagerCycleProgress(input: {
  readonly verdictState?: string;
  readonly verdictReceipt?: string;
  readonly changedPaths?: readonly string[];
  readonly evidenceNote?: string;
  readonly blockedItemId?: string;
  readonly fixItSpawned?: boolean;
  readonly roadmapFingerprintBefore?: string;
  readonly roadmapFingerprintAfter?: string;
}): ProgressCycleObservation {
  const paths = (input.changedPaths ?? []).filter((p) => typeof p === 'string' && p.trim().length > 0);
  if (paths.length > 0) {
    return {
      kind: 'file_diff_receipt',
      detail: buildProgressFingerprint([...paths].sort()),
    };
  }

  const vState = (input.verdictState ?? '').trim();
  if (vState.length > 0) {
    const receipt = (input.verdictReceipt ?? '').trim();
    // Identical failing/unverified verdict with no path change still *wrote*
    // a verdict — but if the after fingerprint equals before, treat as status
    // theater only when the verdict is not a real advance (passing/reviewed).
    const advanced = vState === 'passing' || vState === 'reviewed';
    const before = input.roadmapFingerprintBefore ?? '';
    const after = input.roadmapFingerprintAfter ?? '';
    if (advanced || before !== after || receipt.length > 0) {
      return {
        kind: 'verdict_write',
        detail: buildProgressFingerprint([vState, receipt, after]),
      };
    }
  }

  const evidence = (input.evidenceNote ?? '').trim();
  if (evidence.length > 0) {
    return { kind: 'evidence', detail: buildProgressFingerprint([evidence]) };
  }

  const blockedId = (input.blockedItemId ?? '').trim();
  if (blockedId.length > 0 || input.fixItSpawned === true) {
    return {
      kind: 'blocker_code_change',
      detail: buildProgressFingerprint([
        blockedId,
        input.fixItSpawned === true ? 'fixit' : '',
        input.roadmapFingerprintAfter ?? '',
      ]),
    };
  }

  // Roadmap fingerprint change without classified signal still counts as
  // blocker_code_change (durable plan mutation), not status theater.
  const before = input.roadmapFingerprintBefore ?? '';
  const after = input.roadmapFingerprintAfter ?? '';
  if (before.length > 0 && after.length > 0 && before !== after) {
    return {
      kind: 'blocker_code_change',
      detail: buildProgressFingerprint([before, after]),
    };
  }

  return { kind: 'status_only', detail: after || before || '' };
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/** Fresh invariant state for a new manager / goal auto-continue run. */
export function createProgressInvariantState(): ProgressInvariantState {
  return {
    lastMeaningfulProgressAt: null,
    progressFingerprint: '',
    continuationCount: 0,
    noProgressStreak: 0,
    lastBlockerFingerprint: null,
    repeatedBlockerCount: 0,
  };
}

/**
 * Build the typed blocked record used when auto-continue must stop.
 * Pure; returns null only if buildBlockedRecord rejects (should not for our constants).
 */
export function blockedRecordForNoProgress(input?: {
  readonly noProgressStreak?: number;
  readonly limit?: number;
  readonly progressFingerprint?: string;
}): BlockedRecord | null {
  const streak = input?.noProgressStreak ?? 0;
  const limit = input?.limit ?? DEFAULT_NO_PROGRESS_LIMIT;
  const fp = (input?.progressFingerprint ?? '').trim();
  const reason =
    `No meaningful progress for ${String(streak)} consecutive cycle(s) ` +
    `(limit ${String(limit)}). Heartbeat/status rewrites do not count; ` +
    `need a verdict write, evidence, blocker/code change, or file/diff receipt` +
    (fp.length > 0 ? ` (last fingerprint ${fp})` : '') +
    '.';
  return buildBlockedRecord({
    reason,
    nextAction:
      'Inspect the open to-do / worker, restore a checkpoint or replan a smaller slice, ' +
      'or answer any parked blocker — then resume. Do not auto-continue on status alone.',
    preservedWork:
      'Roadmap verdicts, blocked items, fix-it to-dos, and prior evidence receipts are kept; ' +
      'only automatic continuation stopped.',
    // Use verification_failed as the closest shared code when the loop stalls
    // without new verify evidence; the free-text reason carries the precise cause.
    code: 'verification_failed',
  });
}

/**
 * Whether the current state has already crossed the no-progress limit.
 * Pure read — does not mutate.
 */
export function shouldStopAutoContinue(
  state: ProgressInvariantState,
  noProgressLimit: number = DEFAULT_NO_PROGRESS_LIMIT,
): boolean {
  const limit =
    typeof noProgressLimit === 'number' && Number.isFinite(noProgressLimit) && noProgressLimit > 0
      ? Math.floor(noProgressLimit)
      : DEFAULT_NO_PROGRESS_LIMIT;
  return state.noProgressStreak >= limit;
}

/**
 * Observe one auto-continue / manager cycle and return the next state + stop decision.
 * Pure, total, never throws.
 *
 * Meaningful event with a *new* fingerprint → reset streak, update lastMeaningfulProgressAt.
 * Meaningful event with the *same* fingerprint as last progress → counts as no-progress
 * (identical continuation / stuck on the same receipt).
 * status_only / heartbeat → always increments no-progress streak.
 */
export function observeProgressCycle(
  state: ProgressInvariantState,
  observation: ProgressCycleObservation,
  options: ObserveProgressOptions,
): { readonly state: ProgressInvariantState; readonly decision: ProgressStopDecision } {
  const limitRaw = options.noProgressLimit;
  const limit =
    typeof limitRaw === 'number' && Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.floor(limitRaw)
      : DEFAULT_NO_PROGRESS_LIMIT;
  const nowTick =
    typeof options.nowTick === 'number' && Number.isFinite(options.nowTick) ? options.nowTick : 0;

  const continuationCount = state.continuationCount + 1;
  const meaningful = isMeaningfulProgress(observation);
  const detail =
    typeof observation.detail === 'string' ? observation.detail : '';
  const eventFp = meaningful
    ? buildProgressFingerprint([observation.kind, detail])
    : buildProgressFingerprint([observation.kind, detail]);

  let lastMeaningfulProgressAt = state.lastMeaningfulProgressAt;
  let progressFingerprint = state.progressFingerprint;
  let noProgressStreak = state.noProgressStreak;
  let lastBlockerFingerprint = state.lastBlockerFingerprint;
  let repeatedBlockerCount = state.repeatedBlockerCount;

  if (observation.kind === 'blocker_code_change') {
    if (lastBlockerFingerprint !== null && lastBlockerFingerprint === eventFp) {
      repeatedBlockerCount += 1;
    } else {
      lastBlockerFingerprint = eventFp;
      repeatedBlockerCount = 1;
    }
  }

  if (meaningful) {
    // Same fingerprint as last meaningful progress ⇒ not new progress (stuck loop).
    if (progressFingerprint.length > 0 && progressFingerprint === eventFp) {
      noProgressStreak += 1;
    } else {
      progressFingerprint = eventFp;
      lastMeaningfulProgressAt = nowTick;
      noProgressStreak = 0;
    }
  } else {
    noProgressStreak += 1;
  }

  const next: ProgressInvariantState = {
    lastMeaningfulProgressAt,
    progressFingerprint,
    continuationCount,
    noProgressStreak,
    lastBlockerFingerprint,
    repeatedBlockerCount,
  };

  const stop = shouldStopAutoContinue(next, limit);
  const blocked = stop
    ? blockedRecordForNoProgress({
        noProgressStreak: next.noProgressStreak,
        limit,
        progressFingerprint: next.progressFingerprint,
      })
    : null;

  const decision: ProgressStopDecision = {
    shouldStopAutoContinue: stop,
    blocked,
    code: stop ? 'no_meaningful_progress' : null,
    reason: stop
      ? (blocked?.reason ??
        `No meaningful progress for ${String(next.noProgressStreak)} cycle(s).`)
      : '',
  };

  return { state: next, decision };
}
