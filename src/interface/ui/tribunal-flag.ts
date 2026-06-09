/**
 * src/interface/ui/tribunal-flag.ts — the single source of truth for whether THE RIVAL
 * TRIBUNAL (src/core/tribunal.ts — the cross-vendor build-off on a load-bearing
 * implementation fork) is permitted to fire on a turn.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite under
 * strip-types. DEFAULT OFF — the tribunal ships dark and orchestrate's tribunal branch
 * is structurally unreachable (the turn falls straight through to the normal work-call)
 * unless the caller explicitly opts IN: `MYSHELL_TRIBUNAL` ∈ {'1','true','on','yes'}
 * (case-insensitive, trimmed) OR `config.experimentalTribunal === true`. This mirrors
 * the rollout shape of the governor/verify/judgment/trust features (opt-in, dark).
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns false,
 * `deps.tribunalEnabled` is never set, so orchestrate's `deps.tribunalEnabled === true`
 * guard is false and the whole tribunal branch is skipped — the turn delegates to the
 * normal work-call BYTE-FOR-BYTE as today (the characterization + oracle suites prove
 * that neutrality, both running with the flag OFF). When ON AND a buildable fork + ≥2
 * distinct authed vendors + the Governor permits it, the build-off forms; it still
 * degrades honestly (no fabricated rival) whenever any precondition fails at runtime.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_TRIBUNAL (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the Rival Tribunal is enabled. DEFAULT FALSE. Returns true ONLY when
 * explicitly opted in: `MYSHELL_TRIBUNAL` is one of '1'/'true'/'on'/'yes' (trimmed,
 * case-insensitive) OR `config.experimentalTribunal === true`. Any other value
 * (including absent, '0', 'false', '') → false. Never throws.
 */
export function tribunalEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalTribunal?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_TRIBUNAL'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalTribunal === true) return true;
    return false;
  } catch {
    return false;
  }
}
