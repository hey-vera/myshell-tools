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
 * Resolve a {@link RouteDecision} for the given tier.
 *
 * Algorithm:
 *  1. Walk `policy.providerOrderByTier[tier]` in order.
 *  2. For the first provider that is present in `available`, resolve the
 *     cheapest model for that provider+tier via `getCheapestForTier`, further
 *     restricted to `availableModels[provider]` when that set is non-empty.
 *  3. If none of the policy-preferred providers are available but `available`
 *     is non-empty, fall back to the globally cheapest model for that tier.
 *  4. If `available` is empty, throw — there is nothing to route to.
 *
 * The `availableModels` parameter is additive/opt-in:
 *   - When absent or undefined → behaviour is IDENTICAL to today (no change).
 *   - When a provider's entry is present and non-empty → prefer a model in that
 *     list; if none match the pricing table, fall back to cheapest-for-tier
 *     (graceful degradation, never throws, never returns nothing).
 *
 * @param tier            - The orchestration tier to route.
 * @param available       - Provider IDs that are currently reachable.
 * @param policy          - Active routing policy (from `DEFAULT_POLICY` or overrides).
 * @param availableModels - Optional per-provider advertised model sets from detection.
 */
export function route(
  tier: Tier,
  available: ProviderId[],
  policy: Policy,
  availableModels?: Partial<Record<ProviderId, readonly string[]>>,
): RouteDecision {
  if (available.length === 0) {
    throw new Error(
      `route: no providers available for tier "${tier}" — start at least one provider`,
    );
  }

  const preferredOrder = policy.providerOrderByTier[tier];

  // Walk the preferred order and pick the first available provider.
  for (const preferred of preferredOrder) {
    if (available.includes(preferred)) {
      // When advertised models are supplied for this provider, pass them as
      // the allowed-model filter so we prefer a model the CLI actually has.
      const providerAllowed = availableModels?.[preferred];
      const allowedSet =
        providerAllowed !== undefined && providerAllowed.length > 0
          ? providerAllowed
          : undefined;
      const pricing = getCheapestForTier(tier, [preferred], allowedSet);
      return {
        tier,
        provider: preferred,
        model: pricing.model,
      };
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
