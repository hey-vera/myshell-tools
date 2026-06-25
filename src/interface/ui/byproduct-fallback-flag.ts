/**
 * src/interface/ui/byproduct-fallback-flag.ts — the single source of truth for
 * whether the CAPABILITY PARSE-FROM-TEXT FALLBACK (src/core/byproduct-parse.ts)
 * is permitted to activate when the primary structured parse returns nothing.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm
 * test` suite under strip-types. DEFAULT OFF — this scaffolding slice changes
 * ZERO behavior unless the caller explicitly opts IN through
 * `MYSHELL_BYPRODUCT_FALLBACK` ∈ {'1','true','on','yes'} (case-insensitive,
 * trimmed) or persisted `config.experimentalByproductFallback === true`.
 * Mirrors role-flag.ts / level-flag.ts.
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns
 * false, the intent-extractor path in intent-extractor.ts falls straight from
 * `parseIntentFrame` to the existing `rulesIntentFrame` deterministic fallback
 * — byte-for-byte today's behavior.  The fallback parse functions are pure and
 * never called on the success path regardless of this flag.  This flag controls
 * ONLY whether the text-fallback is tried on a primary-parse failure, and then
 * only as an additional attempt before rulesIntentFrame.
 *
 * Rollback forces it OFF (kill-switch parity with the other canaried flags).
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_BYPRODUCT_FALLBACK. */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the capability parse-from-text fallback is enabled.
 * DEFAULT FALSE. Returns true ONLY on an explicit opt-IN:
 * `MYSHELL_BYPRODUCT_FALLBACK` ∈ {'1','true','on','yes'} (trimmed,
 * case-insensitive) OR `config.experimentalByproductFallback === true`.
 * Rollback forces it off. Any other value (including absent, '0', 'false', '')
 * → false. Never throws.
 */
export function byproductFallbackEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalByproductFallback?: boolean; rollback?: boolean } | undefined,
): boolean {
  try {
    if (rollbackEngaged(env, config)) return false;
    const raw = env?.['MYSHELL_BYPRODUCT_FALLBACK'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    return config?.experimentalByproductFallback === true;
  } catch {
    return false;
  }
}
