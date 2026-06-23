/**
 * src/core/rollback-flag.ts — the single source of truth for whether the unified
 * rollback kill-switch is ENGAGED.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the regular `npm test`
 * suite under strip-types. DEFAULT OFF — rollback changes ZERO behavior unless the
 * caller explicitly opts IN:
 * `MYSHELL_ROLLBACK` ∈ {'1','true','on','yes'} (case-insensitive, trimmed). This
 * mirrors the rollout shape of the judgment/governor/verify/taste features (opt-in,
 * dark by default).
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns false,
 * canaried experimental flags keep their own existing opt-in behavior unchanged.
 * When true, callers use it as a single kill-switch that forces those features off
 * regardless of their individual env/config flags.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_ROLLBACK (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the unified rollback kill-switch is engaged. DEFAULT FALSE.
 * Returns true ONLY when explicitly opted in: `MYSHELL_ROLLBACK` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive). Any other value (including
 * absent, '0', 'false', '') → false. Never throws.
 */
export function rollbackEngaged(env?: Record<string, string | undefined>): boolean {
  try {
    const raw = env?.['MYSHELL_ROLLBACK'];
    return typeof raw === 'string' && ON.has(raw.trim().toLowerCase());
  } catch {
    return false;
  }
}
