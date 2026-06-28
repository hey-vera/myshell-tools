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

/**
 * The maximum number of goals that may run TRULY CONCURRENTLY for a given
 * intensity/tuning regime — the "tuning is a CEILING, never a floor" rule
 * expressed as a pure mapping. `focused`/`pair` → 1 (single-file: low/standard
 * tuning never engages cross-goal concurrency, exactly today's behavior); the
 * `fleet*` regimes → 2, never above {@link BASE_ACTIVE_LIMIT} (= 2 in
 * scheduler.ts). Raising the fleet ceiling to 3–4 is a deferred phase gated on
 * ≥3 signed-in providers; this function never returns more than 2. Pure, total.
 */
export function concurrencyCeilingForRegime(regime: IntensityRegime): 1 | 2 {
  switch (regime) {
    case 'focused':
    case 'pair':
      return 1;
    case 'fleet':
    case 'fleet-hedge':
    case 'fleet-panel':
      return 2;
  }
}

/** Named ceilings + the demand term for {@link crossGoalCap}. */
export interface CrossGoalCapInput {
  /** Honest provider/pressure ceiling from planSchedule.activeLimit. */
  readonly activeLimit: number;
  /** Tuning ceiling from {@link concurrencyCeilingForRegime}. */
  readonly tuningCeiling: number;
  /** Governor turnCallBudget headroom ceiling (budget 1 → 1, ≥2 → 2). */
  readonly callBudgetCeiling: number;
  /** DEMAND: count of independent runnable goals (no unmet dependency). */
  readonly genuineParallelGoalCount: number;
}

/**
 * The load-bearing cross-goal concurrency cap: the `min` of every named ceiling
 * and the demand term — mirroring `planningDepthCap`'s pattern (3.122) where NO
 * single high signal can cancel a lower quota. Max tuning + a high budget + 3
 * providers but only ONE genuinely-parallel goal ⇒ cap 1 (the birdhouse case:
 * the excavator never starts). Pure, total, never throws.
 *
 * Each input is floored at 0 (a NaN/negative/∞ input degrades to 0, the safe
 * "nothing runs" floor rather than an unbounded fan-out).
 */
export function crossGoalCap(input: CrossGoalCapInput): number {
  const floor = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);
  return Math.min(
    floor(input.activeLimit),
    floor(input.tuningCeiling),
    floor(input.callBudgetCeiling),
    floor(input.genuineParallelGoalCount),
  );
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
  const composed = [...input.baselineOrderByTier[tier]];

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
