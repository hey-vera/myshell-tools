/**
 * src/interface/ui/correction-fork-flag.ts — pure helper for whether
 * MYSHELL_CORRECTION_FORK_V1 correction-fork branching is active.
 *
 * Pure (no I/O, no React/Ink), same pattern as every sibling flag. DEFAULT OFF.
 * Returns true only for explicit opt-IN. Requires MYSHELL_INTENT_STORE_V1 to also
 * be on at the call site; this helper only checks its own flag.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function correctionForkV1Enabled(env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    const raw = env?.['MYSHELL_CORRECTION_FORK_V1'];
    if (typeof raw === 'string') {
      const cleaned = raw.trim().toLowerCase();
      if (ON.has(cleaned)) return true;
      if (OFF.has(cleaned)) return false;
    }
    return false;
  } catch {
    return false;
  }
}
