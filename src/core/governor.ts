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
 * The verification lever (master-plan PHASE 3 — now ACTIVE). The verify stage
 * (work-call.ts → core/verify.ts) reads this to decide how far up the cost ladder
 * to climb:
 *   - `none`         : skip verification (non-diff shapes; the stage's diff-gate
 *                      also bypasses it on an empty diff regardless of this value).
 *   - `tests`        : tests-first only (FREE local exec), no critic.
 *   - `tests+critic` : tests-first, then ONE diff-scoped cross-vendor critic.
 *   - `reviewed`     : the critic is the primary signal (when no tests exist).
 * This is the SAME vocabulary as core/verify.ts::VerifyLevel — the two are kept in
 * lockstep so the Governor's plan threads straight into the verify stage.
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
  /**
   * Whether the PLURAL JUDGMENT POLL is permitted to fire this turn (master-plan
   * PHASE 7 / judgment §5.3). The poll is an EXPENSIVE cross-vendor lever (N candidate
   * calls), so the Governor OWNS whether it fires: judgment proposes (a genuine fork),
   * the Governor disposes. True ONLY when the shape warrants a decision poll
   * (`decide`/`risky`) AND ≥2 vendors are authed AND the `turnCallBudget` has room for
   * the candidate calls AND the mode isn't frugal. The actual poll STILL only forms
   * when `planJudgment` finds a real ≥2-option fork + ≥2 distinct vendors — this gate
   * is the BUDGET authority, not the fork detector. When the Governor is OFF the caller
   * applies a conservative built-in default (a high-stakes genuine fork + ≥2 vendors).
   */
  readonly pollAllowed: boolean;
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
 * The plan-adaptive AUTO posture word for the detected strongest tier (master-plan
 * PHASE 4 / experience §3.2 — the tier-adaptive auto-mode the user explicitly asked
 * for: "smart auto mode should auto-adapt to their subscription types"). This is a
 * PURE display projection of the SAME `Mode` the budget is derived from, so the
 * honest label can NEVER drift from the actual `turnCallBudget` the governor sets:
 *
 *   - quality-first (Max)        → 'full'         (budget 3, all in-budget levers)
 *   - balanced     (Pro / none)  → 'balanced'     (budget 2; unknown plan → this
 *                                                  SAFE middle, never 'full')
 *   - cost-saver   (Free)        → 'conservative' (budget 1, no paid levers)
 *
 * The crucial honesty contract: an UNKNOWN / undetected plan resolves (via
 * `autoModeForPlanInfos`) to `balanced` → 'balanced' — never to 'full'. We never
 * assume Max. The display layer pairs this word with the plan label it already
 * renders ("Auto · Max plan → full" / "Auto · Free plan → conservative"); this
 * helper supplies ONLY the adaptive-intent word, it does NOT re-detect the plan.
 */
export type AutoPosture = 'full' | 'balanced' | 'conservative';

export function autoPostureForMode(mode: Mode): AutoPosture {
  switch (mode) {
    case 'quality-first':
      return 'full';
    case 'cost-saver':
      return 'conservative';
    case 'balanced':
    default:
      return 'balanced';
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
 * Whether the SHAPE produces a diff worth verifying (master-plan PHASE 3). Only
 * code-changing shapes are verification-eligible: `build` and `risky` clearly
 * change code; `investigate` may produce a fix. `quick`/`explain`/`decide` do not
 * produce a diff to test (the stage's own diff-gate is the final authority — an
 * empty diff is `unverified` regardless of this).
 */
function shapeProducesDiff(shape: TaskShape): boolean {
  return shape === 'build' || shape === 'risky' || shape === 'investigate';
}

/**
 * The verification LEVEL for this turn (master-plan PHASE 3 / §2.3 firing policy),
 * graduated and tests-first-free:
 *   - non-diff shape → `'none'` (nothing to verify).
 *   - diff shape, low stakes, NOT a large diff, OR <2 vendors → `'tests'`
 *     (tests-first only — the free signal; never opens a paid critic).
 *   - diff shape AND (high stakes OR the shape is `risky`) AND ≥2 vendors AND a
 *     metered unit remains in the budget → `'tests+critic'` (tests-first, then ONE
 *     diff-scoped cross-vendor critic). The critic is the ONE paid lever; it is
 *     gated by stakes + vendor count + the hard budget, never blanket-on, never on
 *     a trivial change.
 *
 * `criticUnitAvailable` is whether a unit of `turnCallBudget` remains after the
 * core answer (+ any Oracle) — the critic draws from the same single counter, so it
 * can never multiplicatively blow quota.
 */
function verifyForShape(
  shape: TaskShape,
  conf: AllocateInput['conf'],
  crossVendor: boolean,
  criticUnitAvailable: boolean,
): Verify {
  if (!shapeProducesDiff(shape)) return 'none';
  // High-stakes (or an explicitly risky shape) earns the diff-scoped critic when a
  // 2nd vendor is connected AND the budget affords the extra metered unit.
  const wantsCritic = (conf.stakes === 'high' || shape === 'risky')
    && crossVendor
    && criticUnitAvailable;
  return wantsCritic ? 'tests+critic' : 'tests';
}

/** A decision poll needs at least this much budget room for its candidate calls. */
const POLL_MIN_BUDGET = 2;

/**
 * Whether the PLURAL JUDGMENT POLL is permitted for this shape/mode/budget (master-
 * plan PHASE 7 / judgment §5.3). The poll is the costliest decision-time lever, so it
 * fires only when:
 *   - the shape is a genuine DECISION turn (`decide`, or a `risky` fork) — never on
 *     `quick`/`explain`/`build`/`investigate` (a build is the critic's turn, not the
 *     poll's; the two share the one budget and never both fire);
 *   - ≥2 vendors are authenticated (plural judgment requires plurality — single-vendor
 *     turns degrade honestly to single-mind judgment, never a faked second voice);
 *   - the mode is NOT frugal (`cost-saver`/Free never auto-opens an expensive lever);
 *   - the `turnCallBudget` has room for the candidate calls (≥ {@link POLL_MIN_BUDGET}).
 * This is the BUDGET authority; the fork itself is still required by `planJudgment`.
 */
function pollAllowedForShape(
  shape: TaskShape,
  mode: Mode,
  crossVendor: boolean,
  turnCallBudget: number,
  spent: number,
  criticChosen: boolean,
): boolean {
  if (!crossVendor) return false;
  if (mode === 'cost-saver') return false;
  if (shape !== 'decide' && shape !== 'risky') return false;
  // The poll and the critic share the ONE budget and NEVER both fire (a decision
  // turn → poll; a build/verify turn → critic). If the critic already took the
  // cross-vendor unit this turn, the poll yields.
  if (criticChosen) return false;
  // Budget room for the candidate calls: at least POLL_MIN_BUDGET total, and a unit
  // beyond what the core answer (+ any Oracle) already spent.
  return turnCallBudget >= POLL_MIN_BUDGET && spent < turnCallBudget;
}

/**
 * The CONSERVATIVE BUILT-IN poll gate used when the Governor is OFF (master-plan
 * PHASE 7 single-vendor / off-default contract): with no Governor coordinating the
 * budget, the poll fires only on a HIGH-STAKES genuine fork with ≥2 vendors — the
 * narrowest honest default. PURE. The CALLER still requires `planJudgment` to find a
 * real ≥2-option fork + ≥2 distinct vendors, so this is the stakes/vendor gate only.
 *
 * @param highStakes - the brain's `conf.stakes === 'high'` read (risk/irreversible).
 * @param authedProviderCount - distinct authed vendors (≥2 to be plural).
 */
export function pollPermittedConservative(
  highStakes: boolean,
  authedProviderCount: number,
): boolean {
  return highStakes && authedVendorCount(authedProviderCount);
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

  // Will the diff-scoped CRITIC fire this turn? Precomputed here (before the Oracle)
  // so the poll/critic mutual exclusion is decided coherently: a build/risky diff
  // turn is the CRITIC's cross-vendor turn, a decision turn is the POLL's. The two
  // never both fire and never both claim the budget. (A `decide` turn produces no
  // diff, so `criticWillFire` is false there → the poll is free to take the unit.)
  const criticWillFire = verifyForShape(shape, input.conf, crossVendor, true) === 'tests+critic';

  // PLURAL JUDGMENT POLL — the DECISION-time cross-vendor lever (master-plan PHASE 7).
  // Allocated BEFORE the Oracle on a decision turn: plural independent judgment beats
  // ONE strong author for a *decision*, so the poll is the higher-value decide lever
  // and claims the cross-vendor unit first; the Oracle then takes a further unit only
  // if budget remains (Max=3 fits core+poll+oracle; Balanced=2 fits core+poll, oracle
  // yields). The poll never fires alongside the critic (criticWillFire gates it).
  const pollAllowed = pollAllowedForShape(
    shape,
    input.mode,
    crossVendor,
    turnCallBudget,
    spent,
    criticWillFire,
  );
  if (pollAllowed) {
    levers.push('poll');
    spent += 1;
    reasons.push('judgment poll — genuine decision; weighing 2+ independent vendor minds');
  } else if ((shape === 'decide' || shape === 'risky') && crossVendor && input.mode !== 'cost-saver') {
    if (criticWillFire) {
      reasons.push('judgment poll refused — the critic took this turn’s cross-vendor unit (poll and critic never both fire)');
    } else {
      reasons.push('judgment poll refused — budget too tight for the candidate calls');
    }
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

  // VERIFICATION — the master-plan PHASE 3 lever, now ACTIVE. Tests-first is free
  // (it draws NO metered unit — local exec); the diff-scoped critic is the ONE paid
  // lever and draws a unit of the budget. It is gated by stakes + vendor count + the
  // hard budget, so it can never blanket-on or multiplicatively blow quota.
  const criticUnitAvailable = spent < turnCallBudget;
  const verify: Verify = verifyForShape(shape, input.conf, crossVendor, criticUnitAvailable);
  if (verify === 'tests+critic') {
    // The critic is a metered cross-vendor lever — record it spending a budget unit.
    levers.push('critic');
    spent += 1;
    reasons.push('critic — diff-scoped cross-vendor check (high stakes / risky change)');
  } else if (verify === 'tests') {
    if (shapeProducesDiff(shape)) {
      reasons.push('verify tests-first — free local exec is the strongest cheap signal');
    }
  }

  // CROSS-VENDOR CELL — the critic above is the verification turn's cross-vendor
  // lever. For shapes whose cross-vendor cell is something else (the `decide` poll,
  // a later phase), or when the critic was NOT chosen, record the LOCK/reservation
  // honestly so the single-vendor surface is truthful and never nagged.
  const cvLever = crossVendorLeverForShape(shape);
  if (cvLever !== null && CROSS_VENDOR_LEVERS.has(cvLever) && verify !== 'tests+critic') {
    if (!crossVendor) {
      locked.push(cvLever);
      reasons.push(`${cvLever} locked — needs a 2nd vendor (single-vendor: honest, not nagged)`);
    } else if (cvLever !== 'critic') {
      // ≥2 vendors: a non-critic cross-vendor cell (the poll) is REACHABLE but its
      // machinery lands in a later phase, so it is reserved (not spent).
      reasons.push(`${cvLever} reserved — eligible with ≥2 vendors, lands in a later phase`);
    }
  }

  // PLURAL JUDGMENT POLL (master-plan PHASE 7) — the decision-time cross-vendor
  // lever. Granted only on a genuine decision turn with ≥2 vendors, a non-frugal
  // mode, and budget room for the candidate calls. The poll and the critic never
  // both fire (a `decide` turn produces no diff to critique; a `build`/`risky` turn
  // is the critic's, not the poll's) — they share the one budget by construction.
  // CONCURRENCY — declared-but-inactive cell in Phase 2.
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
    pollAllowed,
  };
}

/** Whether ≥2 vendors are authenticated (the cross-vendor unlock). Total. */
function authedVendorCount(count: number): boolean {
  return Number.isFinite(count) && Math.floor(count) >= 2;
}
