/**
 * src/core/strong-meta-lane.ts — live inventory strong-meta lane selection (R1.2).
 *
 * Menu meta/orchestration used to hard-code dated release-day model IDs.
 * Strong meta now selects provider + model + account via the same atomic lane
 * selector as work-call (R1.1), forced to manager tier against live inventory.
 *
 * Pure: no I/O, no Date.now / Math.random / console / process.exit.
 */

import type { Policy, Tier } from './types.js';
import type { ProviderId } from '../providers/port.js';
import type { CapabilityRegistry, ReasoningEffort } from './model-capabilities.js';
import {
  DECLARATIVE_MODEL_CAPABILITIES,
} from './model-capabilities.js';
import { effortForDecision } from './orchestrate-signals.js';
import { POLICY_PRESETS } from './policy.js';
import {
  selectExecutionLane,
  type ExecutionLaneSelectFailure,
  type SelectExecutionLaneInput,
} from './execution-lane.js';
import type {
  OpencodeSubscriptionAccount,
  SubscriptionAccount,
} from '../infra/subscriptions.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One strong-meta pick: manager-tier lane + optional high effort. */
export interface StrongMetaLane {
  readonly tier: Tier;
  readonly provider: ProviderId;
  readonly model: string;
  readonly account: SubscriptionAccount | null;
  /**
   * High/max-style effort reconciled against the selected model's supported
   * set via existing effort plumbing. Undefined when no capability metadata.
   */
  readonly effort: ReasoningEffort | undefined;
}

export type StrongMetaLaneResult =
  | { readonly ok: true; readonly lane: StrongMetaLane }
  | { readonly ok: false; readonly failure: ExecutionLaneSelectFailure };

export interface SelectStrongMetaLaneInput {
  /** Session-available provider ids (typically keys of ctx.providers). */
  readonly available: readonly ProviderId[];
  readonly availableModels?: Partial<Record<ProviderId, readonly string[]>>;
  readonly authenticatedProviders?: readonly ProviderId[];
  /**
   * Base policy. maxTier is forced to `manager` so meta always requests a
   * manager-class model (orchestrate-style admission, not a dated table).
   */
  readonly policy?: Policy;
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly accounts?: readonly SubscriptionAccount[];
  readonly opencodeAccounts?: readonly OpencodeSubscriptionAccount[];
  readonly nowMs: number;
  readonly cooldownUntil?: ReadonlyMap<string, number>;
  readonly sessionTokensByAccount?: Readonly<Record<string, number>>;
  readonly strategy?: 'sticky' | 'spread';
  readonly preferredOrder?: readonly ProviderId[];
}

// ---------------------------------------------------------------------------
// Selector
// ---------------------------------------------------------------------------

/**
 * Select a strong-meta execution lane from live inventory + managed accounts.
 *
 * - Model comes from `route` / `selectExecutionLane` against availableModels
 *   (never a hard-coded release-day id).
 * - When managed accounts exist for the chosen provider, pairs an eligible
 *   account; refuses ambient fallthrough if none are eligible (R1.1 rules).
 * - Effort prefers quality-first / manager / high-risk via {@link effortForDecision}.
 */
export function selectStrongMetaLane(
  input: SelectStrongMetaLaneInput,
): StrongMetaLaneResult {
  if (input.available.length === 0) {
    return {
      ok: false,
      failure: {
        code: 'no_eligible_lane',
        message:
          'No eligible strong-meta lane: no available providers in session.',
        blockedProviders: [],
      },
    };
  }

  const basePolicy = input.policy ?? POLICY_PRESETS['quality-first'];
  // Strong meta always wants manager-class models; lift the ceiling the same
  // way work-call does for an admitted manager pass.
  const policy: Policy = { ...basePolicy, maxTier: 'manager' };

  const laneInput: SelectExecutionLaneInput = {
    tier: 'manager',
    available: input.available,
    policy,
    nowMs: input.nowMs,
    strategy: input.strategy ?? 'sticky',
    ...(input.availableModels !== undefined
      ? { availableModels: input.availableModels }
      : {}),
    ...(input.authenticatedProviders !== undefined
      ? { authenticatedProviders: input.authenticatedProviders }
      : {}),
    ...(input.preferredOrder !== undefined
      ? { preferredOrder: input.preferredOrder }
      : {}),
    ...(input.accounts !== undefined ? { accounts: input.accounts } : {}),
    ...(input.opencodeAccounts !== undefined
      ? { opencodeAccounts: input.opencodeAccounts }
      : {}),
    ...(input.cooldownUntil !== undefined
      ? { cooldownUntil: input.cooldownUntil }
      : {}),
    ...(input.sessionTokensByAccount !== undefined
      ? { sessionTokensByAccount: input.sessionTokensByAccount }
      : {}),
  };

  const laneResult = selectExecutionLane(laneInput);
  if (!laneResult.ok) {
    return laneResult;
  }

  // Prefer live/merged registry; fall back to declarative floor so Claude-style
  // effort flags still resolve without inventing model ids.
  const registry =
    input.capabilityRegistry ?? DECLARATIVE_MODEL_CAPABILITIES;

  // High/max-style meta: quality-first + manager + high risk + architecture
  // maps to the deepest supported effort the model admits (never forces an
  // unsupported knob; empty supported → undefined).
  const effort = effortForDecision(
    registry,
    laneResult.lane.provider,
    laneResult.lane.model,
    'manager',
    'quality-first',
    { risk: 'high', routePlan: false, taskKind: 'architecture' },
  );

  return {
    ok: true,
    lane: {
      tier: laneResult.lane.tier,
      provider: laneResult.lane.provider,
      model: laneResult.lane.model,
      account: laneResult.lane.account,
      effort,
    },
  };
}
