/**
 * src/interface/ui/auto-brain-flag.ts — the single source of truth for whether
 * the AUTO BRAIN (src/core/auto-brain.ts — per-turn rung-fusion + objective-
 * evidence escalation) is permitted to participate this turn.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR
 * `npm test` suite under strip-types. Default-false for neutrality tests;
 * production menu composes it default-on via `experimentalEnabledByDefault`.
 * Explicit opt-IN via `MYSHELL_AUTO_BRAIN` ∈ {'1','true','on','yes'}
 * (case-insensitive, trimmed) or persisted `config.experimentalAutoBrain === true`
 * also enables it. Mirrors level-flag.ts / verify-flag.ts. Rollback forces it OFF
 * (kill-switch parity).
 *
 * THE OFF-GUARANTEE (load-bearing neutrality contract): when this returns false,
 * menu.ts injects NOTHING auto-brain-related onto OrchestrateDeps (the
 * `autoBrainRungTuple` field is absent), so `orchestrate` never reads any
 * auto-brain output and every routing path is BYTE-FOR-BYTE today's. The
 * rung-fusion and escalation functions are pure and not consumed by the live
 * route path when this flag is off; this flag exists so the auto-brain substrate
 * wires through the src import graph and so the live-consumption slice has a
 * single gate to flip.
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_AUTO_BRAIN (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Pure helper: decide whether the Auto Brain is enabled. DEFAULT FALSE for
 * neutrality tests; production menu composes it default-on via
 * `experimentalEnabledByDefault`. Returns true on an explicit opt-IN:
 * `MYSHELL_AUTO_BRAIN` ∈ {'1','true','on','yes'} (trimmed, case-insensitive)
 * OR `config.experimentalAutoBrain === true`. Rollback forces it off. Any
 * other value (including absent, '0', 'false', '') → false. Never throws.
 */
export function autoBrainEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalAutoBrain?: boolean; rollback?: boolean } | undefined,
): boolean {
  try {
    if (rollbackEngaged(env, config)) return false;
    const raw = env?.['MYSHELL_AUTO_BRAIN'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    return config?.experimentalAutoBrain === true;
  } catch {
    return false;
  }
}
