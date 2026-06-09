/**
 * src/interface/ui/trust-flag.ts — the single source of truth for whether THE TRUST
 * SURFACE (src/core/trust-receipt.ts — the consolidated, auditable confidence receipt
 * + self-audit) replaces the bare verify-receipt line at the turn's accept point.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types. DEFAULT OFF — the trust surface ships dark and the work-call
 * accept path emits EXACTLY today's line(s) unless the caller explicitly opts IN:
 * `MYSHELL_TRUST` ∈ {'1','true','on','yes'} (case-insensitive, trimmed) OR
 * `config.experimentalTrust === true`. This mirrors the rollout shape of the
 * governor/verify/judgment features (opt-in, dark by default).
 *
 * THE OFF-GUARANTEE (the load-bearing neutrality contract): when this returns false,
 * the consolidated trust receipt is NOT composed — the accept path emits the SAME
 * verify-receipt notice it does today (one line, when MYSHELL_VERIFY is on; nothing
 * when it is off). With ALL flags off, no verify outcome exists, so the trust surface
 * is doubly dark and the accept path is BYTE-FOR-BYTE today's (the characterization +
 * oracle suites prove that neutrality). When ON, the single verify line is UPGRADED
 * into the scannable auditable-confidence + verify + self-audit block — composed
 * PURELY from the real signals already on the turn (no new model call), and still
 * only surfacing signals that genuinely occurred.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_TRUST (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the trust surface is enabled. DEFAULT FALSE. Returns true ONLY when
 * explicitly opted in: `MYSHELL_TRUST` is one of '1'/'true'/'on'/'yes' (trimmed,
 * case-insensitive) OR `config.experimentalTrust === true`. Any other value
 * (including absent, '0', 'false', '') → false. Never throws.
 */
export function trustEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalTrust?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_TRUST'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalTrust === true) return true;
    return false;
  } catch {
    return false;
  }
}
