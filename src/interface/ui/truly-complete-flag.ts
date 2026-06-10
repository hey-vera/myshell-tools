/**
 * src/interface/ui/truly-complete-flag.ts — the single source of truth for whether
 * the VERIFIED-DONE goal-completion GATE (elite-partner Part 3, the anti-fabrication
 * backbone) is armed.
 *
 * When ON, a goal can NO LONGER be marked `done` just because the model SAID
 * GOAL_COMPLETE. The model's GOAL_COMPLETE becomes a REQUEST to verify: before the
 * goal is set `done`, a REAL verification runs over the goal's cumulative changes
 * (the existing verify.ts engine — git-diff change-capture + the project's own test
 * command → the honest four-state `passing|failing|reviewed|unverified`). The goal
 * is set `done` ONLY when the verdict is `passing` or `reviewed`; a `failing` or
 * `unverified` verdict leaves the goal open with an HONEST receipt — never fake green.
 *
 * When OFF, the gate never runs: the model's GOAL_COMPLETE settles the goal `done`
 * exactly as today (byte-for-byte identical). This mirrors the rollout shape of the
 * board/auto-goal/understanding/verify flags (opt-in, dark by default).
 *
 * Pure (no Ink/React, no JSX, no I/O) so it is exercised by the REGULAR `npm test`
 * suite under strip-types. DEFAULT OFF — the gate ships dark unless the caller
 * explicitly opts IN: `MYSHELL_TRULY_COMPLETE` ∈ {'1','true','on','yes'} (case-
 * insensitive, trimmed) OR `config.experimentalTrulyComplete === true`. Never throws.
 *
 * THE OFF-GUARANTEE (the neutrality contract): when this returns false, menu.ts
 * never runs a verification from the goal-completion path, never writes a goal
 * verdict, and never demotes the model's GOAL_COMPLETE — the goal settles exactly
 * as today.
 */

/** Env values treated as an explicit opt-IN for MYSHELL_TRULY_COMPLETE (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the verified-done goal-completion gate is enabled. DEFAULT FALSE.
 * Returns true ONLY when explicitly opted in: `MYSHELL_TRULY_COMPLETE` is one of
 * '1'/'true'/'on'/'yes' (trimmed, case-insensitive) OR
 * `config.experimentalTrulyComplete === true`. Any other value (including absent,
 * '0', 'false', '') → false. Never throws.
 */
export function verifiedDoneEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalTrulyComplete?: boolean } | undefined,
): boolean {
  try {
    const raw = env?.['MYSHELL_TRULY_COMPLETE'];
    if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
    if (config?.experimentalTrulyComplete === true) return true;
    return false;
  } catch {
    return false;
  }
}
