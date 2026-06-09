/**
 * src/core/flagship.ts — adaptive flagship (manager-tier) admission.
 *
 * Replaces the static `Policy.maxTier` ceiling as the primary control over when a
 * turn may reach the strongest model. The product orchestrates FLAT-RATE
 * subscription CLIs, so "the manager model is expensive" is API-billing thinking
 * that doesn't apply — the real scarce resource is quota / rate-limit headroom.
 * Manager access is therefore an adaptive per-turn decision, not a fixed cap:
 *
 *   - Efficient (`never-auto`)      : never auto-opens manager.
 *   - Balanced  (`adaptive`)        : earns ONE manager pass when the turn proves
 *                                     it needs it (high/critical risk, low
 *                                     confidence, or a reviewer escalation), vetoed
 *                                     for an observed `free` plan.
 *   - Max       (`always-eligible`) : manager allowed whenever asked for.
 *
 * Pure: no I/O, no Date/Math, no provider imports beyond the ProviderId port type.
 * The conversation layer passes immutable snapshots (plan classifications) in; the
 * mutable cooldown Map stays in the interface layer.
 */

import type { Assessment, Classification, Policy, Tier } from './types.js';
import type { PlanInfo } from './policy.js';
import type { ProviderId } from '../providers/port.js';

/**
 * What prompted the tier request — shapes how readily `adaptive` opens manager.
 *
 * - `initial`    : the as-classified tier on the first route (manager only when the
 *                  turn justifies it via risk/confidence — never manager-first off a
 *                  soft classification).
 * - `confidence` : orchestrate decided the turn is under-confident → an earned ask.
 * - `review`     : a reviewer (or an upstream architecture gate) asked to escalate.
 * - `failure`    : every vendor at the tier failed → "this is hard, bring the flagship".
 * - `oracle`     : the ORACLE move — route THIS turn's main reasoning to the strongest
 *                  admissible model because it is a SUBSTANTIAL / explanatory / plan /
 *                  insight turn (the moment that most warrants the best brain). It is
 *                  deliberately NOT an "earned trigger": under `adaptive` (Balanced) it
 *                  must still justify itself via the SAME risk/confidence criteria as
 *                  `initial`, so Balanced escalates the Oracle moment only when the turn
 *                  is ALSO high-stakes / low-confidence (conservative — quota-aware). Max
 *                  (`always-eligible`) opens it on every substantial turn; Efficient
 *                  (`never-auto`) never does. The substantial gate itself lives in
 *                  orchestrate (the same `directive.substantial` predicate the
 *                  explanatory-depth + grounded-recommendation directives use), so a
 *                  trivial / quick turn never even requests the Oracle.
 */
export type FlagshipTrigger = 'initial' | 'confidence' | 'review' | 'failure' | 'oracle';

export interface FlagshipContext {
  /** The tier we'd like to run (only `'manager'` requests are gated here). */
  readonly requestedTier: Tier;
  /** The tier currently running (returned when manager is denied). */
  readonly currentTier: Tier;
  readonly classification: Classification;
  /** Present after a turn has produced output; absent on the initial route. */
  readonly assessment?: Assessment;
  readonly policy: Policy;
  /** Observed plan per provider (from classifyPlan). Absent → no plan signal. */
  readonly planInfos?: Partial<Record<ProviderId, PlanInfo>>;
  /**
   * Providers actually eligible to run this manager step (authenticated AND not in
   * cooldown — the conversation layer's already-filtered preference list). When
   * present, the free-plan veto considers ONLY these providers' plans, so a cooled-
   * down or signed-out `free` provider can't veto a manager run that would actually
   * go to a different, non-free (or unknown-plan) provider. Absent → consider all
   * providers in planInfos (backward-compatible).
   */
  readonly candidateProviders?: readonly ProviderId[];
  /** How many manager attempts this turn has already used (quota guard). */
  readonly flagshipAttemptsThisTurn: number;
  readonly trigger: FlagshipTrigger;
}

export interface FlagshipDecision {
  /** The authorized tier — never higher than `requestedTier`. */
  readonly tier: Tier;
  /** True when a `'manager'` request was granted. */
  readonly allowed: boolean;
  /** Human-readable rationale (surfaced as an honest notice). */
  readonly reason: string;
}

/**
 * Resolve the effective admission posture, honouring the deprecated `maxTier`
 * fallback so policies that predate `flagshipAdmission` behave unchanged:
 *   - explicit `flagshipAdmission` wins;
 *   - else `maxTier === 'ic'` (or worker) → `'never-auto'` (old hard cap);
 *   - else (`maxTier` 'manager' or absent) → `'always-eligible'`.
 */
function resolveAdmission(policy: Policy): 'never-auto' | 'adaptive' | 'always-eligible' {
  if (policy.flagshipAdmission !== undefined) return policy.flagshipAdmission;
  if (policy.maxTier === 'ic' || policy.maxTier === 'worker') return 'never-auto';
  return 'always-eligible';
}

/** Highest non-manager tier — what we fall back to when manager is denied. */
function denyTier(currentTier: Tier): Tier {
  // Never *raise* the tier on a denial: if we're already at manager (shouldn't
  // happen for a manager request) keep it; otherwise hold at the current tier.
  return currentTier;
}

/**
 * Decide whether a `'manager'` tier request is admitted for this turn. Requests
 * for worker/ic are always granted (this gate only governs the flagship). Pure.
 *
 * `adaptive` grants manager only when ALL of:
 *   - the turn is justified: a reviewer/confidence trigger, OR high/critical risk,
 *     OR the model self-reported `escalate`, OR parsed confidence is below the
 *     risk threshold. (On the `initial` route, only high/critical risk justifies
 *     manager — we never open manager-first for a merely manager-classified, low-
 *     risk prompt.)
 *   - the per-turn manager-attempt budget isn't spent
 *     (`maxFlagshipAttemptsPerTurn`, default 1);
 *   - no observed `free` plan vetoes it (when the only observed plans are `free`,
 *     auto-opening manager would burn a tight quota — deny and let it ask for Max).
 */
export function authorizeTier(ctx: FlagshipContext): FlagshipDecision {
  const { requestedTier, currentTier, policy } = ctx;

  // This gate only governs the flagship; anything below manager is always allowed.
  if (requestedTier !== 'manager') {
    return { tier: requestedTier, allowed: true, reason: 'below flagship tier' };
  }

  const admission = resolveAdmission(policy);

  if (admission === 'always-eligible') {
    return { tier: 'manager', allowed: true, reason: 'Max: flagship always eligible' };
  }

  if (admission === 'never-auto') {
    return {
      tier: denyTier(currentTier),
      allowed: false,
      reason: 'Efficient: flagship not auto-opened (choose Max to use it)',
    };
  }

  // admission === 'adaptive'
  const { classification, assessment, trigger } = ctx;
  const highStakes = classification.risk === 'high' || classification.risk === 'critical';
  const threshold = policy.escalateBelowConfidence[classification.risk];
  const lowConfidence =
    assessment?.confidence !== undefined &&
    assessment.confidence !== null &&
    assessment.confidence < threshold;

  // "Earned" triggers are justifications in themselves: orchestrate only passes
  // 'confidence' once it has decided the turn is under-confident, 'review' once a
  // reviewer asked to escalate, and 'failure' once every vendor at the tier has
  // failed (a genuine "this is hard — bring the flagship" signal). 'initial' and
  // 'oracle' are the triggers that must justify themselves via risk/confidence — we
  // never open manager-first for a merely manager-classified, low-risk prompt, and
  // (the Oracle move) Balanced escalates a SUBSTANTIAL turn's reasoning to the
  // flagship only when that turn is ALSO high-stakes / low-confidence, staying
  // quota-conservative. Max ('always-eligible', handled above) opens the Oracle on
  // every substantial turn; Efficient ('never-auto', handled above) never does.
  const earnedTrigger = trigger === 'review' || trigger === 'confidence' || trigger === 'failure';
  const justified = earnedTrigger || highStakes || assessment?.escalate === true || lowConfidence;

  if (!justified) {
    return {
      tier: denyTier(currentTier),
      allowed: false,
      reason: 'Balanced: turn did not warrant the flagship',
    };
  }

  // Per-turn manager-attempt budget (quota guard).
  const limit = policy.maxFlagshipAttemptsPerTurn ?? 1;
  if (ctx.flagshipAttemptsThisTurn >= limit) {
    return {
      tier: denyTier(currentTier),
      allowed: false,
      reason: `Balanced: flagship attempt limit reached (${limit}/turn)`,
    };
  }

  // Observed-free-plan veto: never fabricate a plan, but when every plan we can
  // actually see is `free`, don't auto-burn a tight quota on the flagship. Scope to
  // the eligible candidate providers (post auth/cooldown filtering) when known, so a
  // cooled-down or signed-out free provider can't veto a route to a different one.
  const planInfos = ctx.planInfos ?? {};
  const candidatePlans =
    ctx.candidateProviders !== undefined
      ? ctx.candidateProviders.map((id) => planInfos[id])
      : Object.values(planInfos);
  const observed = candidatePlans.filter(
    (p): p is PlanInfo => p !== undefined && p.confidence === 'observed',
  );
  if (observed.length > 0 && observed.every((p) => p.tier === 'free')) {
    return {
      tier: denyTier(currentTier),
      allowed: false,
      reason: 'Balanced: free plan — holding the flagship to preserve quota (choose Max to override)',
    };
  }

  return {
    tier: 'manager',
    allowed: true,
    reason: 'Balanced: flagship warranted for this turn',
  };
}
