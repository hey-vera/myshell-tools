/**
 * src/interface/ui/level-flag.ts — the single source of truth for whether the
 * 5-LEVEL user-facing dial (src/core/mode-levels.ts: Budget / Balanced / High / Max
 * / Auto over the existing Mode/Policy machinery) is permitted to participate this
 * turn.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — this scaffolding slice changes ZERO
 * behavior unless the caller explicitly opts IN through `MYSHELL_LEVEL_DIAL` ∈
 * {'1','true','on','yes'} (case-insensitive, trimmed) or persisted
 * `config.experimentalLevelDial === true`. Mirrors role-flag.ts / verify-flag.ts.
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns false,
 * menu.ts reads `config.mode` exactly as today and injects NOTHING level-related
 * onto OrchestrateDeps, so every routing path is BYTE-FOR-BYTE today's. The level
 * mapping functions are pure and not consumed by the live route path in this slice;
 * this flag exists so the level substrate wires through the src import graph and so
 * the next slice (live consumption + the level selector UI) has a single gate to
 * flip. Rollback forces it OFF (kill-switch parity with the other canaried flags).
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_LEVEL_DIAL (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the 5-level dial is enabled. DEFAULT FALSE. Returns true ONLY on an
 * explicit opt-IN: `MYSHELL_LEVEL_DIAL` ∈ {'1','true','on','yes'} (trimmed,
 * case-insensitive) OR `config.experimentalLevelDial === true`. Rollback forces it
 * off. Any other value (including absent, '0', 'false', '') → false. Never throws.
 */
export function levelDialEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalLevelDial?: boolean; rollback?: boolean } | undefined,
): boolean {
  try {
    if (rollbackEngaged(env, config)) return false;
    const raw = env?.['MYSHELL_LEVEL_DIAL'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    return config?.experimentalLevelDial === true;
  } catch {
    return false;
  }
}
