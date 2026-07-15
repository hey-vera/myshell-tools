/**
 * src/core/execution-lane.ts — atomic execution-lane selection (R1.1 / R1.3b / R1.4 / R1.5).
 *
 * The routing atom is an eligible **lane** = provider + account + model chosen
 * together, not model-then-account. Selection always returns one struct pairing
 * all three and tags the snapshot with a versioned **inventory generation**.
 *
 * Managed-account contract:
 *  - When managed subscription accounts exist for a provider, work-call spawn
 *    uses a selected account lane — never ambient global credentials for that
 *    provider when no account is eligible.
 *  - Accounts with status `auth-failed` / `unknown` (and disabled/expired) are
 *    never selected (see isSubscriptionAccountStructurallyEligible).
 *  - Zero managed accounts: identical to today's provider-global `route()`
 *    behaviour with `account: null`.
 *
 * Inventory generation (R1.3b):
 *  - Callers may pass an explicit `inventoryGeneration` (counter / probe token)
 *    to freeze per turn.
 *  - When absent, a stable content hash is derived from sorted provider / model /
 *    account ids (and per-account model rows when present) — deterministic for
 *    tests; never Date.now.
 *
 * Progressive admission (R1.4):
 *  - When inventory is supplied, models are filtered by
 *    {@link filterAvailableModelsForTier} using the capability registry
 *    (capabilityContext.registry or declarative floor).
 *  - Live inventory ids are spawnable (provisional inventory-listed) on worker,
 *    IC, and manager hard-gates — inventory is CLI authority, not name-promotion
 *    to curated eligible. Explicit candidate / worker-floor quarantine still block.
 *  - Curated eligible models still intersect routingProfile.tierAdmission.
 *  - Sparse registries merge declarative curated profiles for admission.
 *  - Chosen model is re-checked post-route so pricing-table fallback cannot
 *    resurrect candidate/invalidated/worker-floor ids.
 *
 * Per-account model inventory (R1.5):
 *  - Optional `availableModelsByAccount[provider][accountId]` is preferred when
 *    present for an account; provider-global `availableModels` is used only when
 *    the per-account map is absent for that provider (or the account has no row
 *    and global is the fallback).
 *  - When per-account inventories exist and differ, a model listed only under
 *    account B is never paired with account A.
 *  - Live per-account CLI probe is follow-on; this slice is the pure selection
 *    + deps API foundation.
 *
 * Pure: no I/O, no Date.now / Math.random / console / process.exit.
 */

import type { Policy, RouteDecision, Tier } from './types.js';
import type { ProviderId } from '../providers/port.js';
import {
  route,
  type CapabilityRouteContext,
} from './route.js';
import {
  isSubscriptionAccountStructurallyEligible,
  opencodePoolForModel,
  selectSubscriptionAccount,
} from './opencode-account-routing.js';
import type {
  OpencodeSubscriptionAccount,
  SubscriptionAccount,
  SubscriptionProvider,
} from '../infra/subscriptions.js';
import {
  DECLARATIVE_MODEL_CAPABILITIES,
} from './model-capabilities.js';
import {
  filterAvailableModelsForTier,
  isModelAdmittedForTier,
  providerBlockedByAdmission,
  resolveCapabilityForAdmission,
  resolveModelAdmission,
  type AdmissionOverrideMap,
} from './model-admission.js';
import { unionModelIds } from './live-model-inventory.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Versioned inventory generation for a lane snapshot.
 * Explicit counters are usually numbers; content-derived tokens are `ig-…` strings.
 */
export type InventoryGeneration = string | number;

/**
 * Models available to a single account (account id or alias → model ids).
 * Empty array means the account has a known empty entitlement list (not
 * "fall back to global").
 */
export type AccountModelList = Readonly<Record<string, readonly string[]>>;

/**
 * Per-provider map of account id → models that account may run (R1.5).
 * When a provider key is present, lane selection prefers these lists over the
 * provider-global `availableModels` for accounts that appear in the map.
 */
export type AvailableModelsByAccount = Partial<
  Record<ProviderId, AccountModelList>
>;

/**
 * One selected execution lane: provider, model, and account are atomic.
 * `account` is null only when the provider has zero managed accounts (ambient
 * provider-global credentials remain valid).
 * `inventoryGeneration` tags the inventory snapshot used for this selection
 * (R1.3b — freeze per turn for R2 mid-chat refresh).
 */
export interface ExecutionLane {
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string;
  readonly account: SubscriptionAccount | null;
  /** Versioned inventory generation for this lane snapshot. */
  readonly inventoryGeneration: InventoryGeneration;
  readonly capabilityReasons?: readonly string[];
}

/** Typed failure when no lane can be formed without ambient fallthrough. */
export interface ExecutionLaneSelectFailure {
  /**
   * `waiting_on_quota` — every remaining managed path is account-cooldown only
   * (R3.1; do not spawn on a cooling account). `no_eligible_lane` — structural /
   * admission / entitlement / mixed reasons.
   */
  readonly code: 'no_eligible_lane' | 'waiting_on_quota';
  /**
   * Actionable message: which managed providers were blocked and why ambient
   * credentials were not used.
   */
  readonly message: string;
  /** Providers that had managed accounts but no eligible account for a lane. */
  readonly blockedProviders: readonly ProviderId[];
  /**
   * When failure is driven by account cooldown, ms until the earliest cooling
   * account becomes selectable again (bounded Retry-After signal).
   */
  readonly retryAfterMs?: number;
}

export type ExecutionLaneSelectResult =
  | { readonly ok: true; readonly lane: ExecutionLane }
  | { readonly ok: false; readonly failure: ExecutionLaneSelectFailure };

export interface SelectExecutionLaneInput {
  readonly tier: Tier;
  readonly available: readonly ProviderId[];
  readonly policy: Policy;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  /**
   * Optional per-account model inventory (R1.5). Preferred over
   * {@link availableModels} for accounts that have a row under their provider.
   * When the whole map (or a provider key) is absent, provider-global
   * `availableModels` remains the filter (backward compatible).
   */
  readonly availableModelsByAccount?: AvailableModelsByAccount;
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly preferredOrder?: readonly ProviderId[];
  readonly capabilityContext?: CapabilityRouteContext;
  /**
   * Provider-generic managed accounts. When empty/absent and no legacy
   * opencode accounts, every available provider uses ambient credentials.
   */
  readonly accounts?: readonly SubscriptionAccount[];
  /**
   * Legacy opencode-only accounts (pre-subscriptionAccounts). Treated as
   * managed accounts for `opencode` only.
   */
  readonly opencodeAccounts?: readonly OpencodeSubscriptionAccount[];
  /**
   * Explicit inventory generation to freeze on the lane (counter or probe token).
   * When absent, derived from sorted provider/model/account inventory contents.
   */
  readonly inventoryGeneration?: InventoryGeneration;
  /**
   * Optional progressive-admission overrides (e.g. model-not-found → invalidated).
   * Keys via {@link admissionKey}. Absent → ranks derived only from registry facts.
   */
  readonly admissionOverrides?: AdmissionOverrideMap;
  readonly nowMs: number;
  readonly cooldownUntil?: ReadonlyMap<string, number>;
  readonly sessionTokensByAccount?: Readonly<Record<string, number>>;
  readonly strategy?: 'sticky' | 'spread';
}

// ---------------------------------------------------------------------------
// Inventory generation (R1.3b)
// ---------------------------------------------------------------------------

/**
 * Canonical fingerprint of inventory contents for stable generation derivation.
 * Order-independent: providers, models, per-account model rows, and account ids
 * are sorted.
 */
export function inventoryFingerprint(input: {
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly availableModelsByAccount?: AvailableModelsByAccount;
  readonly accounts?: readonly { readonly id: string; readonly provider: string }[];
  readonly opencodeAccounts?: readonly { readonly id: string }[];
}): string {
  const lines: string[] = [];

  const models = input.availableModels ?? {};
  for (const provider of Object.keys(models).sort()) {
    const list = models[provider as ProviderId];
    if (list === undefined) continue;
    for (const model of [...list].map((m) => m.trim()).filter((m) => m.length > 0).sort()) {
      lines.push(`model\t${provider}\t${model}`);
    }
  }

  const byAccount = input.availableModelsByAccount ?? {};
  for (const provider of Object.keys(byAccount).sort()) {
    const accountMap = byAccount[provider as ProviderId];
    if (accountMap === undefined) continue;
    for (const accountId of Object.keys(accountMap).sort()) {
      const list = accountMap[accountId] ?? [];
      for (const model of [...list].map((m) => m.trim()).filter((m) => m.length > 0).sort()) {
        lines.push(`account-model\t${provider}\t${accountId}\t${model}`);
      }
      if (list.length === 0) {
        lines.push(`account-model\t${provider}\t${accountId}\t`);
      }
    }
  }

  const accountKeys: string[] = [];
  if (input.accounts !== undefined) {
    for (const a of input.accounts) {
      accountKeys.push(`${a.provider}\t${a.id}`);
    }
  }
  if (input.opencodeAccounts !== undefined) {
    for (const a of input.opencodeAccounts) {
      // Prefer generic accounts when both present; still include legacy list so
      // a caller that only passes opencodeAccounts gets a distinct generation.
      accountKeys.push(`opencode\t${a.id}`);
    }
  }
  for (const key of accountKeys.sort()) {
    lines.push(`account\t${key}`);
  }

  return lines.join('\n');
}

/** djb2-ish 32-bit hex; pure; no deps. Prefix marks content-derived generations. */
function hashFingerprint(fingerprint: string): string {
  let h = 5381;
  for (let i = 0; i < fingerprint.length; i++) {
    h = ((h << 5) + h + fingerprint.charCodeAt(i)) | 0;
  }
  return 'ig-' + (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Derive a stable inventory generation from inventory contents.
 * Same inventory (order-independent) → same generation; not wall-clock based.
 */
export function deriveInventoryGeneration(input: {
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly availableModelsByAccount?: AvailableModelsByAccount;
  readonly accounts?: readonly { readonly id: string; readonly provider: string }[];
  readonly opencodeAccounts?: readonly { readonly id: string }[];
}): string {
  return hashFingerprint(inventoryFingerprint(input));
}

/**
 * Resolve generation: explicit caller value wins; else content-derived token.
 */
export function resolveInventoryGeneration(
  explicit: InventoryGeneration | undefined,
  inventory: {
    readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
    readonly availableModelsByAccount?: AvailableModelsByAccount;
    readonly accounts?: readonly { readonly id: string; readonly provider: string }[];
    readonly opencodeAccounts?: readonly { readonly id: string }[];
  },
): InventoryGeneration {
  if (explicit !== undefined) return explicit;
  return deriveInventoryGeneration(inventory);
}

// ---------------------------------------------------------------------------
// Per-account model inventory (R1.5)
// ---------------------------------------------------------------------------

/** Case-insensitive model id membership (trim; empty never matches). */
export function modelListIncludes(
  list: readonly string[] | undefined,
  model: string,
): boolean {
  if (list === undefined) return false;
  const key = model.trim().toLowerCase();
  if (key.length === 0) return false;
  return list.some((m) => m.trim().toLowerCase() === key);
}

/**
 * Resolve the model list that governs a specific account.
 *
 * - Per-account map absent for the provider → provider-global list (may be
 *   undefined = unrestricted / pricing-table fallback).
 * - Account has an explicit row under the provider map → that list (even empty).
 * - Provider map present but account has no row → provider-global fallback.
 */
export function resolveModelsForAccount(
  provider: ProviderId,
  accountId: string,
  availableModelsByAccount: AvailableModelsByAccount | undefined,
  availableModels: Partial<Record<ProviderId, readonly string[]>> | undefined,
): readonly string[] | undefined {
  const byProvider = availableModelsByAccount?.[provider];
  if (byProvider === undefined) {
    return availableModels?.[provider];
  }
  if (Object.prototype.hasOwnProperty.call(byProvider, accountId)) {
    return byProvider[accountId] ?? [];
  }
  return availableModels?.[provider];
}

/**
 * True when the account may run `model` under R1.5 entitlement rules.
 * Unrestricted (no list) → true; explicit list → membership only.
 */
export function accountEntitledToModel(
  provider: ProviderId,
  accountId: string,
  model: string,
  availableModelsByAccount: AvailableModelsByAccount | undefined,
  availableModels: Partial<Record<ProviderId, readonly string[]>> | undefined,
): boolean {
  const list = resolveModelsForAccount(
    provider,
    accountId,
    availableModelsByAccount,
    availableModels,
  );
  if (list === undefined) return true;
  return modelListIncludes(list, model);
}

/**
 * Build the provider → model map used for routing when per-account inventories
 * may expand (or replace) the provider-global list.
 *
 * For each provider with a per-account map: union of all account lists, plus
 * the global list for any managed account that lacks a row (fallback). Providers
 * without a per-account map keep provider-global entries only.
 */
export function routingModelsFromInventories(input: {
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly availableModelsByAccount?: AvailableModelsByAccount;
  readonly accounts?: readonly SubscriptionAccount[];
  readonly opencodeAccounts?: readonly OpencodeSubscriptionAccount[];
}): Partial<Record<ProviderId, readonly string[]>> | undefined {
  const { availableModels, availableModelsByAccount } = input;
  if (availableModels === undefined && availableModelsByAccount === undefined) {
    return undefined;
  }

  const providerKeys = new Set<ProviderId>();
  if (availableModels !== undefined) {
    for (const k of Object.keys(availableModels) as ProviderId[]) {
      providerKeys.add(k);
    }
  }
  if (availableModelsByAccount !== undefined) {
    for (const k of Object.keys(availableModelsByAccount) as ProviderId[]) {
      providerKeys.add(k);
    }
  }

  const out: Partial<Record<ProviderId, readonly string[]>> = {};
  for (const provider of providerKeys) {
    const byAcct = availableModelsByAccount?.[provider];
    if (byAcct === undefined) {
      const global = availableModels?.[provider];
      if (global !== undefined) out[provider] = global;
      continue;
    }

    const lists: (readonly string[] | undefined)[] = Object.values(byAcct);
    const managed = managedAccountsForProvider(
      provider,
      input.accounts,
      input.opencodeAccounts,
    );
    for (const a of managed) {
      if (!Object.prototype.hasOwnProperty.call(byAcct, a.id)) {
        lists.push(availableModels?.[provider]);
      }
    }
    // No managed accounts but per-account map present (e.g. pre-wired probe):
    // still expose the union so ambient path can use the same filter surface.
    if (managed.length === 0 && availableModels?.[provider] !== undefined) {
      lists.push(availableModels[provider]);
    }
    const merged = unionModelIds(...lists);
    out[provider] = merged;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function omitModelFromInventory(
  models: Partial<Record<ProviderId, readonly string[]>>,
  provider: ProviderId,
  model: string,
): Partial<Record<ProviderId, readonly string[]>> {
  const key = model.trim().toLowerCase();
  const list = models[provider];
  const next: Partial<Record<ProviderId, readonly string[]>> = { ...models };
  if (list === undefined) {
    next[provider] = [];
    return next;
  }
  next[provider] = list.filter((m) => m.trim().toLowerCase() !== key);
  return next;
}

/**
 * Drop a model from the route inventory; returns true when the map shrank.
 * When the model was not in the list (e.g. pricing-table fallback outside
 * inventory), clears the provider list so the loop cannot spin forever.
 */
function dropModelOrClearProvider(
  models: Partial<Record<ProviderId, readonly string[]>>,
  provider: ProviderId,
  model: string,
): {
  readonly next: Partial<Record<ProviderId, readonly string[]>>;
  readonly progressed: boolean;
} {
  const before = models[provider];
  const next = omitModelFromInventory(models, provider, model);
  const after = next[provider];
  const shrunk = (before?.length ?? 0) !== (after?.length ?? 0);
  if (shrunk) {
    return { next, progressed: (after?.length ?? 0) > 0 };
  }
  // No progress: pricing fallback / non-inventory model — clear provider list.
  const cleared: Partial<Record<ProviderId, readonly string[]>> = {
    ...models,
    [provider]: [],
  };
  return { next: cleared, progressed: false };
}

const SUBSCRIPTION_PROVIDERS: ReadonlySet<string> = new Set([
  'opencode',
  'claude',
  'codex',
  'grok',
]);

function isSubscriptionProvider(id: ProviderId): id is SubscriptionProvider {
  return SUBSCRIPTION_PROVIDERS.has(id);
}

/**
 * Normalize managed-account inventory for a provider.
 * Prefers generic `accounts`; falls back to legacy opencode-only list.
 */
function managedAccountsForProvider(
  provider: ProviderId,
  accounts: readonly SubscriptionAccount[] | undefined,
  opencodeAccounts: readonly OpencodeSubscriptionAccount[] | undefined,
): readonly SubscriptionAccount[] {
  if (accounts !== undefined && accounts.length > 0) {
    return accounts.filter((a) => a.provider === provider);
  }
  if (
    provider === 'opencode' &&
    opencodeAccounts !== undefined &&
    opencodeAccounts.length > 0
  ) {
    return opencodeAccounts;
  }
  return [];
}

function decisionToLane(
  decision: RouteDecision,
  account: SubscriptionAccount | null,
  inventoryGeneration: InventoryGeneration,
): ExecutionLane {
  return {
    tier: decision.tier,
    provider: decision.provider,
    model: decision.model,
    account,
    inventoryGeneration,
    ...(decision.capabilityReasons !== undefined
      ? { capabilityReasons: decision.capabilityReasons }
      : {}),
  };
}

/**
 * Select a single execution lane: provider + model + account together.
 *
 * Walks the same preference surface as {@link route}, but when a chosen
 * provider has managed accounts and none are eligible for the resolved model
 * (pool-aware for opencode), that provider is removed from the candidate set
 * and routing retries — never ambient fallthrough for a managed provider.
 *
 * Ok lanes always carry {@link ExecutionLane.inventoryGeneration} (explicit or
 * content-derived) so callers can freeze the inventory snapshot per turn.
 */
export function selectExecutionLane(
  input: SelectExecutionLaneInput,
): ExecutionLaneSelectResult {
  const {
    tier,
    policy,
    availableModels,
    availableModelsByAccount,
    authenticatedProviders,
    preferredOrder,
    capabilityContext,
    accounts,
    opencodeAccounts,
    admissionOverrides,
    nowMs,
    cooldownUntil = new Map(),
    sessionTokensByAccount = {},
    strategy = 'spread',
  } = input;

  const inventoryGeneration = resolveInventoryGeneration(input.inventoryGeneration, {
    ...(availableModels !== undefined ? { availableModels } : {}),
    ...(availableModelsByAccount !== undefined
      ? { availableModelsByAccount }
      : {}),
    ...(accounts !== undefined ? { accounts } : {}),
    ...(opencodeAccounts !== undefined ? { opencodeAccounts } : {}),
  });

  // Merge provider-global + per-account inventories into the route surface.
  // Generation fingerprint still uses the unfiltered caller inventory.
  const baseInventory = routingModelsFromInventories({
    ...(availableModels !== undefined ? { availableModels } : {}),
    ...(availableModelsByAccount !== undefined
      ? { availableModelsByAccount }
      : {}),
    ...(accounts !== undefined ? { accounts } : {}),
    ...(opencodeAccounts !== undefined ? { opencodeAccounts } : {}),
  });

  // R1.4 — progressive admission filter when inventory is supplied.
  // Registry floor: capabilityContext.registry, else declarative curated table.
  const admissionRegistry =
    capabilityContext?.registry ?? DECLARATIVE_MODEL_CAPABILITIES;
  let modelsForRoute = baseInventory;
  let remaining: ProviderId[] = [...input.available];
  const blockedProviders: ProviderId[] = [];
  const admissionBlocked: ProviderId[] = [];
  const entitlementBlocked: ProviderId[] = [];
  /** Providers whose only remaining selectable accounts were in cooldown (R3.1). */
  const cooldownBlocked: ProviderId[] = [];
  /** Earliest account cooldown expiry (epoch ms) among cooldown-blocked paths. */
  let earliestCooldownUntil: number | undefined;

  if (baseInventory !== undefined) {
    const filtered = filterAvailableModelsForTier(
      baseInventory,
      tier,
      admissionRegistry,
      admissionOverrides,
    );
    modelsForRoute = filtered;
    // Drop providers whose inventory was exclusively non-admitted for this tier
    // (e.g. manager with explicit candidate/worker-floor-only overrides).
    remaining = remaining.filter((p) => {
      if (providerBlockedByAdmission(p, baseInventory[p], filtered[p])) {
        if (!admissionBlocked.includes(p)) admissionBlocked.push(p);
        if (!blockedProviders.includes(p)) blockedProviders.push(p);
        return false;
      }
      return true;
    });
  }

  while (remaining.length > 0) {
    let decision: RouteDecision;
    try {
      decision = route(
        tier,
        remaining,
        policy,
        modelsForRoute,
        authenticatedProviders,
        preferredOrder,
        capabilityContext,
      );
    } catch {
      // route throws when available is empty — treated as no lane below.
      break;
    }

    const provider = decision.provider;

    // R1.4 post-check: refuse models that fail progressive admission for tier
    // (pricing fallback must not resurrect candidate/worker-floor quarantine).
    // Models present in the caller's live inventory are marked inLiveInventory.
    const inventoryList = baseInventory?.[provider];
    const inLiveInventory = modelListIncludes(inventoryList, decision.model);
    const admission = resolveModelAdmission(
      admissionRegistry,
      provider,
      decision.model,
      admissionOverrides,
      { inLiveInventory },
    );
    const cap = resolveCapabilityForAdmission(
      admissionRegistry,
      provider,
      decision.model,
    );
    if (!isModelAdmittedForTier(admission, tier, cap)) {
      if (!admissionBlocked.includes(provider)) admissionBlocked.push(provider);
      if (!blockedProviders.includes(provider)) blockedProviders.push(provider);
      remaining = remaining.filter((p) => p !== provider);
      continue;
    }

    const managed = managedAccountsForProvider(provider, accounts, opencodeAccounts);

    // Zero managed accounts for this provider → ambient / provider-global path.
    if (managed.length === 0) {
      return {
        ok: true,
        lane: decisionToLane(decision, null, inventoryGeneration),
      };
    }

    // Managed accounts exist: must pair an eligible account with this model.
    if (!isSubscriptionProvider(provider)) {
      // Defensive: managed inventory should only exist for known subscription
      // providers. Treat as ambient if somehow present.
      return {
        ok: true,
        lane: decisionToLane(decision, null, inventoryGeneration),
      };
    }

    // R1.5: only accounts entitled to this model may pair (never cross-account).
    const entitled = managed.filter((a) =>
      accountEntitledToModel(
        provider,
        a.id,
        decision.model,
        availableModelsByAccount,
        availableModels,
      ),
    );

    // No account lists this model — drop the model and retry (other accounts
    // may still own different models on the same provider).
    if (entitled.length === 0) {
      if (!entitlementBlocked.includes(provider)) {
        entitlementBlocked.push(provider);
      }
      if (modelsForRoute !== undefined) {
        const drop = dropModelOrClearProvider(
          modelsForRoute,
          provider,
          decision.model,
        );
        modelsForRoute = drop.next;
        if (drop.progressed) {
          continue;
        }
      }
      if (!blockedProviders.includes(provider)) {
        blockedProviders.push(provider);
      }
      remaining = remaining.filter((p) => p !== provider);
      continue;
    }

    const account = selectSubscriptionAccount({
      accounts: entitled,
      provider,
      ...(provider === 'opencode'
        ? { pool: opencodePoolForModel(decision.model) ?? 'zen' }
        : {}),
      nowMs,
      cooldownUntil,
      sessionTokensByAccount,
      strategy,
    });

    if (account !== null) {
      // Defense in depth: never return a cross-account entitlement miss.
      if (
        !accountEntitledToModel(
          provider,
          account.id,
          decision.model,
          availableModelsByAccount,
          availableModels,
        )
      ) {
        if (!entitlementBlocked.includes(provider)) {
          entitlementBlocked.push(provider);
        }
        if (modelsForRoute !== undefined) {
          const drop = dropModelOrClearProvider(
            modelsForRoute,
            provider,
            decision.model,
          );
          modelsForRoute = drop.next;
          if (drop.progressed) {
            continue;
          }
        }
        if (!blockedProviders.includes(provider)) {
          blockedProviders.push(provider);
        }
        remaining = remaining.filter((p) => p !== provider);
        continue;
      }
      return {
        ok: true,
        lane: decisionToLane(decision, account, inventoryGeneration),
      };
    }

    // selectSubscriptionAccount returned null. Detect all-cooling among the
    // structurally eligible entitled accounts (same pool filter as selection)
    // so we can surface waiting_on_quota + retryAfter instead of silent pick.
    const pool =
      provider === 'opencode'
        ? (opencodePoolForModel(decision.model) ?? 'zen')
        : undefined;
    const structuralEntitled = entitled.filter((a) => {
      if (!isSubscriptionAccountStructurallyEligible(a, nowMs)) return false;
      if (provider === 'opencode' && pool !== undefined) {
        const opencode = a as unknown as OpencodeSubscriptionAccount;
        return opencode.pool === pool;
      }
      return true;
    });
    const coolingStructural = structuralEntitled.filter((a) => {
      const until = cooldownUntil.get(a.id);
      return until !== undefined && until > nowMs;
    });
    const allCooling =
      structuralEntitled.length > 0 &&
      coolingStructural.length === structuralEntitled.length;

    if (allCooling) {
      if (!cooldownBlocked.includes(provider)) {
        cooldownBlocked.push(provider);
      }
      for (const a of coolingStructural) {
        const until = cooldownUntil.get(a.id);
        if (until === undefined) continue;
        if (earliestCooldownUntil === undefined || until < earliestCooldownUntil) {
          earliestCooldownUntil = until;
        }
      }
    }

    // Entitled accounts present but none selectable (status/cooldown/pool).
    // If any managed account is still structurally eligible for *some* other
    // model, drop only this model; otherwise block the provider.
    // (Other pools / entitlements may still have healthy accounts.)
    const anyStructurallyEligible = managed.some((a) =>
      isSubscriptionAccountStructurallyEligible(a, nowMs),
    );
    if (anyStructurallyEligible && modelsForRoute !== undefined) {
      const drop = dropModelOrClearProvider(
        modelsForRoute,
        provider,
        decision.model,
      );
      modelsForRoute = drop.next;
      if (drop.progressed) {
        continue;
      }
    }

    // Managed accounts present but none eligible — block this provider; do not
    // fall through to ambient global credentials for it.
    if (!blockedProviders.includes(provider)) {
      blockedProviders.push(provider);
    }
    remaining = remaining.filter((p) => p !== provider);
  }

  const blockedList =
    blockedProviders.length > 0
      ? blockedProviders.join(', ')
      : '(none)';
  const admissionNote =
    admissionBlocked.length > 0
      ? ` Progressive admission blocked (candidate/worker-floor/invalidated for tier ` +
        `"${tier}"): ${admissionBlocked.join(', ')}.`
      : '';
  const entitlementNote =
    entitlementBlocked.length > 0
      ? ` Per-account inventory blocked cross-entitlement pairing for: ` +
        `${entitlementBlocked.join(', ')}.`
      : '';

  const retryAfterMs =
    earliestCooldownUntil !== undefined && earliestCooldownUntil > nowMs
      ? earliestCooldownUntil - nowMs
      : undefined;

  // Pure cooldown failure: every blocked managed path was all-cooling and no
  // other admission/entitlement reason applied (R3.1 waiting_on_quota).
  const pureCooldown =
    cooldownBlocked.length > 0 &&
    admissionBlocked.length === 0 &&
    entitlementBlocked.length === 0 &&
    cooldownBlocked.length === blockedProviders.length &&
    cooldownBlocked.every((p) => blockedProviders.includes(p));

  if (pureCooldown) {
    const secs =
      retryAfterMs !== undefined
        ? Math.max(1, Math.ceil(retryAfterMs / 1000))
        : undefined;
    const waitHint =
      secs !== undefined
        ? ` Earliest account cooldown ends in ~${secs}s (retryAfterMs=${retryAfterMs}).`
        : '';
    return {
      ok: false,
      failure: {
        code: 'waiting_on_quota',
        message:
          `All eligible subscription accounts are in rate-limit cooldown for ` +
          `managed providers: ${blockedList}. Not spawning on a cooling account.` +
          `${waitHint} Wait for cooldown, enable another provider/account, or ` +
          `retry after the earliest account is available. Refusing ambient global ` +
          `credentials for those providers.`,
        blockedProviders,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      },
    };
  }

  const cooldownNote =
    cooldownBlocked.length > 0
      ? ` Account cooldown blocked (no healthy sibling): ${cooldownBlocked.join(', ')}` +
        (retryAfterMs !== undefined
          ? ` (earliest retryAfterMs=${retryAfterMs}).`
          : '.')
      : '';

  return {
    ok: false,
    failure: {
      code: 'no_eligible_lane',
      message:
        `No eligible execution lane: managed subscription accounts exist but none ` +
        `are selectable (status auth-failed/unknown/disabled/expired, disabled, ` +
        `all eligible accounts cooling without a healthy alternate lane, pool ` +
        `mismatch, or model not entitled on any account), or progressive admission ` +
        `refused all inventory for this tier. Blocked managed providers: ${blockedList}.` +
        `${admissionNote}${entitlementNote}${cooldownNote} Refusing ambient global ` +
        `credentials for those providers. Add/repair an eligible account, enable ` +
        `another provider, wait for cooldown/admission, or retry later.`,
      blockedProviders,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    },
  };
}
