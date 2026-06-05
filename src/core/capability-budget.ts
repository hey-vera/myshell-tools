/**
 * src/core/capability-budget.ts — the ONE place the per-turn overhead is summed,
 * plus the ordered quota-shed policy (whole-tool-finish-5.5.md §0.3, §3).
 *
 * Two non-negotiable throughlines this module makes literal:
 *  - **Subscription-aware.** The user pays a flat subscription (OAuth, not
 *    API-key). Our added overhead spends quota + latency, NEVER dollars — there
 *    is no token-budget readout to surface. The only enforced ceiling is *added
 *    blocking model calls* (and injected tokens), summed here so a future feature
 *    that quietly adds a second blocking call FAILS the budget test (the budget
 *    is enforced data, not just documentation).
 *  - **The core answer always survives.** When quota is pressured we shed *our*
 *    features in a fixed order; the un-sheddable core answer is the last thing
 *    standing. The user never hits a wall because of our overhead.
 *
 * This module is PURE: no I/O, no time, no randomness (`test/arch/guards.ts`).
 * It is DATA + total pure functions only.
 */

// ---------------------------------------------------------------------------
// Turn classes (match the router's own notion: trivial / normal / substantial)
// ---------------------------------------------------------------------------

/** The three turn-classes the budget is stated against (router tier + risk). */
export type TurnClass = 'trivial' | 'normal' | 'substantial';

// ---------------------------------------------------------------------------
// The budget table (§3.1) — worst-case ADDED overhead per turn-class
// ---------------------------------------------------------------------------

/**
 * The worst-case ADDED overhead a turn-class may incur on top of the core answer
 * the user pays for anyway. `addedBlockingCalls` is the load-bearing invariant:
 * **at most ONE blocking added call per turn** (the gated intent pass). Recap is
 * always background (non-blocking); memory makes ZERO model calls (deterministic
 * retrieval); APE rides the existing intent frame (it consumes the signal, it
 * does not add a call). `addedDollars` is always 0 on a flat-rate subscription.
 */
export interface TurnBudget {
  /** Worst-case ADDED *blocking* model calls. NEVER exceeds 1 (the budget cap). */
  readonly addedBlockingCalls: number;
  /** Worst-case ADDED *background* (non-blocking) model calls (recap refresh). */
  readonly addedBackgroundCalls: number;
  /** Worst-case ADDED injected tokens (memory + intent + engagement blocks). */
  readonly addedTokensCeiling: number;
  /** Added dollar cost. ALWAYS 0 — flat-rate subscription, quota+latency only. */
  readonly addedDollars: 0;
}

/**
 * The summed worst-case budget per turn-class. This CONSTANT is the enforced
 * ceiling: a test asserts these exact numbers, so adding a second blocking call
 * anywhere (e.g. a non-background recap, a second extractor pass) makes the test
 * fail. The numbers are *ceilings* — the common case (trivial/normal
 * non-ambiguous) adds ZERO calls and a few-hundred tokens at most.
 */
export const CAPABILITY_BUDGET: Readonly<Record<TurnClass, TurnBudget>> = {
  // "what's 2+2", "ls": intent gate skips, memory prefs gated off, recap not
  // triggered (needs ≥3 turns + idle). Zero added overhead.
  trivial: {
    addedBlockingCalls: 0,
    addedBackgroundCalls: 0,
    addedTokensCeiling: 80,
    addedDollars: 0,
  },
  // a question / small edit: intent MAY run 1 cheap call if ambiguous; memory is
  // pure I/O; recap is background-only.
  normal: {
    addedBlockingCalls: 1,
    addedBackgroundCalls: 0,
    addedTokensCeiling: 600,
    addedDollars: 0,
  },
  // "rebuild this module", /goal: 1 intent call (blocking, gated) + 1 background
  // recap call if idle-stale — NEVER 2 blocking calls. Full memory budget.
  substantial: {
    addedBlockingCalls: 1,
    addedBackgroundCalls: 1,
    addedTokensCeiling: 1200,
    addedDollars: 0,
  },
} as const;

/**
 * The hard ceiling on added *blocking* model calls per turn, across ALL classes.
 * The budget test asserts no `TurnBudget.addedBlockingCalls` exceeds this — so a
 * second blocking call anywhere fails the gate. (The intent pass is the one.)
 */
export const MAX_ADDED_BLOCKING_CALLS = 1;

// ---------------------------------------------------------------------------
// Quota-shed policy (§3.2) — ordered; the core answer always survives
// ---------------------------------------------------------------------------

/**
 * Quota pressure, derived from signals the renderer ALREADY surfaces
 * (`rateLimitedProviders` and/or a 429/quota `errorCategory` on a recent turn) —
 * NO new probe, NO token-budget readout (there isn't one on subscription CLIs).
 *
 *   0 = none      — no recent rate-limit/quota signal; nothing shed.
 *   1 = light     — a provider rate-limited recently → drop background recap.
 *   2 = moderate  — also narrow memory to identity + hard constraints.
 *   3 = heavy     — also skip the intent pass (fall back to rules, no call).
 *
 * Levels are clamped: anything ≥3 behaves as 3. Shedding is GRADUAL (one rung at
 * a time, re-evaluated each turn), so a false-positive costs at most a missing
 * recap or narrower memory for one turn — never a wrong or failed answer.
 */
export type QuotaPressure = 0 | 1 | 2 | 3;

/**
 * The shed plan for a turn: which of OUR capabilities run. The core answer is
 * NOT a field here — it is un-sheddable by construction and always runs.
 */
export interface SheddingPlan {
  /** Refresh the background recap this turn? Shed FIRST (cosmetic orientation). */
  readonly recapRefresh: boolean;
  /**
   * Memory injection width: 'full' (ranked prefs + identity/constraints),
   * 'identity-only' (identity + hard constraints — prefs dropped), or 'off'.
   * Narrowed SECOND under pressure; identity + hard constraints are NEVER shed.
   */
  readonly memoryWidth: 'full' | 'identity-only';
  /** Run the gated intent pass this turn? Shed THIRD (it costs a whole call). */
  readonly intentPass: boolean;
  /** The core answer. ALWAYS true — never shed. The last thing standing. */
  readonly coreAnswer: true;
  /** Provenance for transparency + tests. */
  readonly pressure: QuotaPressure;
}

/** Clamp any input to a valid {@link QuotaPressure} (defensive, total). */
function clampPressure(p: number): QuotaPressure {
  if (!Number.isFinite(p) || p <= 0) return 0;
  if (p >= 3) return 3;
  return (Math.floor(p) as QuotaPressure);
}

/**
 * Decide the ordered shed plan for a turn given the quota `pressure`. The order
 * is fixed and least-valuable-and-most-expensive-first (§3.2):
 *
 *   1. Drop background recap refresh   (cosmetic orientation; show cached line)
 *   2. Narrow memory to identity-only  (drop ranked prefs; constraints stay)
 *   3. Skip the intent pass            (fall back to rulesIntentFrame — no call)
 *   4. ── CORE ANSWER ── always runs. Never shed.
 *
 * `turnClass` is accepted for symmetry with the budget and future tightening but
 * does not change the *order* — the order is invariant; only how far down the
 * ladder we go scales with pressure. PURE; total; never throws.
 */
export function decideShed(
  pressure: QuotaPressure | number,
  _turnClass?: TurnClass,
): SheddingPlan {
  const p = clampPressure(pressure as number);
  return {
    recapRefresh: p < 1, // shed at level 1+
    memoryWidth: p < 2 ? 'full' : 'identity-only', // narrow at level 2+
    intentPass: p < 3, // skip at level 3
    coreAnswer: true, // never shed
    pressure: p,
  };
}

/**
 * Map the renderer's existing pressure signals into a {@link QuotaPressure}
 * level WITHOUT any new probe: the count of providers rate-limited recently plus
 * whether a 429/quota error was seen on a recent turn. One rate-limited provider
 * (or a quota error) → light; two → moderate; more, or both together → heavy.
 * Reactive-after-first-429 by design (no token-budget readout exists on
 * subscription CLIs). PURE; total; never throws.
 */
export function pressureFromSignals(input: {
  readonly rateLimitedProviderCount?: number;
  readonly recentQuotaError?: boolean;
}): QuotaPressure {
  const count =
    typeof input?.rateLimitedProviderCount === 'number' &&
    Number.isFinite(input.rateLimitedProviderCount)
      ? Math.max(0, Math.floor(input.rateLimitedProviderCount))
      : 0;
  const quotaErr = input?.recentQuotaError === true;
  let level = count;
  if (quotaErr) level += 1;
  return clampPressure(level);
}
