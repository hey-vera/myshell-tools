/**
 * src/core/route.ts — pure cost-aware routing decision.
 *
 * Given a tier, the set of currently available provider IDs, and the active
 * Policy, selects the concrete provider+model that should handle the work.
 *
 * No I/O, no time, no randomness. Pricing data is pure reference data imported
 * from infra/pricing (permitted by the purity guard because pricing.ts itself
 * imports no fs/path/child_process).
 */

import type { Tier, RouteDecision, Policy } from './types.js';
import type { ProviderId } from '../providers/port.js';
import { getCheapestForTier } from '../infra/pricing.js';
import { selectOpencodeModel } from './opencode-model.js';

/**
 * Ordinal rank of each tier, cheapest → most expensive. Used to clamp a
 * requested tier DOWN to a policy ceiling (`policy.maxTier`).
 */
const TIER_RANK: Record<Tier, number> = {
  worker: 0,
  ic: 1,
  manager: 2,
};

/**
 * Clamp `requested` down to `ceiling` when a ceiling is set. This ONLY lowers
 * the tier (never raises it): if the requested tier already sits at or below the
 * ceiling it is returned unchanged. `undefined` ceiling → no clamp (classifier
 * / caller wins). This is the single chokepoint that caps both initial routing
 * AND escalation/review calls — e.g. under `balanced` (maxTier 'ic') a
 * `route('manager', ...)` request resolves an IC model (sonnet), never opus.
 */
export function clampTier(requested: Tier, ceiling: Tier | undefined): Tier {
  if (ceiling === undefined) return requested;
  return TIER_RANK[requested] > TIER_RANK[ceiling] ? ceiling : requested;
}

/**
 * Resolve a {@link RouteDecision} for the given tier.
 *
 * Algorithm:
 *  0. Clamp the requested `tier` DOWN to `policy.maxTier` when set (only lowers,
 *     never raises; undefined = no cap). This is the single chokepoint that caps
 *     initial routing AND escalation/review calls, so e.g. under `balanced`
 *     (maxTier 'ic') a manager request resolves an IC model, not opus.
 *  1. Walk `policy.providerOrderByTier[tier]` in preference order.
 *  2. When `authenticatedProviders` is supplied and non-empty, prefer the FIRST
 *     provider that is both in `available` AND in `authenticatedProviders`.
 *     This ensures signed-in providers are chosen before signed-out ones,
 *     avoiding wasted attempts against providers that are installed but not
 *     logged in.
 *  3. If no authenticated+available match is found (or `authenticatedProviders`
 *     is absent/empty), fall back to the FIRST provider in preference order that
 *     is present in `available` (current behaviour — a signed-out provider may
 *     still be tried; auth can change at call time and failover handles the rest).
 *  4. If none of the policy-preferred providers are available but `available`
 *     is non-empty, fall back to the globally cheapest model for that tier.
 *  5. If `available` is empty, throw — there is nothing to route to.
 *
 * The `availableModels` parameter is additive/opt-in:
 *   - When absent or undefined → behaviour is IDENTICAL to today (no change).
 *   - When a provider's entry is present and non-empty → prefer a model in that
 *     list; if none match the pricing table, fall back to cheapest-for-tier
 *     (graceful degradation, never throws, never returns nothing).
 *
 * The `authenticatedProviders` parameter is additive/opt-in:
 *   - When absent or empty → behaviour is IDENTICAL to today (no change).
 *   - When supplied and non-empty → authenticated+available providers are
 *     preferred over signed-out+available ones within the policy order.
 *
 * The `preferredOrder` parameter is additive/opt-in (the Local Outcome Learner):
 *   - When absent or empty → behaviour is IDENTICAL to today (no change).
 *   - When supplied and non-empty → this LEARNED order is tried FIRST, using the
 *     SAME auth-aware logic (prefer the first provider that is in `available`
 *     AND, when auth info is present, in `authenticatedProviders`). Only when the
 *     learned order yields no eligible provider does route() fall back to
 *     `policy.providerOrderByTier`. The learned order never expands the candidate
 *     set (a provider must still be in `available`), so it can only REORDER which
 *     reachable provider wins — never route to an unreachable one.
 *
 * @param tier                   - The orchestration tier to route.
 * @param available              - Provider IDs that are currently reachable.
 * @param policy                 - Active routing policy (from `DEFAULT_POLICY` or overrides).
 * @param availableModels        - Optional per-provider advertised model sets from detection.
 * @param authenticatedProviders - Optional set of provider IDs known to be signed in.
 * @param preferredOrder         - Optional learned, observed-only provider order
 *                                 (for the clamped tier) to try before the static
 *                                 policy order. Absent/empty → no effect.
 */
export function route(
  tier: Tier,
  available: ProviderId[],
  policy: Policy,
  availableModels?: Partial<Record<ProviderId, readonly string[]>>,
  authenticatedProviders?: readonly ProviderId[],
  preferredOrder?: readonly ProviderId[],
): RouteDecision {
  if (available.length === 0) {
    throw new Error(
      `route: no providers available for tier "${tier}" — start at least one provider`,
    );
  }

  // Clamp the requested tier down to the policy ceiling BEFORE model resolution.
  // From here on, `tier` is the *effective* tier: provider preference order,
  // model selection, and the returned RouteDecision.tier all use the clamped
  // value, so the decision stays internally consistent (an IC model is reported
  // as tier 'ic', never as a 'manager' decision running a sonnet model).
  tier = clampTier(tier, policy.maxTier);

  const preferredOrder_policy = policy.providerOrderByTier[tier];
  const hasAuthInfo =
    authenticatedProviders !== undefined && authenticatedProviders.length > 0;

  /**
   * Build a RouteDecision for the given provider id, applying the
   * availableModels filter when present.
   */
  function decisionFor(id: ProviderId): RouteDecision {
    const providerAllowed = availableModels?.[id];
    const allowedSet =
      providerAllowed !== undefined && providerAllowed.length > 0
        ? providerAllowed
        : undefined;
    // opencode: which models are usable is entirely the user's connected set
    // (free models, OpenCode Go subscription, or Zen credits). Pick the best of
    // their REAL available models for this tier instead of a pricing placeholder,
    // so `opencode run -m` uses a model they actually have. Fail-safe: when no
    // usable model is found, fall through to pricing (the adapter then omits -m
    // and lets opencode use its own configured default).
    if (id === 'opencode') {
      const picked = selectOpencodeModel(tier, allowedSet);
      if (picked !== undefined) return { tier, provider: id, model: picked };
    }
    const pricing = getCheapestForTier(tier, [id], allowedSet);
    return { tier, provider: id, model: pricing.model };
  }

  // Order in which we consult provider-preference lists: the LEARNED order first
  // (when supplied and non-empty — the Local Outcome Learner), then the static
  // policy order. Each list is walked auth-aware then first-available, so the
  // learned order can only REORDER among reachable providers; it never strands
  // routing (an empty/non-eligible learned list simply falls through to policy).
  const learnedOrder =
    preferredOrder !== undefined && preferredOrder.length > 0 ? preferredOrder : undefined;
  const candidateOrders: ReadonlyArray<readonly ProviderId[]> =
    learnedOrder !== undefined ? [learnedOrder, preferredOrder_policy] : [preferredOrder_policy];

  // Auth-aware pass: when authenticatedProviders is supplied and non-empty, prefer
  // the first provider that is both available AND authenticated. We try the
  // learned order's authenticated match BEFORE the policy order's, so a learned
  // preference wins when it is eligible. This prevents wasting an attempt on a
  // signed-out provider when a ready one exists later in a preference order.
  if (hasAuthInfo) {
    for (const order of candidateOrders) {
      for (const preferred of order) {
        if (
          available.includes(preferred) &&
          (authenticatedProviders as readonly ProviderId[]).includes(preferred)
        ) {
          return decisionFor(preferred);
        }
      }
    }
    // No authenticated+available match found in any order — fall through to the
    // standard first-available pass below (signed-out provider as last resort).
  }

  // Standard pass: walk each preference order (learned first) and pick the first
  // available provider.
  for (const order of candidateOrders) {
    for (const preferred of order) {
      if (available.includes(preferred)) {
        return decisionFor(preferred);
      }
    }
  }

  // None of the policy-preferred providers are available; fall back to the
  // globally cheapest provider, then apply the normal provider-specific model
  // selection so advertised-model filters and opencode handling are preserved.
  const fallback = getCheapestForTier(tier, available);
  return decisionFor(fallback.provider as ProviderId);
}
