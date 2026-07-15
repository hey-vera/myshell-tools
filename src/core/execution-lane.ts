/**
 * src/core/execution-lane.ts — atomic execution-lane selection (R1.1).
 *
 * The routing atom is an eligible **lane** = provider + account + model chosen
 * together, not model-then-account. Inventory v1 still uses provider-global
 * `availableModels` (same models for every account of a provider until R1.3),
 * but selection always returns one struct pairing all three.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One selected execution lane: provider, model, and account are atomic.
 * `account` is null only when the provider has zero managed accounts (ambient
 * provider-global credentials remain valid).
 */
export interface ExecutionLane {
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string;
  readonly account: SubscriptionAccount | null;
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
  readonly nowMs: number;
  readonly cooldownUntil?: ReadonlyMap<string, number>;
  readonly sessionTokensByAccount?: Readonly<Record<string, number>>;
  readonly strategy?: 'sticky' | 'spread';
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
): ExecutionLane {
  return {
    tier: decision.tier,
    provider: decision.provider,
    model: decision.model,
    account,
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
    nowMs,
    cooldownUntil = new Map(),
    sessionTokensByAccount = {},
    strategy = 'spread',
  } = input;

  let remaining: ProviderId[] = [...input.available];
  const blockedProviders: ProviderId[] = [];

  while (remaining.length > 0) {
    let decision: RouteDecision;
    try {
      decision = route(
        tier,
        remaining,
        policy,
        availableModels,
        authenticatedProviders,
        preferredOrder,
        capabilityContext,
      );
    } catch {
      // route throws when available is empty — treated as no lane below.
      break;
    }

    const provider = decision.provider;
    const managed = managedAccountsForProvider(provider, accounts, opencodeAccounts);

    // Zero managed accounts for this provider → ambient / provider-global path.
    if (managed.length === 0) {
      return { ok: true, lane: decisionToLane(decision, null) };
    }

    // Managed accounts exist: must pair an eligible account with this model.
    if (!isSubscriptionProvider(provider)) {
      // Defensive: managed inventory should only exist for known subscription
      // providers. Treat as ambient if somehow present.
      return { ok: true, lane: decisionToLane(decision, null) };
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
      return { ok: true, lane: decisionToLane(decision, account) };
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
  return {
    ok: false,
    failure: {
      code: 'no_eligible_lane',
      message:
        `No eligible execution lane: managed subscription accounts exist but none ` +
        `are selectable (status auth-failed/unknown/disabled/expired, disabled, ` +
        `cooled without alternate provider, or pool mismatch). Blocked managed ` +
        `providers: ${blockedList}. Refusing ambient global credentials for those ` +
        `providers. Add/repair an eligible account or enable another provider.`,
      blockedProviders,
    },
  };
}
