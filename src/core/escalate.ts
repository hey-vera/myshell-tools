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
export function pickReviewer(available: ProviderId[], primary: ProviderId): ProviderId | null {
  if (available.length === 0) return null;

  // Prefer a different vendor (cross-vendor review is the goal)
  const crossVendor = available.find((id) => id !== primary);
  if (crossVendor !== undefined) return crossVendor;

  // All available are same vendor — return primary if it's in the list
  if (available.includes(primary)) return primary;

  return null;
}
