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
 * - balanced     : identical to DEFAULT_POLICY; good for most work.
 * - quality-first: lowers escalation thresholds so it escalates sooner and
 *                  reviews more; prioritises quality over token cost.
 */
export const POLICY_PRESETS: Record<'cost-saver' | 'balanced' | 'quality-first', Policy> = {
  'cost-saver': {
    maxAttempts: 4,
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
