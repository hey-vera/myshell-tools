/**
 * src/core/vendor-neutral-route.ts — Pure vendor-neutral route core (§1, §4, §5).
 *
 * Implements the full deterministic flow from docs/vendor-neutral-routing-spec.md
 * slices 6-8. Takes all inputs as parameters (pure function); no live globals.
 * NOT wired into live routing yet (flag-off = byte-identical).
 */

import type { ProviderId } from '../providers/port.js';
import type { Tier, RouteDecision } from './types.js';
import type { CapabilityRegistry } from './model-capabilities.js';
import { findCapability } from './model-capabilities.js';
import type {
  QuotaPoolId,
  RoutingCandidate,
  OpencodeVerboseFacts,
} from './route-types.js';
import {
  NoCapableProvider,
  poolForModelId,
  opencodeTierRank,
  type RouteResult,
} from './route-types.js';

// ---------------------------------------------------------------------------
// Public inputs shape
// ---------------------------------------------------------------------------

export interface VendorNeutralRouteParams {
  readonly tier: Tier;
  /** Providers known to be signed in. No signed-out fallback. */
  readonly authedProviders: readonly ProviderId[];
  /** Concrete model IDs available per provider (from detect). */
  readonly availableModels: ReadonlyMap<ProviderId, readonly string[]>;
  /** The merged capability registry. */
  readonly registry: CapabilityRegistry;
  /** Per-model verbose facts for opencode models. Key = modelId. */
  readonly opencodeVerboseFacts?: ReadonlyMap<string, OpencodeVerboseFacts>;
  /** Task-level signals (all optional — absent → no constraint). */
  readonly needsWebSearch?: boolean;
  readonly needsVision?: boolean;
  readonly estimatedInputTokens?: number;
  readonly hasAttachments?: boolean;
  /** Per-pool session token load (lower = less congested). */
  readonly poolLoad?: ReadonlyMap<QuotaPoolId, number>;
  /** Pools currently in cooldown. */
  readonly cooledPools?: ReadonlySet<QuotaPoolId>;
  /** Stable session id for hash tiebreaking. */
  readonly sessionId: string;
  /** Hidden override: if set, only consider candidates in these pools. */
  readonly pinnedPools?: readonly QuotaPoolId[];
  /** Hidden override: exclude candidates in these pools. */
  readonly excludedPools?: readonly QuotaPoolId[];
}

// ---------------------------------------------------------------------------
// Candidate suitability scoring
// ---------------------------------------------------------------------------

/**
 * Worker-floor suitability score for unknown/uncurated models.
 * Non-zero so unknown workers can still be selected, but very low.
 */
const UNKNOWN_WORKER_FLOOR = 5;

/** Compute a suitability score for one candidate at a given tier. */
function suitabilityScore(
  candidate: RoutingCandidate,
  tier: Tier,
  opencodeVerboseFacts?: ReadonlyMap<string, OpencodeVerboseFacts>,
): number {
  // OpenCode: use live rank
  if (candidate.provider === 'opencode') {
    const verbose = opencodeVerboseFacts?.get(candidate.model);
    const rank = opencodeTierRank(candidate.model, verbose);
    return rank[tier];
  }

  // Curated non-OpenCode: use registry routingProfile
  if (candidate.routingProfile) {
    return candidate.routingProfile.tierSuitability[tier];
  }

  // Unknown non-OpenCode model — worker floor only
  if (tier === 'worker') return UNKNOWN_WORKER_FLOOR;
  return 0;
}

// ---------------------------------------------------------------------------
// Hard-requirement filter (§1 step 4)
// ---------------------------------------------------------------------------

/** Check whether a candidate model is passable to its provider's adapter. */
function isAdapterPassable(model: string, provider: ProviderId): boolean {
  // Claude/Codex/Grok accept any model ID via --model/-m.
  // OpenCode only passes models containing '/' (src/providers/opencode.ts:92-93).
  if (provider === 'opencode') {
    return model.includes('/');
  }
  return true;
}

/** Check hard requirements for one candidate. */
function passesHardRequirements(
  candidate: RoutingCandidate,
  tier: Tier,
  params: VendorNeutralRouteParams,
): boolean {
  // 1. Tier admission
  if (!candidate.tierAdmission[tier]) return false;

  // 2. Vision requirement
  if (params.needsVision === true) {
    if (candidate.capability?.supportsVision !== true) return false;
  }

  // 3. Context-window requirement
  if (
    params.estimatedInputTokens !== undefined &&
    params.estimatedInputTokens > 0
  ) {
    const window =
      candidate.capability?.maxContextWindow ??
      candidate.capability?.contextWindow;
    if (window === undefined || window < params.estimatedInputTokens) {
      return false;
    }
  }

  // 4. Adapter passability
  if (!isAdapterPassable(candidate.model, candidate.provider)) return false;

  return true;
}

// ---------------------------------------------------------------------------
// CostQuotaSignal tiebreaker (§4)
// ---------------------------------------------------------------------------

/** Simple 32-bit string hash for session-hash rotation. */
function hashString(s: string): number {
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

interface ScoredCandidate {
  readonly candidate: RoutingCandidate;
  readonly score: number;
}

/**
 * Apply CostQuotaSignal tiebreaker over a set of candidates whose suitability
 * scores are within the comparable threshold (§4).
 *
 * Tiebreak order:
 *  1. Not-cooled over cooled
 *  2. Lower normalized pool load
 *  3. Session-hash rotation
 */
function costQuotaTiebreak(
  scored: readonly ScoredCandidate[],
  params: VendorNeutralRouteParams,
): RoutingCandidate {
  if (scored.length === 0) throw new Error('costQuotaTiebreak: empty scored array');
  if (scored.length === 1) {
    const only = scored[0];
    if (only === undefined) throw new Error('costQuotaTiebreak: unexpected empty slot');
    return only.candidate;
  }

  const cooled = params.cooledPools;

  // Sort by tiebreak rules
  const sorted = [...scored].sort((a, b) => {
    // 1. Not-cooled over cooled
    const aCooled = cooled?.has(a.candidate.poolId) === true ? 1 : 0;
    const bCooled = cooled?.has(b.candidate.poolId) === true ? 1 : 0;
    if (aCooled !== bCooled) return aCooled - bCooled;

    // 2. Lower pool load
    const aLoad = params.poolLoad?.get(a.candidate.poolId) ?? 0;
    const bLoad = params.poolLoad?.get(b.candidate.poolId) ?? 0;
    if (aLoad !== bLoad) return aLoad - bLoad;

    // 3. Session-hash rotation (stable, spread across sessions)
    const aHash = hashString(
      `${params.sessionId}:${a.candidate.poolId}:${a.candidate.provider}:${a.candidate.model}`,
    );
    const bHash = hashString(
      `${params.sessionId}:${b.candidate.poolId}:${b.candidate.provider}:${b.candidate.model}`,
    );
    return aHash - bHash;
  });

  const first = sorted[0];
  if (first === undefined) throw new Error('costQuotaTiebreak: sort produced empty array');
  return first.candidate;
}

// ---------------------------------------------------------------------------
// Hidden override (§1)
// ---------------------------------------------------------------------------

/**
 * Apply hidden env/config pin/exclude override AFTER hard-capability filtering.
 * Never resurrects signed-out or incapable candidates.
 */
function applyPoolOverride(
  candidates: readonly RoutingCandidate[],
  params: VendorNeutralRouteParams,
): readonly RoutingCandidate[] {
  let result = candidates;

  // Exclude pools (only if some would remain)
  if (params.excludedPools && params.excludedPools.length > 0) {
    const excluded = new Set(params.excludedPools);
    const filtered = result.filter((c) => !excluded.has(c.poolId));
    if (filtered.length > 0) result = filtered;
    // else: exclusion would strand → ignore
  }

  // Pin pools (narrow to only these pools if any match)
  if (params.pinnedPools && params.pinnedPools.length > 0) {
    const pinned = new Set(params.pinnedPools);
    const pinnedCandidates = result.filter((c) => pinned.has(c.poolId));
    if (pinnedCandidates.length > 0) result = pinnedCandidates;
    // else: no candidates in pinned pools → ignore pin
  }

  return result;
}

// ---------------------------------------------------------------------------
// Build candidates from inputs (§1 step 2)
// ---------------------------------------------------------------------------

function buildCandidates(
  params: VendorNeutralRouteParams,
  trace: string[],
): RoutingCandidate[] {
  const candidates: RoutingCandidate[] = [];

  for (const provider of params.authedProviders) {
    const models = params.availableModels.get(provider);
    if (!models || models.length === 0) {
      trace.push(`provider ${provider}: no available models, skipping`);
      continue;
    }

    for (const model of models) {
      const poolId = poolForModelId(model, provider);
      const cap = findCapability(params.registry, provider, model);
      const routingProfile = cap?.routingProfile;

      let tierAdmission: { worker: boolean; ic: boolean; manager: boolean };

      if (provider === 'opencode') {
        // OpenCode: live rank from verbose facts
        const verbose = params.opencodeVerboseFacts?.get(model);
        const rank = opencodeTierRank(model, verbose);
        tierAdmission = { ...rank.admission };
      } else if (routingProfile) {
        // Curated non-OpenCode: use registry routing profile
        tierAdmission = { ...routingProfile.tierAdmission };
      } else {
        // Unknown non-OpenCode model → worker floor only
        tierAdmission = { worker: true, ic: false, manager: false };
        trace.push(
          `candidate ${provider}/${model}: no routingProfile, worker-floor only`,
        );
      }

      const candidate: RoutingCandidate = {
        provider,
        poolId,
        model,
        tierAdmission,
        ...(cap ? { capability: cap } : {}),
        ...(routingProfile ? { routingProfile } : {}),
      } as RoutingCandidate;

      candidates.push(candidate);
    }
  }

  trace.push(`built ${candidates.length} candidate(s) from ${params.authedProviders.length} authed provider(s)`);
  return candidates;
}

// ---------------------------------------------------------------------------
// Build RouteDecision from winning candidate
// ---------------------------------------------------------------------------

function toRouteDecision(
  candidate: RoutingCandidate,
  tier: Tier,
): RouteDecision {
  return {
    tier,
    provider: candidate.provider,
    model: candidate.model,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Pure, deterministic vendor-neutral route core (§1 flow + §5 behavior).
 *
 * Flow:
 *  1. Build RoutingCandidate[] from authed providers, available models, and registry.
 *  2. Filter to authenticated+spawnable only (no signed-out fallback).
 *  3. Apply hard requirements (tier admission, vision, context, adapter passability).
 *  4. Soft-prefer native-search candidates when web search is needed.
 *  5. Rank by provider-specific baseline suitability.
 *  6. Apply CostQuotaSignal tiebreaker (comparable threshold ≤ 5 pts).
 *  7. Apply hidden pool override (pin/exclude).
 *  8. Return RouteResult with trace.
 *
 * Never throws — returns `{ ok: false }` with NoCapableProvider when no candidate qualifies.
 */
export function vendorNeutralRoute(
  params: VendorNeutralRouteParams,
): RouteResult {
  const trace: string[] = [];

  // Step 1-2: Build candidates (only from authed providers)
  let candidates = buildCandidates(params, trace);

  // Step 3: Hard-requirement filter
  const beforeHardFilter = candidates.length;
  candidates = candidates.filter((c) => {
    const passes = passesHardRequirements(c, params.tier, params);
    if (!passes) {
      trace.push(
        `drop ${c.provider}/${c.model}: fails hard reqs (tier=${params.tier})`,
      );
    }
    return passes;
  });
  trace.push(
    `hard-requirement filter: ${beforeHardFilter} → ${candidates.length} candidate(s)`,
  );

  if (candidates.length === 0) {
    const err = new NoCapableProvider(
      `No provider can satisfy tier "${params.tier}" with the given requirements`,
    );
    return { ok: false, error: err, trace: { steps: trace } };
  }

  // Step 4: Apply hidden pool override (after hard filter, before ranking)
  const beforeOverride = candidates.length;
  candidates = applyPoolOverride(candidates, params) as RoutingCandidate[];
  if (candidates.length !== beforeOverride) {
    trace.push(
      `pool override: ${beforeOverride} → ${candidates.length} candidate(s)`,
    );
  }

  if (candidates.length === 0) {
    const err = new NoCapableProvider(
      `No provider can satisfy tier "${params.tier}" after pool override`,
    );
    return { ok: false, error: err, trace: { steps: trace } };
  }

  // Step 5: Web-search soft-prefer
  let webSearchDisclosed = false;
  if (params.needsWebSearch === true) {
    const nativeSearch = candidates.filter(
      (c) => c.routingProfile?.searchMode === 'native',
    );
    if (nativeSearch.length > 0) {
      trace.push(
        `web-search soft-prefer: narrowed to ${nativeSearch.length} native-search candidate(s)`,
      );
      candidates = nativeSearch;
    } else {
      trace.push(
        'web-search soft-prefer: no native-search candidate available — proceeding with all, disclosure set',
      );
      webSearchDisclosed = true;
    }
  }

  // Step 6: Score and rank by suitability
  const scored: ScoredCandidate[] = candidates.map((c) => ({
    candidate: c,
    score: suitabilityScore(c, params.tier, params.opencodeVerboseFacts),
  }));
  scored.sort((a, b) => b.score - a.score);

  // candidates.length > 0 is guaranteed by earlier checks, but TS needs a nudge
  if (scored.length === 0) {
    const err = new NoCapableProvider(
      `No provider can satisfy tier "${params.tier}"`,
    );
    return { ok: false, error: err, trace: { steps: trace } };
  }
  const topS = scored[0];
  if (topS === undefined) {
    const err = new NoCapableProvider(
      `No provider can satisfy tier "${params.tier}" after scoring`,
    );
    return { ok: false, error: err, trace: { steps: trace } };
  }
  const topScore = topS.score;

  trace.push(
    `suitability ranking: top score = ${topScore} (${topS.candidate.provider}/${topS.candidate.model})`,
  );

  // Step 7: Comparable threshold (within 5 pts of top)
  const comparable = scored.filter((s) => s.score >= topScore - 5);

  if (comparable.length > 1) {
    trace.push(
      `comparable threshold: ${comparable.length} candidate(s) within 5 points — applying CostQuotaSignal`,
    );
  }

  // Step 8: CostQuotaSignal tiebreaker
  const winner = costQuotaTiebreak(comparable, params);

  // Build trace detail
  trace.push(
    `selected: ${winner.provider}/${winner.model} (pool=${winner.poolId})`,
  );
  if (webSearchDisclosed) {
    trace.push(
      'disclosure: no authenticated provider with native web search',
    );
  }

  const decision = toRouteDecision(winner, params.tier);

  return {
    ok: true,
    decision,
    trace: { steps: trace },
  };
}
