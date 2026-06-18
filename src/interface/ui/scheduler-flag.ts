/**
 * src/interface/ui/scheduler-flag.ts — the single source of truth for whether
 * the BOUNDED CONCURRENT MULTI-GOAL SCHEDULER (src/core/scheduler.ts) is active.
 *
 * Pure (no Ink/React, no JSX) so it is exercised by the REGULAR `npm test` suite
 * under strip-types.
 *
 * SMART AUTO (beyond 10/10): for /goal the scheduler + decompose is ON by default
 * (plug-and-play, low-pressure friendly). Explicit OFF with MYSHELL_SCHEDULER=0/false/off/no.
 * Explicit ON with 1/true/on/yes or config.experimentalScheduler.
 * This makes concurrent "pretty much auto, smart" when a plan has parallel work
 * or conditions are good — never forces fan-out on truly sequential plans (decompose
 * returns 1 goal in that case and behavior is equivalent).
 */

// Re-export the sibling Phase-D per-item parking flag so it participates in the
// src import graph (the no-orphan arch guard requires a SRC importer). The flag
// itself is dark until the D5 wiring; its only behavioral consumer this slice is
// its unit test (which imports it directly from item-park-flag.ts).
export { itemParkingEnabled } from './item-park-flag.js';

/** Env values treated as an explicit opt-IN for MYSHELL_SCHEDULER (case-insensitive). */
const ON = new Set(['1', 'true', 'on', 'yes']);
/** Env values treated as explicit opt-OUT (forces sequential even for multi-goal plans). */
const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Decide whether the multi-goal scheduler is enabled.
 * - Explicit ON via MYSHELL_SCHEDULER=1/true/on/yes or config.experimentalScheduler=true → true
 * - Explicit OFF via MYSHELL_SCHEDULER=0/false/off/no → false
 * - Default: true (smart auto for /goal: decompose always, concurrent when beneficial)
 */
export function schedulerEnabled(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalScheduler?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_SCHEDULER'];
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (OFF.has(v)) return false;
    if (ON.has(v)) return true;
  }
  if (config?.experimentalScheduler === false) return false;
  if (config?.experimentalScheduler === true) return true;
  return true; // smart auto default
}

/**
 * True if the env/config explicitly forces the scheduler OFF.
 * Used to override smart-auto decisions.
 */
export function schedulerExplicitlyOff(
  env: NodeJS.ProcessEnv | undefined,
  config: { experimentalScheduler?: boolean } | undefined,
): boolean {
  const raw = env?.['MYSHELL_SCHEDULER'];
  if (typeof raw === 'string' && OFF.has(raw.trim().toLowerCase())) return true;
  if (config?.experimentalScheduler === false) return true;
  return false;
}
