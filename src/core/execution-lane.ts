/**
 * src/core/execution-lane.ts — atomic execution-lane selection (R1.1 / R1.3b / R1.4).
 *
 * The routing atom is an eligible **lane** = provider + account + model chosen
 * together, not model-then-account. Inventory v1 still uses provider-global
 * `availableModels` (same models for every account of a provider until full
 * per-account probe), but selection always returns one struct pairing all three
 * and tags the snapshot with a versioned **inventory generation**.
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
 *    account ids — deterministic for tests; never Date.now.
 *
 * Progressive admission (R1.4):
 *  - When `availableModels` is supplied, models are filtered by
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
 * Pure: no I/O, no Date.now / Math.random / console / process.exit.
 */

import type { Policy, RouteDecision, Tier } from './types.js';
import type { ProviderId } from '../providers/port.js';
import {
  route,
  type CapabilityRouteContext,
} from './route.js';
import {
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Versioned inventory generation for a lane snapshot.
 * Explicit counters are usually numbers; content-derived tokens are `ig-…` strings.
 */
export type InventoryGeneration = string | number;

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
  readonly code: 'no_eligible_lane';
  /**
   * Actionable message: which managed providers were blocked and why ambient
   * credentials were not used.
   */
  readonly message: string;
  /** Providers that had managed accounts but no eligible account for a lane. */
  readonly blockedProviders: readonly ProviderId[];
}

export type ExecutionLaneSelectResult =
  | { readonly ok: true; readonly lane: ExecutionLane }
  | { readonly ok: false; readonly failure: ExecutionLaneSelectFailure };

export interface SelectExecutionLaneInput {
  readonly tier: Tier;
  readonly available: readonly ProviderId[];
  readonly policy: Policy;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
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
 * Order-independent: providers, models, and account ids are sorted.
 */
export function inventoryFingerprint(input: {
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
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
    readonly accounts?: readonly { readonly id: string; readonly provider: string }[];
    readonly opencodeAccounts?: readonly { readonly id: string }[];
  },
): InventoryGeneration {
  if (explicit !== undefined) return explicit;
  return deriveInventoryGeneration(inventory);
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
    ...(accounts !== undefined ? { accounts } : {}),
    ...(opencodeAccounts !== undefined ? { opencodeAccounts } : {}),
  });

  // R1.4 — progressive admission filter when inventory is supplied.
  // Registry floor: capabilityContext.registry, else declarative curated table.
  // Generation fingerprint still uses the unfiltered inventory (discovery truth).
  const admissionRegistry =
    capabilityContext?.registry ?? DECLARATIVE_MODEL_CAPABILITIES;
  let modelsForRoute = availableModels;
  let remaining: ProviderId[] = [...input.available];
  const blockedProviders: ProviderId[] = [];
  const admissionBlocked: ProviderId[] = [];

  if (availableModels !== undefined) {
    const filtered = filterAvailableModelsForTier(
      availableModels,
      tier,
      admissionRegistry,
      admissionOverrides,
    );
    modelsForRoute = filtered;
    // Drop providers whose inventory was exclusively non-admitted for this tier
    // (e.g. manager with explicit candidate/worker-floor-only overrides).
    remaining = remaining.filter((p) => {
      if (providerBlockedByAdmission(p, availableModels[p], filtered[p])) {
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
    const inventoryList = availableModels?.[provider];
    const inLiveInventory =
      inventoryList !== undefined &&
      inventoryList.some(
        (m) => m.trim().toLowerCase() === decision.model.trim().toLowerCase(),
      );
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

    const account = selectSubscriptionAccount({
      accounts: managed,
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
      return {
        ok: true,
        lane: decisionToLane(decision, account, inventoryGeneration),
      };
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
  return {
    ok: false,
    failure: {
      code: 'no_eligible_lane',
      message:
        `No eligible execution lane: managed subscription accounts exist but none ` +
        `are selectable (status auth-failed/unknown/disabled/expired, disabled, ` +
        `cooled without alternate provider, or pool mismatch), or progressive ` +
        `admission refused all inventory for this tier. Blocked managed ` +
        `providers: ${blockedList}.${admissionNote} Refusing ambient global ` +
        `credentials for those providers. Add/repair an eligible account, enable ` +
        `another provider, or wait for model admission promotion.`,
      blockedProviders,
    },
  };
}
