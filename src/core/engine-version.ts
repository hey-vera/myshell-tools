/**
 * src/core/engine-version.ts — the Adaptive Partner Engine BEHAVIOR version marker
 * (adaptive-partner-v2-5.6.md §3 + §4 Stage 6).
 *
 * A single, minimal, backward-compatible constant stamped onto accepted assistant
 * entries when they are persisted, so a later turn can IDENTIFY which transcript
 * period a prior assistant turn was written in.
 *
 * WHY: the stale-history quarantine (§3, `decideHistoryPolicy`) currently relies on
 * recognising the old generic "fix/add/polish/integrate?" menu by its TEXT. But a
 * pre-fix transcript can contain order-taker prose that does NOT obviously read as a
 * menu yet still few-shots the model back into the old behavior. Stamping each
 * post-fix assistant turn with the current engine behavior version lets the
 * quarantine treat an assistant turn written by a PRE-FIX engine (no marker, or a
 * marker below the current version) as a quarantine CANDIDATE — even when its text
 * is not an obvious menu.
 *
 * BACKWARD COMPATIBILITY (the whole point of "minimal"):
 *   - The marker is OPTIONAL on `SessionEntry`. An entry without it is LEGACY
 *     (written by a pre-fix build) and still loads — the jsonl guard accepts both
 *     present (a finite number) and absent. Absent is the pre-fix state.
 *   - {@link isLegacyEngineEntry} maps "absent OR below current" → legacy; a marker
 *     at/above the current version is trusted (current-engine prose).
 *   - Bumping {@link ENGINE_BEHAVIOR_VERSION} in a future fix automatically makes
 *     today's entries legacy relative to that future — no schema migration needed.
 *
 * PURE: no I/O, no time, no randomness (test/arch/guards.ts).
 */

/**
 * The current engine BEHAVIOR version. Bumped only when a behavior change makes
 * prior assistant prose untrustworthy as a few-shot exemplar.
 *
 * 1 — the AP2 hardening line: enforced pre-provider asks (§2.2 A1), the generic-menu
 *     output validator (§2.2 A2), and stale-history quarantine + native-session
 *     hardening (§3, §4 Stage 6). Entries stamped `1` were written by an engine that
 *     no longer emits the order-taker menu; entries with NO marker predate it.
 */
export const ENGINE_BEHAVIOR_VERSION = 1 as const;

/**
 * Is this persisted engine-behavior-version marker LEGACY (pre-fix) relative to the
 * current engine? PURE; never throws.
 *
 * Legacy when the marker is ABSENT (an old transcript period that predates the
 * marker) OR present but BELOW {@link ENGINE_BEHAVIOR_VERSION} (written by an older,
 * pre-fix engine line). A marker at or above the current version is current-engine
 * prose (trusted, not a quarantine candidate on the version axis alone).
 *
 * @param version - the `engineBehaviorVersion` read off a persisted assistant entry
 *   (or `undefined` when the entry predates the marker).
 */
export function isLegacyEngineEntry(version: number | undefined): boolean {
  if (version === undefined || version === null) return true;
  if (typeof version !== 'number' || !Number.isFinite(version)) return true;
  return version < ENGINE_BEHAVIOR_VERSION;
}
