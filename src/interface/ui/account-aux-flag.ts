/**
 * src/interface/ui/account-aux-flag.ts — pure helper for whether
 * MYSHELL_ACCOUNT_AUX auxiliary-model ledger accounting is active.
 *
 * Pure (no I/O, no React/Ink), same pattern as every sibling flag. DEFAULT ON.
 * Returns false only for explicit opt-out.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function accountAuxEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    const raw = env?.['MYSHELL_ACCOUNT_AUX'];
    if (typeof raw === 'string') {
      const cleaned = raw.trim().toLowerCase();
      if (ON.has(cleaned)) return true;
      if (OFF.has(cleaned)) return false;
    }
    return true;
  } catch {
    return true;
  }
}
