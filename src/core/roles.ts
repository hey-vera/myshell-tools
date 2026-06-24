/**
 * src/core/roles.ts — the LOGICAL ROLE abstraction (redesign Phase 0, slice 1).
 *
 * A `Role` is a provider-agnostic LANE — chat / ghost / execution — that resolves
 * against whatever models the user actually has and collapses gracefully onto a
 * 1-provider / 1-model setup (north-star principle #8). This is a thin pure layer
 * OVER the existing tier machinery (`Tier` worker/ic/manager + the `tierHint`
 * capability fact), never a parallel universe of types.
 *
 * PURE — no I/O, no time, no randomness, no module state (matches the
 * src/core/ purity guard in test/arch/guards.test.ts). It imports `Tier`,
 * `Mode`, `ReasoningEffort`, `ProviderId`, and `CapabilityRegistry` as the SAME
 * types the rest of the core uses, and reuses `findCapability` for tier hints.
 *
 * SCAFFOLDING ONLY (slice 1): these functions are not yet consumed by
 * `orchestrate`/`route`. They sit behind the default-OFF `roleMappingEnabled`
 * flag (src/interface/ui/role-flag.ts). The mapping ladder deliberately mirrors
 * `baseDesiredEffort`'s envelope (route.ts) so a later unification is mechanical
 * and the two can never disagree. See docs/one-chat-redesign-plan.md
 * "Phase 0 — Implementation Spec".
 */

import type { ProviderId } from '../providers/port.js';
import type { Tier } from './types.js';
import type { Mode } from './policy.js';
import type { CapabilityRegistry, ReasoningEffort } from './model-capabilities.js';
import { findCapability } from './model-capabilities.js';

// ---------------------------------------------------------------------------
// Types — the logical lanes + the data shapes resolution works over.
// ---------------------------------------------------------------------------

/**
 * The three logical lanes. PROVIDER-AGNOSTIC by construction:
 *  - `chat`      : the strong conversational / understanding model (never cheap —
 *                  principle #2: cheap models are for throwaway work only).
 *  - `ghost`     : the fast, throwaway model for self-correcting ghost text. Errors
 *                  are free because the user accepts/rejects (principle #2).
 *  - `execution` : the model that does build / edit work.
 */
export type Role = 'chat' | 'ghost' | 'execution';

/** The closed set, in a stable order (chat strongest-intent → ghost cheapest). */
export const ALL_ROLES: readonly Role[] = ['chat', 'ghost', 'execution'] as const;

/**
 * A role's desired PROFILE for a given mode: the tier RUNG it wants and the
 * NORMALIZED reasoning effort (the single internal scale; adapters project it onto
 * each provider's dialect — OpenAI/Grok `reasoning_effort`, Anthropic
 * adaptive-thinking/budget). Both are desires; `resolveRole` reconciles them
 * against what the user actually has.
 */
export interface RoleProfile {
  readonly rung: Tier;
  readonly effort: ReasoningEffort;
}

/** A provider plus the concrete model ids it advertises (from detect.ts). */
export interface ProviderModels {
  readonly provider: ProviderId;
  /** Concrete model ids, e.g. ['opus','sonnet','haiku']. Order is not relied upon. */
  readonly models: readonly string[];
}

/**
 * The result of resolving a role against the available models: a concrete
 * `(provider, model)` plus the normalized effort the role wanted. `collapsed` is
 * true when the desired rung had no model and we stepped to the nearest available
 * one (honest signal for callers/tests). `available` is false ONLY when there are
 * no providers/models at all — there is then nothing to run.
 */
export interface RoleResolution {
  readonly role: Role;
  readonly provider: ProviderId;
  readonly model: string;
  readonly rung: Tier;
  readonly effort: ReasoningEffort;
  /** True when the chosen rung differs from the role's desired rung (graceful step). */
  readonly collapsed: boolean;
}

// ---------------------------------------------------------------------------
// Mode → (rung, effort) per role — the dial mapping.
// ---------------------------------------------------------------------------

/** Tier rank for stepping (worker cheapest → manager strongest). PURE. */
const TIER_RANK: Record<Tier, 0 | 1 | 2> = { worker: 0, ic: 1, manager: 2 };
const TIER_BY_RANK: readonly Tier[] = ['worker', 'ic', 'manager'] as const;

/**
 * The role × mode profile table. Deliberately conservative and aligned with
 * `baseDesiredEffort` (route.ts) so the role layer never disagrees with the
 * already-shipped effort selector:
 *
 *   - chat: the understanding lane. ic at Efficient/Balanced, manager at Max. It
 *     is never the worker (cheap) rung — principle #2.
 *   - execution: build/edit. worker at Efficient, ic at Balanced, manager at Max.
 *   - ghost: ALWAYS worker (cheapest fast rung) with `low` effort — throwaway,
 *     self-correcting, volume-controlled (principle #2/#3). Mode does not deepen
 *     ghost: a deeper ghost would defeat its purpose.
 *
 * Efforts mirror `baseDesiredEffort` for a non-hard, implementation-class turn at
 * the chosen tier/mode, so a later unification is mechanical. PURE total mapping.
 */
export function roleProfileForMode(mode: Mode, role: Role): RoleProfile {
  if (role === 'ghost') {
    // Throwaway lane — cheapest rung, shallow effort, mode-invariant.
    return { rung: 'worker', effort: 'low' };
  }

  switch (mode) {
    case 'cost-saver':
      return role === 'chat' ? { rung: 'ic', effort: 'medium' } : { rung: 'worker', effort: 'low' }; // execution
    case 'balanced':
      return role === 'chat' ? { rung: 'ic', effort: 'medium' } : { rung: 'ic', effort: 'medium' }; // execution
    case 'quality-first':
      return role === 'chat'
        ? { rung: 'manager', effort: 'high' }
        : { rung: 'manager', effort: 'high' }; // execution
  }
}

/** The full role→profile map for a mode. PURE. */
export function rolesForMode(mode: Mode): Record<Role, RoleProfile> {
  return {
    chat: roleProfileForMode(mode, 'chat'),
    ghost: roleProfileForMode(mode, 'ghost'),
    execution: roleProfileForMode(mode, 'execution'),
  };
}

// ---------------------------------------------------------------------------
// Resolution — collapse the desired rung onto what the user actually has.
// ---------------------------------------------------------------------------

/**
 * The tier rung a concrete model serves, from the capability registry's
 * `tierHint`. Honest about absence: a model with no known hint is treated as the
 * neutral `ic` rung (the middle) rather than guessed strong/cheap — never invent a
 * tier. Matches `model-capabilities.ts`'s unknown-is-absent invariant. PURE.
 */
function rungForModel(
  registry: CapabilityRegistry | undefined,
  provider: ProviderId,
  model: string,
): Tier {
  if (registry === undefined) return 'ic';
  const cap = findCapability(registry, provider, model);
  return cap?.tierHint ?? 'ic';
}

/**
 * Pick the best concrete `(provider, model)` for a desired rung from the available
 * set, stepping DOWN then UP to the nearest available rung when the exact rung has
 * no model. NEVER invents a model; returns undefined only when nothing exists.
 *
 * Selection within a rung is deterministic: it honors `preferredOrder` (provider
 * preference, e.g. policy.providerOrderByTier) then the input order — so a
 * multi-provider setup is stable and a 1-provider setup trivially stays on it. PURE.
 */
function pickForRung(
  desired: Tier,
  available: readonly ProviderModels[],
  registry: CapabilityRegistry | undefined,
  preferredOrder: readonly ProviderId[],
): { provider: ProviderId; model: string; rung: Tier } | undefined {
  // Index every (provider, model) by the rung it serves.
  const byRung: Record<Tier, { provider: ProviderId; model: string }[]> = {
    worker: [],
    ic: [],
    manager: [],
  };
  for (const pm of available) {
    for (const model of pm.models) {
      const rung = rungForModel(registry, pm.provider, model);
      byRung[rung].push({ provider: pm.provider, model });
    }
  }

  // Build the search order: the desired rung first, then nearest by |rank diff|,
  // preferring a STEP DOWN (cheaper) over a step up on a tie (quota-frugal).
  const desiredRank = TIER_RANK[desired];
  const order = [...TIER_BY_RANK].sort((a, b) => {
    const da = Math.abs(TIER_RANK[a] - desiredRank);
    const db = Math.abs(TIER_RANK[b] - desiredRank);
    if (da !== db) return da - db;
    // Tie on distance → prefer the lower (cheaper) rung.
    return TIER_RANK[a] - TIER_RANK[b];
  });

  for (const rung of order) {
    const candidates = byRung[rung];
    if (candidates.length === 0) continue;
    // Within the rung, honor provider preference then input order.
    const sorted = [...candidates].sort((a, b) => {
      const ia = preferredOrder.indexOf(a.provider);
      const ib = preferredOrder.indexOf(b.provider);
      const ra = ia === -1 ? Number.MAX_SAFE_INTEGER : ia;
      const rb = ib === -1 ? Number.MAX_SAFE_INTEGER : ib;
      return ra - rb;
    });
    const chosen = sorted[0];
    if (chosen !== undefined) return { provider: chosen.provider, model: chosen.model, rung };
  }
  return undefined;
}

/**
 * Resolve ONE role against the user's available models for a given mode.
 *
 * GRACEFUL COLLAPSE (principle #8):
 *  - desired rung missing → step to the nearest available rung (`collapsed: true`).
 *  - 1 provider with 1 model → every role resolves to that single model.
 *  - never invents a model; never throws on an empty set (returns null instead).
 *
 * `preferredOrder` is an optional provider preference (e.g.
 * policy.providerOrderByTier[tier]); absent → the input order decides ties. PURE.
 */
export function resolveRole(input: {
  readonly role: Role;
  readonly mode: Mode;
  readonly available: readonly ProviderModels[];
  readonly registry?: CapabilityRegistry;
  readonly preferredOrder?: readonly ProviderId[];
}): RoleResolution | null {
  const { role, mode, available, registry, preferredOrder } = input;
  // Drop providers that advertise no models — nothing to run there.
  const nonEmpty = available.filter((p) => p.models.length > 0);
  if (nonEmpty.length === 0) return null;

  const profile = roleProfileForMode(mode, role);
  const pick = pickForRung(profile.rung, nonEmpty, registry, preferredOrder ?? []);
  if (pick === undefined) return null;

  return {
    role,
    provider: pick.provider,
    model: pick.model,
    rung: pick.rung,
    effort: profile.effort,
    collapsed: pick.rung !== profile.rung,
  };
}

/**
 * Resolve ALL three roles at once for a mode. Returns a partial map: a role is
 * absent only when there is nothing at all to run it on (empty available set). On a
 * 1-provider/1-model setup every role maps to that one model (each `collapsed` per
 * whether its desired rung matched the lone model's hint). PURE.
 */
export function resolveAllRoles(input: {
  readonly mode: Mode;
  readonly available: readonly ProviderModels[];
  readonly registry?: CapabilityRegistry;
  readonly preferredOrder?: readonly ProviderId[];
}): Partial<Record<Role, RoleResolution>> {
  const out: Partial<Record<Role, RoleResolution>> = {};
  for (const role of ALL_ROLES) {
    const resolved = resolveRole({ ...input, role });
    if (resolved !== null) out[role] = resolved;
  }
  return out;
}
