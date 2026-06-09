/**
 * src/core/governor.ts — THE PERFORMANCE GOVERNOR (Phase 2 skeleton, the spine).
 *
 * A single PURE module the orchestrate loop consults ONCE per turn at the existing
 * admission seam (orchestrate.ts, after `admitManager` / `authorizeTier` / the
 * Oracle escalation are wired and BEFORE the work loop). It reads ONLY real,
 * in-process, free-to-read signals already computed elsewhere — it fabricates
 * nothing — and returns one typed {@link AllocationPlan}: a hard, tier-adaptive
 * per-turn call budget plus, WITHIN that budget, exactly which levers to spend on,
 * chosen by expected quality-per-token for THIS turn's shape and stakes.
 *
 * THE ONE IDEA: today every expensive lever (the Oracle, the panel, the review
 * critic, the brain's investigation rounds) is a SEPARATE default-OFF gate tuned in
 * isolation. There is no single place that says "for THIS turn, the best spend of a
 * bounded budget is one Oracle pass and no panel." The governor is that place. It
 * does NOT rewrite or bypass the gates — it becomes the one CALLER that drives them
 * coherently from one budget and one signal read. The gates keep their authority
 * (`authorizeTier` keeps the free-plan veto, never-auto, and per-turn flagship
 * budget); the governor only stops the UNCOORDINATED requesting and refuses waste.
 *
 * ANTI-DRIFT VIA REFUSAL: the governor's most important act is REFUSAL. A lever is
 * allocated ONLY when it can advance THIS turn's shape/stakes/objective; an Oracle
 * pass on a `quick` lookup, depth on a turn there is nothing to investigate — these
 * are refused up front, with the reason recorded on {@link AllocationPlan.reasons}
 * so the refusal reads as senior judgment, not a missing feature.
 *
 * PHASE 2 SCOPE — only the levers that ALREADY exist are ACTIVE:
 *   - model tier   (ic | oracle)  → the FlagshipTrigger request the loop makes
 *   - depth        (round budget) → the brain's investigation-round budget
 *   - verbosity    (terse | laddered | deep) → pure prompt shaping
 * The later-phase cells — verification, the judgment poll, the Tribunal, and real
 * concurrency — are DECLARED but INACTIVE here: `verify` is always `'none'` and
 * `concurrency` is always `1` in Phase 2. They light up in their own phases without
 * a new governor; the governor is built once and the levers arrive over time.
 *
 * SINGLE-VENDOR-AWARE: cross-vendor levers are LOCKED when fewer than two vendors
 * are authenticated. In Phase 2 no cross-vendor lever is yet active, so the lock is
 * recorded honestly (in {@link AllocationPlan.locked}) and never spent — the moment
 * a verification/poll/Tribunal lever lands, the same lock gates it automatically.
 *
 * PURITY (enforced by test/arch/guards.test.ts, identical to every core module):
 *   - No imports of fs / path / child_process
 *   - No console.* calls
 *   - No Date.now() / Math.random() / new Date()
 *   - No process.exit(); NO model call to decide — the governor only decides what
 *     the impure orchestrate loop is ALLOWED to spend.
 * Total + fail-soft: an absent/malformed signal degrades to the honest prior
 * (`explain` shape, the safe-middle allowance), never to an invented value; the
 * function never throws.
 *
 * @see .tmp-master-performance.md  — the governor design (the spec for this module)
 * @see .tmp-master-build.md PHASE 2 — the spine statement + the build sequence
 */

import type { IntentFrame } from './intent.js';
import type { EngagementSignals, EngagementPlan } from './engagement.js';
import { isTrivial } from './engagement.js';
import type { Confidence } from './brain.js';
import { confidenceTooLowToAct } from './brain.js';
import type { Mode } from './policy.js';
import type { QuotaPressure } from './capability-budget.js';

// ---------------------------------------------------------------------------
// TaskShape — the one genuinely-new pure projection (§1.2 of the perf doc)
// ---------------------------------------------------------------------------

/**
 * The SHAPE of a turn — which levers are even ELIGIBLE for it. NOT a new model
 * call: composed PURELY from signals already in scope, reusing the EXACT predicates
 * the codebase already trusts (`isTrivial`, `confidenceTooLowToAct`, the substantial
 * decision predicate). Total + fail-soft: an unknown turn → `'explain'` (the safe
 * middle).
 *
 *   - `quick`        greeting / lookup / one-liner — `isTrivial(signals)` is true.
 *   - `explain`      a question / research answer — no diff, layered prose (the
 *                    residual default, the safe middle).
 *   - `build`        a code change — diff-producing, tests-eligible later.
 *   - `investigate`  a debug / "why is X" — hypothesis → read → re-assess.
 *   - `decide`       a design/recommendation fork — panel-eligible, take a position.
 *   - `risky`        high-stakes / irreversible — verification floor raised later.
 */
export type TaskShape =
  | 'quick'
  | 'explain'
  | 'build'
  | 'investigate'
  | 'decide'
  | 'risky';

/**
 * Inputs to {@link classifyTaskShape}. Every field is a REAL signal already
 * computed by brain.ts / turn-directive.ts upstream — the projection invents
 * nothing. `frame` may be absent (skipped/failed extraction); the projection
 * degrades to the safe middle.
 */
export interface TaskShapeInput {
  /** The brain's confidence/stakes tuple (brain.ts::assessConfidence — verbatim). */
  readonly conf: Confidence;
  /** The (possibly absent) extracted intent frame. */
  readonly frame: IntentFrame | undefined;
  /** The engagement signals (carry classification, task text, the frame). */
  readonly signals: EngagementSignals;
  /** The engagement plan (advisory action list). */
  readonly plan: EngagementPlan;
  /**
   * `directive.substantial` — the codebase's existing decision/recommendation
   * predicate (turn-directive.ts decideSubstantial → isTrivial-exempt). Reused
   * VERBATIM to identify a `decide` turn.
   */
  readonly substantial: boolean;
  /**
   * `directive.repoOriented` — true when a repo is present / INVESTIGATE_CONTEXT
   * was planned. Used to identify a `build` (code-change) context vs a pure
   * `explain` answer.
   */
  readonly repoOriented: boolean;
}

/**
 * Classify the turn's {@link TaskShape} — the ~30-line pure projection (perf doc
 * §1.2). PURE, TOTAL, fail-soft (unknown → `'explain'`), ZERO tokens. It REUSES the
 * existing predicates verbatim and does NOT reinvent them; the precedence is the
 * perf doc's, top-down (the strongest, most-specific signal wins):
 *
 *   0) `quick`        ← `isTrivial(signals)` — the same population the intent gate
 *                       and the brain's fast-path already exempt. Provably budget 1.
 *   1) `risky`        ← `conf.stakes === 'high'` (risk high/critical OR irreversible
 *                       — brain.ts already computed it). Stakes dominate shape.
 *   2) `decide`       ← `substantial` (decideSubstantial — the decision/recommendation
 *                       predicate). A genuine fork to deliberate.
 *   3) `investigate`  ← `confidenceTooLowToAct(conf, frame, signals)` — the EXACT
 *                       gate brain.ts uses to decide a hypothesis round is warranted.
 *   4) `build`        ← `repoOriented` — a code-change context (diff-producing).
 *   5) `explain`      ← the residual default — substantial-but-no-diff / a plain
 *                       answer (the safe middle).
 *
 * The ORDER encodes the priority: a high-stakes decision turn reads as `risky`
 * (the costliest cell, by design — stakes win); a clearly-understood code change is
 * `build`; only a turn with no stronger signal falls to `explain`.
 */
export function classifyTaskShape(input: TaskShapeInput): TaskShape {
  // Fail-soft: a malformed signals bag degrades to the safe middle, never throws.
  const signals = input.signals;
  if (signals === null || typeof signals !== 'object') return 'explain';

  // 0) TRIVIAL — the hard fast-path. Same predicate the brain's fast-path uses.
  if (isTrivial(signals)) return 'quick';

  // 1) RISKY — high stakes dominate. `conf.stakes` is brain.ts's honest read of
  //    risk high/critical OR irreversible; the costliest lever cell is gated to it.
  if (input.conf.stakes === 'high') return 'risky';

  // 2) DECIDE — a genuine decision/recommendation fork (the existing predicate).
  if (input.substantial === true) return 'decide';

  // 3) INVESTIGATE — genuinely too-low understanding on an investigable turn: the
  //    EXACT gate brain.ts uses to fund a hypothesis round. Reused verbatim.
  if (confidenceTooLowToAct(input.conf, input.frame, signals)) return 'investigate';

  // 4) BUILD — a code-change context (repo present / investigate-context planned).
  if (input.repoOriented === true) return 'build';

  // 5) EXPLAIN — the residual default (the safe middle).
  return 'explain';
}

// ---------------------------------------------------------------------------
// The lever set + the AllocationPlan (§2 + §3.2 of the perf doc)
// ---------------------------------------------------------------------------

/** Which model tier the turn REQUESTS (the loop still asks authorizeTier). */
export type TierRequest = 'ic' | 'oracle';

/** The verbosity ladder the prompt assembler reads (the cheapest, most-felt lever). */
export type Verbosity = 'terse' | 'laddered' | 'deep';

/**
 * The verification lever. PHASE 2: always `'none'` (the machinery does not exist
 * yet — Phase 3 lands change-capture + tests + the cross-vendor critic, at which
 * point `allocate` starts returning the non-`'none'` values it already encodes). A
 * declared-but-inactive cell, by design.
 */
export type Verify = 'none' | 'tests' | 'tests+critic' | 'reviewed';

/**
 * A lever the governor can spend a unit of the budget on. The cross-vendor levers
 * (`critic`, `poll`, `tribunal`) are LOCKED below two authenticated vendors. In
 * Phase 2 only `oracle` and `depth` are ever ACTIVE; the rest are declared cells.
 */
export type Lever =
  | 'oracle' // the strong model (a metered escalation) — ACTIVE in Phase 2
  | 'depth' // investigation rounds (local read/grep) — ACTIVE in Phase 2
  | 'critic' // cross-vendor diff-scoped critic — Phase 3 (cross-vendor: locked <2)
  | 'poll' // the judgment poll — Phase 7 (cross-vendor: locked <2)
  | 'tribunal'; // the Rival Tribunal — Phase 9 (cross-vendor: locked <2)

/** Levers that REQUIRE ≥2 authenticated vendors — locked, then auto-unlocked. */
const CROSS_VENDOR_LEVERS: ReadonlySet<Lever> = new Set<Lever>(['critic', 'poll', 'tribunal']);

/**
 * THE TYPED ALLOCATION PLAN — the single object the orchestrate loop reads instead
 * of each gate re-deriving its own trigger (perf doc §3.2). Every field is an
 * HONEST allocation derived from real signals; nothing is fabricated.
 */
export interface AllocationPlan {
  /** The turn's classified shape (which levers are eligible). */
  readonly shape: TaskShape;
  /**
   * THE HARD CAP — the single counter capping total provider invocations this turn
   * (1..3), set from the observed strongest tier and shrunk HONESTLY by live
   * pressure (`effectiveBudget = max(1, base − pressure)`). Every metered lever
   * draws from this; the levers can never multiplicatively blow quota.
   */
  readonly turnCallBudget: number;
  /** Which model tier to request (the loop still asks authorizeTier). */
  readonly tierRequest: TierRequest;
  /** The brain investigation-round budget for this turn (0..maxRounds). */
  readonly roundBudget: number;
  /** The verbosity ladder the prompt assembler reads. */
  readonly verbosity: Verbosity;
  /** The verification level. PHASE 2: always `'none'` (machinery not built yet). */
  readonly verify: Verify;
  /** The requested concurrency / activeLimit. PHASE 2: always `1` (single goal). */
  readonly concurrency: number;
  /**
   * The levers ACTUALLY chosen this turn, in priority order, bounded so
   * `levers.length <= turnCallBudget`. A metered lever (the Oracle) consumes one
   * unit of the budget; the free local levers (depth) are tracked here too so the
   * receipt is honest about what the turn will do.
   */
  readonly levers: readonly Lever[];
  /**
   * The cross-vendor levers that WOULD have applied to this shape but are LOCKED by
   * `authedProviderCount < 2`. Surfaced honestly (never as a fake `✓`); empty when
   * ≥2 vendors or the shape has no cross-vendor cell.
   */
  readonly locked: readonly Lever[];
  /**
   * Why this allocation — the AUDITABLE refusal/grant reasons (perf doc §4.3). Each
   * refused lever records its reason here so the spend reads as senior judgment.
   */
  readonly reasons: readonly string[];
}

/**
 * Inputs to {@link allocate}. Every signal is REAL and in-process; an absent signal
 * degrades to the honest prior. The governor is a PURE function of these inputs.
 */
export interface AllocateInput {
  /** The brain's confidence/stakes tuple (brain.ts::assessConfidence — verbatim). */
  readonly conf: Confidence;
  /** The (possibly absent) extracted intent frame. */
  readonly frame: IntentFrame | undefined;
  /** The engagement signals. */
  readonly signals: EngagementSignals;
  /** The engagement plan. */
  readonly plan: EngagementPlan;
  /** `directive.substantial` (reused verbatim — see {@link TaskShapeInput}). */
  readonly substantial: boolean;
  /** `directive.repoOriented` (reused verbatim — see {@link TaskShapeInput}). */
  readonly repoOriented: boolean;
  /**
   * The detected strongest authed MODE (from detect.ts → autoModeForPlanInfos):
   * `quality-first` (Max) → generous, `balanced` (Pro / no signal) → adaptive,
   * `cost-saver` (Free) → frugal. Observed, never inferred; absent → `'balanced'`.
   */
  readonly mode: Mode;
  /**
   * How many of claude/codex/opencode are authenticated (the same count
   * planSchedule/planPanel use). Sets which cross-vendor levers are reachable.
   */
  readonly authedProviderCount: number;
  /**
   * Live rate-limit pressure (capability-budget.ts::pressureFromSignals, 0–3). No
   * new probe — reactive after the first 429. Shrinks the allowance HONESTLY.
   * Absent → 0 (the honest default; the governor never fabricates pressure).
   */
  readonly pressure: QuotaPressure;
  /**
   * The brain's per-turn round ceiling (maxRoundsFor(style) — 2 default, 3
   * collaborative). The governor's `roundBudget` never exceeds it.
   */
  readonly maxRounds: number;
}

/**
 * The base per-turn call budget from the detected strongest tier (the ALLOWANCE,
 * perf doc §3.1). This EXTENDS the existing `autoModeForPlanInfos` tier→mode map —
 * it does not replace it. Honest middle for an absent/unknown signal.
 *
 *   - quality-first (Max)        → 3   (generous; substantial turns reason strong)
 *   - balanced     (Pro / none)  → 2   (adaptive; earns ONE strong pass when proven)
 *   - cost-saver   (Free)        → 1   (frugal; never auto-opens the strong model)
 */
function baseBudgetForMode(mode: Mode): number {
  switch (mode) {
    case 'quality-first':
      return 3;
    case 'cost-saver':
      return 1;
    case 'balanced':
    default:
      return 2;
  }
}

/**
 * Shrink the allowance by live pressure, HONESTLY (perf doc §3.1): a Max account
 * under heavy 429 pressure drops toward a frugal budget — and never silently. The
 * floor is 1 (the core answer is un-sheddable). `effectiveBudget = max(1, base −
 * pressure)`.
 */
function effectiveBudget(base: number, pressure: QuotaPressure): number {
  return Math.max(1, base - pressure);
}

/**
 * Whether the Oracle (strong model) is even ELIGIBLE to be requested for this shape
 * and mode — the per-shape policy from the perf doc's lever table (§2.7) and the
 * allocation order (§3.2). This mirrors what orchestrate's Oracle escalation
 * already does (gated by `directive.substantial` + admitManager) — the governor
 * makes the per-shape eligibility EXPLICIT so the request is coordinated, not
 * uncoordinated. The actual open is STILL decided by authorizeTier/admitManager.
 *
 *   - quick / explain / build / investigate → IC (the Oracle is deprioritized; on a
 *     routine build the diff+tests external signal buys more confidence-per-token
 *     than a stronger author — the frontier result encoded).
 *   - decide / risky → Oracle ELIGIBLE (one strong reason beats weak rounds on a
 *     fork; a wrong irreversible action dominates cost).
 *   - cost-saver (Free) NEVER requests the Oracle (the frugal-allowance invariant).
 */
function oracleEligibleForShape(shape: TaskShape, mode: Mode): boolean {
  if (mode === 'cost-saver') return false; // Free never auto-opens the strong model
  return shape === 'decide' || shape === 'risky';
}

/**
 * The investigation-round budget for this shape (perf doc §2.2 lever table). A
 * surgical hypothesis read is the cheapest confidence-per-token on an `investigate`
 * turn; a `decide` turn spends on a panel/strong-model, not reads (rounds 0); a
 * `risky` turn earns at least one. Bounded by the brain's `maxRounds`.
 *
 *   quick=0 · explain=0 · build=1 · investigate=up to maxRounds · decide=0 · risky=1
 */
function roundBudgetForShape(shape: TaskShape, maxRounds: number): number {
  const cap = Number.isFinite(maxRounds) && maxRounds > 0 ? Math.floor(maxRounds) : 0;
  switch (shape) {
    case 'quick':
      return 0;
    case 'explain':
      return 0;
    case 'decide':
      return 0;
    case 'build':
      return Math.min(1, cap);
    case 'risky':
      return Math.min(1, cap);
    case 'investigate':
      return cap;
    default:
      return 0;
  }
}

/**
 * The verbosity ladder for this shape (perf doc §2.3) — the cheapest lever (pure
 * prompt shaping, zero extra call) and the most FELT. A trivial turn is never
 * bloated; a complex turn is never sparse.
 *
 *   quick → terse · explain/build/decide → laddered · investigate/risky → deep
 */
function verbosityForShape(shape: TaskShape): Verbosity {
  switch (shape) {
    case 'quick':
      return 'terse';
    case 'investigate':
    case 'risky':
      return 'deep';
    case 'explain':
    case 'build':
    case 'decide':
    default:
      return 'laddered';
  }
}

/**
 * The cross-vendor lever this SHAPE would reach for, if any (perf doc §2.7 / §5.2).
 * `build` / `risky` would draw a `critic`; `decide` would draw a `poll` (and, on a
 * load-bearing implementation fork, a `tribunal` — earned last, Phase 9). In Phase
 * 2 none are active, so this only drives the honest `locked` surface when <2
 * vendors. Returns `null` for shapes with no cross-vendor cell.
 */
function crossVendorLeverForShape(shape: TaskShape): Lever | null {
  switch (shape) {
    case 'build':
    case 'risky':
      return 'critic';
    case 'decide':
      return 'poll';
    default:
      return null;
  }
}

/**
 * THE ALLOCATION — a PURE function `allocate(input) → AllocationPlan` (perf doc
 * §3.2). Total, fail-soft, ZERO tokens to compute. It:
 *
 *   1. Classifies the {@link TaskShape} (the eligible-lever selector).
 *   2. Sets the hard `turnCallBudget` from the observed tier, shrunk by pressure.
 *   3. Within that budget, allocates levers by the deterministic per-shape priority
 *      order (the master docs' verdicts made mechanical) — and REFUSES every lever
 *      whose marginal gain is below the floor for this shape, recording WHY.
 *
 * PHASE 2 INVARIANTS (the deterministic tripwires the tests assert):
 *   - `quick` → budget 1, NO escalation lever, terse, 0 rounds (provably instant).
 *   - `levers.length <= turnCallBudget` (the hard-cap promise).
 *   - a cross-vendor lever is NEVER in `levers` when `authedProviderCount < 2`
 *     (it sits in `locked` instead).
 *   - `cost-saver` (Free) NEVER requests the Oracle.
 *   - `verify` is `'none'` and `concurrency` is `1` (declared-but-inactive cells).
 */
export function allocate(input: AllocateInput): AllocationPlan {
  const reasons: string[] = [];

  const shape = classifyTaskShape({
    conf: input.conf,
    frame: input.frame,
    signals: input.signals,
    plan: input.plan,
    substantial: input.substantial,
    repoOriented: input.repoOriented,
  });

  // --- The hard budget: allowance from the observed tier, shrunk by pressure. ---
  // A trivial turn is PROVABLY 1 — it bypasses every metered lever (the surgical
  // claim, perf doc §3.3). For every other shape the allowance is the tier base,
  // shrunk honestly by live pressure.
  const base = baseBudgetForMode(input.mode);
  const pressure = input.pressure;
  const turnCallBudget = shape === 'quick' ? 1 : effectiveBudget(base, pressure);
  if (shape === 'quick') {
    reasons.push('trivial turn — budget 1, no metered lever (instant)');
  } else if (pressure > 0 && turnCallBudget < base) {
    reasons.push(`conserving — quota pressure shrank the budget ${base}→${turnCallBudget}`);
  }

  // --- The free levers (zero metered cost): verbosity + depth. ---
  const verbosity = verbosityForShape(shape);
  const roundBudget = roundBudgetForShape(shape, input.maxRounds);

  // --- Within-budget metered allocation, by per-shape priority order. ---
  // `spent` counts the METERED units consumed (the core answer is unit 1 and is
  // un-sheddable; the Oracle is a metered escalation that draws a further unit).
  // `levers` records what the turn will actually do (metered + free), bounded so it
  // never exceeds the budget.
  const levers: Lever[] = [];
  let spent = 1; // the core answer always runs and draws one unit of the budget.

  const crossVendor = authedVendorCount(input.authedProviderCount);
  const locked: Lever[] = [];

  // DEPTH (free, local read/grep) — allocated by shape, never a metered unit.
  if (roundBudget > 0 && spent < turnCallBudget) {
    levers.push('depth');
    reasons.push(`depth ${roundBudget} round(s) — ${shape} earns a grounded check`);
  } else if (roundBudget > 0) {
    reasons.push('depth refused — no budget left for an investigation round');
  }

  // MODEL TIER — request the Oracle only when the shape/mode earns it AND a unit
  // of the budget remains. Otherwise REFUSE it explicitly (the anti-drift act).
  let tierRequest: TierRequest = 'ic';
  if (oracleEligibleForShape(shape, input.mode)) {
    if (spent < turnCallBudget) {
      tierRequest = 'oracle';
      levers.push('oracle');
      spent += 1;
      reasons.push(`oracle — ${shape} warrants the strongest model (one strong pass)`);
    } else {
      reasons.push('oracle refused — budget already spent on a higher-value lever');
    }
  } else if (input.mode === 'cost-saver') {
    reasons.push('oracle refused — frugal allowance never auto-opens the strong model');
  } else {
    reasons.push(`oracle refused — ${shape} does not warrant the strong model (efficiency)`);
  }

  // CROSS-VENDOR CELL — declared but INACTIVE in Phase 2. We record the LOCK
  // honestly when the shape would have drawn a cross-vendor lever but <2 vendors
  // are authed; we never SPEND it (no verification/poll/tribunal machinery yet).
  const cvLever = crossVendorLeverForShape(shape);
  if (cvLever !== null && CROSS_VENDOR_LEVERS.has(cvLever)) {
    if (!crossVendor) {
      locked.push(cvLever);
      reasons.push(`${cvLever} locked — needs a 2nd vendor (single-vendor: honest, not nagged)`);
    } else {
      // ≥2 vendors: the cell is REACHABLE but its machinery is not built in Phase 2,
      // so it is reserved (not spent). The reason makes the reservation honest.
      reasons.push(`${cvLever} reserved — eligible with ≥2 vendors, lands in a later phase`);
    }
  }

  // VERIFICATION + CONCURRENCY — declared-but-inactive cells in Phase 2.
  const verify: Verify = 'none';
  const concurrency = 1;

  return {
    shape,
    turnCallBudget,
    tierRequest,
    roundBudget,
    verbosity,
    verify,
    concurrency,
    levers,
    locked,
    reasons,
  };
}

/** Whether ≥2 vendors are authenticated (the cross-vendor unlock). Total. */
function authedVendorCount(count: number): boolean {
  return Number.isFinite(count) && Math.floor(count) >= 2;
}
