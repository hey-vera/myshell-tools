/**
 * src/core/turn-lane-snapshot.ts — freeze one routing inventory + lane per turn (R2.1).
 *
 * A work turn freezes provider-neutral inventory (models, accounts, generation)
 * at dispatch. Mid-turn mutation of live deps / catalogs must not change what
 * in-flight attempts see. The next turn may adopt a new lane at a safe boundary
 * by freezing a fresh inventory from updated deps.
 *
 * Pure: no I/O, no Date.now / Math.random / console / process.exit.
 */

import type { Tier } from './types.js';
import type { ProviderId } from '../providers/port.js';
import type {
  OpencodeSubscriptionAccount,
  SubscriptionAccount,
} from '../infra/subscriptions.js';
import {
  deriveInventoryGeneration,
  resolveInventoryGeneration,
  type AvailableModelsByAccount,
  type ExecutionLane,
  type InventoryGeneration,
} from './execution-lane.js';

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

/**
 * Why / where a turn lane inventory or selected-lane snapshot was frozen.
 * Kept narrow for R2.1; continuity bridge (R2.2) may add more.
 */
export type TurnLaneFreezeReason =
  | 'work-call-dispatch'
  | 'work-call-attempt'
  | 'hedge-primary-dispatch'
  | 'hedge-attempt';

// ---------------------------------------------------------------------------
// Selected lane snapshot (what one request / ledger row used)
// ---------------------------------------------------------------------------

/**
 * Immutable record of the execution lane used for one provider request.
 * Captures the atomic provider + account + model together with the inventory
 * generation frozen for the turn.
 */
export interface TurnLaneSnapshot {
  readonly provider: ProviderId;
  readonly model: string;
  readonly accountId: string | null;
  readonly tier: Tier;
  readonly inventoryGeneration: InventoryGeneration;
  readonly frozenAt: TurnLaneFreezeReason;
  readonly capabilityReasons?: readonly string[];
}

/**
 * Build a turn-lane snapshot from a successful atomic execution lane.
 * Does not retain live account object references beyond id.
 */
export function turnLaneSnapshotFromLane(
  lane: ExecutionLane,
  frozenAt: TurnLaneFreezeReason,
): TurnLaneSnapshot {
  return {
    provider: lane.provider,
    model: lane.model,
    accountId: lane.account?.id ?? null,
    tier: lane.tier,
    inventoryGeneration: lane.inventoryGeneration,
    frozenAt,
    ...(lane.capabilityReasons !== undefined && lane.capabilityReasons.length > 0
      ? { capabilityReasons: [...lane.capabilityReasons] }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Inventory freeze (inputs to selectExecutionLane for the whole turn)
// ---------------------------------------------------------------------------

/**
 * Deep-copied inventory used for every route within one dispatched turn.
 * Callers must not mutate these fields; they are frozen at dispatch.
 */
export interface TurnInventoryFreeze {
  /** Explicit or content-derived generation token for this turn. */
  readonly inventoryGeneration: InventoryGeneration;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly availableModelsByAccount?: AvailableModelsByAccount;
  readonly accounts?: readonly SubscriptionAccount[];
  readonly opencodeAccounts?: readonly OpencodeSubscriptionAccount[];
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly frozenAt: TurnLaneFreezeReason;
}

export interface FreezeTurnInventoryInput {
  readonly inventoryGeneration?: InventoryGeneration;
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly availableModelsByAccount?: AvailableModelsByAccount;
  readonly accounts?: readonly SubscriptionAccount[];
  readonly opencodeAccounts?: readonly OpencodeSubscriptionAccount[];
  readonly authenticatedProviders?: readonly ProviderId[];
  readonly frozenAt: TurnLaneFreezeReason;
}

function copyAvailableModels(
  models: Partial<Record<ProviderId, readonly string[]>> | undefined,
): Partial<Record<ProviderId, readonly string[]>> | undefined {
  if (models === undefined) return undefined;
  const out: Partial<Record<ProviderId, readonly string[]>> = {};
  for (const key of Object.keys(models) as ProviderId[]) {
    const list = models[key];
    if (list !== undefined) out[key] = [...list];
  }
  return out;
}

function copyAvailableModelsByAccount(
  byAccount: AvailableModelsByAccount | undefined,
): AvailableModelsByAccount | undefined {
  if (byAccount === undefined) return undefined;
  const out: AvailableModelsByAccount = {};
  for (const provider of Object.keys(byAccount) as ProviderId[]) {
    const accountMap = byAccount[provider];
    if (accountMap === undefined) continue;
    const copied: Record<string, readonly string[]> = {};
    for (const accountId of Object.keys(accountMap)) {
      const list = accountMap[accountId];
      copied[accountId] = list !== undefined ? [...list] : [];
    }
    out[provider] = copied;
  }
  return out;
}

/**
 * Freeze inventory inputs for one turn. Deep-copies model lists and account
 * arrays so later mutation of the caller's deps objects cannot change the
 * in-flight turn. Resolves inventoryGeneration once (explicit wins, else
 * content-derived from the frozen copy).
 */
export function freezeTurnInventory(
  input: FreezeTurnInventoryInput,
): TurnInventoryFreeze {
  const availableModels = copyAvailableModels(input.availableModels);
  const availableModelsByAccount = copyAvailableModelsByAccount(
    input.availableModelsByAccount,
  );
  const accounts =
    input.accounts !== undefined ? [...input.accounts] : undefined;
  const opencodeAccounts =
    input.opencodeAccounts !== undefined
      ? [...input.opencodeAccounts]
      : undefined;
  const authenticatedProviders =
    input.authenticatedProviders !== undefined
      ? [...input.authenticatedProviders]
      : undefined;

  const inventoryGeneration = resolveInventoryGeneration(
    input.inventoryGeneration,
    {
      ...(availableModels !== undefined ? { availableModels } : {}),
      ...(availableModelsByAccount !== undefined
        ? { availableModelsByAccount }
        : {}),
      ...(accounts !== undefined ? { accounts } : {}),
      ...(opencodeAccounts !== undefined ? { opencodeAccounts } : {}),
    },
  );

  return {
    inventoryGeneration,
    ...(availableModels !== undefined ? { availableModels } : {}),
    ...(availableModelsByAccount !== undefined
      ? { availableModelsByAccount }
      : {}),
    ...(accounts !== undefined ? { accounts } : {}),
    ...(opencodeAccounts !== undefined ? { opencodeAccounts } : {}),
    ...(authenticatedProviders !== undefined
      ? { authenticatedProviders }
      : {}),
    frozenAt: input.frozenAt,
  };
}

/**
 * Convenience: freeze inventory from an OrchestrateDeps-shaped bag.
 * Does not retain a live deps reference.
 */
export function freezeTurnInventoryFromDeps(
  deps: {
    readonly inventoryGeneration?: InventoryGeneration;
    readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
    readonly availableModelsByAccount?: AvailableModelsByAccount;
    readonly subscriptionAccounts?: readonly SubscriptionAccount[];
    readonly opencodeAccounts?: readonly OpencodeSubscriptionAccount[];
    readonly authenticatedProviders?: readonly ProviderId[];
  },
  frozenAt: TurnLaneFreezeReason = 'work-call-dispatch',
): TurnInventoryFreeze {
  return freezeTurnInventory({
    frozenAt,
    ...(deps.inventoryGeneration !== undefined
      ? { inventoryGeneration: deps.inventoryGeneration }
      : {}),
    ...(deps.availableModels !== undefined
      ? { availableModels: deps.availableModels }
      : {}),
    ...(deps.availableModelsByAccount !== undefined
      ? { availableModelsByAccount: deps.availableModelsByAccount }
      : {}),
    ...(deps.subscriptionAccounts !== undefined
      ? { accounts: deps.subscriptionAccounts }
      : {}),
    ...(deps.opencodeAccounts !== undefined
      ? { opencodeAccounts: deps.opencodeAccounts }
      : {}),
    ...(deps.authenticatedProviders !== undefined
      ? { authenticatedProviders: deps.authenticatedProviders }
      : {}),
  });
}

/**
 * True when two freezes share the same inventory generation token.
 * Used by tests and optional continuity checks (not a full R2.2 bridge).
 */
export function sameInventoryGeneration(
  a: InventoryGeneration,
  b: InventoryGeneration,
): boolean {
  return a === b;
}

/** Re-export derive helper so tests can compare content hashes without a second import path. */
export { deriveInventoryGeneration };
