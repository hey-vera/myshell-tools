/**
 * src/core/policy.ts — the single source of orchestration thresholds & routing
 * preferences. All tunable numbers live here (typed by `Policy` in types.ts),
 * never scattered as magic constants across the core.
 *
 * Pure data module: no I/O, no time, no randomness.
 */

import type { Policy } from './types.js';

export const DEFAULT_POLICY: Policy = {
  // Bounds ordinary escalation, review, and repair iterations. Provider
  // failover is budgeted separately in runWorkCall: after an execution error,
  // every authenticated, available provider at that tier may run once even if
  // this ceiling has been reached. Timeouts remain terminal and do not fail over.
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
    worker: ['claude', 'codex', 'opencode', 'grok'],
    ic: ['claude', 'codex', 'opencode', 'grok'],
    manager: ['claude', 'codex', 'opencode', 'grok'],
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
 * on a flat-rate subscription a USD cap is fiction, and maxAttempts bounds ordinary
 * escalation/repair iterations while provider failover is bounded by the finite
 * authenticated-provider pool. The real scarce resource (rate-limit headroom) is handled per-session
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
 * The Max sub-tier, distinguished from the generic Max plan by the account's
 * rate-limit tier (Claude's `rateLimitTier`, e.g. "default_claude_max_5x" vs the
 * analogous "...max_20x"). 'unknown' covers both non-Max plans and a Max plan
 * whose sub-tier we could not read (fail-soft → behaves like generic Max). We
 * deliberately match the "5x"/"20x" SUBSTRING rather than any exact string, so a
 * future rename of the surrounding label does not break detection.
 */
export type MaxSubTier = 'max_5x' | 'max_20x' | 'unknown';

/**
 * Classify a plan string's Max sub-tier from the "5x"/"20x" substring it may
 * carry (detect.ts folds the account's rateLimitTier into the plan string as
 * "max_5x"/"max_20x" when known). Pure; case-insensitive substring match. Any
 * non-Max plan, or a Max plan with no recognised sub-tier marker, is 'unknown'
 * — which the auto path treats exactly like generic Max (3-way panel).
 */
export function classifyMaxSubTier(plan: string | null | undefined): MaxSubTier {
  if (plan === null || plan === undefined) return 'unknown';
  const p = plan.toLowerCase();
  if (!p.includes('max')) return 'unknown';
  if (p.includes('20x')) return 'max_20x';
  if (p.includes('5x')) return 'max_5x';
  return 'unknown';
}

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
 * Display label for a classified plan that is honest about the Max sub-tier:
 * "Max 5x" / "Max 20x" when the account's rate-limit tier told us which, plain
 * "Max" when it didn't (or for any non-Max tier, which just uses the tier label).
 * Pure / display-only. Keeps the concise tier name for Pro/Free/Unknown.
 */
export function planDisplayLabel(info: PlanInfo): string {
  if (info.tier === 'max') {
    const sub = classifyMaxSubTier(info.raw);
    if (sub === 'max_5x') return 'Max 5x';
    if (sub === 'max_20x') return 'Max 20x';
    return 'Max';
  }
  return PLAN_TIER_LABEL[info.tier];
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

  // Count by tier, strongest first. Max is broken out by sub-tier so the summary
  // is honest about quota ("1 Max 5x" vs "1 Max 20x") when we detected which.
  const parts: string[] = [];
  const maxByLabel = new Map<string, number>();
  for (const i of observed) {
    if (i.tier !== 'max') continue;
    const label = planDisplayLabel(i); // "Max 5x" / "Max 20x" / "Max"
    maxByLabel.set(label, (maxByLabel.get(label) ?? 0) + 1);
  }
  // Emit Max sub-tiers in a stable, strongest-first order.
  for (const label of ['Max 20x', 'Max 5x', 'Max']) {
    const n = maxByLabel.get(label) ?? 0;
    if (n > 0) parts.push(`${n} ${label}`);
  }
  for (const tier of ['pro', 'free', 'unknown'] as const) {
    const n = observed.filter((i) => i.tier === tier).length;
    if (n > 0) parts.push(`${n} ${PLAN_TIER_LABEL[tier]}`);
  }

  let summary = parts.join(', ');
  if (none > 0) {
    summary += `${parts.length > 0 ? ' · ' : ''}${none} reported no plan`;
  }
  return summary;
}

/**
 * Quota-aware tuning of an AUTO-selected policy for the Max 5x sub-tier.
 *
 * A Max 5x account has far less rate-limit headroom than Max 20x, yet both would
 * otherwise auto-engage the same 3-way cross-vendor panel on hard turns. When the
 * detected plans indicate a 5x account WITHOUT any 20x/generic-Max signal that
 * carries more headroom, narrow the auto panel to 2 providers (still a real
 * cross-vendor panel, just gentler on quota). 20x, generic Max, and any non-Max
 * mix are left exactly as today.
 *
 * Applied ONLY in the auto-mode path (keyed off the DETECTED plan) — a user who
 * explicitly picks the Max preset via /mode is untouched, because this is not
 * folded into POLICY_PRESETS['quality-first'] itself.
 *
 * Pure / fail-soft: returns the policy unchanged unless every Max signal we saw
 * is specifically 5x. `plans` are the raw plan strings of the authenticated
 * providers (the same list the auto mode was resolved from).
 */
export function tunePolicyForMaxSubTier(
  policy: Policy,
  plans: ReadonlyArray<string | null>,
): Policy {
  const maxSubs = plans
    .map(classifyPlan)
    .filter((i) => i.tier === 'max')
    .map((i) => classifyMaxSubTier(i.raw));

  if (maxSubs.length === 0) return policy; // no Max signal → unchanged
  // Keep the wider panel if ANY Max carries more headroom (20x) or an unknown
  // (generic) Max sub-tier — only narrow when EVERY Max signal is specifically 5x.
  const everyMaxIs5x = maxSubs.every((s) => s === 'max_5x');
  if (!everyMaxIs5x) return policy;
  if (policy.maxPanelProviders === undefined || policy.maxPanelProviders <= 2) {
    return policy; // already gentle enough
  }
  return { ...policy, maxPanelProviders: 2 };
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
      worker: ['claude', 'codex', 'opencode', 'grok'],
      ic: ['claude', 'codex', 'opencode', 'grok'],
      manager: ['claude', 'codex', 'opencode', 'grok'],
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
      worker: ['claude', 'codex', 'opencode', 'grok'],
      ic: ['claude', 'codex', 'opencode', 'grok'],
      manager: ['claude', 'codex', 'opencode', 'grok'],
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
