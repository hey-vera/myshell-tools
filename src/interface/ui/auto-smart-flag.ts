/**
 * src/interface/ui/auto-smart-flag.ts — the single source of truth for whether
 * the AUTO SMART DEFAULT (Redesign Slice C) is enabled.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — Auto resolves to a fixed preset via
 * plan detection exactly as today. When ON, absent config.mode becomes a
 * standalone smart default with a neutral balanced base policy and per-turn
 * governor/capacity-allocator scaling.
 *
 * THE OFF-GUARANTEE: when this returns false, the effective mode for an absent
 * config.mode is computed via `resolveAutoMode` → `autoModeForPlanInfos` as
 * today — every budget, policy, and display is byte-for-byte unchanged.
 * Enable: `MYSHELL_AUTO_SMART` ∈ {'1','true','on','yes'} (case-insensitive,
 * trimmed) OR `config.experimentalAutoSmart === true`.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_AUTO_SMART (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the Auto Smart Default is enabled. DEFAULT FALSE. Returns true
 * ONLY when explicitly opted in: `MYSHELL_AUTO_SMART` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalAutoSmart === true`. Any other
 * value (including absent, '0', 'false', '') → false. Never throws.
 */
export function autoSmartEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalAutoSmart?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_AUTO_SMART'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalAutoSmart === true) return true;
  return false;
}
