/**
 * src/core/capability-budget.ts — an ADVISORY model of the per-turn overhead,
 * plus the ordered quota-shed policy (whole-tool-finish-5.5.md §0.3, §3).
 *
 * Scope / honesty: this module is ADVISORY, NOT a hard per-turn governor. It
 * does NOT intercept or count real calls at runtime — nothing here enforces a
 * call budget on the live chat path. Real chat paths can stack several OPTIONAL
 * blocking pre-answer calls (smart-route classifier, intent extraction, resume
 * recap, capability refresh), each bounded only by its OWN timeout — not by a
 * single summed cap. The table below documents the overhead we INTEND each
 * turn-class to carry; treat it as a design target and a regression tripwire,
 * not a guarantee the code prevents a second blocking call from being added.
 *
 * Two throughlines this module models:
 *  - **Subscription-aware.** The user pays a flat subscription (OAuth, not
 *    API-key). Our added overhead spends quota + latency. The real cost ceiling
 *    is the subscription quota / rate-limit itself, not a number summed here.
 *  - **The core answer survives shedding.** When quota is pressured we shed
 *    *our* advisory features in a fixed order; the core answer is the last thing
 *    we drop. (This is the one behaviour this module actually drives — see
 *    {@link decideShed}.)
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
// The budget table (§3.1) — INTENDED ADDED overhead per turn-class (advisory)
// ---------------------------------------------------------------------------

/**
 * The INTENDED added overhead a turn-class carries on top of the core answer the
 * user pays for anyway. These are design targets, not runtime-enforced limits.
 *
 * Reality check on `addedBlockingCalls`: this field records the overhead this
 * MODULE'S own features intend to add (the gated intent pass). It is NOT a count
 * of every blocking pre-answer call on the live chat path — the smart-route
 * classifier, intent extraction, resume recap and capability refresh can each
 * run as separate optional blocking calls, none of which this table sums or
 * caps. Each is bounded only by its own timeout. Do not read this number as a
 * guarantee that only one blocking call precedes the answer.
 */
export interface TurnBudget {
  /** INTENDED added *blocking* model calls from this module's features (advisory). */
  readonly addedBlockingCalls: number;
  /** INTENDED added *background* (non-blocking) model calls (recap refresh). */
  readonly addedBackgroundCalls: number;
  /** INTENDED added injected tokens (memory + intent + engagement blocks). */
  readonly addedTokensCeiling: number;
}

/**
 * The intended added overhead per turn-class. The unit test asserts these exact
 * numbers, so it acts as a regression tripwire: if THIS module's features change
 * their intended overhead, the test must be updated deliberately. It is NOT a
 * runtime governor and does not prevent other subsystems from adding blocking
 * calls. The numbers are intent targets — the common case (trivial/normal
 * non-ambiguous) adds ZERO calls and a few-hundred tokens at most.
 */
export const CAPABILITY_BUDGET: Readonly<Record<TurnClass, TurnBudget>> = {
  // "what's 2+2", "ls": intent gate skips, memory prefs gated off, recap not
  // triggered (needs ≥3 turns + idle). Zero added overhead.
  trivial: {
    addedBlockingCalls: 0,
    addedBackgroundCalls: 0,
    addedTokensCeiling: 80,
  },
  // a question / small edit: intent MAY run 1 cheap call if ambiguous; memory is
  // pure I/O; recap is background-only.
  normal: {
    addedBlockingCalls: 1,
    addedBackgroundCalls: 0,
    addedTokensCeiling: 600,
  },
  // "rebuild this module", /goal: 1 intent call (gated) + 1 background recap call
  // if idle-stale. Full memory budget. (This module's own intended overhead —
  // other pre-answer calls on the chat path are not counted here.)
  substantial: {
    addedBlockingCalls: 1,
    addedBackgroundCalls: 1,
    addedTokensCeiling: 1200,
  },
} as const;

/**
 * The intended ceiling on added *blocking* model calls from THIS module's own
 * features, across all classes. The unit test asserts no `addedBlockingCalls`
 * in the table above exceeds this — a regression tripwire for this module, NOT a
 * runtime cap on the chat path's total blocking pre-answer calls.
 */
export const MAX_ADDED_BLOCKING_CALLS = 1;

// ---------------------------------------------------------------------------
// Aggregate preflight-overhead guard (audit rank 10) — default-OFF, neutral
// ---------------------------------------------------------------------------

/**
 * OBSERVED in-turn blocking preflight state for the rank-10 guard. NO new probe,
 * NO token meter — just the count of blocking model calls already taken this turn
 * plus the EXISTING QuotaPressure signal the renderer already surfaces.
 */
export interface PreflightObservation {
  /** Blocking model calls already taken this turn (upstream + in-orchestrate). */
  readonly blockingCallsSoFar: number;
  /** The live quota pressure the caller already computed from cooldown state. */
  readonly pressure: QuotaPressure;
}

/**
 * The rank-10 gate: may this turn take ONE MORE optional blocking preflight?
 * True iff the observed count is still strictly below the turn-class budget AND
 * quota pressure is not already heavy (pressure ≥ 3 already shed the intent pass
 * per decideShed; the guard must not re-admit). PURE; total; never throws.
 */
export function preflightAdmits(obs: PreflightObservation, turnClass: TurnClass): boolean {
  const budget = CAPABILITY_BUDGET[turnClass]?.addedBlockingCalls ?? 0;
  return (
    Number.isFinite(obs.blockingCallsSoFar) &&
    obs.blockingCallsSoFar < budget &&
    obs.pressure < 3
  );
}

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
