/**
 * src/interface/ui/intent-store-flag.ts — pure helper for whether
 * MYSHELL_INTENT_STORE_V1 intent-version persistence is active.
 *
 * Pure (no I/O, no React/Ink), same pattern as every sibling flag. DEFAULT ON.
 * Returns false only for explicit opt-out.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function intentStoreV1Enabled(env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    const raw = env?.['MYSHELL_INTENT_STORE_V1'];
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
