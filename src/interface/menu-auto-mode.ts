/**
 * src/interface/menu-auto-mode.ts — Auto-mode helpers (multi-provider).
 *
 * Extracted from menu.ts — behavior-preserving, pure helpers.
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
 * The honest unit the Auto decision and the "Auto detected" screen share.
 */
interface ProviderPlanInfo {
  readonly label: string;
  readonly info: PlanInfo;
}

/**
 * Classify the plan of every AUTHENTICATED provider. Providers that are signed
 * out are excluded (they contribute no signal). The result preserves duplicates
 * (multiple Max plans show up as multiple entries) — that is what lets the Auto
 * decision and its reason account for "all of them, and what kind".
 */
function authedProviderPlans(env: EnvironmentStatus): ProviderPlanInfo[] {
  return [env.claude, env.codex, env.opencode, env.grok]
    .filter((p) => p.authenticated)
    .map((p) => ({
      label: PROVIDER_LABEL[p.id] ?? p.id,
      info: classifyPlan(p.plan),
    }));
}

export function subscriptionInventoryFromEnvironment(env: EnvironmentStatus): CapacityWeight[] {
  return [env.claude, env.codex, env.opencode, env.grok]
    .filter((p) => p.authenticated)
    .map((p) => classifyCapacity(p.id, p.plan));
}

/**
 * Resolve the auto mode across ALL authenticated providers (strongest KIND wins).
 * Classifies each provider's plan then delegates to autoModeForPlanInfos, so
 * Claude, Codex and opencode subscriptions are all included in the decision.
 */
export function resolveAutoMode(env: EnvironmentStatus): Mode {
  return autoModeForPlanInfos(authedProviderPlans(env).map((p) => p.info));
}

/**
 * The per-turn budget ceiling implied by the user's subscription plans.
 * Maps plan-derived mode to a budget number the governor can use as a CAP
 * when Auto Smart is on (Redesign Slice C): Max → 3, Pro/none → 2, Free → 1.
 * Used only as a ceiling — the governor's base budget still comes from the
 * neutral balanced policy.
 */
export function planBudgetCeiling(env: EnvironmentStatus): number {
  const autoMode = resolveAutoMode(env);
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
 * Compact reason for the MAIN status line when auto is active. Summarises only
 * the OBSERVED plans (e.g. "auto · 2 Max, 1 Pro"); when no provider reported a
 * plan it stays clean ("auto") rather than nagging "no plan reported" on every
 * screen — the full per-provider story (including who reported nothing) lives on
 * the mode screen's "Auto detected" breakdown, not here.
 *
 * When `autoSmart` is true (Redesign Slice C), the suffix describes per-turn
 * scaling instead of pinning to a plan-derived posture — the plan raises the
 * ceiling but doesn't define what Auto "is."
 */
export function autoModeReason(env: EnvironmentStatus, autoSmart = false): string {
  const infos = authedProviderPlans(env).map((p) => p.info);
  const observed = infos.filter((i) => i.confidence === 'observed');
  if (autoSmart) {
    const planPart = observed.length === 0 ? 'auto' : `auto · ${describePlanSet(observed)}`;
    return `${planPart} — per-turn effort from task + risk + provider headroom`;
  }
  const posture = autoPostureForMode(autoModeForPlanInfos(infos));
  const planPart = observed.length === 0 ? 'auto' : `auto · ${describePlanSet(observed)}`;
  return `${planPart} → ${posture}`;
}


