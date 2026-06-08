/**
 * src/interface/ui/flag.ts — the single source of truth for whether the
 * experimental Ink chat UI is active.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF: the Ink path only activates when the
 * `MYSHELL_INK` env var is truthy OR `config.experimentalInk === true`. When it
 * returns false, not a single byte of the legacy render/menu path changes.
 */

/** Env values treated as "on" for MYSHELL_INK (case-insensitive). */
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/**
 * Decide whether to mount the Ink UI. True iff `MYSHELL_INK` is a truthy env
 * value OR `config.experimentalInk === true`. Any other state (including absent
 * env and absent/false config) → false. Never throws.
 */
export function inkEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalInk?: boolean } | undefined,
): boolean {
  if (config?.experimentalInk === true) return true;
  const raw = env?.['MYSHELL_INK'];
  if (typeof raw === 'string' && TRUTHY.has(raw.trim().toLowerCase())) return true;
  return false;
}
