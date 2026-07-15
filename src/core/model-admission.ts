/**
 * src/core/model-admission.ts — progressive admission for newly discovered models (R1.4).
 *
 * Ladder (strict; never skip via name/version alone):
 *   candidate     → newly discovered / unknown; not admitted to any tier
 *   worker-floor  → quarantine; worker tier only
 *   provisional   → objective metadata present (not name-derived); worker + IC
 *   eligible      → normal eligibility (curated profile or measured rank)
 *   invalidated   → demoted; model-not-found or schema drift
 *
 * Production path: resolve rank from capability registry facts; filter inventory
 * for the requested tier inside selectExecutionLane so manager/high-risk never
 * selects candidate or worker-floor models. Worker may use worker-floor.
 *
 * Pure: no I/O, no Date.now / Math.random / console / process.exit.
 */

import type { ProviderId } from '../providers/port.js';
import type { Tier } from './types.js';
import {
  findCapability,
  type CapabilityRegistry,
  type ModelCapability,
} from './model-capabilities.js';

// ---------------------------------------------------------------------------
// Ranks + events
// ---------------------------------------------------------------------------

/**
 * Progressive admission ranks. Order is the ladder; numeric rank is for
 * comparison only — promotion still requires the matching event/evidence.
 */
export type ModelAdmissionRank =
  | 'candidate'
  | 'worker-floor'
  | 'provisional'
  | 'eligible'
  | 'invalidated';

const RANK_ORDER: Readonly<Record<ModelAdmissionRank, number>> = {
  invalidated: -1,
  candidate: 0,
  'worker-floor': 1,
  provisional: 2,
  eligible: 3,
};

/** Why a model sits at a given rank (audit trail; not a promotion input alone). */
export type ModelAdmissionReason =
  | 'discovered'
  | 'detect-only'
  | 'objective-metadata'
  | 'registry-curated'
  | 'measured-rank'
  | 'model-not-found'
  | 'schema-drift'
  | 'name-version-rejected'
  | 'override';

/**
 * Events that transition admission state. Promotion events require real evidence
 * kinds — never a version string or marketing name.
 */
export type ModelAdmissionEvent =
  | { readonly type: 'discovered' }
  /** Explicit quarantine / first worker-safe admission after discovery. */
  | { readonly type: 'admit-worker-floor' }
  /**
   * Objective machine-readable facts (context window, efforts, tool flags, etc.).
   * Must NOT be inferred from the model id/name/version string alone.
   */
  | { readonly type: 'objective-metadata'; readonly hasObjectiveFacts: boolean }
  /**
   * Measured provisional rank from non-mutating canary / outcome measurement.
   * `measured: true` only when a real measurement exists (not name-based).
   */
  | { readonly type: 'measured-rank'; readonly measured: boolean }
  /** Curated declarative routingProfile with explicit tierAdmission. */
  | { readonly type: 'registry-curated' }
  | { readonly type: 'model-not-found' }
  | { readonly type: 'schema-drift' }
  /**
   * Attempted promotion from name or version number alone — always rejected;
   * never raises rank.
   */
  | { readonly type: 'promote-by-name-version'; readonly nameOrVersion: string };

export interface ModelAdmissionRecord {
  readonly provider: ProviderId;
  readonly model: string;
  readonly rank: ModelAdmissionRank;
  readonly reasons: readonly ModelAdmissionReason[];
}

/** Optional per-model override (e.g. persisted invalidation after live failure). */
export type AdmissionOverrideMap = ReadonlyMap<string, ModelAdmissionRank>;

/** Canonical key for override maps. */
export function admissionKey(provider: ProviderId, model: string): string {
  return `${provider}\t${model.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Tier gates
// ---------------------------------------------------------------------------

/**
 * Whether a rank may serve a tier.
 *  - candidate / invalidated → none
 *  - worker-floor → worker only
 *  - provisional → worker + ic (not manager / high-risk)
 *  - eligible → all tiers (caller may still apply routingProfile.tierAdmission)
 */
export function isRankAdmittedForTier(
  rank: ModelAdmissionRank,
  tier: Tier,
): boolean {
  switch (rank) {
    case 'invalidated':
    case 'candidate':
      return false;
    case 'worker-floor':
      return tier === 'worker';
    case 'provisional':
      return tier === 'worker' || tier === 'ic';
    case 'eligible':
      return true;
    default: {
      const _exhaustive: never = rank;
      return _exhaustive;
    }
  }
}

/**
 * When eligible and a curated routingProfile exists, intersect progressive
 * admission with profile.tierAdmission so e.g. haiku stays worker-only.
 */
export function isModelAdmittedForTier(
  record: ModelAdmissionRecord,
  tier: Tier,
  capability?: ModelCapability,
): boolean {
  if (!isRankAdmittedForTier(record.rank, tier)) return false;
  if (record.rank === 'eligible' && capability?.routingProfile !== undefined) {
    return capability.routingProfile.tierAdmission[tier] === true;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Derive rank from capability facts (no name/version promotion)
// ---------------------------------------------------------------------------

/**
 * True when capability carries objective machine-readable facts that are not
 * the bare id. Name/version tokens are never treated as objective evidence.
 */
export function hasObjectiveCapabilityFacts(
  cap: ModelCapability | undefined,
): boolean {
  if (cap === undefined) return false;
  if (cap.contextWindow !== undefined && cap.contextWindow > 0) return true;
  if (cap.maxContextWindow !== undefined && cap.maxContextWindow > 0) return true;
  if (cap.maxOutputTokens !== undefined && cap.maxOutputTokens > 0) return true;
  if (cap.supportedReasoningEfforts.length > 0) return true;
  if (cap.supportsVision === true) return true;
  if (cap.supportsToolCalling === true) return true;
  if (cap.supportsSearchTool === true) return true;
  if (cap.supportsNativeSession === true) return true;
  if (cap.inputModalities !== undefined && cap.inputModalities.length > 0) return true;
  // Live richer sources (not id morphology)
  if (cap.source.includes('codex-cache')) return true;
  return false;
}

/**
 * Resolve progressive admission from registry facts + optional override.
 *
 * Rules:
 *  - override `invalidated` / any override wins
 *  - curated routingProfile → eligible
 *  - objective facts without curated profile → provisional
 *  - detect-only registry row → worker-floor
 *  - missing from registry, Claude/Codex/Grok → worker-floor (discovered unknown;
 *    never manager/IC; never ranked from name/version)
 *  - missing from registry, OpenCode → eligible for filter purposes: the connected
 *    OpenCode catalog is inventory authority (`selectOpencodeModel`); progressive
 *    admission still never invents suitability from the model id string
 *  - NEVER promotes from model id / version string
 */
export function resolveModelAdmission(
  registry: CapabilityRegistry | undefined,
  provider: ProviderId,
  model: string,
  overrides?: AdmissionOverrideMap,
): ModelAdmissionRecord {
  const trimmed = model.trim();
  const key = admissionKey(provider, trimmed);
  const override = overrides?.get(key);
  if (override !== undefined) {
    return {
      provider,
      model: trimmed,
      rank: override,
      reasons: ['override'],
    };
  }

  // OpenCode connected catalog is inventory authority (`selectOpencodeModel`).
  // Progressive admission still applies demotion overrides, but never invents
  // rank from the model id string and never quarantines catalog ids as
  // candidate/worker-floor solely for lacking a curated routingProfile.
  if (provider === 'opencode') {
    return {
      provider,
      model: trimmed,
      rank: 'eligible',
      reasons: ['discovered'],
    };
  }

  if (registry === undefined) {
    return {
      provider,
      model: trimmed,
      rank: 'worker-floor',
      reasons: ['discovered'],
    };
  }

  const cap = findCapability(registry, provider, trimmed);
  if (cap === undefined) {
    return {
      provider,
      model: trimmed,
      rank: 'worker-floor',
      reasons: ['discovered'],
    };
  }

  if (cap.routingProfile !== undefined) {
    return {
      provider,
      model: trimmed,
      rank: 'eligible',
      reasons: ['registry-curated'],
    };
  }

  if (hasObjectiveCapabilityFacts(cap)) {
    return {
      provider,
      model: trimmed,
      rank: 'provisional',
      reasons: ['objective-metadata'],
    };
  }

  // Present in registry only via detect (or empty facts) → worker-floor quarantine.
  return {
    provider,
    model: trimmed,
    rank: 'worker-floor',
    reasons: ['detect-only'],
  };
}

// ---------------------------------------------------------------------------
// State machine transitions
// ---------------------------------------------------------------------------

/**
 * Apply one admission event. Pure.
 *
 * Demotion (model-not-found / schema-drift) always → invalidated.
 * Name/version promotion is always rejected (rank unchanged; reason recorded).
 * Other promotions only move forward when evidence is present and never jump
 * past the next allowed rung without the right event type.
 */
export function applyAdmissionEvent(
  current: ModelAdmissionRecord,
  event: ModelAdmissionEvent,
): ModelAdmissionRecord {
  if (event.type === 'model-not-found') {
    return {
      ...current,
      rank: 'invalidated',
      reasons: [...current.reasons, 'model-not-found'],
    };
  }
  if (event.type === 'schema-drift') {
    return {
      ...current,
      rank: 'invalidated',
      reasons: [...current.reasons, 'schema-drift'],
    };
  }
  if (event.type === 'promote-by-name-version') {
    // Hard rule: never rank from name or version number.
    return {
      ...current,
      reasons: [...current.reasons, 'name-version-rejected'],
    };
  }

  // Demoted models stay invalidated until an explicit rediscovery path recreates
  // a fresh record (callers should start from discovered, not re-apply promote).
  if (current.rank === 'invalidated') {
    return current;
  }

  let nextRank = current.rank;
  let reason: ModelAdmissionReason | undefined;

  switch (event.type) {
    case 'discovered':
      // Fresh discovery: do not raise past candidate if already higher.
      if (RANK_ORDER[current.rank] <= RANK_ORDER.candidate) {
        nextRank = 'candidate';
        reason = 'discovered';
      }
      break;
    case 'admit-worker-floor':
      if (RANK_ORDER[current.rank] < RANK_ORDER['worker-floor']) {
        nextRank = 'worker-floor';
        reason = 'detect-only';
      }
      break;
    case 'objective-metadata':
      if (event.hasObjectiveFacts && RANK_ORDER[current.rank] < RANK_ORDER.provisional) {
        nextRank = 'provisional';
        reason = 'objective-metadata';
      }
      break;
    case 'measured-rank':
      if (event.measured && RANK_ORDER[current.rank] < RANK_ORDER.eligible) {
        // Measured rank promotes to eligible only from provisional or higher
        // worker-floor without measurement stays below eligible.
        if (
          current.rank === 'provisional' ||
          current.rank === 'eligible'
        ) {
          nextRank = 'eligible';
          reason = 'measured-rank';
        }
      }
      break;
    case 'registry-curated':
      if (RANK_ORDER[current.rank] < RANK_ORDER.eligible) {
        nextRank = 'eligible';
        reason = 'registry-curated';
      }
      break;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }

  if (reason === undefined && nextRank === current.rank) {
    return current;
  }
  return {
    ...current,
    rank: nextRank,
    reasons: reason !== undefined ? [...current.reasons, reason] : current.reasons,
  };
}

/**
 * Create a fresh admission record for a newly discovered model id.
 */
export function admitDiscovered(
  provider: ProviderId,
  model: string,
): ModelAdmissionRecord {
  return applyAdmissionEvent(
    {
      provider,
      model: model.trim(),
      rank: 'candidate',
      reasons: [],
    },
    { type: 'discovered' },
  );
}

// ---------------------------------------------------------------------------
// Inventory filtering (production seam for selectExecutionLane)
// ---------------------------------------------------------------------------

/**
 * Keep only model ids admitted for `tier` under progressive admission.
 */
export function filterModelsForTier(
  provider: ProviderId,
  models: readonly string[],
  tier: Tier,
  registry: CapabilityRegistry | undefined,
  overrides?: AdmissionOverrideMap,
): readonly string[] {
  return models.filter((model) => {
    const record = resolveModelAdmission(registry, provider, model, overrides);
    const cap =
      registry !== undefined ? findCapability(registry, provider, model) : undefined;
    return isModelAdmittedForTier(record, tier, cap);
  });
}

/**
 * Filter a per-provider availableModels map for the requested tier.
 * Providers with no remaining models keep an empty array (caller may drop them).
 * Pure; does not invent model ids.
 */
export function filterAvailableModelsForTier(
  availableModels: Partial<Record<ProviderId, readonly string[]>>,
  tier: Tier,
  registry: CapabilityRegistry | undefined,
  overrides?: AdmissionOverrideMap,
): Partial<Record<ProviderId, readonly string[]>> {
  const out: Partial<Record<ProviderId, readonly string[]>> = {};
  for (const key of Object.keys(availableModels) as ProviderId[]) {
    const list = availableModels[key];
    if (list === undefined) continue;
    out[key] = filterModelsForTier(key, list, tier, registry, overrides);
  }
  return out;
}

/**
 * True when a provider had advertised models but none survive admission for tier
 * (manager with candidate-only inventory → blocked).
 */
export function providerBlockedByAdmission(
  provider: ProviderId,
  original: readonly string[] | undefined,
  filtered: readonly string[] | undefined,
): boolean {
  if (original === undefined || original.length === 0) return false;
  return filtered === undefined || filtered.length === 0;
}
