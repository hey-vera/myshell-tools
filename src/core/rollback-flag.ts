/**
 * src/core/rollback-flag.ts — the single source of truth for whether the unified
 * rollback kill-switch is ENGAGED.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the regular `npm test`
 * suite under strip-types. DEFAULT OFF — rollback changes ZERO behavior unless the
 * caller explicitly opts IN through `MYSHELL_ROLLBACK` ∈
 * {'1','true','on','yes'} (case-insensitive, trimmed) or persisted
 * `config.rollback === true`.
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
 * The emergency environment form is checked first, then persisted config. Any
 * other value (including absent, '0', 'false', '') is inert. Never throws.
 */
export function rollbackEngaged(
  env?: Record<string, string | undefined>,
  config?: { rollback?: boolean },
): boolean {
  try {
    const raw = env?.['MYSHELL_ROLLBACK'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    return config?.rollback === true;
  } catch {
    return config?.rollback === true;
  }
}
