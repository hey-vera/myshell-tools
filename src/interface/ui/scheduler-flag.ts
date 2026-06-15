/**
 * src/interface/ui/scheduler-flag.ts — the single source of truth for whether
 * the BOUNDED CONCURRENT MULTI-GOAL SCHEDULER (src/core/scheduler.ts) is active.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types. DEFAULT OFF — the scheduler ships dark and the live
 * single-goal /goal path is byte-for-byte unchanged unless the caller explicitly
 * opts IN: `MYSHELL_SCHEDULER` ∈ {'1','true','on','yes'} (case-insensitive,
 * trimmed) OR `config.experimentalScheduler === true`. This mirrors the rollout
 * shape of the panel/hedge features (opt-in, dark by default) — the inverse of
 * the Ink flag's default-ON, by design: concurrency/cancellation is delicate and
 * lands behind a switch for an adversarial pass before becoming a default.
 *
 * NB: enabling the scheduler ALSO requires the next-phase wiring (the /goal
 * runner calling runSchedule) — this flag answers "did the user opt in?", not
 * "is the runner wired?". The wiring seam is marked `// NEXT PHASE:` at the
 * runGoalLoop call site in menu.ts.
 */

// Re-export the sibling Phase-D per-item parking flag so it participates in the
// src import graph (the no-orphan arch guard requires a SRC importer). The flag
// itself is dark until the D5 wiring; its only behavioral consumer this slice is
// its unit test (which imports it directly from item-park-flag.ts).
export { itemParkingEnabled } from './item-park-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_SCHEDULER (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);

/**
 * Decide whether the multi-goal scheduler is enabled. DEFAULT FALSE. Returns true
 * ONLY when explicitly opted in: `MYSHELL_SCHEDULER` is one of '1'/'true'/'on'/
 * 'yes' (trimmed, case-insensitive) OR `config.experimentalScheduler === true`.
 * Any other value (including absent, '0', 'false', '') → false. Never throws.
 */
export function schedulerEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalScheduler?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_SCHEDULER'];
  if (typeof raw === 'string' && ON.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalScheduler === true) return true;
  return false;
}
