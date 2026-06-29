/**
 * src/interface/ui/goal-steward-flag.ts — the single source of truth for whether
 * the GOAL STEWARD deterministic audit engine (src/core/goal-steward.ts) is
 * consulted at session/conversation-open.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite.
 * DEFAULT OFF — the steward ships dark and no goal audit/wiring runs unless the
 * caller explicitly opts IN: `MYSHELL_GOAL_STEWARD` ∈ {'1','true','on','yes'}
 * (case-insensitive, trimmed) OR `config.experimentalGoalSteward === true`.
 *
 * THE OFF-GUARANTEE: when this returns false, no goal stewardship occurs — the
 * observable behaviour (conversation open, session prompts) is byte-for-byte
 * identical to today's.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_GOAL_STEWARD (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the Goal Steward deterministic audit is enabled. DEFAULT FALSE.
 * Returns true ONLY when explicitly opted in: `MYSHELL_GOAL_STEWARD` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR
 * `config.experimentalGoalSteward === true`. Any other value (including absent,
 * '0', 'false', '') → false. Never throws.
 */
export function goalStewardEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalGoalSteward?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_GOAL_STEWARD'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalGoalSteward === true) return true;
  return false;
}
