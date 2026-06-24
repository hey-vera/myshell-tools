/**
 * src/interface/ui/role-flag.ts — the single source of truth for whether the
 * LOGICAL ROLE ABSTRACTION (src/core/roles.ts: chat / ghost / execution resolution
 * + the mode→rung/effort mapping) is permitted to participate this turn.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — this scaffolding slice changes ZERO
 * behavior unless the caller explicitly opts IN through `MYSHELL_ROLES` ∈
 * {'1','true','on','yes'} (case-insensitive, trimmed) or persisted
 * `config.experimentalRoles === true`. Mirrors verify-flag.ts / governor-flag.ts.
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns false,
 * menu.ts injects NOTHING onto OrchestrateDeps for roles (the `roleMapping` field is
 * absent), so `orchestrate` never reads role data and every path is BYTE-FOR-BYTE
 * today's. The role functions are not consumed by the live path in this slice at
 * all; this flag exists so the role substrate wires through the src import graph
 * and so the next slice (live consumption) has a single gate to flip.
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_ROLES (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the role abstraction is enabled. DEFAULT FALSE. Returns true ONLY
 * on an explicit opt-IN: `MYSHELL_ROLES` ∈ {'1','true','on','yes'} (trimmed,
 * case-insensitive) OR `config.experimentalRoles === true`. Rollback forces it off
 * (kill-switch parity with the other canaried flags). Any other value (including
 * absent, '0', 'false', '') → false. Never throws.
 */
export function roleMappingEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalRoles?: boolean; rollback?: boolean } | undefined,
): boolean {
  try {
    if (rollbackEngaged(env, config)) return false;
    const raw = env?.['MYSHELL_ROLES'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    return config?.experimentalRoles === true;
  } catch {
    return false;
  }
}
