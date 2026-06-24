/**
 * src/interface/ui/trust-flag.ts — the single source of truth for whether THE TRUST
 * SURFACE (src/core/trust-receipt.ts — the consolidated, auditable confidence receipt
 * + self-audit) replaces the bare verify-receipt line at the turn's accept point.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types.
 *
 * STABLE — promoted to stable default-on in v9 Phase 7c. The trust surface is ON by
 * default at the interactive entry point (resolved via `experimentalEnabledByDefault`
 * in src/interface/ui/experimental-default.ts) and at the one-shot `run` surface
 * (src/cli.ts). Explicit opt-out: `MYSHELL_TRUST` ∈ {'0','false','off','no'} OR
 * `config.experimentalTrust === false` OR `MYSHELL_BASIC` truthy OR rollback engaged.
 * `experimentalTrust` is a deprecated alias kept for config compatibility; a future
 * major version may rename it.
 *
 * Trust labels are structurally derived from typed verification outcomes
 * (src/core/evidence.ts); the trust surface never fabricates a basis — if a signal
 * did not occur, its line is absent. Trust is only as sound as the verify inputs and
 * prompt-injection boundary (hardened in v9 Phase 7a).
 *
 * THE OFF-GUARANTEE (preserved): when this helper returns false AND
 * `experimentalEnabledByDefault` returns false, the consolidated trust receipt is NOT
 * composed — the accept path emits the SAME verify-receipt notice it does today (one
 * line, when verify ran; nothing otherwise) — BYTE-FOR-BYTE neutrality (the
 * characterization + oracle suites prove that). When ON, the single verify line is
 * UPGRADED into the scannable auditable-confidence + verify + self-audit block —
 * composed PURELY from the real signals already on the turn (no new model call).
 */

import { rollbackEngaged } from '../../core/rollback-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_TRUST (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * The low-level explicit opt-IN predicate for the trust surface. Returns true ONLY
 * when the caller explicitly opts in: `MYSHELL_TRUST` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalTrust === true`. Any other value
 * (including absent, '0', 'false', '') → false. Never throws.
 *
 * NOTE: The default-on behavior for interactive/run surfaces is handled by
 * `experimentalEnabledByDefault` (src/interface/ui/experimental-default.ts), which
 * COMPOSES this helper. Test this helper directly only for the opt-IN truth table.
 */
export function trustEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalTrust?: boolean; rollback?: boolean } | undefined,
): boolean {
  try {
    if (rollbackEngaged(env, config)) return false;
    const raw = env?.['MYSHELL_TRUST'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalTrust === true) return true;
    return false;
  } catch {
    return false;
  }
}
