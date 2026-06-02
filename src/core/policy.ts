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
export const POLICY_PRESETS: Record<'cost-saver' | 'balanced' | 'quality-first', Policy> = {
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
