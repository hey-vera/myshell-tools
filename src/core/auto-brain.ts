/**
 * src/core/auto-brain.ts — the AUTO BRAIN: per-turn rung-fusion + receipt.
 *
 * Implements the locked "predict-and-commit" Auto architecture from
 * docs/one-chat-redesign-plan.md §Auto — Locked Design Decisions.
 *
 * TWO LAYERS:
 *
 * LAYER A — predict & commit (the spine, fully implemented here).
 *   `fuseRung` is a PURE function that resolves the {@link RungTuple} for the
 *   turn from THREE signals, fused in priority order:
 *
 *     1. Byproduct ROUTE HINT (from the existing IntentFrame): the model's
 *        `routeTier` hint and `operationRisk`/`blastRadius` signals are read
 *        STRUCTURALLY (no new model call — byproduct of the turn in progress).
 *        Tier hint → suggested level; highest of operationRisk / blastRadius
 *        bumps that level up one step when the risk warrants it.
 *     2. Deterministic floor from classify() signals: the classification tier
 *        and risk come from the existing deterministic classifier (`classify.ts`)
 *        — also no new model call. The floor is the level the classify signals
 *        alone would pick.
 *     3. Per-project memory bias (`memoryBias: -1 | 0 | 1`): the taste ledger's
 *        accumulated ask-vs-proceed dial, applied as a ±1 nudge on the resolved
 *        level AFTER the byproduct/floor fusion.
 *
 *   The result is then clamped to the user's capacity ceiling (the caller
 *   passes the highest level they want to allow). On byproduct-flagged HARD /
 *   BIG turns (manager routeTier + high/critical operationRisk or blastRadius),
 *   `fuseRung` skips any cheap probe and commits straight to the appropriate
 *   rung — no tentative downgrade.
 *
 *   `buildAutoBrainReceipt` renders the legible per-turn RECEIPT: one line
 *   surfacing the committed rung, the objective reason, and the cost tier.
 *
 * LAYER B — objective-evidence-only escalation.
 *   The escalation re-point lives in `shouldEscalate` and `shouldDeEscalate`.
 *   Both are PURE decision functions over objective, machine-checkable signals
 *   (test/typecheck/lint failures, scope growth, explicit user pushback, stall).
 *   SELF-CONFIDENCE IS BANNED from the trigger (locked decision #5); it may
 *   appear as a tie-breaker at most. Hysteresis constants protect against
 *   thrash. These pure helpers remain tested helpers, and the live within-turn
 *   Layer B path is `decideLayerBEscalation`, wired through
 *   `src/core/work-call.ts:1012-1064` when Auto Brain committed a rung.
 *
 * PURE module: no I/O, no time, no randomness, no module state. Every export is
 * a total function that never throws (bad input → safe default). Enforced by
 * test/arch/guards.test.ts.
 *
 * Default-on in production via `experimentalEnabledByDefault` composing
 * `autoBrainEnabled` (src/interface/ui/auto-brain-flag.ts). The flag's pure helper
 * is default-false for neutrality tests. When the flag is off/basic-mode,
 * `orchestrate` never reads any field in this module and the path is
 * BYTE-FOR-BYTE today's. See the seam in `OrchestrateDeps.autoBrainRungTuple`.
 */

import type { Tier, Risk } from './types.js';
import type { IntentFrame } from './intent.js';
import {
  type Level,
  type RungTuple,
  rungTupleForLevel,
  resolveLevel,
} from './mode-levels.js';
import type { Mode } from './policy.js';

// ---------------------------------------------------------------------------
// Intent-shape detection (structural read from existing byproduct — no new call)
// ---------------------------------------------------------------------------

/**
 * The intent shapes Auto recognises STRUCTURALLY from the existing byproduct.
 * Read off IntentFrame.kind + routeTier + operationRisk/blastRadius; no new
 * model call needed.
 *
 * - `paste-code`    : user pasted code for review/explain (worker-shaped).
 * - `fix-bug`       : targeted repair, bounded scope (ic-shaped).
 * - `vague-discuss` : exploratory/conversational, no clear build intent.
 * - `big-build`     : manager-tier: architecture, migration, multi-file new work.
 * - `unknown`       : shape not determinable from available signals.
 */
export type IntentShape = 'paste-code' | 'fix-bug' | 'vague-discuss' | 'big-build' | 'unknown';

/**
 * Derive the {@link IntentShape} STRUCTURALLY from the existing byproduct.
 * Reads `IntentFrame.routeTier` (the model's tier hint), `kind` (open-vocab
 * work kind), and `operationRisk`/`blastRadius` (risk hints). No new model
 * call; falls back to `'unknown'` on any absent/garbled field. PURE, total.
 */
export function intentShapeOf(frame: IntentFrame | null | undefined): IntentShape {
  try {
    if (frame === null || frame === undefined) return 'unknown';

    const routeTier = frame.routeTier;
    const kind = (frame.kind ?? '').toLowerCase();
    const opRisk = frame.operationRisk;
    const blast = frame.blastRadius;

    // Big-build: manager tier OR high/critical risk on either dimension.
    if (
      routeTier === 'manager' ||
      opRisk === 'high' || opRisk === 'critical' ||
      blast === 'high' || blast === 'critical'
    ) {
      return 'big-build';
    }

    // Paste-code: explanatory / summarize / read-only kind with worker tier.
    if (
      routeTier === 'worker' ||
      /\bexplain\b|\bsummar|\bpastebin\b|\breview\b|\bdescribe\b/.test(kind)
    ) {
      return 'paste-code';
    }

    // Vague-discuss: low-confidence goal or no build intent evident.
    if (
      frame.confidence === 'low' ||
      /\bdiscuss\b|\bchat\b|\bask\b|\bquestion\b|\bhelp\b|\bwhat is\b/.test(kind)
    ) {
      return 'vague-discuss';
    }

    // Fix-bug: targeted repair signals.
    if (
      routeTier === 'ic' ||
      /\bfix\b|\bbug\b|\bdebug\b|\berror\b|\brepair\b|\bpatch\b/.test(kind)
    ) {
      return 'fix-bug';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Floor derivation from classify() signals (deterministic, no model call)
// ---------------------------------------------------------------------------

/**
 * The deterministic {@link Level} floor from the EXISTING classifier outputs —
 * the tier and risk from `classify()` (which have zero model-call cost). This
 * is the Auto brain's safety net: the fused rung may go ABOVE this floor but
 * NEVER below it (locked decision #3). PURE, total.
 */
export function floorFromClassification(
  tier: Tier | undefined,
  risk: Risk | undefined,
): Exclude<Level, 'auto'> {
  try {
    // Critical or high risk demands at least High rung regardless of tier.
    if (risk === 'critical') return 'high';
    if (risk === 'high') return 'high';

    // Manager tier warrants at least High.
    if (tier === 'manager') return 'high';

    // IC tier with medium risk: balanced.
    if (tier === 'ic') return 'balanced';

    // Worker + low risk: budget is the floor.
    if (tier === 'worker') return 'budget';

    // No clear signals → safe middle ground (balanced).
    return 'balanced';
  } catch {
    return 'balanced';
  }
}

// ---------------------------------------------------------------------------
// Memory bias → level nudge (per-project taste signal)
// ---------------------------------------------------------------------------

/**
 * A closed union for the rank of a concrete {@link Level} on the budget→max
 * ladder. Mirrors `levelRank` in mode-levels.ts (intentionally NOT re-exported
 * from there — keep this module independent).
 */
type LevelRank = 0 | 1 | 2 | 3;

function rankOf(level: Exclude<Level, 'auto'>): LevelRank {
  switch (level) {
    case 'budget': return 0;
    case 'balanced': return 1;
    case 'high': return 2;
    case 'max': return 3;
  }
}

const LEVEL_AT_RANK: readonly Exclude<Level, 'auto'>[] = ['budget', 'balanced', 'high', 'max'];

function levelAtRank(rank: number): Exclude<Level, 'auto'> {
  const clamped = Math.max(0, Math.min(3, rank)) as LevelRank;
  // The cast is safe: clamped is always 0–3 and the array has exactly 4 elements.
  return LEVEL_AT_RANK[clamped] as Exclude<Level, 'auto'>;
}

/**
 * Apply the per-project memory bias (the taste ledger's ask-vs-proceed dial)
 * as a ±1 nudge on the resolved level.
 *
 *   +1 (proceed bias): nudge DOWN one rung (the user prefers fast execution).
 *   -1 (ask bias): nudge UP one rung (the user prefers deeper, more careful work).
 *    0 (neutral): no nudge.
 *
 * Note the sign convention: a +1 "proceed" bias means the user acts quickly, so
 * Auto spends LESS firepower; a -1 "ask" bias means the user is cautious, so Auto
 * spends MORE. Always clamped to budget…max. PURE, total.
 */
export function applyMemoryBias(
  level: Exclude<Level, 'auto'>,
  memoryBias: -1 | 0 | 1 | undefined,
): Exclude<Level, 'auto'> {
  try {
    if (memoryBias === undefined || memoryBias === 0) return level;
    // +1 proceed bias → lower rung; -1 ask bias → higher rung.
    const nudge = memoryBias === 1 ? -1 : 1;
    return levelAtRank(rankOf(level) + nudge);
  } catch {
    return level;
  }
}

// ---------------------------------------------------------------------------
// Capacity ceiling
// ---------------------------------------------------------------------------

/**
 * Clamp the resolved level to the capacity ceiling the caller asserts
 * (e.g. the user's plan max). When `ceiling` is absent no clamp is applied.
 * PURE, total.
 */
export function clampToCeiling(
  level: Exclude<Level, 'auto'>,
  ceiling: Exclude<Level, 'auto'> | undefined,
): Exclude<Level, 'auto'> {
  try {
    if (ceiling === undefined) return level;
    return rankOf(level) <= rankOf(ceiling) ? level : ceiling;
  } catch {
    return level;
  }
}

// ---------------------------------------------------------------------------
// Layer A: rung-fusion — the predict-and-commit spine
// ---------------------------------------------------------------------------

/**
 * Inputs to the rung-fusion function. All fields optional so callers may pass
 * only what they have; absent signals → safe defaults.
 */
export interface FuseRungInput {
  /**
   * The byproduct IntentFrame from the turn in progress (the model's structural
   * routing hint — no new model call). Used for `routeTier`, `operationRisk`,
   * `blastRadius`, `kind`, `confidence`. Absent → byproduct signal unavailable.
   */
  readonly frame?: IntentFrame | null;
  /**
   * The deterministic CLASSIFICATION outputs from `classify()` (also no new
   * model call). Used for the floor derivation.
   */
  readonly classifyTier?: Tier;
  readonly classifyRisk?: Risk;
  /**
   * The per-project memory bias from the taste ledger (`distillTaste().memoryBias`).
   * Absent → 0 (no nudge).
   */
  readonly memoryBias?: -1 | 0 | 1;
  /**
   * The user's capacity ceiling — the highest level they want Auto to commit.
   * Absent → no ceiling clamped (Auto may go up to Max). Derived from plan
   * detection + the existing `flagshipAdmission` logic.
   */
  readonly capacityCeiling?: Exclude<Level, 'auto'>;
  /**
   * Persisted legacy `config.mode`, if any (for the resolveLevel fallback chain
   * when neither the byproduct nor classify signals give a strong enough signal).
   */
  readonly persistedMode?: Mode | string | null;
  /**
   * Plan-derived auto mode (today's `resolveAutoMode`), if computed.
   */
  readonly autoMode?: Mode;
}

/**
 * The result of the rung-fusion decision, ready to surface and act on.
 */
export interface FuseRungResult {
  /** The committed six-dial rung tuple Auto will use this turn. */
  readonly rung: RungTuple;
  /**
   * The objective reason for the committed rung (for the receipt / ledger).
   * Always a non-empty string, never "model said so".
   */
  readonly reason: string;
  /**
   * The intent shape detected from the byproduct (for the receipt).
   * `'unknown'` when no byproduct signal was available.
   */
  readonly intentShape: IntentShape;
  /**
   * True when the byproduct flagged a HARD/BIG turn (manager routeTier OR
   * high/critical risk) and Auto committed straight to the right rung, skipping
   * any cheaper probe (locked decision #8).
   */
  readonly predictAndCommit: boolean;
}

/**
 * LAYER A: the rung-fusion function — PURE, total, the predict-and-commit spine.
 *
 * Resolves the {@link RungTuple} for the turn by fusing three ordered signals:
 *
 *   1. Byproduct hint: read STRUCTURALLY from the existing IntentFrame (no new
 *      model call). Manager routeTier + high/critical risk → commit straight to
 *      `high` or `max` (predict-and-commit, locked decision #8).
 *   2. Deterministic floor from classify() tier + risk.
 *   3. Memory bias: per-project ±1 nudge from the taste ledger.
 *
 * The final rung is clamped to `input.capacityCeiling` (never below Budget).
 * On HARD/BIG turns the fusion is fast-tracked — no cheap probe, no tentative
 * downgrade. On ambiguous turns the existing `resolveLevel` fallback chain runs.
 *
 * PURE: no I/O, no time, no randomness, no side effects. Safe on any input.
 */
export function fuseRung(input: FuseRungInput): FuseRungResult {
  try {
    const { frame, classifyTier, classifyRisk, memoryBias, capacityCeiling, persistedMode, autoMode } = input;

    // --- Step 1: read the byproduct STRUCTURALLY ---
    const shape = intentShapeOf(frame);
    const floor = floorFromClassification(classifyTier, classifyRisk);

    // Detect HARD/BIG turn: byproduct flagged manager tier OR high/critical risk.
    const isBigBuild = shape === 'big-build';
    const isHighRisk = classifyRisk === 'high' || classifyRisk === 'critical';
    const isManagerTier = classifyTier === 'manager';
    const hardTurn = isBigBuild || isHighRisk || isManagerTier;

    let committed: Exclude<Level, 'auto'>;
    let reason: string;
    let predictAndCommit = false;

    if (hardTurn) {
      // Predict-and-commit: skip cheap probe, commit to right rung immediately.
      predictAndCommit = true;
      // Big-build with critical risk → max; high risk or manager → high.
      if (
        isBigBuild &&
        (classifyRisk === 'critical' || frame?.operationRisk === 'critical' || frame?.blastRadius === 'critical')
      ) {
        committed = 'max';
        reason = `hard turn: big-build intent + critical risk → max (predict-and-commit)`;
      } else if (isBigBuild || isManagerTier) {
        committed = 'high';
        reason = `hard turn: ${isBigBuild ? 'big-build intent' : 'manager-tier classify'} → high (predict-and-commit)`;
      } else {
        // high risk only
        committed = 'high';
        reason = `hard turn: ${classifyRisk} risk → high (predict-and-commit)`;
      }

      // Clamp to floor (floor may actually push us above the byproduct for safety).
      if (rankOf(committed) < rankOf(floor)) {
        committed = floor;
        reason = `hard turn: floor-clamped to ${floor} (classify: tier=${classifyTier ?? 'none'}, risk=${classifyRisk ?? 'none'})`;
      }
    } else {
      // --- Step 2: byproduct hint drives the rung; floor is a SOFT safety net ---
      // Per locked decision #3: byproduct hint MAY lower below the classify floor,
      // but NEVER below Budget. So for non-hard turns, trust the byproduct hint
      // (which may resolve to budget for genuinely trivial turns), then clamp to
      // Budget as the absolute hard floor — NOT to the classify floor.
      const byproductLevel = frame?.routeTier !== undefined
        ? tierToLevel(frame.routeTier)
        : undefined;

      // exactOptionalPropertyTypes: only include fields when they have a real value.
      // Pass `floor: 'budget'` as the hint floor so resolveRouteHint clamps to Budget
      // (the locked hard floor) rather than to the classify-derived floor — this is
      // what allows a trivial turn (worker, low-risk "thanks!") to resolve to budget.
      committed = resolveLevel({
        chosen: 'auto',
        ...(byproductLevel !== undefined
          ? { routeHint: { suggestedLevel: byproductLevel, floor: 'budget' } }
          : {}),
        ...(persistedMode !== undefined ? { persistedMode } : {}),
        ...(autoMode !== undefined ? { autoMode } : {}),
      });

      // Hard floor: never below Budget (locked decision #3). The classify floor is a
      // SOFT safety net surfaced in the receipt but NOT a clamping minimum — a trivial
      // turn's byproduct is allowed to route below it (e.g. worker+low → budget even
      // when classify says balanced) as long as we never go below Budget.
      if (rankOf(committed) < 0) committed = 'budget'; // paranoia — rankOf always ≥ 0

      reason = buildReason(shape, classifyTier, classifyRisk, byproductLevel, committed);
    }

    // --- Step 3: apply memory bias ---
    committed = applyMemoryBias(committed, memoryBias);

    // Hard floor after bias: never below Budget (locked decision #3).
    // Note: applyMemoryBias is already clamped to budget…max internally,
    // so this is a belt-and-suspenders guard only.
    if (rankOf(committed) < 0) committed = 'budget'; // paranoia

    // --- Step 4: clamp to capacity ceiling ---
    committed = clampToCeiling(committed, capacityCeiling);

    return {
      rung: rungTupleForLevel(committed),
      reason,
      intentShape: shape,
      predictAndCommit,
    };
  } catch {
    // Safe fallback: balanced rung with honest receipt.
    return {
      rung: rungTupleForLevel('balanced'),
      reason: 'safe fallback (fusion error)',
      intentShape: 'unknown',
      predictAndCommit: false,
    };
  }
}

/** Map a routing tier to the level it suggests (worker→budget, ic→balanced, manager→high). */
function tierToLevel(tier: Tier): Exclude<Level, 'auto'> {
  switch (tier) {
    case 'worker': return 'budget';
    case 'ic': return 'balanced';
    case 'manager': return 'high';
  }
}

/** Build a human-readable, non-confidence-based reason string for the receipt. */
function buildReason(
  shape: IntentShape,
  tier: Tier | undefined,
  risk: Risk | undefined,
  byproductLevel: Exclude<Level, 'auto'> | undefined,
  committed: Exclude<Level, 'auto'>,
): string {
  const parts: string[] = [];
  if (shape !== 'unknown') parts.push(`intent:${shape}`);
  if (tier !== undefined) parts.push(`tier:${tier}`);
  if (risk !== undefined && risk !== 'low') parts.push(`risk:${risk}`);
  if (byproductLevel !== undefined) parts.push(`byproduct:${byproductLevel}`);
  parts.push(`→${committed}`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Per-turn receipt (the legible one-line surface via the trust/ledger machinery)
// ---------------------------------------------------------------------------

/**
 * Build the legible per-turn AUTO BRAIN RECEIPT — a single, scannable line
 * surfacing:
 *   - the committed rung (budget…max)
 *   - the objective reason (no confidence claims)
 *   - the cost tier (cheap / moderate / expensive / maximum)
 *
 * This receipt is written via the existing ledger/trust-receipt machinery
 * (the caller embeds it as a `notice` or appends it to the trust receipt).
 * PURE, total.
 */
export function buildAutoBrainReceipt(result: FuseRungResult): string {
  try {
    const { rung, reason, predictAndCommit } = result;
    const costLabel = costTierLabel(rung.level);
    const commitLabel = predictAndCommit ? ' [predict-and-commit]' : '';
    return `auto-brain: ${rung.level} (${costLabel})${commitLabel} — ${reason}`;
  } catch {
    return 'auto-brain: balanced (moderate) — safe fallback';
  }
}

function costTierLabel(level: Exclude<Level, 'auto'>): string {
  switch (level) {
    case 'budget': return 'cheap';
    case 'balanced': return 'moderate';
    case 'high': return 'expensive';
    case 'max': return 'maximum';
  }
}

// ---------------------------------------------------------------------------
// Layer B: objective-evidence-only escalation (live, wired via work-call.ts)
// ---------------------------------------------------------------------------

/**
 * Objective signals for escalation decisions (LAYER B). Only machine-checkable
 * evidence is accepted here — self-confidence is BANNED (locked decision #5).
 *
 * These are the signals `shouldEscalate` may act on:
 *   - `testFailures`       : number of test failures in the last verify run.
 *   - `typecheckFailures`  : number of typecheck errors in the last verify run.
 *   - `lintFailures`       : number of lint errors in the last verify run.
 *   - `scopeGrowth`        : has the goal's scope grown since the last rung decision?
 *   - `explicitUserPushback`: did the user explicitly say "this isn't working"?
 *   - `consecutiveStalls`  : how many turns has the work stalled (no progress)?
 *   - `attemptNumber`      : current attempt index (1-based), for maxAttempts guard.
 *   - `maxAttempts`        : the policy ceiling — never escalate above this.
 *   - `currentLevel`       : the rung currently in use.
 *   - `consecutiveCleanTodos`: how many todos completed cleanly (for de-escalation).
 */
export interface EscalationSignals {
  readonly testFailures?: number;
  readonly typecheckFailures?: number;
  readonly lintFailures?: number;
  readonly scopeGrowth?: boolean;
  readonly explicitUserPushback?: boolean;
  readonly consecutiveStalls?: number;
  readonly attemptNumber?: number;
  readonly maxAttempts?: number;
  readonly currentLevel?: Exclude<Level, 'auto'>;
  readonly consecutiveCleanTodos?: number;
}

/**
 * HYSTERESIS CONSTANTS — how many objective failures before escalating, and how
 * many clean todos before de-escalating. Set conservatively; tune on
 * core/eval/ harness before stable promotion (locked decision #7).
 */
export const ESCALATE_FAILURE_MARGIN = 2; // ≥2 objective failures to escalate
export const DEESCALATE_CLEAN_MARGIN = 3; // ≥3 clean todos to de-escalate

/**
 * LAYER B: decide whether to escalate the current rung, based on OBJECTIVE
 * evidence ONLY. Self-confidence / model self-report CANNOT trigger escalation
 * (it may appear as a tie-breaker at most, and only when all other signals are
 * tied — which the function currently does not expose, keeping the door closed
 * by default). PURE, total, never throws. Returns `true` only when objective
 * evidence clears the hysteresis margin AND the policy ceiling allows it.
 *
 * Live: fully specced, tested, and wired into the live escalation path via
 * `decideLayerBEscalation` in `src/core/work-call.ts:1012-1064`.
 */
export function shouldEscalate(signals: EscalationSignals): boolean {
  try {
    const {
      testFailures = 0,
      typecheckFailures = 0,
      lintFailures = 0,
      scopeGrowth = false,
      explicitUserPushback = false,
      consecutiveStalls = 0,
      attemptNumber = 1,
      maxAttempts = 3,
      currentLevel = 'balanced',
    } = signals;

    // Never escalate beyond the policy ceiling.
    if (attemptNumber >= maxAttempts) return false;
    // Already at max — nowhere to go.
    if (currentLevel === 'max') return false;

    // Count objective failure signals (self-confidence never counted here).
    const objectiveFailures =
      (testFailures >= 1 ? 1 : 0) +
      (typecheckFailures >= 1 ? 1 : 0) +
      (lintFailures >= 1 ? 1 : 0) +
      (scopeGrowth ? 1 : 0) +
      (explicitUserPushback ? 1 : 0) +
      (consecutiveStalls >= 2 ? 1 : 0);

    // Hysteresis: must clear ESCALATE_FAILURE_MARGIN distinct objective signals.
    return objectiveFailures >= ESCALATE_FAILURE_MARGIN;
  } catch {
    return false;
  }
}

/**
 * LAYER B: decide whether to de-escalate (downgrade) the current rung when
 * work proves mechanical — i.e., the goal has been progressing cleanly without
 * objective failures. PURE, total. Returns `true` when the clean-todo count
 * clears DEESCALATE_CLEAN_MARGIN and the current level is above budget.
 *
 * Live: fully specced, tested, and wired into the live path via `decideLayerBEscalation`.
 */
export function shouldDeEscalate(signals: EscalationSignals): boolean {
  try {
    const {
      testFailures = 0,
      typecheckFailures = 0,
      lintFailures = 0,
      consecutiveCleanTodos = 0,
      currentLevel = 'balanced',
    } = signals;

    // Cannot de-escalate if there are any active objective failures.
    const hasActiveFailure = testFailures > 0 || typecheckFailures > 0 || lintFailures > 0;
    if (hasActiveFailure) return false;

    // Already at budget — nowhere to go down.
    if (currentLevel === 'budget') return false;

    // De-escalate only when work has been cleanly progressing for the margin.
    return consecutiveCleanTodos >= DEESCALATE_CLEAN_MARGIN;
  } catch {
    return false;
  }
}

/**
 * LAYER B — the LIVE within-turn escalation decision (Option B: repeated
 * objective failure). This is the wired counterpart to {@link shouldEscalate}
 * (whose ≥2-distinct-category model needs richer per-category evidence than the
 * single-state `VerifyOutcome` currently provides — a future cross-turn upgrade).
 *
 * Faithful to auto-mode-design's "escalate only AFTER the cheaper attempt
 * DEMONSTRABLY failed its objective check": the accept-stage quality gate already
 * runs ONE bounded repair before it reports `'failing'`, so a `'failing'`
 * classification IS demonstrable repeated objective failure (attempt → repair →
 * still failing). Escalate on THAT — never on self-confidence — bounded by the
 * attempt ceiling and the tier ceiling (cannot climb past `manager`). PURE,
 * total, never throws. Returns false for any non-failing classification, so a
 * `passing`/`unverified` gate never escalates.
 */
export function decideLayerBEscalation(input: {
  readonly classification: 'passing' | 'failing' | 'unverified';
  readonly currentTier: Tier;
  readonly attempts: number;
  readonly maxAttempts: number;
}): boolean {
  try {
    if (input.classification !== 'failing') return false;
    // Never exceed the policy ceiling on attempts.
    if (input.attempts >= input.maxAttempts) return false;
    // Already at the top rung — nowhere to escalate to.
    if (input.currentTier === 'manager') return false;
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 1-model case: model-rung collapses, effort becomes the primary lever
// ---------------------------------------------------------------------------

/**
 * When the user has only ONE model available, the `modelRung` dimension of the
 * tuple is meaningless (there is nothing to route to). This function adapts the
 * rung tuple for the 1-model case:
 *   - `modelRung` is pinned to `'ic'` (the single model IS the ic rung).
 *   - `effort` is preserved and elevated to the primary lever.
 *   - `verifyDepth` `'cross-vendor'` collapses to `'self-check'` — a second
 *     self-review pass (the 1-model substitute for cross-vendor, capped to
 *     high/critical turns and toggled off by default per locked decision #4).
 *
 * PURE, total. The `selfReviewPassEnabled` toggle defaults to false (off by
 * default under quota pressure — locked decision #4).
 */
export function adaptForSingleModel(
  rung: RungTuple,
  selfReviewPassEnabled: boolean = false,
): RungTuple {
  try {
    // Cross-vendor verification requires two models — a 1-model setup cannot do it.
    // What the toggle gates is whether a SELF-REVIEW PASS runs as a substitute.
    //
    // Per locked decision #4: self-review is capped to high/max turns and is OFF by
    // default under quota pressure. The unconditional collapse (1 model can't
    // cross-check) is preserved; the TOGGLE gates whether the collapse produces a
    // self-check pass or collapses all the way to 'none':
    //
    //   - cross-vendor + toggle=true  + high/max → self-check  (1-model substitute)
    //   - cross-vendor + toggle=false + any level → none        (quota-limited, honest)
    //   - cross-vendor + toggle=true  + budget/balanced → none  (capped to high/max)
    //   - non-cross-vendor → unchanged (self-check / none stay as-is)
    const isHighOrMax = rung.level === 'high' || rung.level === 'max';
    const selfReviewRunsThisTurn =
      rung.verifyDepth === 'cross-vendor' &&
      selfReviewPassEnabled &&
      isHighOrMax;

    const newVerifyDepth: RungTuple['verifyDepth'] =
      rung.verifyDepth === 'cross-vendor'
        ? selfReviewRunsThisTurn
          ? 'self-check'
          : 'none'
        : rung.verifyDepth;

    return {
      ...rung,
      // Pin modelRung to ic — the single model IS the ic rung.
      modelRung: 'ic',
      // Toggle gates whether self-review runs (per locked decision #4).
      verifyDepth: newVerifyDepth,
    };
  } catch {
    return rung;
  }
}
