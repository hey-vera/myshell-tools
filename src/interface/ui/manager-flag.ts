/**
 * src/interface/ui/manager-flag.ts — the single source of truth for whether the
 * PER-GOAL MANAGER CYCLE (elite-partner Part 7) is armed.
 *
 * When ON (and the activated goal has a real, non-empty roadmap), runGoalLoop
 * DRIVES execution by the goal's to-do list instead of the free GOAL_COMPLETE
 * loop: it picks the next actionable to-do, runs ONE worker turn scoped to that
 * to-do, runs a REAL tests-only verification (the same verify.ts engine the
 * goal-completion gate uses), records the honest per-item verdict (evidence-only,
 * via setRoadmapItemVerdict), marks the item done only when the verdict is
 * passing/reviewed, and spawns a bounded fix-it to-do otherwise. When every item
 * is verified-done it runs the EXISTING goal-level verified-done gate before the
 * goal can settle `done`.
 *
 * When OFF (or the goal has no roadmap) the cycle never runs: runGoalLoop is
 * byte-for-byte today's free turn loop. This mirrors the rollout shape of the
 * board / auto-goal / understanding / truly-complete flags (opt-in, dark by
 * default).
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — the cycle ships dark unless the caller
 * explicitly opts IN: `MYSHELL_MANAGER` ∈ {'1','true','on','yes'} (case-
 * insensitive, trimmed) OR `config.experimentalManager === true`. Never throws.
 *
 * THE OFF-GUARANTEE (the neutrality contract): when this returns false, runGoalLoop
 * never picks a to-do, never runs a per-item verification, never writes a per-item
 * verdict, and never deviates from today's free loop.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_MANAGER (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the per-goal manager cycle is enabled. DEFAULT FALSE.
 * Returns true ONLY when explicitly opted in: `MYSHELL_MANAGER` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR
 * `config.experimentalManager === true`. Any other value (including absent,
 * '0', 'false', '') → false. Never throws.
 */
export function managerCycleEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalManager?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_MANAGER'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalManager === true) return true;
    return false;
  } catch {
    return false;
  }
}
