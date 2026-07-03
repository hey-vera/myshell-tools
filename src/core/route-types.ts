/**
 * src/core/route-types.ts — Vendor-Neutral Routing types, flag resolver,
 * OpenCode tier ranking, and pool derivation. Additive: NOT wired into
 * live routing yet (flag-off = byte-identical). See §1-§5 of
 * docs/vendor-neutral-routing-spec.md.
 */

import type { ProviderId } from '../providers/port.js';
import type { ModelCapability, ReasoningEffort } from './model-capabilities.js';
import type { RouteDecision, LedgerEntry } from './types.js';

// ---------------------------------------------------------------------------
// §1 — Router types (no call sites)
// ---------------------------------------------------------------------------

/** A quota/pool identity used for cost-signal accounting (load, cooldown). */
export type QuotaPoolId =
  | 'claude'
  | 'codex'
  | 'grok'
  | 'opencode-go'
  | 'opencode-zen-or-free'
  | 'opencode-unknown-default';

/** Serializable routing-profile facts for one model. (§2) */
export interface RoutingProfile {
  readonly tierSuitability: { readonly worker: number; readonly ic: number; readonly manager: number };
  readonly tierAdmission: { readonly worker: boolean; readonly ic: boolean; readonly manager: boolean };
  readonly speedClass: 'fast' | 'balanced' | 'deep';
  readonly quotaClass: 'subscription' | 'metered' | 'free' | 'unknown';
  readonly searchMode: 'native' | 'none' | 'unknown';
  readonly poolHint?: QuotaPoolId;
  /** audit-trail validation metadata (§2) */
  readonly validation: {
    readonly source: 'curated-table' | 'opencode-live-rank' | 'official-doc' | 'cli-metadata';
    readonly checkedAt: string;
    readonly overrideReason?: string;
  };
}

/** One candidate for a routing decision. (§1 step 2) */
export interface RoutingCandidate {
  readonly provider: ProviderId;
  readonly poolId: QuotaPoolId;
  readonly model: string;
  readonly tierAdmission: { readonly worker: boolean; readonly ic: boolean; readonly manager: boolean };
  readonly capability?: ModelCapability;
  readonly routingProfile?: RoutingProfile;
}

/** Ordered audit steps produced during a routing decision. */
export interface RouteTrace {
  readonly steps: readonly string[];
}

/** Typed error when no provider can satisfy the requested tier. */
export class NoCapableProvider extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoCapableProvider';
  }
}

/**
 * Typed routing result. Replaces the current `throw` at
 * `src/core/route.ts:166-170` when the flag is active. (§1)
 */
export type RouteResult =
  | { readonly ok: true; readonly decision: RouteDecision; readonly trace: RouteTrace }
  | { readonly ok: false; readonly error: NoCapableProvider; readonly trace: RouteTrace };

// ---------------------------------------------------------------------------
// §2 — Vendor-neutral router (DEFAULT-ON / shipped product path)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §3 — OpenCode tier ranking (pure, deterministic)
// ---------------------------------------------------------------------------

/** Facts extracted from `opencode models --verbose`. Absent fields = unknown. */
export interface OpencodeVerboseFacts {
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly reasoning: boolean;
  readonly variantLevels: readonly ReasoningEffort[];
}

/** Soft credential hints — never the source of pool identity. (§3) */
export interface CredentialHints {
  readonly hasApiCredential: boolean;
  readonly hasOAuthCredential: boolean;
}

/** Result of `opencodeTierRank()`. */
export interface OpencodeTierRankResult {
  readonly worker: number;
  readonly ic: number;
  readonly manager: number;
  readonly admission: { readonly worker: boolean; readonly ic: boolean; readonly manager: boolean };
  readonly speedClass: 'fast' | 'balanced' | 'deep';
  readonly ctxBand: number;
  readonly outBand: number;
  readonly reasonBand: number;
  readonly freeFlag: boolean;
}

// ---- morphology helpers ----

const FAST_MORPH = new Set(['fast', 'flash', 'turbo', 'mini', 'nano', 'lite']);
const DEEP_MORPH = new Set(['pro', 'max', 'plus', 'large', 'xl']);
const FREE_TOKEN = 'free';

/** Split a model id into lowercase tokens (split on '/', '-'). */
function modelIdTokens(modelId: string): Set<string> {
  return new Set(modelId.toLowerCase().split(/[/-]/));
}

function hasMorph(modelId: string, tokens: Set<string>): boolean {
  const parts = modelIdTokens(modelId);
  for (const t of tokens) {
    if (parts.has(t)) return true;
  }
  return false;
}

function isFree(modelId: string): boolean {
  return modelIdTokens(modelId).has(FREE_TOKEN);
}

// ---- band helpers ----

function ctxBand(ctx?: number): number {
  if (ctx === undefined || ctx <= 0) return 0;
  if (ctx < 64_000) return 0;
  if (ctx < 128_000) return 1; // 64k
  if (ctx < 256_000) return 2; // 128k
  if (ctx < 512_000) return 3; // 256k
  if (ctx < 1_000_000) return 4; // 512k
  return 5; // 1M+
}

function outBand(out?: number): number {
  if (out === undefined || out <= 0) return 0;
  if (out < 8_000) return 0;
  if (out < 16_000) return 1; // 8k
  if (out < 32_000) return 2; // 16k
  if (out < 64_000) return 3; // 32k
  return 4; // 64k+
}

const EFFORT_RANK: Record<ReasoningEffort, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

function reasonBand(variantLevels: readonly ReasoningEffort[], reasoning: boolean): number {
  if (variantLevels.length === 0) {
    return reasoning ? 1 : 0;
  }
  let max = 0;
  for (const lvl of variantLevels) {
    const v = EFFORT_RANK[lvl];
    if (v !== undefined && v > max) max = v;
  }
  return max;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Pure, deterministic OpenCode tier rank from model id, verbose facts, and
 * soft credential hints. Never uses credentials for pool identity. (§3)
 *
 * When `verboseFacts` is undefined the model is worker-only (detected-only case).
 */
export function opencodeTierRank(
  modelId: string,
  verboseFacts?: OpencodeVerboseFacts,
  _credentialHints?: CredentialHints,
): OpencodeTierRankResult {
  const ctx = verboseFacts?.contextWindow;
  const out = verboseFacts?.maxOutputTokens;
  const reasoning = verboseFacts?.reasoning ?? false;
  const variants = verboseFacts?.variantLevels ?? [];

  const cBand = ctxBand(ctx);
  const oBand = outBand(out);
  const rBand = reasonBand(variants, reasoning);
  const freeFlag = isFree(modelId);

  // speedClass (§3)
  let speedClass: 'fast' | 'balanced' | 'deep';
  if (hasMorph(modelId, FAST_MORPH)) {
    speedClass = 'fast';
  } else if (hasMorph(modelId, DEEP_MORPH) || (rBand >= 4 && cBand >= 3)) {
    speedClass = 'deep';
  } else {
    speedClass = 'balanced';
  }

  // admission (§3)
  const hasVerbose = verboseFacts !== undefined;
  const workerAdmit = true; // any authenticated, spawnable model (caller's gate)
  const icAdmit =
    hasVerbose &&
    ((ctx !== undefined && ctx >= 128_000) || (ctx !== undefined && ctx >= 64_000 && reasoning));
  const managerAdmit =
    hasVerbose &&
    ctx !== undefined &&
    ctx >= 128_000 &&
    // output is present or unknown-not-needed (adapter omits -m for opencode)
    // either reasoning support or deep morphology
    (reasoning || hasMorph(modelId, DEEP_MORPH));
  // if no verbose facts, worker-only

  // bonuses (§3)
  const fastBonus = speedClass === 'fast' ? 20 : speedClass === 'balanced' ? 10 : 0;
  const deepPenalty = speedClass === 'deep' ? 10 : 0;
  const freeBonus = freeFlag ? 10 : 0;
  const balancedBonus = speedClass === 'balanced' ? 20 : speedClass === 'deep' ? 15 : 10;
  const deepBonus = speedClass === 'deep' ? 25 : speedClass === 'balanced' ? 10 : 0;
  const freePenalty = freeFlag ? 1 : 0;

  const worker = clamp(
    40 + fastBonus + freeBonus + cBand * 3 + rBand * 2 - deepPenalty,
    0,
    100,
  );
  const ic = icAdmit
    ? clamp(35 + balancedBonus + cBand * 5 + rBand * 5 + oBand * 2 - freePenalty, 0, 100)
    : 0;
  const manager = managerAdmit
    ? clamp(20 + deepBonus + cBand * 7 + rBand * 8 + oBand * 3 - freePenalty * 10, 0, 100)
    : 0;

  return {
    worker,
    ic,
    manager,
    admission: { worker: workerAdmit, ic: icAdmit, manager: managerAdmit },
    speedClass,
    ctxBand: cBand,
    outBand: oBand,
    reasonBand: rBand,
    freeFlag,
  };
}

// ---------------------------------------------------------------------------
// §3 — Pool identity (prefix-derived)
// ---------------------------------------------------------------------------

/**
 * Derive a QuotaPoolId from a model id and optional provider hint.
 * For OpenCode the pool is prefix-derived; for Claude/Codex/Grok it is the
 * provider itself. Credential hints are NEVER the source of pool identity.
 */
export function poolForModelId(
  modelId: string,
  provider?: ProviderId,
): QuotaPoolId {
  if (provider === 'claude') return 'claude';
  if (provider === 'codex') return 'codex';
  if (provider === 'grok') return 'grok';

  const lower = modelId.toLowerCase();
  if (lower.startsWith('opencode-go/')) return 'opencode-go';
  if (lower.startsWith('opencode/')) return 'opencode-zen-or-free';

  // Bare 'opencode' or unknown prefix
  if (provider === 'opencode' || lower === 'opencode' || lower.startsWith('opencode')) {
    return 'opencode-unknown-default';
  }

  return 'opencode-unknown-default';
}

// ---------------------------------------------------------------------------
// §4 — Pool-aware session-load helper (slice 6)
// ---------------------------------------------------------------------------

/**
 * Compute per-`QuotaPoolId` session-token load from ledger entries.
 * Derives the pool from `LedgerEntry.provider/model` via `poolForModelId()`.
 * Pure/additive — does NOT change how the menu currently keys session consumption.
 */
export function sessionTokenLoadByPool(
  entries: readonly LedgerEntry[],
  sessionId: string,
): ReadonlyMap<QuotaPoolId, number> {
  const loads = new Map<QuotaPoolId, number>();
  for (const entry of entries) {
    if (entry.sessionId !== sessionId) continue;
    const poolId = poolForModelId(entry.model, entry.provider);
    const tokens =
      (Number.isFinite(entry.inputTokens) ? Math.max(0, entry.inputTokens) : 0) +
      (Number.isFinite(entry.outputTokens) ? Math.max(0, entry.outputTokens) : 0);
    loads.set(poolId, (loads.get(poolId) ?? 0) + tokens);
  }
  return loads;
}

// ---------------------------------------------------------------------------
// §4 — Pool-aware cooldown helper (slice 7)
// ---------------------------------------------------------------------------

/** All OpenCode-related pool ids — used when a bare `opencode` placeholder hits a rate limit. */
const ALL_OPENCODE_POOLS: readonly QuotaPoolId[] = [
  'opencode-go',
  'opencode-zen-or-free',
  'opencode-unknown-default',
];

/**
 * Resolve which pool(s) a cooldown applies to, given a model+provider.
 *
 * For Claude/Codex/Grok this is the provider's single pool.
 * For `opencode-unknown-default` (bare `opencode` placeholder) it cools
 * ALL opencode pools, per §4.
 *
 * Pure/additive — does NOT rewire live cooldown yet.
 */
export function resolveCooldownPools(
  modelId: string,
  provider: ProviderId,
): readonly QuotaPoolId[] {
  const poolId = poolForModelId(modelId, provider);
  if (poolId === 'opencode-unknown-default') {
    return ALL_OPENCODE_POOLS;
  }
  return [poolId];
}
