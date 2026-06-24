/**
 * src/core/judgment-flag.ts — the single source of truth for whether THE FREE
 * JUDGMENT LAYER (the `push_back` brain move + the sharpened ask-vs-proceed
 * calibration; .tmp-master-judgment.md Parts 2 & 3, master-plan PHASE 5) is ACTIVE.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the regular
 * `npm test` suite under strip-types.
 *
 * STABLE — promoted to stable default-on in v9 Phase 7c. The judgment layer is ON
 * by default at the interactive entry point (resolved via
 * `experimentalEnabledByDefault` in src/interface/ui/experimental-default.ts) and
 * at the one-shot `run` surface (src/cli.ts). Explicit opt-out:
 * `MYSHELL_JUDGMENT` ∈ {'0','false','off','no'} (case-insensitive, trimmed) OR
 * `config.experimentalJudgment === false` OR `MYSHELL_BASIC` truthy OR rollback
 * engaged. `experimentalJudgment` is a deprecated alias kept for config
 * compatibility; a future major version may rename it.
 *
 * This helper returns true ONLY when the caller explicitly opts IN via the env/config
 * values below. It is the low-level opt-IN predicate consumed by
 * `experimentalEnabledByDefault`; the default-on behavior lives in that resolver, not
 * here. The OFF-GUARANTEE is preserved: when this helper returns false AND
 * `experimentalEnabledByDefault` returns false, `decideNextMove` returns
 * BYTE-FOR-BYTE today's moves — `push_back` is NEVER offered and the ask-vs-proceed
 * calibration is UNCHANGED.
 *
 * When ON, the `push_back` move may fire — but ONLY under its own deliberately
 * narrow grounded-reason gate (a correctness/irreversibility RED FLAG, or a
 * LEARNED-TASTE VIOLATION). With NO grounded reason it stays silent (silence is
 * correct). The flag enables the *capability*; the gate keeps it rare.
 */

import { rollbackEngaged } from './rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_JUDGMENT (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * The low-level explicit opt-IN predicate for the free judgment layer. Returns true
 * ONLY when the caller explicitly opts in: `MYSHELL_JUDGMENT` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR
 * `config.experimentalJudgment === true`. Any other value (including absent, '0',
 * 'false', '') → false. Never throws.
 *
 * NOTE: The default-on behavior for interactive/run surfaces is handled by
 * `experimentalEnabledByDefault` (src/interface/ui/experimental-default.ts), which
 * COMPOSES this helper. Test this helper directly only for the opt-IN truth table;
 * test the resolver for the default-on + opt-out + rollback + basic-mode table.
 */
export function judgmentEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalJudgment?: boolean; rollback?: boolean } | undefined,
): boolean {
  try {
    if (rollbackEngaged(env, config)) return false;
    const raw = env?.['MYSHELL_JUDGMENT'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalJudgment === true) return true;
    return false;
  } catch {
    return false;
  }
}
