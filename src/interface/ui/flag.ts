/**
 * src/interface/ui/flag.ts — the single source of truth for whether the
 * Ink chat UI is active.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT ON: the Ink path is active unless the caller
 * has explicitly opted OUT — `MYSHELL_INK` ∈ {'0','false','off','no'}
 * (case-insensitive, trimmed) OR `config.experimentalInk === false`. The legacy
 * render/menu path is retained as the explicit fallback (`MYSHELL_INK=0`); when
 * this returns false, not a single byte of that legacy path changes.
 *
 * NB: mounting Ink ALSO requires an interactive TTY — that guard lives at the
 * mount site (menu.ts startMenu), not here. This flag answers "did the user
 * opt out?", not "is the terminal capable?".
 */

/** Env values treated as an explicit opt-OUT for MYSHELL_INK (case-insensitive). */
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Decide whether the Ink UI is enabled. DEFAULT TRUE. Returns false ONLY when
 * explicitly opted out: `MYSHELL_INK` is one of '0'/'false'/'off'/'no'
 * (trimmed, case-insensitive) OR `config.experimentalInk === false`. The
 * explicit opt-IN forms (`config.experimentalInk === true`, or a truthy
 * `MYSHELL_INK`) are harmless and also return true. Never throws.
 */
export function inkEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalInk?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_INK'];
  if (typeof raw === 'string' && OFF.has(raw.trim().toLowerCase())) return false;
  if (config?.experimentalInk === false) return false;
  return true;
}
