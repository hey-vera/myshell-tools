/**
 * src/core/capacity-allocator.ts — pure subscription-capacity allocation math.
 *
 * Design source: DESIGN-ALLOCATOR.md §1, §3, §4.
 *
 * This module is intentionally substrate-only:
 * - no I/O
 * - no clocks
 * - no randomness
 * - no module state
 */

import type { ProviderId } from '../providers/port.js';
import type { Risk, Tier } from './types.js';
import {
  classifyMaxSubTier,
  classifyPlan,
  type Mode,
} from './policy.js';

const CANONICAL_PROVIDER_ORDER: readonly ProviderId[] = ['claude', 'codex', 'opencode'];

// Internal capacity classes. Not exported yet — no consumer references the bare
// union (callers use CapacityWeight). A later slice can export it if a display
// or settings surface needs the label directly.
type CapacityTier =
  | 'claude-max-20x'
  | 'claude-max-5x'
  | 'claude-max-generic'
  | 'paid-high'
  | 'paid-standard'
  | 'free'
  | 'unknown';

export interface CapacityWeight {
  readonly provider: ProviderId;
  readonly tier: CapacityTier;
  readonly weight: number;
  readonly confidence: 'observed' | 'none';
}

export function classifyCapacity(provider: ProviderId, plan: string | null): CapacityWeight {
  const planInfo = classifyPlan(plan);
  if (planInfo.confidence !== 'observed' || planInfo.raw === null) {
    return unknownCapacity(provider);
  }

  const normalizedPlan = planInfo.raw.toLowerCase();

  if (provider === 'claude') {
    if (planInfo.tier === 'max') {
      const maxSubTier = classifyMaxSubTier(planInfo.raw);
      if (maxSubTier === 'max_20x') {
        return observedCapacity(provider, 'claude-max-20x', 10);
      }
      if (maxSubTier === 'max_5x') {
        return observedCapacity(provider, 'claude-max-5x', 4);
      }
      return observedCapacity(provider, 'claude-max-generic', 4);
    }
    if (planInfo.tier === 'pro') {
      return observedCapacity(provider, 'paid-standard', 1);
    }
    if (planInfo.tier === 'free') {
      return observedCapacity(provider, 'free', 0.25);
    }
    return unknownCapacity(provider);
  }

  if (planInfo.tier === 'free') {
    return observedCapacity(provider, 'free', 0.25);
  }

  // Conservative honesty rule for Codex/OpenCode:
  // - only explicit, recognized labels move away from neutral unknown;
  // - standard paid labels stay at weight 1.0;
  // - the high-capacity rows (Codex 5.0 / OpenCode 3.0) trigger ONLY on a
  //   clearly explicit high-capacity marker, otherwise we stay neutral or
  //   standard-paid rather than promoting by provider reputation.
  if (!hasRecognizedPaidLabel(normalizedPlan)) {
    return unknownCapacity(provider);
  }

  if (provider === 'codex') {
    if (hasExplicitHighCapacityMarker(normalizedPlan)) {
      return observedCapacity(provider, 'paid-high', 5);
    }
    return observedCapacity(provider, 'paid-standard', 1);
  }

  if (hasExplicitHighCapacityMarker(normalizedPlan)) {
    return observedCapacity(provider, 'paid-high', 3);
  }
  return observedCapacity(provider, 'paid-standard', 1);
}

export function deriveBaselineOrder(
  weights: readonly CapacityWeight[],
): Record<Tier, readonly ProviderId[]> {
  const present = new Set<ProviderId>();
  const sorted = [...weights]
    .sort((left, right) => {
      if (right.weight !== left.weight) return right.weight - left.weight;
      return canonicalIndex(left.provider) - canonicalIndex(right.provider);
    })
    .map((entry) => {
      present.add(entry.provider);
      return entry.provider;
    });

  const order = [
    ...sorted,
    ...CANONICAL_PROVIDER_ORDER.filter((provider) => !present.has(provider)),
  ] as const;

  return {
    worker: order,
    ic: order,
    manager: order,
  };
}

export type Intensity = 'auto' | 1 | 2 | 3 | 4 | 5;

export type IntensityRegime = 'focused' | 'pair' | 'fleet' | 'fleet-hedge' | 'fleet-panel';

export function regimeForIntensity(level: Exclude<Intensity, 'auto'>): IntensityRegime {
  switch (level) {
    case 1:
      return 'focused';
    case 2:
      return 'pair';
    case 3:
      return 'fleet';
    case 4:
      return 'fleet-hedge';
    case 5:
      return 'fleet-panel';
  }
}

export function legacyModeToIntensity(
  mode: Mode,
  opts: { panel?: boolean; hedge?: boolean } = {},
): Exclude<Intensity, 'auto'> {
  const base =
    mode === 'cost-saver' ? 1
      : mode === 'balanced' ? 3
        : 5;
  const floor = Math.max(opts.panel === true ? 5 : 0, opts.hedge === true ? 4 : 0);
  return Math.max(base, floor) as Exclude<Intensity, 'auto'>;
}

export function autoIntensityForTurn(s: {
  readonly tier: Tier;
  readonly risk: Risk;
  readonly depth: 0 | 1 | 2;
  readonly escalate: boolean;
  readonly needsReview?: boolean;
}): Exclude<Intensity, 'auto'> {
  const hardTurn = s.risk === 'high' || s.risk === 'critical';
  if (
    (s.risk === 'critical' && (s.tier === 'manager' || s.depth === 2)) ||
    (s.needsReview === true && hardTurn)
  ) {
    return 4;
  }
  if (hardTurn || s.escalate) {
    return 4;
  }
  if (s.tier === 'manager' || s.depth === 2) {
    return 3;
  }
  // Efficiency-first: the genuinely-trivial fast path (worker + low risk + no
  // depth) earns the cheapest regime. Checked BEFORE the ordinary row below
  // because a trivial turn also satisfies the ordinary predicate; ordering it
  // first is what keeps 1 reachable instead of always landing on 2.
  if (s.tier === 'worker' && s.risk === 'low' && s.depth === 0) {
    return 1;
  }
  if (
    (s.tier === 'worker' || s.tier === 'ic') &&
    (s.risk === 'low' || s.risk === 'medium')
  ) {
    return 2;
  }
  return 2;
}

export interface LiveCapacityInput {
  readonly baselineOrderByTier: Record<Tier, readonly ProviderId[]>;
  readonly capacityWeightByProvider: Readonly<Partial<Record<ProviderId, number>>>;
  readonly sessionTokensByProvider: Readonly<Partial<Record<ProviderId, number>>>;
  readonly learnedOutcomeOrderByTier?: Partial<Record<Tier, readonly ProviderId[]>>;
  readonly coolingProviders: ReadonlySet<ProviderId>;
}

export function deriveLiveProviderOrder(
  input: LiveCapacityInput,
): Record<Tier, readonly ProviderId[]> {
  return {
    worker: deriveLiveTierOrder('worker', input),
    ic: deriveLiveTierOrder('ic', input),
    manager: deriveLiveTierOrder('manager', input),
  };
}

function deriveLiveTierOrder(
  tier: Tier,
  input: LiveCapacityInput,
): readonly ProviderId[] {
  const baseline = input.baselineOrderByTier[tier];
  const learned = input.learnedOutcomeOrderByTier?.[tier];
  const composed = learned !== undefined && learned.length > 0
    ? [
        ...learned,
        ...baseline.filter((provider) => !learned.includes(provider)),
      ]
    : [...baseline];

  const totalObservedTokens = composed.reduce(
    (sum, provider) => sum + (input.sessionTokensByProvider[provider] ?? 0),
    0,
  );
  if (totalObservedTokens === 0) {
    return composed;
  }

  const sorted = composed
    .map((provider, index) => ({
      provider,
      index,
      normalizedLoad:
        (input.sessionTokensByProvider[provider] ?? 0) /
        (input.capacityWeightByProvider[provider] ?? 1),
    }))
    .sort((left, right) => {
      if (left.normalizedLoad !== right.normalizedLoad) {
        return left.normalizedLoad - right.normalizedLoad;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.provider);

  const active = sorted.filter((provider) => !input.coolingProviders.has(provider));
  const cooling = sorted.filter((provider) => input.coolingProviders.has(provider));
  return [...active, ...cooling];
}

function observedCapacity(
  provider: ProviderId,
  tier: CapacityTier,
  weight: number,
): CapacityWeight {
  return { provider, tier, weight, confidence: 'observed' };
}

function unknownCapacity(provider: ProviderId): CapacityWeight {
  return { provider, tier: 'unknown', weight: 1, confidence: 'none' };
}

function hasRecognizedPaidLabel(plan: string): boolean {
  return ['pro', 'plus', 'max', 'team', 'business'].some((label) => plan.includes(label));
}

function hasExplicitHighCapacityMarker(plan: string): boolean {
  return (
    plan.includes('high-capacity') ||
    plan.includes('high capacity') ||
    plan.includes('priority') ||
    plan.includes('enterprise')
  );
}

function canonicalIndex(provider: ProviderId): number {
  return CANONICAL_PROVIDER_ORDER.indexOf(provider);
}
