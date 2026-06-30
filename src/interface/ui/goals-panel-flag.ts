/**
 * src/interface/ui/goals-panel-flag.ts — the single source of truth for whether
 * the FULLSCREEN GOALS PANEL surface (a fullscreen keyboard-nav goals page) is
 * rendered by App.tsx and the associated keybinding behaviour is active.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types. DEFAULT OFF — the panel ships dark and the App.tsx render
 * tree is BYTE-FOR-BYTE unchanged unless the caller explicitly opts IN:
 * `MYSHELL_GOALS_PANEL` ∈ {'1','true','on','yes'} (case-insensitive, trimmed) OR
 * `config.experimentalGoalsPanel === true`. This mirrors the rollout shape of the
 * governor/hedge/scheduler features (opt-in, dark by default).
 *
 * THE OFF-GUARANTEE: when this returns false, App.tsx never renders the panel and
 * no new keybinding behaviour exists — the observable behaviour is byte-for-byte
 * identical to today.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_GOALS_PANEL (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the Goals Panel is enabled. DEFAULT FALSE. Returns true ONLY
 * when explicitly opted in: `MYSHELL_GOALS_PANEL` is one of '1'/'true'/'on'/'yes'
 * (trimmed, case-insensitive) OR `config.experimentalGoalsPanel === true`. Any
 * other value (including absent, '0', 'false', '') → false. Never throws.
 */
export function goalsPanelEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalGoalsPanel?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_GOALS_PANEL'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalGoalsPanel === true) return true;
  return false;
}
