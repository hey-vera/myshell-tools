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

  // Tier ceiling — retained as route()'s final safety net only. The PRIMARY
  // control for manager access is flagshipAdmission (below): balanced is
  // 'adaptive', earning a single manager pass when a turn proves it needs it.
  // This value stays 'ic'; orchestrate lifts the ceiling to 'manager' for a
  // specific route ONLY after authorizeTier admits it (see admitManager / the
  // effPolicy in the main loop and the review path), so clampTier never negates
  // an admitted escalation yet still guards un-admitted manager requests.
  maxTier: 'ic',

  // Adaptive flagship admission: balanced earns ONE manager-tier attempt per turn
  // when justified (high/critical risk, low confidence, or a reviewer escalation),
  // vetoed for an observed free plan. See core/flagship.ts::authorizeTier.
  flagshipAdmission: 'adaptive',
  maxFlagshipAttemptsPerTurn: 1,

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

  // Auto-engaged concurrency (the default, frictionless experience). These are
  // NOT separate opt-in switches any more — the mode knob owns them:
  //  - hedgePolicy 'on'        : on a hard turn (high/critical risk) that is
  //                              likely to escalate, speculatively start the
  //                              flagship in parallel if the primary is slow, so
  //                              the user never serially waits for a weak attempt
  //                              before the strong one begins. Costs 1 run when
  //                              the primary is fast+adequate, 2 overlapped runs
  //                              when it is slow. Still gated by planHedge:
  //                              high/critical risk + flagship admittable + the
  //                              sleep port injected.
  //  - panelPolicy 'hard-turns': on a hard turn, when ≥2 providers are signed in,
  //                              run them as a cross-vendor panel + synthesizer
  //                              for independent judgment. Falls back to the
  //                              sequential path when <2 providers. Quota cost is
  //                              maxPanelProviders + 1 runs — disclosed up front
  //                              by the panel notice (never billed as "free").
  // On a flat-rate subscription the budget is quota + latency, not dollars; these
  // defaults spend a little of both on the RARE hard turn to buy a better answer,
  // and stay completely out of the way on trivial/low/medium turns.
  hedgePolicy: 'on',
  panelPolicy: 'hard-turns',
  maxPanelProviders: 2,
};

/**
 * Named policy presets selectable from the Settings screen.
 *
 * - cost-saver   : raises escalation thresholds so it rarely escalates; stays
 *                  on cheaper worker/IC tiers. flagshipAdmission 'never-auto' —
 *                  never auto-opens the flagship (manager) model.
 * - balanced     : identical to DEFAULT_POLICY; good for most work.
 *                  flagshipAdmission 'adaptive' — earns one manager pass per turn
 *                  when a turn proves it needs it (vetoed on an observed free plan).
 * - quality-first: lowers escalation thresholds so it escalates sooner and reviews
 *                  more. flagshipAdmission 'always-eligible' — manager whenever asked.
 *
 * Manager-tier access is governed by flagshipAdmission (core/flagship.ts), with
 * maxTier kept only as route()'s clamp safety net. There is no dollar budget guard:
 * on a flat-rate subscription a USD cap is fiction, and maxAttempts already bounds
 * the loop. The real scarce resource (rate-limit headroom) is handled per-session
 * by the cooldown (core/cooldown.ts) and the free-plan veto in flagship admission.
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
 * One-line descriptions, framed around how readily each mode reaches the flagship
 * (strongest) model — governed by flagshipAdmission, not a static ceiling:
 *   - Efficient never auto-opens the flagship;
 *   - Balanced EARNS a single flagship pass on a turn that proves it needs one
 *     (high/critical risk, low confidence, reviewer escalation), vetoed on an
 *     observed free plan;
 *   - Max opens the flagship whenever a turn asks for it.
 * (Honest copy: earlier wording claimed every mode "always escalates to the
 * strongest model" — false under the old maxTier clamp — and a later revision
 * over-corrected to "reserved for Max", which adaptive Balanced now makes false.)
 */
export const MODE_DESC: Record<Mode, string> = {
  'cost-saver': 'lean & fast — stays on the lighter models, escalating among them only when a turn needs it (won\'t open the top model)',
  'balanced': 'sensible middle — earns one pass at the strongest model on a turn that proves it needs it (high-risk or low-confidence); otherwise stays mid-tier',
  'quality-first': 'best answers — opens and reaches for the strongest model on hard turns; slower, never capped',
};

export function modeLabel(mode: Mode): string {
  return MODE_LABEL[mode];
}

/**
 * Recover the {@link Mode} a Policy was built from, using its `flagshipAdmission`
 * posture (the 1:1 mode marker in POLICY_PRESETS: never-auto → Efficient,
 * always-eligible → Max, adaptive/absent → Balanced). PURE. Used by orchestrate
 * to pass the active mode into the capability-fit / reasoning-effort selectors
 * without threading a second mode field everywhere. Falls back to 'balanced'
 * (the safe middle) for any unrecognised/absent admission.
 */
export function modeFromPolicy(policy: Policy): Mode {
  switch (policy.flagshipAdmission) {
    case 'never-auto':
      return 'cost-saver';
    case 'always-eligible':
      return 'quality-first';
    case 'adaptive':
      return 'balanced';
    default:
      return 'balanced';
  }
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
    // run the manager model at all. (maxTier retained as a route() safety net;
    // flagshipAdmission 'never-auto' is the primary control.)
    maxTier: 'ic',
    flagshipAdmission: 'never-auto',
    maxFlagshipAttemptsPerTurn: 0,
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
    // Efficient is the quota-frugal posture: NO auto-engaged concurrency. No
    // speculative hedge, no cross-vendor panel — the user explicitly chose to
    // conserve quota, so a hard turn runs the single sequential path. (They can
    // still force a panel/hedge per turn; see the explicit overrides.)
    hedgePolicy: 'off',
    panelPolicy: 'off',
  },

  'balanced': DEFAULT_POLICY,

  'quality-first': {
    maxAttempts: 3,
    // Opens the manager tier — quality-first is the preset where escalating to
    // (and reviewing with) the most capable model is the intended behaviour.
    maxTier: 'manager',
    flagshipAdmission: 'always-eligible',
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
    // Max auto-engages the same concurrency as Balanced, but with broader panel
    // coverage: a hard turn runs up to 3 signed-in providers (vs Balanced's 2)
    // before synthesis, because the user explicitly chose "best answers" and
    // accepts the extra quota. Panel still only forms on high/critical turns with
    // ≥2 providers; hedge still only fires when the primary is slow.
    hedgePolicy: 'on',
    panelPolicy: 'hard-turns',
    maxPanelProviders: 3,
  },
};
