/**
 * src/core/policy.ts — the single source of orchestration thresholds & routing
 * preferences. All tunable numbers live here (typed by `Policy` in types.ts),
 * never scattered as magic constants across the core.
 *
 * Pure data module: no I/O, no time, no randomness.
 */

import type { Policy } from './types.js';

export const DEFAULT_POLICY: Policy = {
  maxAttempts: 3,

  // Hard tier ceiling. balanced must NOT auto-launch the manager tier (opus /
  // gpt-5.5) off a soft classification — running the most expensive model is an
  // explicit user choice, not a default. Clamping to 'ic' means a message that
  // classifies as 'manager' still runs at most the IC model (sonnet) under
  // balanced; escalation/review calls are clamped at the same chokepoint
  // (route()). quality-first is the preset that opens the manager tier.
  maxTier: 'ic',

  // Per-task USD budget guard. A defensible round ceiling (not measured
  // precision): balanced should comfortably cover normal IC work while still
  // stopping a runaway loop. orchestrate() stops spending once totalCostUsd
  // reaches this.
  maxCostUsd: 2.0,

  // Higher-risk work demands higher confidence before we accept it; below the
  // threshold we escalate to a higher tier (or, later, a cross-vendor review).
  escalateBelowConfidence: {
    low: 0.4,
    medium: 0.5,
    high: 0.7,
    critical: 0.8,
  },

  // Provider preference per tier. route() picks the first available provider in
  // this order that has a model for the tier; otherwise it falls back to the
  // cheapest available model for that tier (via pricing.getCheapestForTier).
  // opencode is listed last — it is a fallback / explicit-choice provider and
  // must NOT displace claude or codex when those are available.
  providerOrderByTier: {
    worker: ['claude', 'codex', 'opencode'],
    ic: ['claude', 'codex', 'opencode'],
    manager: ['claude', 'codex', 'opencode'],
  },

  // Review policy: 'auto' = current default behaviour (review on high/critical or needsReview).
  reviewPolicy: 'auto',
};

/**
 * Named policy presets selectable from the Settings screen.
 *
 * - cost-saver   : raises escalation thresholds so it rarely escalates; stays
 *                  on cheaper worker/IC tiers as long as possible.
 *                  maxTier 'ic' (never manager), maxCostUsd $0.50.
 * - balanced     : identical to DEFAULT_POLICY; good for most work.
 *                  maxTier 'ic' (manager is an explicit ask), maxCostUsd $2.00.
 * - quality-first: lowers escalation thresholds so it escalates sooner and
 *                  reviews more; prioritises quality over token cost.
 *                  maxTier 'manager' (opens the manager tier), no cost cap.
 *
 * maxTier is enforced by route() (the single clamp chokepoint); maxCostUsd is
 * enforced by orchestrate()'s budget guard. The dollar figures are defensible
 * round ceilings, not measured precision.
 */
export type Mode = 'cost-saver' | 'balanced' | 'quality-first';

/**
 * User-facing labels — framed around the quality↔speed spectrum, NOT cost
 * (myshell-tools drives subscriptions, so "cost" is the wrong axis). The internal
 * keys stay stable so persisted configs and route() are untouched.
 */
const MODE_LABEL: Record<Mode, string> = {
  'cost-saver': 'Efficient',
  'balanced': 'Balanced',
  'quality-first': 'Max',
};

/**
 * One-line descriptions, framed around how high each mode lets routing reach.
 * Within a mode the architecture still escalates to that mode's CEILING when a
 * turn needs it — but the ceiling differs by mode: Efficient and Balanced top out
 * below the strongest model, and only Max opens it. Launching the most powerful
 * (and priciest) model is a deliberate choice, not a silent default — see the
 * maxTier reasoning in DEFAULT_POLICY. (Honest copy: earlier wording claimed every
 * mode "always escalates to the strongest model", which the maxTier clamp on
 * cost-saver/balanced makes false.)
 */
export const MODE_DESC: Record<Mode, string> = {
  'cost-saver': 'lean & fast — stays on the lighter models, escalating among them only when a turn needs it (won\'t open the top model)',
  'balanced': 'sensible middle — escalates to the mid-tier model on harder turns; the strongest model stays reserved for Max',
  'quality-first': 'best answers — opens and reaches for the strongest model on hard turns; slower, never capped',
};

export function modeLabel(mode: Mode): string {
  return MODE_LABEL[mode];
}

/**
 * Pick a sensible default mode from the detected subscription plan, so a new user
 * gets the right firepower WITHOUT being asked. Big plan (Max) → the top of the
 * knob; everything else → balanced; unknown/none → balanced (safe). Pure;
 * case-insensitive substring match on the plan string (e.g. claude's
 * `subscriptionType`).
 */
export function defaultModeForPlan(plan: string | null | undefined): Mode {
  if (plan === null || plan === undefined) return 'balanced';
  const p = plan.toLowerCase();
  if (p.includes('max')) return 'quality-first';
  if (p.includes('free')) return 'cost-saver';
  return 'balanced';
}

/**
 * The KIND of a subscription plan, classified from its reported label. This is
 * the honest taxonomy: we only ever observe a plan string from a CLI that
 * actually reports one (Claude's `subscriptionType` today). Everything else is
 * `unknown` with `confidence: 'none'` — we never fabricate a tier.
 */
export type PlanTier = 'max' | 'pro' | 'free' | 'unknown';

/**
 * A classified plan for one provider. `raw` is the original reported string
 * (null when the CLI reports no plan). `tier` is the classified kind. `confidence`
 * distinguishes a real reported plan ('observed') from the absence of any signal
 * ('none') — there is deliberately no 'inferred' producer yet, because inferring a
 * plan from indirect signals would be fabrication. The variant is reserved so the
 * shape is forward-compatible the day a CLI lets us infer responsibly.
 */
export interface PlanInfo {
  readonly raw: string | null;
  readonly tier: PlanTier;
  readonly confidence: 'observed' | 'inferred' | 'none';
}

/**
 * Classify a single reported plan string into a {@link PlanInfo}. Pure;
 * case-insensitive substring match. A null plan (CLI reports nothing) classifies
 * to `unknown` / `none` — NOT a guess. A non-null string that matches no known
 * kind is `unknown` but still `observed` (we saw a plan, we just don't recognise
 * the label). Order matters: 'max' is checked before 'pro' so "max" never falls
 * through to a substring like "pro".
 */
export function classifyPlan(plan: string | null): PlanInfo {
  if (plan === null) {
    return { raw: null, tier: 'unknown', confidence: 'none' };
  }
  const p = plan.toLowerCase();
  let tier: PlanTier = 'unknown';
  if (p.includes('max')) tier = 'max';
  else if (p.includes('pro')) tier = 'pro';
  else if (p.includes('free')) tier = 'free';
  return { raw: plan, tier, confidence: 'observed' };
}

/**
 * Resolve the auto mode from a set of classified plans (strongest KIND wins).
 * Pure. Built on {@link classifyPlan} so the decision and the display share one
 * taxonomy. Rules, accounting for the FULL set of authenticated providers:
 *   - any plan is 'max'          -> 'quality-first'
 *   - else any plan is 'pro'     -> 'balanced'
 *   - no observed plans at all   -> 'balanced'   (no signal)
 *   - every observed plan 'free' -> 'cost-saver'
 *   - otherwise                  -> 'balanced'
 */
export function autoModeForPlanInfos(infos: ReadonlyArray<PlanInfo>): Mode {
  const observed = infos.filter((i) => i.confidence === 'observed');

  if (observed.some((i) => i.tier === 'max')) return 'quality-first';
  if (observed.some((i) => i.tier === 'pro')) return 'balanced';
  if (observed.length === 0) return 'balanced';
  if (observed.every((i) => i.tier === 'free')) return 'cost-saver';
  return 'balanced';
}

/**
 * Convenience overload kept for existing call-sites that hold raw plan strings:
 * classifies each then delegates to {@link autoModeForPlanInfos}. `plans` is the
 * list of plan strings for authenticated providers (null for providers whose CLI
 * does not expose a plan, e.g. codex/opencode today).
 */
export function autoModeForPlans(plans: ReadonlyArray<string | null>): Mode {
  return autoModeForPlanInfos(plans.map(classifyPlan));
}

/** Title-case label for a {@link PlanTier} (display only). */
const PLAN_TIER_LABEL: Record<PlanTier, string> = {
  max: 'Max',
  pro: 'Pro',
  free: 'Free',
  unknown: 'Unknown',
};

export function planTierLabel(tier: PlanTier): string {
  return PLAN_TIER_LABEL[tier];
}

/**
 * Summarise a set of classified plans into a short reason string that accounts
 * for the FULL multiset (counts and kinds), e.g. "2 Max, 1 Pro" or
 * "Max + Pro". Providers that reported no plan are counted separately as
 * "N reported no plan" so the string never implies we know more than we do.
 * Returns "no plan reported" when nothing was observed. Pure.
 */
export function describePlanSet(infos: ReadonlyArray<PlanInfo>): string {
  const observed = infos.filter((i) => i.confidence === 'observed');
  const none = infos.length - observed.length;

  if (observed.length === 0) {
    return 'no plan reported';
  }

  // Count by tier, strongest first.
  const order: readonly PlanTier[] = ['max', 'pro', 'free', 'unknown'];
  const parts: string[] = [];
  for (const tier of order) {
    const n = observed.filter((i) => i.tier === tier).length;
    if (n > 0) parts.push(`${n} ${PLAN_TIER_LABEL[tier]}`);
  }

  let summary = parts.join(', ');
  if (none > 0) {
    summary += `${parts.length > 0 ? ' · ' : ''}${none} reported no plan`;
  }
  return summary;
}

export const POLICY_PRESETS: Record<Mode, Policy> = {
  'cost-saver': {
    maxAttempts: 4,
    // Tightest tier ceiling: never leave the IC tier. cost-saver should never
    // run the manager model at all.
    maxTier: 'ic',
    // Smallest budget guard — a defensible round ceiling, not measured precision.
    maxCostUsd: 0.5,
    escalateBelowConfidence: {
      low: 0.2,
      medium: 0.3,
      high: 0.5,
      critical: 0.65,
    },
    providerOrderByTier: {
      worker: ['claude', 'codex', 'opencode'],
      ic: ['claude', 'codex', 'opencode'],
      manager: ['claude', 'codex', 'opencode'],
    },
    // Only trigger cross-vendor review for critical-risk tasks to halve spend.
    reviewPolicy: 'critical-only',
  },

  'balanced': DEFAULT_POLICY,

  'quality-first': {
    maxAttempts: 3,
    // Opens the manager tier — quality-first is the preset where escalating to
    // (and reviewing with) the most capable model is the intended behaviour.
    maxTier: 'manager',
    // No budget cap: quality-first prioritises quality over token cost, so the
    // budget guard is disabled (null = no cap).
    maxCostUsd: null,
    escalateBelowConfidence: {
      low: 0.6,
      medium: 0.7,
      high: 0.85,
      critical: 0.92,
    },
    providerOrderByTier: {
      worker: ['claude', 'codex', 'opencode'],
      ic: ['claude', 'codex', 'opencode'],
      manager: ['claude', 'codex', 'opencode'],
    },
    // Review on high/critical risk or model-requested needsReview (most thorough).
    reviewPolicy: 'auto',
  },
};
