/**
 * src/interface/ui/verify-flag.ts — the single source of truth for whether THE
 * VERIFICATION CENTERPIECE (src/core/verify.ts + the verifyStage slot in
 * work-call.ts) runs this turn.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types. DEFAULT OFF — verification ships dark and the work-call accept
 * path is BYTE-FOR-BYTE unchanged unless the caller explicitly opts IN:
 * `MYSHELL_VERIFY` ∈ {'1','true','on','yes'} (case-insensitive, trimmed) OR
 * `config.experimentalVerify === true`. This mirrors the rollout shape of the
 * governor/panel/hedge/scheduler features (opt-in, dark by default).
 *
 * THE OFF-GUARANTEE: when this returns false, the verify port is NOT injected onto
 * deps, so verifyStage in work-call.ts is never armed and the accept path stays the
 * byte-for-byte no-op it is today (the Phase-1 characterization + oracle suites pass
 * UNCHANGED — the flag-off neutrality proof). When ON, the verify stage runs at the
 * turn's accept point: tests-first (free local exec) then, when the Governor's
 * `verify` lever selects it (or a conservative built-in default), ONE diff-scoped
 * cross-vendor critic.
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_VERIFY (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the verification centerpiece is enabled. DEFAULT FALSE. Returns
 * true ONLY when explicitly opted in: `MYSHELL_VERIFY` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR `config.experimentalVerify
 * === true`. Any other value (including absent, '0', 'false', '') → false. Never
 * throws.
 */
export function verifyEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalVerify?: boolean; rollback?: boolean } | undefined,
): boolean {
  if (rollbackEngaged(env, config)) return false;
  const raw = env?.['MYSHELL_VERIFY'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalVerify === true) return true;
  return false;
}
