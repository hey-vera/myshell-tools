/**
 * src/interface/ui/evidence-receipt-flag.ts — pure helper for whether
 * MYSHELL_EVIDENCE_RECEIPT_V2 evidence receipt is active.
 *
 * Pure (no I/O, no React/Ink), same pattern as every sibling flag. DEFAULT OFF.
 * Returns true only for explicit opt-IN.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function evidenceReceiptV2Enabled(env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    const raw = env?.['MYSHELL_EVIDENCE_RECEIPT_V2'];
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
