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
  providerOrderByTier: {
    worker: ['claude', 'codex'],
    ic: ['claude', 'codex'],
    manager: ['claude', 'codex'],
  },
};
