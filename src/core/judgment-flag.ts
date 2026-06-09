/**
 * src/core/judgment-flag.ts — the single source of truth for whether THE FREE
 * JUDGMENT LAYER (the `push_back` brain move + the sharpened ask-vs-proceed
 * calibration; .tmp-master-judgment.md Parts 2 & 3, master-plan PHASE 5) is ACTIVE.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the regular
 * `npm test` suite under strip-types. DEFAULT OFF — the judgment layer ships dark
 * and changes ZERO behavior unless the caller explicitly opts IN:
 * `MYSHELL_JUDGMENT` ∈ {'1','true','on','yes'} (case-insensitive, trimmed) OR
 * `config.experimentalJudgment === true`. This mirrors the rollout shape of the
 * governor/verify/taste features (opt-in, dark by default).
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns
 * false, `decideNextMove` returns BYTE-FOR-BYTE today's moves — `push_back` is
 * NEVER offered, and the ask-vs-proceed calibration is UNCHANGED. The existing
 * brain/decideNextMove tests and the characterization + oracle suites pass
 * UNCHANGED, which IS the flag-off neutrality proof. The flag is read once and
 * threaded into the pure policy as a boolean; the policy short-circuits the new
 * `push_back` arm and the calibration sharpening when it is false.
 *
 * When ON, the `push_back` move may fire — but ONLY under its own deliberately
 * narrow grounded-reason gate (a correctness/irreversibility RED FLAG, or a
 * LEARNED-TASTE VIOLATION). With NO grounded reason it stays silent (silence is
 * correct). The flag enables the *capability*; the gate keeps it rare.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_JUDGMENT (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the free judgment layer is enabled. DEFAULT FALSE. Returns true
 * ONLY when explicitly opted in: `MYSHELL_JUDGMENT` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalJudgment === true`. Any other
 * value (including absent, '0', 'false', '') → false. Never throws.
 */
export function judgmentEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalJudgment?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_JUDGMENT'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalJudgment === true) return true;
    return false;
  } catch {
    return false;
  }
}
