/**
 * src/core/taste-flag.ts — the single source of truth for whether the LEARNED
 * TASTE LEDGER (the Phase-7 free layer: src/infra/taste-ledger.ts +
 * src/core/taste.ts) is ACTIVE.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the regular
 * `npm test` suite under strip-types. DEFAULT OFF — the taste ledger ships dark
 * and changes ZERO behavior unless the caller explicitly opts IN:
 * `MYSHELL_TASTE` ∈ {'1','true','on','yes'} (case-insensitive, trimmed) OR
 * `config.experimentalTaste === true`. This mirrors the rollout shape of the
 * decompose/scheduler features (opt-in, dark by default): the ledger learns the
 * user's actual decisions only AFTER an adversarial pass flips the flag.
 *
 * When the flag is OFF:
 *   - recall (taste playbook + memoryBias) returns the empty/neutral result, so
 *     NOTHING is injected into any prompt and the ask-vs-proceed dial is unmoved;
 *   - recording is inert at the wiring layer (the caller checks this flag before
 *     it ever calls record), so the ledger file is never even created.
 * OFF therefore means byte-for-byte the pre-taste path.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_TASTE (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the learned-taste ledger is enabled. DEFAULT FALSE. Returns true
 * ONLY when explicitly opted in: `MYSHELL_TASTE` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalTaste === true`. Any other
 * value (including absent, '0', 'false', '') → false. Never throws.
 */
export function tasteEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalTaste?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_TASTE'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalTaste === true) return true;
    return false;
  } catch {
    return false;
  }
}
