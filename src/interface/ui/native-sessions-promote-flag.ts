/**
 * src/interface/ui/native-sessions-promote-flag.ts — pure helper for whether
 * MYSHELL_NATIVE_SESSIONS_PROMOTE native-session promotion is active.
 *
 * Pure (no I/O, no React/Ink), same pattern as every sibling flag. DEFAULT ON.
 * Returns false only for explicit opt-out.
 */

const ON = new Set(['1', 'true', 'on', 'yes']);
const OFF = new Set(['0', 'false', 'off', 'no']);

export function nativeSessionsPromoteEnabled(env: NodeJS.ProcessEnv | undefined): boolean {
  try {
    const raw = env?.['MYSHELL_NATIVE_SESSIONS_PROMOTE'];
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

export function nativeSessionsEffectiveEnabled(input: {
  readonly configNativeSessions?: boolean;
  readonly promoted: boolean;
}): boolean {
  return input.configNativeSessions === true || input.promoted === true;
}
