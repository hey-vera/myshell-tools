/**
 * src/core/taste-flag.ts — the single source of truth for whether the LEARNED
 * TASTE LEDGER (the Phase-7 free layer: src/infra/taste-ledger.ts +
 * src/core/taste.ts) is ACTIVE.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the regular
 * `npm test` suite under strip-types. DEFAULT ON for max intelligence — the
 * ledger is a pure, free, observed-only preference layer (no tokens, no cost,
 * no fabrication). It records the user's actual past decisions (fork choices,
 * immediate edits/rephrases, accept/reject push-backs) and distills them into
 * a prompt block + ask-vs-proceed bias so the partner reasons *with* the user's
 * demonstrated taste instead of guessing.
 *
 * Opt OUT explicitly: `MYSHELL_TASTE` ∈ {'0','false','off','no'} (case-insensitive)
 * OR `config.experimentalTaste === false`. This keeps the "explicit off" escape
 * hatch while making the intelligent default the "batter".
 *
 * When OFF: recall returns empty/neutral (no injection, no bias), recording is
 * inert. Byte-identical to pre-taste.
 *
 * Quota note: we deliberately do *not* synthesize "remaining quota" numbers
 * (flat-rate subs don't expose reliable real-time headroom via CLIs, and
 * fabricating estimates for "quota-aware planning" would be dishonest and
 * brittle). Preference + observed outcomes (this + routing-memory + capacity
 * from real plan tiers) is the realistic, intelligent path.
 */

/** Env values treated as explicit opt-OUT for MYSHELL_TASTE (case-insensitive). */
const OFF = new Set(['0', 'false', 'off', 'no', '']);

/**
 * Decide whether the learned-taste ledger is enabled. DEFAULT TRUE (max intel).
 * Returns false ONLY on explicit opt-out. Never throws.
 */
export function tasteEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalTaste?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_TASTE'];
    if (typeof raw === 'string' && OFF.has(raw.trim().toLowerCase())) return false;
    if (config?.experimentalTaste === false) return false;
    return true;
  } catch {
    return true; // default on even on error
  }
}
