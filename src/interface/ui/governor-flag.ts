/**
 * src/interface/ui/governor-flag.ts — the single source of truth for whether THE
 * PERFORMANCE GOVERNOR (src/core/governor.ts) is consulted at the orchestrate
 * admission seam.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types. DEFAULT OFF — the governor ships dark and the orchestrate
 * admission path is BYTE-FOR-BYTE unchanged unless the caller explicitly opts IN:
 * `MYSHELL_GOVERNOR` ∈ {'1','true','on','yes'} (case-insensitive, trimmed) OR
 * `config.experimentalGovernor === true`. This mirrors the rollout shape of the
 * panel/hedge/scheduler features (opt-in, dark by default).
 *
 * THE OFF-GUARANTEE: when this returns false, orchestrate SHORT-CIRCUITS before the
 * governor is consulted (it computes no AllocationPlan and applies none), so the
 * observable behaviour — every emitted CoreEvent, every tier request, every prompt
 * — is identical to today's. The Phase-2 characterization tests (e.g.
 * orchestrate-oracle.test.ts) pass UNCHANGED, which is the flag-off neutrality
 * proof. When ON, the governor is consulted ONCE per turn; in Phase 2 it COORDINATES
 * the existing Oracle tier request through the SAME authorizeTier/admitManager gates
 * — it never bypasses them and never opens a tier the gate would deny.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_GOVERNOR (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the Performance Governor is enabled. DEFAULT FALSE. Returns true
 * ONLY when explicitly opted in: `MYSHELL_GOVERNOR` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalGovernor === true`. Any other
 * value (including absent, '0', 'false', '') → false. Never throws.
 */
export function governorEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalGovernor?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_GOVERNOR'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalGovernor === true) return true;
  return false;
}
