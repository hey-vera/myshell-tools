/**
 * src/core/research-flag.ts — the single source of truth for whether
 * RESEARCH-UNTIL-CONFIDENT's SECOND-ANGLE web re-research (the brain's `'web'`
 * investigation move; vision-brain §2b / master-plan Phase 3b) is ACTIVE.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the regular `npm test`
 * suite under strip-types. DEFAULT OFF — research-until-confident ships dark and
 * changes ZERO behavior unless the caller explicitly opts IN:
 * `MYSHELL_RESEARCH` ∈ {'1','true','on','yes'} (case-insensitive, trimmed) OR
 * `config.experimentalResearch === true`. This mirrors the rollout shape of the
 * judgment/governor/verify/taste features (opt-in, dark by default).
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns false,
 * `decideNextMove` NEVER emits the `'web'` investigation move, so the brain loop and
 * the policy are BYTE-FOR-BYTE today's behavior. The characterization + oracle +
 * brain suites pass UNCHANGED, which IS the flag-off neutrality proof. Note the REAL
 * Read/Grep retrieval that enriches the always-on codebase round is gated SEPARATELY
 * by the presence of a `researchPort` (absent → static-layout re-check, as today);
 * this flag governs only the EXTERNAL web angle.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_RESEARCH (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the second-angle web re-research is enabled. DEFAULT FALSE. Returns
 * true ONLY when explicitly opted in: `MYSHELL_RESEARCH` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalResearch === true`. Any other
 * value (including absent, '0', 'false', '') → false. Never throws.
 */
export function researchEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalResearch?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_RESEARCH'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalResearch === true) return true;
    return false;
  } catch {
    return false;
  }
}
