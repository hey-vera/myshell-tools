/**
 * src/interface/ui/verify-flag.ts — the single source of truth for whether THE
 * VERIFICATION CENTERPIECE (src/core/verify.ts + the verifyStage slot in
 * work-call.ts) runs this turn.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types.
 *
 * STABLE (default-on at the entry points) — verify is ON by default at the
 * interactive entry point (resolved via `experimentalEnabledByDefault` in
 * src/interface/ui/experimental-default.ts) and at the one-shot `run` surface
 * (src/cli.ts). Explicit opt-out: `MYSHELL_VERIFY` ∈ {'0','false','off','no'} OR
 * `config.experimentalVerify === false` OR `MYSHELL_BASIC` truthy OR rollback
 * engaged. `experimentalVerify` is a deprecated alias kept for config compatibility.
 *
 * OPERATIONAL NOTE: verify runs detected project test commands at the turn's accept
 * point (src/infra/verify-port.ts). All commands are routed through the command gate
 * before execution (verify-port.ts:187), which enforces the project's command-safety
 * policy. Default level is 'tests' (tests-first, the free local signal). No test
 * command detected → no test run. This surface stays gated on real-project canary
 * evidence before being declared broadly stable for all project shapes.
 *
 * THE OFF-GUARANTEE: when this returns false AND the resolver also returns false,
 * the verify port is NOT injected onto deps, so verifyStage in work-call.ts is never
 * armed and the accept path stays byte-for-byte unchanged (the characterization +
 * oracle suites prove that neutrality). When ON, the verify stage runs at the turn's
 * accept point: tests-first (free local exec) then, when the Governor's `verify`
 * lever selects it (or the conservative built-in default), ONE diff-scoped
 * cross-vendor critic.
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_VERIFY (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * The low-level explicit opt-IN predicate for the verification centerpiece. Returns
 * true ONLY when the caller explicitly opts in: `MYSHELL_VERIFY` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR `config.experimentalVerify
 * === true`. Any other value (including absent, '0', 'false', '') → false. Never
 * throws.
 *
 * NOTE: The default-on behavior for interactive/run surfaces is handled by
 * `experimentalEnabledByDefault` (src/interface/ui/experimental-default.ts), which
 * COMPOSES this helper. Test this helper directly only for the opt-IN truth table.
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
