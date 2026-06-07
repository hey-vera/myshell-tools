/**
 * src/interface/menu-auto-mode.ts — Auto-mode helpers (multi-provider).
 *
 * Extracted from menu.ts — behavior-preserving, pure helpers.
 */

import type { EnvironmentStatus } from '../providers/detect.js';
import {
  modeLabel,
  autoModeForPlanInfos,
  classifyPlan,
  describePlanSet,
  planDisplayLabel,
} from '../core/policy.js';
import type { PlanInfo } from '../core/policy.js';
import type { Mode } from '../core/policy.js';
import { dim } from '../ui/theme.js';

export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
};

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
  return [env.claude, env.codex, env.opencode]
    .filter((p) => p.authenticated)
    .map((p) => ({
      label: PROVIDER_LABEL[p.id] ?? p.id,
      info: classifyPlan(p.plan),
    }));
}

/**
 * Resolve the auto mode across ALL authenticated providers (strongest KIND wins).
 * Classifies each provider's plan then delegates to autoModeForPlanInfos, so
 * Claude, Codex and opencode subscriptions are all included in the decision.
 */
export function resolveAutoMode(env: EnvironmentStatus): Mode {
  return autoModeForPlanInfos(authedProviderPlans(env).map((p) => p.info));
}

export function hasAuthenticatedProvider(env: EnvironmentStatus): boolean {
  return env.claude.authenticated || env.codex.authenticated || env.opencode.authenticated;
}

/**
 * Compact reason for the MAIN status line when auto is active. Summarises only
 * the OBSERVED plans (e.g. "auto · 2 Max, 1 Pro"); when no provider reported a
 * plan it stays clean ("auto") rather than nagging "no plan reported" on every
 * screen — the full per-provider story (including who reported nothing) lives on
 * the mode screen's "Auto detected" breakdown, not here.
 */
export function autoModeReason(env: EnvironmentStatus): string {
  const observed = authedProviderPlans(env)
    .map((p) => p.info)
    .filter((i) => i.confidence === 'observed');
  return observed.length === 0 ? 'auto' : `auto · ${describePlanSet(observed)}`;
}

/**
 * One-line, per-provider honest description of a classified plan for the
 * "Auto detected" breakdown. Shows the reported tier + the raw label when the
 * CLI gave one, or an explicit "no plan reported" when it didn't — never a guess.
 */
function planLineFor(p: ProviderPlanInfo): string {
  if (p.info.confidence === 'none') {
    return `${p.label} — no plan reported`;
  }
  // Sub-tier-aware label: "Max 5x" / "Max 20x" when known, else the plain tier.
  const tierLabel = planDisplayLabel(p.info);
  // Show the raw label alongside the tier when they differ (e.g. label "Max 20x",
  // raw "default_claude_max_20x") so the breakdown is fully traceable.
  const raw = p.info.raw;
  const detail = raw !== null && raw.toLowerCase() !== tierLabel.toLowerCase() ? ` (${raw})` : '';
  return `${p.label} — ${tierLabel}${detail} · observed`;
}

/**
 * Render the "Auto detected" breakdown: every authenticated provider with its
 * classified plan, the resulting mode, and the deciding rule. This is the honest
 * answer to "account for all of them and what kind" — it shows exactly what was
 * detected per provider (including providers that report nothing) and why Auto
 * landed where it did. Returns lines (no trailing newline) for the caller to write.
 */
export function renderAutoDetected(env: EnvironmentStatus, color: boolean): string[] {
  const plans = authedProviderPlans(env);
  const mode = autoModeForPlanInfos(plans.map((p) => p.info));
  const lines: string[] = [dim('  Auto detected:', color)];

  if (plans.length === 0) {
    lines.push(dim('    (no providers signed in)', color));
  } else {
    for (const p of plans) {
      lines.push(dim(`    • ${planLineFor(p)}`, color));
    }
  }

  lines.push(
    dim(`    → ${describePlanSet(plans.map((p) => p.info))} ⇒ ${modeLabel(mode)}`, color),
  );
  return lines;
}
