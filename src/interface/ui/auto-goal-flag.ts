/**
 * src/interface/ui/auto-goal-flag.ts — the single source of truth for whether the
 * PLANNING BRAIN / AUTO-STAGE pass (elite-partner Phase 6) is permitted to run.
 *
 * When ON, the partner JUDGES each substantial owner turn post-reply and — when
 * confident there is real work — AUTO-STAGES professional goals (each with its
 * to-do list) as PARKED goals (non-destructive), or surfaces ONE sharp clarifying
 * question when the turn is genuinely ambiguous. When OFF, the planner never runs,
 * so the post-turn slot is byte-for-byte identical to today.
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — auto-staging ships dark unless the caller
 * explicitly opts IN: `MYSHELL_AUTO_GOAL` ∈ {'1','true','on','yes'} (case-
 * insensitive, trimmed) OR `config.experimentalAutoGoal === true`. This mirrors the
 * rollout shape of the board/tribunal/judgment/verify/scheduler flags (opt-in,
 * dark).
 *
 * THE OFF-GUARANTEE (the neutrality contract): when this returns false, menu.ts
 * never builds or invokes the planner, never calls goalStore.create from the
 * planning path, and prints no staging note — the turn settles exactly as today.
 */

/** Env values treated as an explicit opt-IN (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);
/** Env values treated as an explicit opt-OUT (case-insensitive) — restores legacy. */
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Decide whether the planning-brain / auto-stage pass is enabled. DEFAULT TRUE (the
 * partner judges + stages goals — the shipped elite experience). Returns false ONLY
 * on an explicit opt-OUT: `MYSHELL_AUTO_GOAL` ∈ {'0','false','off','no'} (trimmed,
 * case-insensitive) OR `config.experimentalAutoGoal === false`, which restores the
 * byte-identical legacy post-turn slot. Absent / any opt-in value → true. Never throws.
 */
export function autoStageEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalAutoGoal?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_AUTO_GOAL'];
    if (typeof raw === 'string') {
      const v = raw.trim().toLowerCase();
      if (OFF.has(v)) return false;
      if (ON.has(v)) return true;
    }
    if (config?.experimentalAutoGoal === false) return false;
    return true;
  } catch {
    return true;
  }
}
