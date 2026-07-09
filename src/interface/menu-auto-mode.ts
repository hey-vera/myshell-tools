/**
 * src/interface/menu-auto-mode.ts — Auto-mode helpers (multi-provider).
 *
 * Product truth (P1.2): Auto defaults come from the **Accounts inventory**
 * (myshell-managed subscriptions.json), not ambient host CLI detection.
 * Ambient detect stays for install/doctor; home/mode never markets "Pro
 * observed" for accounts the user never added to myshell-tools.
 */

import type { EnvironmentStatus } from '../providers/detect.js';
import {
  classifyCapacity,
  legacyModeToIntensity,
  type CapacityWeight,
  type Intensity,
} from '../core/capacity-allocator.js';
import {
  autoModeForPlanInfos,
  classifyPlan,
  describePlanSet,
} from '../core/policy.js';
import type { PlanInfo } from '../core/policy.js';
import type { Mode } from '../core/policy.js';
import { autoPostureForMode } from '../core/governor.js';
import type { AppConfig } from '../infra/config.js';
import type { ConversationMeta } from '../infra/conversation-store.js';
import type { SubscriptionAccount } from '../infra/subscriptions.js';

export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
};

export type ResolvedIntensity =
  | { readonly source: 'conversation'; readonly value: 1 | 2 | 3 | 4 | 5 }
  | { readonly source: 'global'; readonly value: 1 | 2 | 3 | 4 | 5 }
  | { readonly source: 'legacy'; readonly value: 1 | 2 | 3 | 4 | 5 }
  | { readonly source: 'auto'; readonly value: 'auto' };

function isNumericIntensity(value: Intensity | undefined): value is 1 | 2 | 3 | 4 | 5 {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5;
}

export function resolveIntensity(
  meta: Pick<ConversationMeta, 'intensity'> | undefined,
  config: AppConfig,
): ResolvedIntensity {
  if (isNumericIntensity(meta?.intensity)) {
    return { source: 'conversation', value: meta.intensity };
  }
  if (isNumericIntensity(config.intensity)) {
    return { source: 'global', value: config.intensity };
  }
  if (config.mode !== undefined || config.panel === true || config.hedge === true) {
    return {
      source: 'legacy',
      value: legacyModeToIntensity(config.mode ?? 'balanced', {
        ...(config.panel === true ? { panel: true } : {}),
        ...(config.hedge === true ? { hedge: true } : {}),
      }),
    };
  }
  return { source: 'auto', value: 'auto' };
}

/**
 * One authenticated provider's classified plan, paired with its display label.
 * Used only by ambient (doctor/internal) helpers — not product Auto defaults.
 */
interface ProviderPlanInfo {
  readonly label: string;
  readonly info: PlanInfo;
}

/**
 * Classify the plan of every AUTHENTICATED ambient provider. Providers that are
 * signed out are excluded. Kept for doctor/install-style internal detect and
 * unit tests of ambient classification — not for home/mode Auto marketing.
 */
function authedProviderPlans(env: EnvironmentStatus): ProviderPlanInfo[] {
  return [env.claude, env.codex, env.opencode, env.grok]
    .filter((p) => p.authenticated)
    .map((p) => ({
      label: PROVIDER_LABEL[p.id] ?? p.id,
      info: classifyPlan(p.plan),
    }));
}

/**
 * Accounts that contribute to Auto posture: enabled, not disabled priority,
 * and not in a terminal bad status. Expired/auth-failed/disabled do not raise
 * Auto to Max/Pro theater.
 */
export function usableAccountsForAuto(
  accounts: readonly SubscriptionAccount[],
): readonly SubscriptionAccount[] {
  return accounts.filter((a) => {
    if (!a.enabled) return false;
    if (a.priority === 'disabled') return false;
    const status = a.status;
    if (status === 'disabled' || status === 'expired' || status === 'auth-failed') {
      return false;
    }
    return true;
  });
}

/** Classified plans from usable Accounts inventory (product Auto truth). */
export function planInfosFromAccounts(
  accounts: readonly SubscriptionAccount[],
): PlanInfo[] {
  return usableAccountsForAuto(accounts).map((a) => classifyPlan(a.plan ?? null));
}

/**
 * Auto mode from Accounts inventory alone.
 * Empty inventory / no observed plans → balanced (honest, no ambient theater).
 */
export function resolveAutoModeFromAccounts(
  accounts: readonly SubscriptionAccount[],
): Mode {
  return autoModeForPlanInfos(planInfosFromAccounts(accounts));
}

/**
 * Ambient CLI plan → mode. Doctor/internal only — not home/mode marketing.
 * Prefer {@link resolveAutoModeFromAccounts} for product Auto defaults.
 */
export function resolveAutoModeFromEnvironment(env: EnvironmentStatus): Mode {
  return autoModeForPlanInfos(authedProviderPlans(env).map((p) => p.info));
}

/**
 * Capacity inventory from ambient env (routing weights). Unchanged from the
 * pre-P1.2 path; capacity rebalancing still reads live detect for providers
 * that are signed in at the host. Auto *posture* uses Accounts instead.
 */
export function subscriptionInventoryFromEnvironment(env: EnvironmentStatus): CapacityWeight[] {
  return [env.claude, env.codex, env.opencode, env.grok]
    .filter((p) => p.authenticated)
    .map((p) => classifyCapacity(p.id, p.plan));
}

/**
 * Resolve the product Auto mode.
 *
 * When `accounts` is provided (including empty), Accounts inventory is sole
 * truth — empty → balanced, never ambient "Pro observed" theater.
 * When omitted, returns balanced (honest default); pass accounts at every
 * user-facing call site that has loaded the store.
 */
export function resolveAutoMode(
  env: EnvironmentStatus,
  accounts?: readonly SubscriptionAccount[],
): Mode {
  if (accounts !== undefined) {
    return resolveAutoModeFromAccounts(accounts);
  }
  // No inventory argument: do not market ambient CLI plans as Auto posture.
  void env;
  return 'balanced';
}

/**
 * The per-turn budget ceiling implied by Accounts plan inventory.
 * Maps plan-derived mode to a budget number the governor can use as a CAP
 * when Auto Smart is on: Max → 3, Pro/none → 2, Free → 1.
 * Used only as a ceiling — the governor's base budget still comes from the
 * neutral balanced policy.
 */
export function planBudgetCeiling(
  env: EnvironmentStatus,
  accounts?: readonly SubscriptionAccount[],
): number {
  const autoMode = resolveAutoMode(env, accounts);
  switch (autoMode) {
    case 'quality-first':
      return 3;
    case 'cost-saver':
      return 1;
    case 'balanced':
    default:
      return 2;
  }
}

export function hasAuthenticatedProvider(env: EnvironmentStatus): boolean {
  return env.claude.authenticated || env.codex.authenticated || env.opencode.authenticated || env.grok.authenticated;
}

/**
 * Compact reason for Auto status when a caller still needs a plan summary.
 * Summarises only Accounts inventory when provided; empty inventory → clean
 * "auto" without ambient Pro/Max marketing. When autoSmart is true, the
 * suffix describes per-turn scaling instead of a pinned posture.
 */
export function autoModeReason(
  env: EnvironmentStatus,
  autoSmart = false,
  accounts?: readonly SubscriptionAccount[],
): string {
  // Accounts-only observed plans; ambient env is never used for this string.
  void env;
  const infos =
    accounts !== undefined ? planInfosFromAccounts(accounts) : ([] as PlanInfo[]);
  const observed = infos.filter((i) => i.confidence === 'observed');
  if (autoSmart) {
    const planPart = observed.length === 0 ? 'auto' : `auto · ${describePlanSet(observed)}`;
    return `${planPart} — per-turn effort from task + risk + provider headroom`;
  }
  const posture = autoPostureForMode(autoModeForPlanInfos(infos));
  const planPart = observed.length === 0 ? 'auto' : `auto · ${describePlanSet(observed)}`;
  return `${planPart} → ${posture}`;
}

/** Raw plan strings from usable accounts (for tunePolicyForMaxSubTier, etc.). */
export function accountPlanStrings(
  accounts: readonly SubscriptionAccount[],
): Array<string | null> {
  return usableAccountsForAuto(accounts).map((a) => a.plan ?? null);
}
