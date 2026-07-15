/**
 * src/interface/enrich-orchestrate-accounts.ts — shared managed-account enrich
 * for OrchestrateDeps (menu + detached worker parity).
 *
 * Mirrors menu `enrichDepsWithAccounts` core: load subscriptions, prefer real
 * per-account probe inventory, else provisional global-copy, attach cooldowns.
 * Fail-soft: any read/probe failure returns base deps unchanged.
 *
 * Detached `productionDeps` uses this so Esc→worker does not ambient-route
 * around managed accounts. Menu may keep its local extras (session tokens,
 * parallelism, lastUsedAt) layered on top of this seam later.
 */

import type { AvailableModelsByAccount } from '../core/execution-lane.js';
import type { OrchestrateDeps } from '../core/types.js';
import { probeAvailableModelsByAccount as defaultProbe } from '../infra/subscription-detect.js';
import {
  readSubscriptions as defaultReadSubscriptions,
  type OpencodeSubscriptionAccount,
  type SubscriptionAccount,
  type SubscriptionsFileV1,
} from '../infra/subscriptions.js';
import { buildAvailableModelsByAccountDepsSlice } from './build-orchestrate-deps.js';

export interface EnrichOrchestrateAccountsOptions {
  /** Working directory for env-scoped per-account probe. */
  readonly cwd: string;
  /**
   * Cooldown map for R3 cooling rules. Empty Map is valid when the caller has
   * no session cooldown state (detached worker today).
   */
  readonly accountCooldownUntil?: ReadonlyMap<string, number>;
  /** Injectable for tests — defaults to production readSubscriptions. */
  readonly readSubscriptions?: () => Promise<SubscriptionsFileV1>;
  /**
   * Injectable for tests — defaults to production probeAvailableModelsByAccount.
   * Signature matches the real probe (cwd + optional detect opts omitted here).
   */
  readonly probeAvailableModelsByAccount?: (
    accounts: readonly SubscriptionAccount[],
    cwd: string,
  ) => Promise<AvailableModelsByAccount | undefined>;
}

/**
 * Enrich base OrchestrateDeps with managed subscription account fields.
 *
 * Rules:
 *  - No accounts → return base unchanged (do not force empty subscriptionAccounts).
 *  - Prefer base.availableModelsByAccount if already set.
 *  - Else prefer real probe rows when any exist; never invent models on empty probe.
 *  - Else provisional `buildAvailableModelsByAccountDepsSlice` from global models.
 *  - Always set subscriptionAccounts + legacy opencodeAccounts + accountCooldownUntil
 *    when accounts exist.
 *  - Fail-soft on read/probe errors → base.
 */
export async function enrichOrchestrateDepsWithAccounts(
  base: OrchestrateDeps,
  opts: EnrichOrchestrateAccountsOptions,
): Promise<OrchestrateDeps> {
  const readSubs = opts.readSubscriptions ?? defaultReadSubscriptions;
  const probe = opts.probeAvailableModelsByAccount ?? defaultProbe;

  try {
    const subs = await readSubs();
    const allAccounts = subs.accounts;
    if (allAccounts.length === 0) return base;

    const opencodeAccounts = allAccounts.filter(
      (a): a is OpencodeSubscriptionAccount => a.provider === 'opencode',
    );

    let byAccountSlice: AvailableModelsByAccountDepsSlice =
      base.availableModelsByAccount !== undefined
        ? { availableModelsByAccount: base.availableModelsByAccount }
        : {};

    if (base.availableModelsByAccount === undefined) {
      let probed: AvailableModelsByAccount | undefined;
      try {
        probed = await probe(allAccounts, opts.cwd);
      } catch {
        probed = undefined;
      }
      if (probed !== undefined && Object.keys(probed).length > 0) {
        byAccountSlice = { availableModelsByAccount: probed };
      } else {
        byAccountSlice = buildAvailableModelsByAccountDepsSlice(
          base.availableModels,
          allAccounts,
        );
      }
    }

    const accountCooldownUntil =
      opts.accountCooldownUntil ?? new Map<string, number>();

    return {
      ...base,
      subscriptionAccounts: allAccounts,
      accountCooldownUntil,
      opencodeAccounts,
      ...byAccountSlice,
    };
  } catch {
    return base;
  }
}

type AvailableModelsByAccountDepsSlice = Pick<
  OrchestrateDeps,
  'availableModelsByAccount'
>;
