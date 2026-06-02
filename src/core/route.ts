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
function clampTier(requested: Tier, ceiling: Tier | undefined): Tier {
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
 * @param tier                   - The orchestration tier to route.
 * @param available              - Provider IDs that are currently reachable.
 * @param policy                 - Active routing policy (from `DEFAULT_POLICY` or overrides).
 * @param availableModels        - Optional per-provider advertised model sets from detection.
 * @param authenticatedProviders - Optional set of provider IDs known to be signed in.
 */
export function route(
  tier: Tier,
  available: ProviderId[],
  policy: Policy,
  availableModels?: Partial<Record<ProviderId, readonly string[]>>,
  authenticatedProviders?: readonly ProviderId[],
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

  const preferredOrder = policy.providerOrderByTier[tier];
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
    const pricing = getCheapestForTier(tier, [id], allowedSet);
    return { tier, provider: id, model: pricing.model };
  }

  // Auth-aware pass: when authenticatedProviders is supplied and non-empty,
  // walk the preferred order and pick the first provider that is both available
  // AND authenticated.  This prevents wasting an attempt on a signed-out provider
  // when a ready one exists later in the preference order.
  if (hasAuthInfo) {
    for (const preferred of preferredOrder) {
      if (
        available.includes(preferred) &&
        (authenticatedProviders as readonly ProviderId[]).includes(preferred)
      ) {
        return decisionFor(preferred);
      }
    }
    // No authenticated+available match found — fall through to the standard
    // first-available pass below (signed-out provider as last resort).
  }

  // Standard pass: walk the preferred order and pick the first available provider.
  for (const preferred of preferredOrder) {
    if (available.includes(preferred)) {
      return decisionFor(preferred);
    }
  }

  // None of the policy-preferred providers are available; fall back to the
  // globally cheapest model across all available providers.
  const fallback = getCheapestForTier(tier, available);
  return {
    tier,
    provider: fallback.provider as ProviderId,
    model: fallback.model,
  };
}
