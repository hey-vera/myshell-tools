/**
 * src/core/escalate.ts — pure escalation helpers.
 *
 * Provides utilities for determining the next tier in the escalation chain
 * and selecting a cross-vendor reviewer.
 *
 * Pure module: no I/O, no time, no randomness.
 */

import type { Tier } from './types.js';
import type { ProviderId } from '../providers/port.js';
import type { CapabilityRegistry } from './model-capabilities.js';
import { findCapability } from './model-capabilities.js';
import { opencodeTierRank, poolForModelId } from './route-types.js';

// ---------------------------------------------------------------------------
// Tier chain
// ---------------------------------------------------------------------------

/**
 * Return the next tier up from the given tier, or null if already at the top.
 *
 * Chain: worker → ic → manager → null
 *
 * @param tier - The current orchestration tier.
 */
export function nextTierUp(tier: Tier): Tier | null {
  switch (tier) {
    case 'worker':
      return 'ic';
    case 'ic':
      return 'manager';
    case 'manager':
      return null;
  }
}

// ---------------------------------------------------------------------------
// Reviewer selection
// ---------------------------------------------------------------------------

/**
 * Pick a reviewer provider from the available list, preferring cross-vendor
 * review over same-vendor review.
 *
 * Algorithm:
 *  1. If `available` is empty, return null.
 *  2. Prefer a provider with a DIFFERENT id than `primary` (cross-vendor review).
 *  3. If all available are the same vendor as primary, return `primary` if it
 *     is in `available`, else return null.
 *
 * @param available - Provider IDs that are currently reachable.
 * @param primary   - The provider ID that ran the IC work being reviewed.
 */
export function pickReviewer(
  available: ProviderId[],
  primary: ProviderId,
  opts?: {
    /** When true, select the cross-vendor reviewer with the highest manager suitability. */
    readonly vendorNeutralEnabled?: boolean;
    readonly registry?: CapabilityRegistry;
    readonly availableModels?: ReadonlyMap<ProviderId, readonly string[]>;
  },
): ProviderId | null {
  if (available.length === 0) return null;

  if (opts?.vendorNeutralEnabled === true && opts.registry !== undefined && opts.availableModels !== undefined) {
    const crossVendors = available.filter((id) => id !== primary);
    if (crossVendors.length === 0) {
      if (available.includes(primary)) return primary;
      return null;
    }
    // Pick the cross-vendor provider whose best model has the highest manager suitability.
    let best: ProviderId | null = null;
    let bestScore = -1;
    for (const provider of crossVendors) {
      const models = opts.availableModels.get(provider) ?? [];
      for (const model of models) {
        const cap = findCapability(opts.registry, provider, model);
        const poolId = poolForModelId(model, provider);
        let score = 0;
        if (provider === 'opencode') {
          const rank = opencodeTierRank(model);
          score = rank.manager;
        } else if (cap?.routingProfile) {
          score = cap.routingProfile.tierSuitability.manager;
        }
        if (score > bestScore) {
          bestScore = score;
          best = provider;
        }
      }
    }
    if (best !== null) return best;
    // No scored cross-vendor — fall back to first cross-vendor.
    return crossVendors[0] ?? null;
  }

  // Prefer a different vendor (cross-vendor review is the goal)
  const crossVendor = available.find((id) => id !== primary);
  if (crossVendor !== undefined) return crossVendor;

  // All available are same vendor — return primary if it's in the list
  if (available.includes(primary)) return primary;

  return null;
}
